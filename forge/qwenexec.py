"""
Qwen **Code** CLI (агент с tools), не LLM-only.

Не использует ``qwen_headless_argv()`` из ``common.py`` — тот путь с ``--yolo`` и ``-p …``
без ``--output-format json``; здесь только ``--approval-mode yolo`` (не смешивать с ``--yolo`` — CLI падает в help).

Здесь: **обязательно** ``-p`` / ``--prompt`` для headless (см. Qwen Code docs); позиционный промпт без ``-p``
может открыть интерактив/приветствие вместо JSON. Разбор последнего ``{"type": "result"}`` в stdout+stderr.

По умолчанию процесс запускается через ``Popen`` + потоки: stderr/stdout (опц.) в лог с префиксом
``qwen │ native │``, раз в ``FORGE_QWEN_HEARTBEAT_SEC`` — heartbeat (как smith). Отключить: ``FORGE_QWEN_STREAM=0``.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path
from subprocess import TimeoutExpired
from typing import Any

try:
    from forge.common import (
        SUBPROCESS_TEXT,
        atomic_write_yaml,
        env_paths,
        forge_dotenv_setting,
        resolve_executable,
        setup_logging,
    )
    from forge.done_paths import check_done_cmd_paths
    from forge.qwenbudget import (
        can_call_executor,
        is_quota_exhausted_output,
        log_remote_qwen_limit,
        record,
    )
except ImportError:  # pragma: no cover
    from common import (
        SUBPROCESS_TEXT,
        atomic_write_yaml,
        env_paths,
        forge_dotenv_setting,
        resolve_executable,
        setup_logging,
    )
    from done_paths import check_done_cmd_paths
    from qwenbudget import (
        can_call_executor,
        is_quota_exhausted_output,
        log_remote_qwen_limit,
        record,
    )

LOG = setup_logging("qwenexec")

_DEFAULT_QWEN_RUN_S = 900
# Qwen CLI: FatalTurnLimitedError / exit 53 when session hits --max-session-turns (tsc-style ATM).
_DEFAULT_MAX_SESSION_TURNS = "40"


def _qwen_run_timeout() -> int:
    raw = os.environ.get("FORGE_QWEN_TIMEOUT", "").strip()
    if raw.isdigit():
        return max(30, int(raw))
    return _DEFAULT_QWEN_RUN_S


def _prompt(atom: dict[str, Any]) -> str:
    project = env_paths()["OSNOVA_PROJECT"]
    rc = atom.get("retry_context")
    retry_block = ""
    if isinstance(rc, dict) and (rc.get("previous_failure") or rc.get("attempt")):
        retry_block = (
            "\n--- ПОВТОР после BLK ---\n"
            f"attempt: {rc.get('attempt')}\n"
            f"previous_failure: {rc.get('previous_failure')}\n"
            f"hint: {rc.get('hint', '')}\n"
        )
    return (
        "Ты — forge smith. Репозиторий: "
        f"{project}.\n"
        f"Задача: {atom.get('goal')}\n"
        f"Файлы scope (прочти перед правкой): {atom.get('scope')}\n"
        f"Шаги: {atom.get('steps')}\n"
        f"Проверка: запусти {atom.get('done')} и убедись что exit code 0.\n"
        f"Не трогай: {atom.get('notouch')}\n"
        f"{retry_block}"
        "Ответь кратко что изменил.\n"
    )


def _default_prompt_via() -> str:
    """Windows npm ``qwen.cmd`` часто ломает длинный ``-p``; надёжнее stdin (как ``echo | qwen`` в доке)."""
    return "stdin" if sys.platform == "win32" else "dash_p"


def _effective_max_session_turns(override: str | None) -> str:
    if override is not None:
        s = override.strip()
        return s if s else _DEFAULT_MAX_SESSION_TURNS
    raw = os.environ.get("FORGE_QWEN_MAX_SESSION_TURNS", _DEFAULT_MAX_SESSION_TURNS).strip()
    return raw or _DEFAULT_MAX_SESSION_TURNS


def _retry_max_session_turns_after_limit(base: str) -> str:
    """Second attempt after FatalTurnLimitedError; override: FORGE_QWEN_MAX_SESSION_TURNS_RETRY."""
    raw = os.environ.get("FORGE_QWEN_MAX_SESSION_TURNS_RETRY", "").strip()
    if raw.isdigit():
        try:
            b = max(1, int(base)) if base.isdigit() else 1
        except ValueError:
            b = 1
        return str(max(int(raw), b))
    try:
        b = max(1, int(base)) if base.isdigit() else int(_DEFAULT_MAX_SESSION_TURNS)
    except ValueError:
        b = 40
    return str(max(b * 3, 80))


def _qwen_shared_flags(*, max_session_turns: str | None = None) -> list[str]:
    tools = os.environ.get(
        "FORGE_QWEN_ALLOWED_TOOLS",
        "write_file,edit,read_file,run_shell_command,grep_search,glob",
    ).strip()
    turns = _effective_max_session_turns(max_session_turns)
    return [
        "--approval-mode",
        "yolo",
        "--output-format",
        "json",
        "--max-session-turns",
        turns,
        "--allowed-tools",
        tools,
    ]


def _qwen_code_invocation(prompt: str, *, max_session_turns: str | None = None) -> tuple[list[str], str | None, str]:
    """
    Возвращает ``(argv, stdin_or_none, via)``.

    - ``stdin``: ``qwen`` + флаги из ``_qwen_shared_flags()`` + промпт в stdin.
    - ``dash_p``: ``qwen -p PROMPT`` + те же флаги (headless в доке).
    - ``positional``: отладка — ``qwen PROMPT …`` (часто уходит в чат).

    Авто-approve только через ``--approval-mode yolo`` в ``_qwen_shared_flags``; отдельный ``--yolo``
    с ним конфликтует и ведёт к exit 1 / usage.
    """
    exe = resolve_executable(env_paths()["QWENBIN"])
    via_raw = forge_dotenv_setting("FORGE_QWEN_CODE_PROMPT_VIA", _default_prompt_via()).strip().lower()
    via = via_raw or _default_prompt_via().strip().lower()
    tail = _qwen_shared_flags(max_session_turns=max_session_turns)
    if via == "positional":
        return [exe, prompt, *tail], None, via
    if via == "stdin":
        return [exe, *tail], prompt, via
    # dash_p (явный дефолт на non-Windows) и любое неизвестное значение — безопасный headless
    if via not in ("dash_p", "-p", "p", ""):
        LOG.warning("qwenexec: unknown FORGE_QWEN_CODE_PROMPT_VIA=%r — using dash_p", via)
    return [exe, "-p", prompt, *tail], None, via


def _qwen_code_argv(prompt: str) -> list[str]:
    """Совместимость со старыми импортами; для stdin используйте ``_qwen_code_invocation``."""
    argv, _stdin, _via = _qwen_code_invocation(prompt, max_session_turns=None)
    return argv


class _QwenStreamStats:
    __slots__ = ("_lock", "out_lines", "err_lines")

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.out_lines = 0
        self.err_lines = 0

    def inc(self, stream: str) -> None:
        with self._lock:
            if stream == "out":
                self.out_lines += 1
            else:
                self.err_lines += 1

    def snapshot(self) -> tuple[int, int]:
        with self._lock:
            return self.out_lines, self.err_lines


def _qwen_stream_enabled() -> bool:
    v = forge_dotenv_setting("FORGE_QWEN_STREAM", "1").strip().lower()
    return v not in ("0", "false", "no")


def _qwen_heartbeat_sec() -> float:
    raw = forge_dotenv_setting("FORGE_QWEN_HEARTBEAT_SEC", "60").strip()
    if not raw or raw in ("0", "false", "no"):
        return 0.0
    try:
        return max(15.0, float(raw))
    except ValueError:
        return 60.0


def _qwen_log_stdout_lines() -> bool:
    v = forge_dotenv_setting("FORGE_QWEN_LOG_STDOUT", "0").strip().lower()
    return v in ("1", "true", "yes")


def _qwen_stats_for_report(result: dict[str, Any]) -> dict[str, Any]:
    """Subset of Qwen ``type=result`` stats for report.yaml / reviewer hints."""
    out: dict[str, Any] = {}
    st = result.get("stats")
    if not isinstance(st, dict):
        return out
    files = st.get("files")
    if not isinstance(files, dict):
        return out
    for key in ("totalLinesAdded", "totalLinesRemoved", "totalFiles"):
        if key in files:
            try:
                out[key] = int(files[key])
            except (TypeError, ValueError):
                out[key] = files[key]
    for key in ("changedFiles", "paths", "touched", "edited"):
        v = files.get(key)
        if isinstance(v, list) and v:
            out["changed_files"] = [str(x) for x in v[:50]]
            break
    return out


def _log_qwen_post_session_summary(atom_id: str, result: dict[str, Any]) -> None:
    prefix = "qwen │ native │"
    delta = _files_delta(result)
    bits = [f"lines±={delta}"]
    ex = _qwen_stats_for_report(result)
    if ex.get("changed_files"):
        cf = ex["changed_files"]
        tail = ", ".join(cf[:12])
        if len(cf) > 12:
            tail += f" …(+{len(cf) - 12})"
        bits.append(f"changed_files=[{tail}]")
    for k in ("totalLinesAdded", "totalLinesRemoved"):
        if k in ex:
            bits.append(f"{k}={ex[k]}")
    LOG.info("%s session end: %s [ATM %s]", prefix, " · ".join(bits), atom_id)


def _run_qwen_capture(
    cmd: list[str],
    run_kw: dict[str, Any],
    *,
    atom_id: str,
) -> subprocess.CompletedProcess[str]:
    """
    Run Qwen CLI: by default stream stderr/stdout to logs + periodic heartbeat (like smith native).
    Set FORGE_QWEN_STREAM=0 to use one-shot ``subprocess.run`` (tests / minimal env).
    """
    if not _qwen_stream_enabled():
        return _run_qwen(cmd, run_kw)

    run_s = int(run_kw.get("timeout") or _qwen_run_timeout())
    cwd = run_kw.get("cwd")
    env = dict(run_kw.get("env") or os.environ)
    env.setdefault("PYTHONUNBUFFERED", "1")
    text_mode = bool(run_kw.get("text", True))
    stdin_payload = run_kw.get("input")
    use_stdin_pipe = stdin_payload is not None

    cmd_eff = list(cmd)
    if sys.platform == "win32":
        exe = cmd_eff[0]
        if not Path(exe).is_file():
            exe2 = resolve_executable(env_paths()["QWENBIN"])
            if Path(exe2).is_file():
                cmd_eff = [exe2] + cmd_eff[1:]
            else:
                return _run_qwen(cmd, run_kw)

    out_chunks: list[str] = []
    err_chunks: list[str] = []
    stats = _QwenStreamStats()
    prefix = "qwen │ native │"
    log_stdout = _qwen_log_stdout_lines()

    popen_kw: dict[str, Any] = {
        "cwd": cwd,
        "env": env,
        "stdin": subprocess.PIPE if use_stdin_pipe else subprocess.DEVNULL,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "text": text_mode,
        "bufsize": 1,
        **SUBPROCESS_TEXT,
    }
    proc = subprocess.Popen(cmd_eff, **popen_kw)

    if use_stdin_pipe and proc.stdin is not None:
        try:
            proc.stdin.write(stdin_payload)
        except Exception as exc:  # pragma: no cover
            LOG.warning("qwenexec: stdin write failed: %s", exc)
        finally:
            try:
                proc.stdin.close()
            except Exception:
                pass

    def _drain_stdout() -> None:
        if proc.stdout is None:
            return
        try:
            for line in iter(proc.stdout.readline, ""):
                out_chunks.append(line)
                stats.inc("out")
                if log_stdout and line.strip():
                    LOG.info("%s %s", prefix, line.rstrip("\r\n"))
        except Exception as exc:  # pragma: no cover
            LOG.warning("qwenexec stdout reader: %s", exc)
        finally:
            try:
                proc.stdout.close()
            except Exception:
                pass

    def _drain_stderr() -> None:
        if proc.stderr is None:
            return
        try:
            for line in iter(proc.stderr.readline, ""):
                err_chunks.append(line)
                stats.inc("err")
                if line.strip():
                    LOG.info("%s %s", prefix, line.rstrip("\r\n"))
        except Exception as exc:  # pragma: no cover
            LOG.warning("qwenexec stderr reader: %s", exc)
        finally:
            try:
                proc.stderr.close()
            except Exception:
                pass

    t_out = threading.Thread(target=_drain_stdout, daemon=True, name="qwenexec-stdout")
    t_err = threading.Thread(target=_drain_stderr, daemon=True, name="qwenexec-stderr")
    t_out.start()
    t_err.start()

    stop_hb = threading.Event()
    hb_sec = _qwen_heartbeat_sec()

    def _heartbeat() -> None:
        t0 = time.monotonic()
        while not stop_hb.wait(timeout=hb_sec):
            elapsed = int(time.monotonic() - t0)
            ol, el = stats.snapshot()
            LOG.info(
                "%s heartbeat: %ss · stdout_lines=%d stderr_lines=%d · pid=%s · ATM=%s",
                prefix,
                elapsed,
                ol,
                el,
                proc.pid,
                atom_id,
            )

    hb_thread: threading.Thread | None = None
    if hb_sec > 0:
        hb_thread = threading.Thread(target=_heartbeat, daemon=True, name="qwenexec-hb")
        hb_thread.start()

    try:
        rc = proc.wait(timeout=run_s)
    except subprocess.TimeoutExpired:
        try:
            proc.kill()
        except Exception:
            pass
        try:
            proc.wait(timeout=30)
        except Exception:
            pass
        stop_hb.set()
        if hb_thread:
            hb_thread.join(timeout=2.0)
        t_out.join(timeout=30.0)
        t_err.join(timeout=30.0)
        raise subprocess.TimeoutExpired(cmd_eff, run_s) from None
    finally:
        stop_hb.set()
        if hb_thread:
            hb_thread.join(timeout=2.0)

    t_out.join(timeout=120.0)
    t_err.join(timeout=120.0)
    stdout = "".join(out_chunks)
    stderr = "".join(err_chunks)
    return subprocess.CompletedProcess(
        args=cmd_eff,
        returncode=rc if rc is not None else -1,
        stdout=stdout,
        stderr=stderr,
    )


def _run_qwen(cmd: list[str], run_kw: dict[str, Any]) -> subprocess.CompletedProcess[str]:
    """
    Windows: ``CreateProcess`` не резолвит ``qwen`` как npm-.cmd; ``resolve_executable`` даёт путь к .cmd.
    Если файла всё ещё нет — ``shell=True`` + ``list2cmdline`` (cmd.exe ищет PATH).
    """
    exe = cmd[0]
    if sys.platform == "win32" and not Path(exe).is_file():
        exe2 = resolve_executable(env_paths()["QWENBIN"])
        if Path(exe2).is_file():
            cmd = [exe2] + list(cmd[1:])
        else:
            line = subprocess.list2cmdline(cmd)
            return subprocess.run(line, shell=True, **run_kw)
    return subprocess.run(cmd, **run_kw)


def _log_qwen_argv(cmd: list[str], via: str) -> None:
    safe: list[str] = []
    for i, a in enumerate(cmd):
        prev = cmd[i - 1] if i else ""
        if prev in ("-p", "--prompt") and len(a) > 100:
            safe.append(f"{a[:72]}…({len(a)} chars)")
        else:
            safe.append(a)
    # Не логировать список через %s: str(list) даёт repr элементов → C:\\\\\\ в путях.
    LOG.info("qwenexec: FORGE_QWEN_CODE_PROMPT_VIA=%s argv=%s", via, subprocess.list2cmdline(safe))


def _parse_result_event(stdout: str) -> dict[str, Any] | None:
    """Find last JSON object with type==result (NDJSON lines or one blob or array)."""
    events: list[dict[str, Any]] = []
    for line in (stdout or "").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
            if isinstance(obj, dict):
                events.append(obj)
        except json.JSONDecodeError:
            continue
    for r in reversed(events):
        if r.get("type") == "result":
            return r
    blob = (stdout or "").strip()
    if not blob:
        return None
    try:
        data = json.loads(blob)
        if isinstance(data, dict) and data.get("type") == "result":
            return data
        if isinstance(data, list):
            for r in reversed(data):
                if isinstance(r, dict) and r.get("type") == "result":
                    return r
    except json.JSONDecodeError:
        pass
    for m in re.finditer(r"\{[^{}]*\"type\"\s*:\s*\"result\"[^{}]*\}", blob, flags=re.DOTALL):
        try:
            obj = json.loads(m.group(0))
            if isinstance(obj, dict):
                return obj
        except json.JSONDecodeError:
            continue
    return None


def _files_delta(result: dict[str, Any]) -> int:
    try:
        st = result.get("stats") or {}
        files = st.get("files") or {}
        return int(files.get("totalLinesAdded", 0) or 0) + int(files.get("totalLinesRemoved", 0) or 0)
    except (TypeError, ValueError):
        return 0


def _is_fatal_turn_limit_error(combined: str, returncode: int) -> bool:
    """Qwen CLI: ``FatalTurnLimitedError`` / code 53 — не списываем бюджет на первой попытке, retry с большим ``--max-session-turns``."""
    if returncode == 53:
        return True
    for line in (combined or "").splitlines():
        s = line.strip()
        if not s.startswith("{"):
            continue
        try:
            obj = json.loads(s)
        except json.JSONDecodeError:
            continue
        if not isinstance(obj, dict):
            continue
        err = obj.get("error")
        if isinstance(err, dict):
            if err.get("type") == "FatalTurnLimitedError":
                return True
            try:
                if int(err.get("code", 0) or 0) == 53:
                    return True
            except (TypeError, ValueError):
                pass
    return False


def _write_report(project: Path, atom_id: str, report: dict[str, Any]) -> None:
    try:
        p = project / ".osnova" / "report.yaml"
        p.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_yaml(p, report)
    except Exception as exc:
        LOG.warning("qwenexec: could not write report.yaml: %s", exc)


def run_atom(atom: dict[str, Any], dry_run: bool = False) -> tuple[bool, dict[str, Any]]:
    atom_id = str(atom.get("id") or "")
    if dry_run:
        LOG.info("[dry-run] Would call Qwen Code for %s", atom_id)
        return True, {"v": 5, "t": "RPT", "id": atom_id, "s": "OK", "changed": [], "elapsed": 0}

    run_s = _qwen_run_timeout()
    project = Path(env_paths()["OSNOVA_PROJECT"])
    LOG.info(
        "qwenexec: Qwen Code CLI for %s (timeout %ss; FORGE_QWEN_TIMEOUT)",
        atom_id,
        run_s,
    )

    def _blk(
        err: str,
        *,
        retry_cursor: bool = True,
        proc_returncode: int | None = None,
        output_tail: str | None = None,
    ) -> tuple[bool, dict[str, Any]]:
        tail = (output_tail or "").replace("\r\n", "\n").strip()
        if len(tail) > 2000:
            tail = tail[-2000:]
        rc = "n/a" if proc_returncode is None else str(proc_returncode)
        LOG.warning(
            "qwenexec: BLK %s returncode=%s err=%s — tail:\n%s",
            atom_id,
            rc,
            err,
            tail if tail else "(no capture)",
        )
        r: dict[str, Any] = {
            "v": 5,
            "t": "RPT",
            "id": atom_id,
            "s": "BLK",
            "err": err,
            "changed": [],
        }
        if retry_cursor:
            r["forge_retry_executor"] = "cursor"
        _write_report(project, atom_id, r)
        return False, r

    if not can_call_executor():
        return _blk("Qwen executor daily budget exhausted", retry_cursor=True, output_tail="budget gate (can_call_executor false)")

    prompt = _prompt(atom)
    base_turns = _effective_max_session_turns(None)
    retry_turns = _retry_max_session_turns_after_limit(base_turns)

    def _run_once(turns: str) -> subprocess.CompletedProcess[str]:
        cmd, stdin_payload, via = _qwen_code_invocation(prompt, max_session_turns=turns)
        _log_qwen_argv(cmd, via)
        run_kw: dict[str, Any] = {
            "cwd": str(project),
            "capture_output": True,
            "text": True,
            "timeout": run_s,
            "check": False,
            **SUBPROCESS_TEXT,
        }
        if stdin_payload is not None:
            run_kw["input"] = stdin_payload
        else:
            run_kw["stdin"] = subprocess.DEVNULL
        return _run_qwen_capture(cmd, run_kw, atom_id=atom_id)

    try:
        proc = _run_once(base_turns)
    except TimeoutExpired:
        record(served=True, role="executor")
        return _blk(
            f"qwen code timeout after {run_s}s",
            retry_cursor=True,
            output_tail=f"TimeoutExpired after {run_s}s",
        )

    out = proc.stdout or ""
    err = proc.stderr or ""
    combined = f"{out}\n{err}"
    if is_quota_exhausted_output(combined):
        log_remote_qwen_limit("qwenexec", combined, ref=atom_id)
        record(served=False)
        return _blk(
            "Qwen API quota / rate limit",
            retry_cursor=True,
            proc_returncode=proc.returncode,
            output_tail=combined,
        )

    if _is_fatal_turn_limit_error(combined, proc.returncode):
        LOG.warning(
            "qwenexec: FatalTurnLimitedError / exit 53 for %s — retry without budget debit; --max-session-turns %s→%s",
            atom_id,
            base_turns,
            retry_turns,
        )
        try:
            proc = _run_once(retry_turns)
        except TimeoutExpired:
            record(served=True, role="executor")
            return _blk(
                f"qwen code timeout after {run_s}s",
                retry_cursor=True,
                output_tail=f"TimeoutExpired after {run_s}s (after turn-limit retry)",
            )
        out = proc.stdout or ""
        err = proc.stderr or ""
        combined = f"{out}\n{err}"
        if is_quota_exhausted_output(combined):
            log_remote_qwen_limit("qwenexec", combined, ref=atom_id)
            record(served=False)
            return _blk(
                "Qwen API quota / rate limit",
                retry_cursor=True,
                proc_returncode=proc.returncode,
                output_tail=combined,
            )

    record(served=True, role="executor")

    if proc.returncode != 0:
        tail = combined.strip()[-2000:]
        if _is_fatal_turn_limit_error(combined, proc.returncode):
            return _blk(
                "qwen code FatalTurnLimitedError (code 53) after retry with higher max-session-turns",
                retry_cursor=True,
                proc_returncode=proc.returncode,
                output_tail=tail,
            )
        return _blk(
            f"qwen code exit {proc.returncode}",
            retry_cursor=True,
            proc_returncode=proc.returncode,
            output_tail=tail,
        )

    # JSON может оказаться в stderr (редко) или весь буфер — склеиваем
    result = _parse_result_event(f"{out}\n{err}")
    if result is None:
        tail = f"{out}\n{err}".replace("\r\n", "\n").strip()[-2000:]
        return _blk(
            "qwen code output has no type=result JSON",
            retry_cursor=True,
            proc_returncode=proc.returncode,
            output_tail=tail,
        )

    _log_qwen_post_session_summary(atom_id, result)
    st_rep = _qwen_stats_for_report(result)
    is_err = bool(result.get("is_error"))
    delta = _files_delta(result)
    if is_err:
        return _blk(
            "qwen code result.is_error true",
            retry_cursor=True,
            proc_returncode=proc.returncode,
            output_tail=json.dumps(result, ensure_ascii=False)[:2000],
        )
    if delta <= 0:
        done_str = (atom.get("done") or "").strip()
        if done_str:
            missing = check_done_cmd_paths(done_str, project)
            if missing:
                LOG.warning(
                    "ATM %s done-cmd references nonexistent path(s) %s and zero delta "
                    "— skipping Cursor fallback (ATM_DONE_CMD_INVALID)",
                    atom_id,
                    missing,
                )
                report_invalid: dict[str, Any] = {
                    "v": 5,
                    "t": "RPT",
                    "id": atom_id,
                    "s": "WARN",
                    "err": f"ATM_DONE_CMD_INVALID: done-cmd references missing files: {missing}",
                    "forge_done_cmd_invalid": True,
                    "changed": [],
                }
                _write_report(project, atom_id, report_invalid)
                return False, report_invalid
        try:
            from forge.reviewer import run_atom_done_subprocess
        except ImportError:  # pragma: no cover
            from reviewer import run_atom_done_subprocess
        done_proc = run_atom_done_subprocess(atom, timeout_s=900)
        if done_proc is None:
            return _blk(
                "qwen code made no file changes (stats) and atom has no done command",
                retry_cursor=True,
                proc_returncode=proc.returncode,
                output_tail=json.dumps(result, ensure_ascii=False)[:2000],
            )
        if done_proc.returncode == 0:
            report_ok: dict[str, Any] = {
                "v": 5,
                "t": "RPT",
                "id": atom_id,
                "s": "OK",
                "changed": [],
                "elapsed": 0,
                "qwen_result": {
                    "lines_delta": delta,
                    "zero_line_delta_done_verified": True,
                    **st_rep,
                },
                "reviewer_skip_done": True,
            }
            _write_report(project, atom_id, report_ok)
            return True, report_ok
        done_tail = f"{done_proc.stdout or ''}\n{done_proc.stderr or ''}".strip()[-2000:]
        return _blk(
            "qwen code zero line delta; ATM done command failed after OK agent result",
            retry_cursor=True,
            proc_returncode=done_proc.returncode,
            output_tail=f"{json.dumps(result, ensure_ascii=False)[:1200]}\n--- done ---\n{done_tail}",
        )

    report: dict[str, Any] = {
        "v": 5,
        "t": "RPT",
        "id": atom_id,
        "s": "OK",
        "changed": list(st_rep.get("changed_files") or []),
        "elapsed": 0,
        "qwen_result": {"lines_delta": delta, **st_rep},
        # Agent prompt already runs `done`; reviewer can skip second vitest (see forge.review skip_done_command).
        "reviewer_skip_done": True,
    }
    _write_report(project, atom_id, report)
    return True, report


def main() -> None:
    LOG.info("qwenexec module ready")


if __name__ == "__main__":
    main()
