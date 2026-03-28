from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
from collections import deque
from pathlib import Path
from subprocess import TimeoutExpired
from typing import Any

try:
    from forge.common import (
        SUBPROCESS_TEXT,
        atomic_write_yaml,
        bash_executable,
        cursor_cli_extra_path_entries,
        env_paths,
        find_cursor_agent_node_bundle,
        forge_dotenv_setting,
        load_yaml,
        resolve_cursor_bin_for_smith,
        secret_from_env_or_forge_dotenv,
        setup_logging,
        write_smith_agent_prompt,
        _path_for_git_bash,
    )
except ImportError:  # pragma: no cover
    from common import (
        SUBPROCESS_TEXT,
        atomic_write_yaml,
        bash_executable,
        cursor_cli_extra_path_entries,
        env_paths,
        find_cursor_agent_node_bundle,
        forge_dotenv_setting,
        load_yaml,
        resolve_cursor_bin_for_smith,
        secret_from_env_or_forge_dotenv,
        setup_logging,
        write_smith_agent_prompt,
        _path_for_git_bash,
    )

try:
    from forge import humanlog as _humanlog
except ImportError:  # pragma: no cover
    import humanlog as _humanlog  # type: ignore[no-redef]

LOG = setup_logging("cursorexec")


def _smith_files_changed(project: Path, report: dict[str, Any]) -> int:
    ch = report.get("changed")
    if isinstance(ch, list) and ch:
        return len(ch)
    try:
        proc = subprocess.run(
            ["git", "diff", "--name-only", "HEAD"],
            cwd=project,
            capture_output=True,
            text=True,
            timeout=30,
            **SUBPROCESS_TEXT,
        )
        if proc.returncode == 0:
            return len([x for x in (proc.stdout or "").splitlines() if x.strip()])
    except Exception:
        pass
    return 0


def _hlog_smith_done(atom: dict[str, Any], project: Path, report: dict[str, Any]) -> None:
    try:
        n = _smith_files_changed(project, report)
        _humanlog.hlog("smith_done", atm_id=atom.get("id"), files_changed=n)
    except Exception:
        pass

# smith.sh tries up to 3 Cursor models, each SMITH_TIMEOUT (default 300s) — parent must not kill bash early
_DEFAULT_WRAP = 1080
# Keep last N lines for failure tail (memory cap)
_TAIL_MAX_LINES = 500


class _StreamStats:
    """Thread-safe counts of non-empty lines forwarded to the forge log (for heartbeats)."""

    __slots__ = ("_lock", "err", "out")

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.out = 0
        self.err = 0

    def inc(self, stream: str) -> None:
        with self._lock:
            if stream == "out":
                self.out += 1
            else:
                self.err += 1

    def snapshot(self) -> tuple[int, int]:
        with self._lock:
            return self.out, self.err


def _smith_stream_enabled() -> bool:
    v = os.environ.get("FORGE_SMITH_STREAM", "1").strip().lower()
    return v not in ("0", "false", "no")


def _smith_heartbeat_sec() -> float:
    raw = os.environ.get("FORGE_SMITH_HEARTBEAT_SEC", "60").strip()
    if not raw or raw in ("0", "false", "no"):
        return 0.0
    try:
        return max(15.0, float(raw))
    except ValueError:
        return 60.0


def _stream_pipe_to_log(
    pipe: Any,
    prefix: str,
    capture: deque[str],
    label: str,
    stats: _StreamStats | None,
    stream_key: str,
) -> None:
    """Read pipe line-by-line until EOF; log each non-empty line."""
    try:
        for line in iter(pipe.readline, ""):
            capture.append(line)
            s = line.rstrip("\r\n")
            if s:
                LOG.info("%s %s", prefix, s)
                if stats is not None:
                    stats.inc(stream_key)
    except Exception as exc:  # pragma: no cover
        LOG.warning("%s pipe read ended: %s", label, exc)
    finally:
        try:
            pipe.close()
        except Exception:
            pass


def _smith_subprocess_env() -> dict[str, str]:
    """Merge forge/.env resolution (env_paths) into the child env so smith.sh sees CURSORBIN/OSNOVA_*."""
    env = os.environ.copy()
    # Helps any Python tool in the agent chain flush lines when not a TTY.
    env.setdefault("PYTHONUNBUFFERED", "1")
    p = env_paths()
    for key in ("OSNOVA_PROJECT", "OSNOVA_FORGE", "QWENBIN"):
        val = (p.get(key) or "").strip()
        if val:
            env[key] = val
    cb = (p.get("CURSORBIN") or "").strip()
    use_node_bundle = False
    if cb:
        resolved = resolve_cursor_bin_for_smith(cb)
        env["CURSORBIN"] = resolved
        looks_unresolved = "/" not in resolved and "\\" not in resolved
        if (
            sys.platform == "win32"
            and os.environ.get("FORGE_SMITH_USE_CURSOR_SHIM", "").strip().lower() not in ("1", "true", "yes")
        ):
            bundle = find_cursor_agent_node_bundle()
            if bundle:
                node, idx = bundle
                env["CURSOR_AGENT_NODE"] = _path_for_git_bash(node)
                env["CURSOR_AGENT_INDEX_JS"] = _path_for_git_bash(idx)
                use_node_bundle = True
                LOG.info(
                    "smith: Windows — using Cursor CLI node bundle (avoids agent.cmd/ps1 under Git Bash): %s %s",
                    env["CURSOR_AGENT_NODE"],
                    env["CURSOR_AGENT_INDEX_JS"],
                )
        if sys.platform == "win32" and looks_unresolved:
            LOG.warning(
                "CURSORBIN %r did not resolve to a path — ensure Cursor CLI is installed "
                "(~\\.local\\bin\\agent.exe) or set CURSORBIN to the full path.",
                cb,
            )
        elif sys.platform == "win32" and resolved.lower().endswith((".cmd", ".bat")) and not use_node_bundle:
            LOG.warning(
                "CURSORBIN resolves to %r (cmd/bat shim). smith under Git Bash often "
                "gets no output until timeout. Install Cursor agent under %%LOCALAPPDATA%%\\cursor-agent "
                "or set FORGE_SMITH_USE_CURSOR_SHIM=0 (default: use node bundle when found).",
                resolved,
            )
        elif cb.strip() != resolved.strip() and ("/" in resolved or "\\" in resolved):
            LOG.info("CURSORBIN %r → %r", cb, resolved)
    api_key = secret_from_env_or_forge_dotenv("CURSOR_API_KEY")
    if api_key:
        env["CURSOR_API_KEY"] = api_key
    if sys.platform == "win32":
        extra = cursor_cli_extra_path_entries()
        if extra:
            env["PATH"] = os.pathsep.join(extra + [env.get("PATH", "")])
        # GNU `timeout` + node Cursor CLI under Git Bash often exits 124 at SMITH_TIMEOUT while work
        # continues; rely on cursorexec outer FORGE_SMITH_WRAP_TIMEOUT only. Override: FORGE_SMITH_NO_INNER_TIMEOUT=0 in forge/.env
        no_inner = forge_dotenv_setting("FORGE_SMITH_NO_INNER_TIMEOUT", "1").lower()
        if no_inner not in ("0", "false", "no"):
            env["FORGE_SMITH_NO_INNER_TIMEOUT"] = "1"
            LOG.info(
                "smith: FORGE_SMITH_NO_INNER_TIMEOUT=1 (Windows) — inner GNU timeout disabled; "
                "outer FORGE_SMITH_WRAP_TIMEOUT still kills hung runs."
            )
    return env


def _smith_wrap_timeout() -> int:
    raw = os.environ.get("FORGE_SMITH_WRAP_TIMEOUT", "").strip()
    if raw.isdigit():
        return max(60, int(raw))
    return _DEFAULT_WRAP


def _smith_models_tokens() -> list[str]:
    return [x for x in forge_dotenv_setting("SMITH_MODELS", "_ auto").split() if x]


def _finalize_smith_artifacts_native(
    project: Path,
    atm_id: str,
    status: str,
    elapsed: int,
    result_err: str,
) -> None:
    report: dict[str, Any] = {
        "v": 5,
        "t": "RPT",
        "id": atm_id,
        "s": status,
        "tests": {"passed": 0, "total": 0},
        "changed": [],
        "elapsed": int(elapsed),
        "err": result_err or None,
    }
    atomic_write_yaml(project / ".osnova" / "report.yaml", report)
    subprocess.run(
        ["git", "-C", str(project), "add", ".osnova/report.yaml"],
        capture_output=True,
        **SUBPROCESS_TEXT,
        check=False,
    )
    subprocess.run(
        ["git", "-C", str(project), "commit", "-m", f"smith report {atm_id} {status}"],
        capture_output=True,
        **SUBPROCESS_TEXT,
        check=False,
    )
    subprocess.run(
        ["git", "-C", str(project), "push"],
        capture_output=True,
        **SUBPROCESS_TEXT,
        check=False,
    )


def _run_smith_native_win32_capture(
    atom: dict[str, Any],
    project: Path,
    env: dict[str, str],
    wrap_s: int,
) -> tuple[bool, dict[str, Any]]:
    report_file = project / ".osnova" / "report.yaml"
    start_ts = time.monotonic()
    atm_id = write_smith_agent_prompt(project)
    prompt_text = (project / ".osnova" / "smith-agent-prompt.txt").read_text(encoding="utf-8")
    node, js = env["CURSOR_AGENT_NODE"], env["CURSOR_AGENT_INDEX_JS"]
    deadline = start_ts + wrap_s
    ok = False
    result_err = ""
    for model_token in _smith_models_tokens():
        rem = deadline - time.monotonic()
        if rem <= 0:
            result_err = result_err or "smith native: wrap timeout before model"
            break
        argv = [node, js, "-p", "--yolo", "--trust", "--workspace", str(project)]
        if model_token not in ("_", ""):
            argv.extend(["--model", model_token])
        argv.append(prompt_text)
        try:
            proc = subprocess.run(
                argv,
                cwd=project,
                env=env,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                timeout=rem,
                check=False,
                **SUBPROCESS_TEXT,
            )
        except TimeoutExpired:
            result_err = "smith native: model run TimeoutExpired"
            break
        if proc.returncode == 0:
            ok = True
            result_err = ""
            break
        result_err = f"agent -p failed (model token: {model_token})"
    elapsed_sec = int(time.monotonic() - start_ts)
    status = "OK" if ok else "BLK"
    _finalize_smith_artifacts_native(project, atm_id, status, elapsed_sec, result_err)
    report = load_yaml(report_file, default={}) or {}
    _hlog_smith_done(atom, project, report)
    return report.get("s") == "OK", report


def _run_smith_native_win32_streaming(
    atom: dict[str, Any],
    project: Path,
    env: dict[str, str],
    wrap_s: int,
) -> tuple[bool, dict[str, Any]]:
    report_file = project / ".osnova" / "report.yaml"
    LOG.info("cursorexec: smith native Windows — direct node (Git Bash skipped) for %s", atom.get("id"))
    start_ts = time.monotonic()
    atm_id = write_smith_agent_prompt(project)
    prompt_text = (project / ".osnova" / "smith-agent-prompt.txt").read_text(encoding="utf-8")
    node, js = env["CURSOR_AGENT_NODE"], env["CURSOR_AGENT_INDEX_JS"]
    deadline = start_ts + wrap_s
    ok = False
    result_err = ""
    last_stderr = ""
    last_stdout = ""

    for model_token in _smith_models_tokens():
        rem = deadline - time.monotonic()
        if rem <= 0:
            result_err = result_err or "smith native: FORGE_SMITH_WRAP_TIMEOUT before model start"
            break
        argv = [node, js, "-p", "--yolo", "--trust", "--workspace", str(project)]
        if model_token not in ("_", ""):
            argv.extend(["--model", model_token])
        argv.append(prompt_text)

        LOG.info(
            "smith native: model=%s remaining_wrap≈%.0fs node=%s",
            model_token or "_",
            rem,
            node,
        )
        stdout_cap: deque[str] = deque(maxlen=_TAIL_MAX_LINES)
        stderr_cap: deque[str] = deque(maxlen=_TAIL_MAX_LINES)
        stream_stats = _StreamStats()
        proc = subprocess.Popen(
            argv,
            cwd=project,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=1,
            **SUBPROCESS_TEXT,
        )
        assert proc.stdout is not None and proc.stderr is not None
        t_out = threading.Thread(
            target=_stream_pipe_to_log,
            args=(proc.stdout, "smith │ native │", stdout_cap, "stdout", stream_stats, "out"),
            daemon=True,
        )
        t_err = threading.Thread(
            target=_stream_pipe_to_log,
            args=(proc.stderr, "smith │ native stderr │", stderr_cap, "stderr", stream_stats, "err"),
            daemon=True,
        )
        t_out.start()
        t_err.start()

        model_wait_start = time.monotonic()
        rc: int | None = None
        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    LOG.error("smith native: hard timeout — killing node for %s", atom.get("id"))
                    proc.kill()
                    rc = proc.wait()
                    break
                hb_sec = _smith_heartbeat_sec()
                chunk = min(hb_sec if hb_sec > 0 else 120.0, remaining)
                try:
                    rc = proc.wait(timeout=chunk)
                    break
                except TimeoutExpired:
                    if hb_sec > 0:
                        out_n, err_n = stream_stats.snapshot()
                        LOG.info(
                            "smith native … heartbeat: %ds (model) · stdout=%d stderr=%d",
                            int(time.monotonic() - model_wait_start),
                            out_n,
                            err_n,
                        )
                        _humanlog.hlog(
                            "smith_heartbeat",
                            elapsed_s=int(time.monotonic() - model_wait_start),
                        )
        except Exception as exc:
            LOG.exception("smith native wait failed: %s", exc)
            try:
                proc.kill()
            except Exception:
                pass
            rc = proc.wait() if rc is None else rc

        t_out.join(timeout=30)
        t_err.join(timeout=30)

        proc_stderr = "".join(stderr_cap)
        proc_stdout = "".join(stdout_cap)
        if rc is None:
            rc = proc.poll() if proc.poll() is not None else -1
        returncode = rc if rc is not None else -1

        if returncode != 0:
            LOG.warning(
                "smith native: model %s exit=%s stderr_tail=%s",
                model_token,
                returncode,
                proc_stderr.strip()[-400:],
            )
        last_stderr = proc_stderr
        last_stdout = proc_stdout
        if returncode == 0:
            ok = True
            result_err = ""
            break
        result_err = f"agent -p failed (model token: {model_token})"

    elapsed_sec = int(time.monotonic() - start_ts)
    status = "OK" if ok else "BLK"
    _finalize_smith_artifacts_native(project, atm_id, status, elapsed_sec, result_err)

    report = load_yaml(report_file, default={}) or {}
    success = report.get("s") == "OK"
    if not success:
        err = (report.get("err") or "").strip()
        LOG.warning(
            "smith native ATM %s → BLK (report.s from report.yaml). err=%s\n--- stderr ---\n%s\n--- stdout ---\n%s",
            atom.get("id"),
            err or "(see report.yaml)",
            last_stderr[-1500:],
            last_stdout[-1500:],
        )
    _hlog_smith_done(atom, project, report)
    return success, report


def run_atom(atom: dict[str, Any], dry_run: bool = False) -> tuple[bool, dict[str, Any]]:
    project = Path(env_paths()["OSNOVA_PROJECT"])
    task_file = project / ".osnova" / "task.yaml"
    report_file = project / ".osnova" / "report.yaml"
    atomic_write_yaml(task_file, atom)
    if dry_run:
        LOG.info("[dry-run] Would call smith.sh for %s", atom.get("id"))
        return True, {"v": 5, "t": "RPT", "id": atom.get("id"), "s": "OK", "changed": [], "elapsed": 0}
    wrap_s = _smith_wrap_timeout()
    LOG.info(
        "cursorexec: starting smith.sh for %s (subprocess timeout %ss; set FORGE_SMITH_WRAP_TIMEOUT if needed)",
        atom.get("id"),
        wrap_s,
    )
    smith = Path(env_paths()["OSNOVA_FORGE"]) / "smith.sh"

    env = _smith_subprocess_env()

    use_native_win = (
        sys.platform == "win32"
        and env.get("CURSOR_AGENT_NODE")
        and env.get("CURSOR_AGENT_INDEX_JS")
        and forge_dotenv_setting("FORGE_SMITH_NATIVE_WIN32", "1").lower() not in ("0", "false", "no")
    )
    if use_native_win:
        LOG.info(
            "cursorexec: smith native Windows (FORGE_SMITH_NATIVE_WIN32) — direct node, Git Bash skipped",
        )
        if _smith_stream_enabled():
            return _run_smith_native_win32_streaming(atom, project, env, wrap_s)
        return _run_smith_native_win32_capture(atom, project, env, wrap_s)

    bash = bash_executable()
    if not bash:
        LOG.error(
            "smith.sh needs bash (Git for Windows). Set FORGE_BASH to bash.exe or add bash to PATH."
        )
        return False, {
            "v": 5,
            "t": "RPT",
            "id": atom.get("id"),
            "s": "BLK",
            "err": "bash not found (WinError 193 fix: run smith under bash)",
            "changed": [],
        }

    if not _smith_stream_enabled():
        try:
            proc = subprocess.run(
                [bash, str(smith)],
                cwd=project,
                env=env,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                timeout=wrap_s,
                check=False,
                **SUBPROCESS_TEXT,
            )
        except TimeoutExpired:
            LOG.error(
                "smith.sh timed out after %ss for %s — raise FORGE_SMITH_WRAP_TIMEOUT or lower SMITH_TIMEOUT in smith.sh",
                wrap_s,
                atom.get("id"),
            )
            return False, {
                "v": 5,
                "t": "RPT",
                "id": atom.get("id"),
                "s": "BLK",
                "err": f"smith.sh subprocess timeout {wrap_s}s",
                "changed": [],
            }
        if proc.returncode != 0:
            LOG.warning("smith failed: %s", (proc.stderr or "").strip())
        report = load_yaml(report_file, default={}) or {}
        success = report.get("s") == "OK"
        if not success:
            err = (report.get("err") or "").strip()
            LOG.warning(
                "smith ATM %s → BLK (smith.sh/bash exit=%s; report.s from report.yaml). err=%s\n"
                "--- stderr tail ---\n%s\n--- stdout tail ---\n%s",
                atom.get("id"),
                proc.returncode,
                err or "(see report.yaml)",
                (proc.stderr or "")[-1500:],
                (proc.stdout or "")[-1500:],
            )
        _hlog_smith_done(atom, project, report)
        return success, report

    # Stream stdout/stderr line-by-line so operators see Cursor/agent activity (not a 5-minute black hole).
    stdout_cap: deque[str] = deque(maxlen=_TAIL_MAX_LINES)
    stderr_cap: deque[str] = deque(maxlen=_TAIL_MAX_LINES)
    stream_stats = _StreamStats()
    proc = subprocess.Popen(
        [bash, str(smith)],
        cwd=project,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=1,
        **SUBPROCESS_TEXT,
    )
    assert proc.stdout is not None and proc.stderr is not None
    t_out = threading.Thread(
        target=_stream_pipe_to_log,
        args=(proc.stdout, "smith │", stdout_cap, "stdout", stream_stats, "out"),
        daemon=True,
    )
    t_err = threading.Thread(
        target=_stream_pipe_to_log,
        args=(proc.stderr, "smith │ stderr │", stderr_cap, "stderr", stream_stats, "err"),
        daemon=True,
    )
    t_out.start()
    t_err.start()
    hb_sec = _smith_heartbeat_sec()
    LOG.info(
        "cursorexec: streaming smith.sh output line-by-line (FORGE_SMITH_STREAM=1); "
        "heartbeat every %ss (FORGE_SMITH_HEARTBEAT_SEC, 0=off)",
        int(hb_sec) if hb_sec > 0 else 0,
    )
    _hb_tail = (
        "inner GNU timeout is off (FORGE_SMITH_NO_INNER_TIMEOUT=1); forge kills the run at FORGE_SMITH_WRAP_TIMEOUT if the agent never exits."
        if env.get("FORGE_SMITH_NO_INNER_TIMEOUT") == "1"
        else "process may still be working until SMITH_TIMEOUT inner kill."
    )
    LOG.info(
        "smith │ subprocess pid=%s — if heartbeats show 0 stdout / 0 stderr lines, Cursor CLI is not "
        "writing to pipes (buffering or UI-only); %s",
        proc.pid,
        _hb_tail,
    )

    start = time.monotonic()
    rc: int | None = None
    try:
        while True:
            elapsed = time.monotonic() - start
            remaining = wrap_s - elapsed
            if remaining <= 0:
                LOG.error(
                    "smith: hard timeout %ss — killing bash/agent for %s",
                    wrap_s,
                    atom.get("id"),
                )
                proc.kill()
                rc = proc.wait()
                break
            chunk = min(hb_sec if hb_sec > 0 else 120.0, remaining)
            try:
                rc = proc.wait(timeout=chunk)
                break
            except TimeoutExpired:
                if hb_sec > 0:
                    out_n, err_n = stream_stats.snapshot()
                    _pipe_note = (
                        "— Cursor CLI often writes nothing to pipes here"
                        if out_n == 0 and err_n == 0
                        else "— only smith stderr lines so far; node/agent may still be running without stdout"
                    )
                    LOG.info(
                        "smith │ … heartbeat pid=%s: %ds / %ds cap · lines logged: stdout=%d stderr=%d %s",
                        proc.pid,
                        int(time.monotonic() - start),
                        wrap_s,
                        out_n,
                        err_n,
                        _pipe_note,
                    )
                    _humanlog.hlog("smith_heartbeat", elapsed_s=int(time.monotonic() - start))
    except Exception as exc:
        LOG.exception("smith: wait failed: %s", exc)
        try:
            proc.kill()
        except Exception:
            pass
        rc = proc.wait() if rc is None else rc

    t_out.join(timeout=30)
    t_err.join(timeout=30)

    proc_stderr = "".join(stderr_cap)
    proc_stdout = "".join(stdout_cap)

    if rc is None:
        rc = proc.poll() if proc.poll() is not None else -1

    returncode = rc if rc is not None else -1

    if returncode != 0:
        LOG.warning("smith failed (exit=%s): %s", returncode, proc_stderr.strip()[-500:])

    report = load_yaml(report_file, default={}) or {}
    success = report.get("s") == "OK"
    if not success:
        err = (report.get("err") or "").strip()
        LOG.warning(
            "smith ATM %s → BLK (smith.sh/bash exit=%s; report.s from report.yaml). err=%s\n"
            "--- stderr tail ---\n%s\n--- stdout tail ---\n%s",
            atom.get("id"),
            returncode,
            err or "(see report.yaml)",
            proc_stderr[-1500:],
            proc_stdout[-1500:],
        )
    _hlog_smith_done(atom, project, report)
    return success, report


def main() -> None:
    LOG.info("cursorexec module ready")


if __name__ == "__main__":
    main()

