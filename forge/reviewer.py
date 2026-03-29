from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from subprocess import TimeoutExpired
from typing import Any

# str = shell on Windows; list = argv (no cmd.exe shim) — Vitest suite registration on some setups.
DoneCmd = str | list[str]

try:
    from forge.common import (
        SUBPROCESS_TEXT,
        env_paths,
        qwen_headless_argv,
        resolve_executable,
        setup_logging,
    )
    from forge.qwenbudget import can_call, is_quota_exhausted_output, log_remote_qwen_limit, record
except ImportError:  # pragma: no cover
    from common import (
        SUBPROCESS_TEXT,
        env_paths,
        qwen_headless_argv,
        resolve_executable,
        setup_logging,
    )
    from qwenbudget import can_call, is_quota_exhausted_output, log_remote_qwen_limit, record

LOG = setup_logging("reviewer")


def _review_reason_storage_max() -> int:
    raw = os.environ.get("FORGE_REVIEW_REASON_MAX", "").strip()
    if raw.isdigit():
        return max(256, int(raw))
    return 8000


def _stored_review_reason(full: str) -> str:
    """Cap length for returned ``reason`` / ATM storage. Parsing always uses the full Qwen output before this."""
    cap = _review_reason_storage_max()
    if cap <= 0 or len(full) <= cap:
        return full
    return full[:cap] + "…"


def _is_forge_default_vitest_done(cmd: str) -> bool:
    """Epic `done` that runs compiler + agents vitest (Forge v5.2 ATM default)."""
    c = " ".join(cmd.split()).lower()
    if "vitest" not in c:
        return False
    if "src/compiler" not in c:
        return False
    if "src/agents" not in c:
        return False
    return True


def _npm_run_argv(script: str) -> list[str]:
    """Windows: must use cmd.exe to run npm.cmd; argv list avoids Python shell= metacharacter quirks."""
    npm = shutil.which("npm.cmd") or shutil.which("npm") or "npm"
    return ["cmd", "/c", npm, "run", "-s", script]


def _prepare_done_invocation(project: Path, done_cmd: str) -> tuple[DoneCmd, dict[str, str]]:
    """
    Build shell command + env for atom `done` checks. On Windows, may replace ``npx vitest`` with
    ``node …/vitest.mjs`` for resolution; does not inject ``--pool=forks`` / isolation flags (breaks ``vi.mock``).
    """
    done_env = os.environ.copy()
    done_env["NODE_ENV"] = "test"
    cmd = done_cmd
    if sys.platform != "win32":
        return cmd, done_env

    if os.environ.get("FORGE_REVIEWER_KEEP_NODE_OPTIONS", "").strip().lower() not in (
        "1",
        "true",
        "yes",
    ):
        done_env.pop("NODE_OPTIONS", None)

    if os.environ.get("FORGE_REVIEWER_RAW_DONE", "").strip().lower() in (
        "1",
        "true",
        "yes",
    ):
        return cmd, done_env

    # Windows + Python subprocess: direct vitest/npx still hits "No test suite found" for some
    # setups; npm lifecycle fixes INIT_CWD / env enough that suites register reliably.
    if (
        os.environ.get("FORGE_REVIEWER_NO_NPM_VITEST", "").strip().lower()
        not in ("1", "true", "yes")
        and _is_forge_default_vitest_done(cmd)
    ):
        return _npm_run_argv("test:forge:done"), done_env

    mjs = (project / "node_modules" / "vitest" / "vitest.mjs").resolve()
    if mjs.is_file() and "npx vitest" in cmd:
        cmd = cmd.replace("npx vitest", f'node "{mjs}"')

    return cmd, done_env


def _parse_review_json(text: str) -> tuple[bool, str] | None:
    """
    Expect ``{"passed": bool, "reason": str}``. Tolerates leading chatter / markdown fences:
    model must still emit one JSON object (first successful ``raw_decode`` from each ``{``).
    """
    s = (text or "").strip()
    if not s:
        return None
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", s, re.IGNORECASE)
    if fence:
        inner = fence.group(1).strip()
        if inner:
            s = inner
    dec = json.JSONDecoder()
    start = 0
    while True:
        i = s.find("{", start)
        if i < 0:
            break
        try:
            obj, _end = dec.raw_decode(s, i)
        except json.JSONDecodeError:
            start = i + 1
            continue
        if isinstance(obj, dict) and isinstance(obj.get("passed"), bool):
            r = obj.get("reason", "")
            if not isinstance(r, str):
                r = str(r) if r is not None else ""
            return (bool(obj["passed"]), r.strip())
        start = i + 1
    return None


def _normalize_qwen_review_output(raw: str) -> tuple[str, bool, bool]:
    """
    Prefer structured JSON verdict; else keep legacy PASS:/FAIL: heuristics.
    Returns (reason_text_for_storage, passed_when_no_done_cmd, used_json_verdict).
    """
    stripped = (raw or "").strip()
    parsed = _parse_review_json(stripped)
    if parsed is not None:
        passed, reason = parsed
        tag = "PASS" if passed else "FAIL"
        body = reason if reason else ("ok" if passed else "rejected")
        return f"{tag}: {body}", passed, True
    base = stripped if stripped else "No reviewer output"
    return base, _parse_qwen_review_pass(base), False


def _line_verdict(line: str) -> bool | None:
    """First explicit PASS: or FAIL: on a line (markdown/list-tolerant). None = no verdict on this line."""
    s = line.strip()
    if not s:
        return None
    s = re.sub(r"^[\s#*>`\-]+", "", s)
    s = re.sub(r"^\d+\.\s*", "", s)
    if s.startswith("**"):
        s = s[2:]
    if s.endswith("**"):
        s = s[:-2]
    s = s.strip()
    if re.match(r"(?i)FAIL\s*:", s):
        return False
    if re.match(r"(?i)PASS\s*:", s):
        return True
    return None


def _parse_qwen_review_pass(text: str) -> bool:
    """
    Qwen often writes intermediate FAIL: in reasoning and a final PASS: at the end.
    Use the last line with explicit PASS:/FAIL: (not the first). Regex fallback: last PASS: vs last FAIL: via rfind.
    If no PASS:/FAIL:, compare last prose keyword hits (tests passed / failed, exit codes, etc.).
    """
    if not (text or "").strip():
        return False
    last_line_verdict: bool | None = None
    for line in text.splitlines():
        v = _line_verdict(line)
        if v is not None:
            last_line_verdict = v
    if last_line_verdict is not None:
        return last_line_verdict
    last_p = text.rfind("PASS:")
    last_f = text.rfind("FAIL:")
    if last_p != -1 or last_f != -1:
        return last_p > last_f and last_p != -1
    keywords_pass = [
        "все тесты прошли",
        "all tests passed",
        "exit 0",
        "passed",
        "✅",
        "зелёные",
        "успешно",
    ]
    keywords_fail = [
        "failed",
        "ошибк",
        "падени",
        "exit 1",
        "❌",
    ]
    low = text.lower()
    last_kw_pass = -1
    for kw in keywords_pass:
        pos = text.rfind(kw) if kw == "✅" else low.rfind(kw.lower())
        if pos > last_kw_pass:
            last_kw_pass = pos
    last_kw_fail = -1
    for kw in keywords_fail:
        pos = text.rfind(kw) if kw == "❌" else low.rfind(kw)
        if pos > last_kw_fail:
            last_kw_fail = pos
    if last_kw_pass == -1 and last_kw_fail == -1:
        return text.lstrip().upper().startswith("PASS")
    return last_kw_pass > last_kw_fail


def _git_diff(project: Path) -> str:
    proc = subprocess.run(
        ["git", "diff", "HEAD~1"],
        cwd=project,
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
        **SUBPROCESS_TEXT,
    )
    return (proc.stdout or "") if proc.returncode == 0 else ""


def _git_diff_range(project: Path, base_ref: str | None) -> str:
    br = (base_ref or "").strip()
    if br:
        proc = subprocess.run(
            ["git", "diff", f"{br}..HEAD"],
            cwd=project,
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
            **SUBPROCESS_TEXT,
        )
        if proc.returncode == 0:
            return proc.stdout or ""
    return _git_diff(project)


def scope_derived_expected_files(scope: list[Any]) -> list[str]:
    out: list[str] = []
    for raw in scope or []:
        s = str(raw).strip()
        if not s:
            continue
        line = s.split("—")[0].strip().split("–")[0].strip()
        if not line:
            continue
        tok = line.split()[0]
        if "/" in tok or tok.endswith(
            (".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".yaml", ".yml", ".md", ".py", ".rs", ".go")
        ):
            out.append(tok.replace("\\", "/").lstrip("/"))
    return out


def expected_files_for_atom(atom: dict[str, Any]) -> list[str]:
    ef = atom.get("expected_files")
    if isinstance(ef, list) and ef:
        return [str(x).strip().replace("\\", "/").lstrip("/") for x in ef if str(x).strip()]
    return scope_derived_expected_files(atom.get("scope") or [])


def _resolved_file_in_project(project: Path, rel: str) -> Path | None:
    rel = rel.replace("\\", "/").strip().lstrip("/")
    if not rel or ".." in rel.split("/"):
        return None
    try:
        cand = (project / rel).resolve()
        cand.relative_to(project.resolve())
    except Exception:
        return None
    return cand if cand.is_file() else None


def check_files_in_diff(diff_text: str, rel_paths: list[str]) -> bool:
    if not rel_paths:
        return True
    for rel in rel_paths:
        posix = rel.replace("\\", "/")
        if posix in diff_text:
            continue
        if f"b/{posix}" in diff_text or f"a/{posix}" in diff_text:
            continue
        if f"diff --git a/{posix}" in diff_text:
            continue
        return False
    return True


def semantic_export_match(project: Path, atom: dict[str, Any]) -> bool:
    ex = atom.get("expected_exports")
    if not isinstance(ex, list) or not ex:
        return True
    ef = expected_files_for_atom(atom)
    if not ef:
        return True
    target = _resolved_file_in_project(project, ef[0])
    if target is None:
        return False
    try:
        text = target.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False
    for name in ex:
        if str(name) not in text:
            return False
    return True


def append_review_mismatch_record(project: Path, atom: dict[str, Any], reason: str) -> None:
    try:
        from forge.common import atomic_write_yaml, now_iso
    except ImportError:  # pragma: no cover
        from common import atomic_write_yaml, now_iso

    meta = project / ".osnova" / "meta"
    meta.mkdir(parents=True, exist_ok=True)
    path = meta / "review-mismatches.yaml"
    data: Any
    data = {}
    if path.is_file():
        try:
            import yaml as _yaml

            data = _yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        except Exception:
            data = {}
    if not isinstance(data, dict):
        data = {}
    items = data.get("items")
    if not isinstance(items, list):
        items = []
    items.append(
        {
            "ts": now_iso(),
            "atm_id": str(atom.get("id") or ""),
            "epic": str(atom.get("epic") or ""),
            "reason": reason[:4000],
        }
    )
    data["items"] = items[-300:]
    atomic_write_yaml(path, data)


def _qwen_review_timeout() -> int:
    raw = os.environ.get("FORGE_QWEN_REVIEW_TIMEOUT", "").strip()
    if raw.isdigit():
        return max(30, int(raw))
    return 300


def _qwen_review_use_stdin() -> bool:
    """Pass prompt on stdin (-p -) so Windows does not hit ~8191-char CreateProcess limit."""
    v = os.environ.get("FORGE_QWEN_REVIEW_USE_STDIN", "1").strip().lower()
    return v not in ("0", "false", "no")


def _run_qwen_review_subprocess(prompt: str, rev_s: int) -> subprocess.CompletedProcess[str]:
    """Same pattern as atomizer: argv stays short; body goes via stdin when enabled."""
    exe = resolve_executable(env_paths()["QWENBIN"])
    if os.environ.get("FORGE_QWEN_LEGACY_RUN", "").strip().lower() in ("1", "true", "yes"):
        return subprocess.run(
            [exe, "run", prompt],
            capture_output=True,
            text=True,
            timeout=rev_s,
            check=False,
            **SUBPROCESS_TEXT,
        )
    if _qwen_review_use_stdin():
        argv = [exe, "--yolo"]
        model = os.environ.get("FORGE_QWEN_MODEL", "").strip()
        if model:
            argv.extend(["--model", model])
        argv.extend(["-p", "-"])
        return subprocess.run(
            argv,
            input=prompt,
            capture_output=True,
            text=True,
            timeout=rev_s,
            check=False,
            **SUBPROCESS_TEXT,
        )
    return subprocess.run(
        qwen_headless_argv(prompt),
        capture_output=True,
        text=True,
        timeout=rev_s,
        check=False,
        **SUBPROCESS_TEXT,
    )


def run_atom_done_subprocess(
    atom: dict[str, Any],
    *,
    timeout_s: int = 900,
) -> subprocess.CompletedProcess[str] | None:
    """
    Запускает ``atom["done"]`` так же, как в :func:`review` (env, Windows npm/vitest).
    ``None``, если ``done`` пустой.
    """
    project = Path(env_paths()["OSNOVA_PROJECT"])
    done_cmd = str(atom.get("done", "")).strip()
    if not done_cmd:
        return None
    done_cmd = done_cmd.replace(" && ", " ; ") if sys.platform == "win32" else done_cmd
    cmd_eff, done_env = _prepare_done_invocation(project, done_cmd)
    log_cmd = " ".join(cmd_eff) if isinstance(cmd_eff, list) else cmd_eff
    LOG.info(
        "reviewer: running ATM done-command (up to %ss): %s",
        timeout_s,
        log_cmd[:500] + ("…" if len(log_cmd) > 500 else ""),
    )
    cwd = str(project.resolve())
    if isinstance(cmd_eff, list):
        return subprocess.run(
            cmd_eff,
            cwd=cwd,
            shell=False,
            timeout=timeout_s,
            check=False,
            env=done_env,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            **SUBPROCESS_TEXT,
        )
    return subprocess.run(
        cmd_eff,
        cwd=cwd,
        shell=True,
        timeout=timeout_s,
        check=False,
        env=done_env,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        **SUBPROCESS_TEXT,
    )


def _qwen_review(
    atom: dict[str, Any], diff: str
) -> tuple[str, bool, bool]:
    """
    Returns (reason_text, need_done_fallback, passed_when_no_done_cmd).

    When the atom has a ``done`` command, :func:`review` uses exit code for ``passed``; the third
    value is ignored then. If there is no ``done`` command, ``passed`` comes from the third value
    (Qwen parse via :func:`_parse_qwen_review_pass`), except error paths where it is False.

    need_done_fallback=True: локальный лимит forge или ответ API «quota» — при успешном done можно авто-PASS.
    """
    if not can_call():
        LOG.warning(
            "reviewer: forge Qwen daily budget exhausted — skipping LLM (set FORGE_QWEN_DAILY_LIMIT or wait next day)",
        )
        try:
            from forge import humanlog as _hl

            _hl.hlog("qwen_quota", detail="локальный дневной лимит forge (не ответ API)")
        except Exception:
            pass
        return "FAIL: forge Qwen daily budget exhausted (local)", True, False

    prompt = (
        "You are a code-review gate for an automated forge pipeline. "
        "Your reply MUST be machine-readable JSON only.\n\n"
        "Hard rules:\n"
        "- Output a single JSON object and nothing else: no markdown fences, no preamble, "
        "no lines like \"I will analyze\" / \"Проанализирую\" / thinking out loud before the JSON.\n"
        '- Schema exactly: {"passed": <true or false>, "reason": "<one short sentence>"}\n'
        "- passed=true if the diff adequately addresses the goal and respects scope; false otherwise.\n"
        "- reason: concise justification (any language).\n\n"
        f"Goal: {atom.get('goal')}\nScope: {atom.get('scope')}\n"
        f"Done command: {atom.get('done')}\nDiff:\n{diff}\n"
    )
    rev_s = _qwen_review_timeout()
    try:
        proc = _run_qwen_review_subprocess(prompt, rev_s)
    except TimeoutExpired:
        record(served=True)
        return f"FAIL: qwen review timeout after {rev_s}s (FORGE_QWEN_REVIEW_TIMEOUT)", False, False
    out = proc.stdout or ""
    err = proc.stderr or ""
    combined = f"{out}\n{err}"
    if is_quota_exhausted_output(combined):
        kind, excerpt = log_remote_qwen_limit(
            "reviewer",
            combined,
            ref=str(atom.get("id") or ""),
        )
        try:
            from forge import humanlog as _hl

            _hl.hlog(
                "qwen_quota",
                detail=f"API {kind} — {excerpt[:320]}",
            )
        except Exception:
            pass
        return combined.strip() or "FAIL: Qwen quota exceeded", True, False

    record(served=True)
    raw_qwen_output = combined.strip()
    try:
        reason_full, qwen_pass_no_done, used_json = _normalize_qwen_review_output(raw_qwen_output)
    except Exception:
        LOG.exception("reviewer: _normalize_qwen_review_output crashed (ATM %s)", atom.get("id"))
        reason_full = raw_qwen_output if raw_qwen_output else "No reviewer output"
        qwen_pass_no_done = _parse_qwen_review_pass(raw_qwen_output)
        used_json = False
    if not used_json and raw_qwen_output:
        LOG.debug(
            "reviewer: Qwen reply was not valid JSON verdict — used PASS:/FAIL: fallback (ATM %s)",
            atom.get("id"),
        )
    LOG.debug("reviewer verdict (used if atom has no done-cmd): passed=%s", qwen_pass_no_done)
    return reason_full, False, qwen_pass_no_done


def review(
    atom: dict[str, Any],
    dry_run: bool = False,
    *,
    run_done: bool = True,
    skip_done_command: bool = False,
) -> tuple[bool, str, int, str | None]:
    start = time.time()
    project = Path(env_paths()["OSNOVA_PROJECT"])
    if dry_run:
        return True, "dry-run: reviewer skipped", 0, None
    if not run_done:
        LOG.info(
            "reviewer: skipping LLM + done-cmd — executor report was not OK (avoids long Qwen + broken vitest)"
        )
        elapsed = int(time.time() - start)
        return False, "FAIL: executor BLK — reviewer skipped", elapsed, None

    base_sha = atom.get("review_base_sha")
    base_s = base_sha.strip() if isinstance(base_sha, str) else None
    diff = _git_diff_range(project, base_s)

    llm_reason = "FAIL: reviewer not run"
    need_done_fallback = False
    qwen_pass_no_done = False
    try:
        llm_reason, need_done_fallback, qwen_pass_no_done = _qwen_review(atom, diff)
    except Exception:
        LOG.exception(
            "reviewer: unexpected error during diff or Qwen review (ATM %s)",
            atom.get("id"),
        )
        llm_reason = "FAIL: reviewer internal error (see forge.reviewer.log)"
        need_done_fallback = False
        qwen_pass_no_done = False

    done_cmd = str(atom.get("done", "")).strip()
    done_cmd = done_cmd.replace(" && ", " ; ") if sys.platform == "win32" else done_cmd
    if not done_cmd:
        elapsed = int(time.time() - start)
        passed_no_done = False if need_done_fallback else qwen_pass_no_done
        return passed_no_done, _stored_review_reason(llm_reason), elapsed, None

    expected = expected_files_for_atom(atom)

    if skip_done_command:
        LOG.info(
            "reviewer: skip_done_command — not re-running ATM done (Qwen Code agent already ran it; FORGE_REVIEWER_SKIP_DONE_AFTER_QWEN)"
        )
        if need_done_fallback:
            passed = True
            reason = (
                "PASS: Qwen review unavailable (quota/budget); auto-approved with skip_done "
                "(agent was expected to run done)."
            )
            LOG.warning("reviewer: %s", reason)
        else:
            passed = _parse_qwen_review_pass(llm_reason)
            reason = llm_reason if passed else f"{llm_reason}; FAIL on diff review (done not re-run)"
        elapsed = int(time.time() - start)
        aid = str(atom.get("id") or "")
        if expected and passed:
            missing = [f for f in expected if _resolved_file_in_project(project, f) is None]
            if missing:
                return (
                    False,
                    _stored_review_reason(f"FAIL: expected files missing: {missing}"),
                    elapsed,
                    None,
                )
            if not check_files_in_diff(diff, expected):
                LOG.warning(
                    "reviewer: skip_done — expected files not in git diff but LLM gate passed; "
                    "skipping diff-range gate (artifact present) [ATM %s]",
                    atom.get("id"),
                )
        try:
            from forge import humanlog as _hl

            if passed:
                _hl.hlog("review_pass", atm_id=aid, elapsed_s=elapsed)
            else:
                _hl.hlog("review_fail", atm_id=aid, reason=(reason or ""), elapsed_s=elapsed)
        except Exception:
            pass
        return passed, _stored_review_reason(reason), elapsed, None

    done = run_atom_done_subprocess(atom, timeout_s=900)
    if done is None:
        elapsed = int(time.time() - start)
        return False, "FAIL: internal reviewer error (empty done after check)", elapsed, None
    try:
        from forge.humanlog import hlog_tests_run_from_output

        hlog_tests_run_from_output(done.stdout or "", done.stderr or "")
    except Exception:
        pass
    cmd_passed = done.returncode == 0

    if expected and not skip_done_command:
        missing = [f for f in expected if _resolved_file_in_project(project, f) is None]
        if missing:
            elapsed = int(time.time() - start)
            return (
                False,
                _stored_review_reason(f"FAIL: expected files missing: {missing}"),
                elapsed,
                None,
            )
        if not cmd_passed:
            elapsed = int(time.time() - start)
            reason = f"{llm_reason}; done command failed: {done.returncode}"
            return False, _stored_review_reason(reason), elapsed, None
        if not semantic_export_match(project, atom):
            elapsed = int(time.time() - start)
            return (
                False,
                _stored_review_reason("FAIL: expected_exports not found in artifact"),
                elapsed,
                None,
            )
        if not check_files_in_diff(diff, expected):
            # Reached only when cmd_passed (we return above if done failed).
            LOG.warning(
                "reviewer: expected files not in git diff but done-command passed; "
                "skipping diff-range gate (artifact present; possible pre-existing code or diff base) [ATM %s]",
                atom.get("id"),
            )
        skip_qwen_ms = os.environ.get("FORGE_REVIEWER_MULTISIG_SKIP_QWEN", "1").strip().lower() not in (
            "0",
            "false",
            "no",
        )
        if skip_qwen_ms:
            elapsed = int(time.time() - start)
            aid = str(atom.get("id") or "")
            try:
                from forge import humanlog as _hl

                _hl.hlog("review_pass", atm_id=aid, elapsed_s=elapsed)
            except Exception:
                pass
            return True, "PASS: multi-signal (artifact + done + diff range)", elapsed, None

    if not cmd_passed:
        passed = False
    elif need_done_fallback:
        passed = True
        llm_reason = (
            "PASS: Qwen review unavailable (quota/budget); auto-approved because done-command exited 0."
        )
        LOG.warning("reviewer: %s", llm_reason)
    else:
        passed = cmd_passed
        _hint = _parse_qwen_review_pass(llm_reason)
        LOG.debug(
            "reviewer done exit=0; passed follows exit code; _parse_qwen_review_pass (informational)=%s",
            _hint,
        )
    reason = llm_reason if done.returncode == 0 else f"{llm_reason}; done command failed: {done.returncode}"
    elapsed = int(time.time() - start)
    aid = str(atom.get("id") or "")
    if done_cmd and done.returncode == 0:
        try:
            from forge import humanlog as _hl

            if need_done_fallback:
                _hl.hlog(
                    "review_skip",
                    atm_id=aid,
                    reason="квота Qwen или лимит forge",
                )
            elif passed:
                _hl.hlog("review_pass", atm_id=aid, elapsed_s=elapsed)
            else:
                _hl.hlog(
                    "review_fail",
                    atm_id=aid,
                    reason=(llm_reason or ""),
                    elapsed_s=elapsed,
                )
        except Exception:
            pass
    LOG.debug("reviewer passed=%s reason_head=%s", passed, (reason[:100] if reason else ""))
    return passed, _stored_review_reason(reason), elapsed, None


def main() -> None:
    LOG.info("reviewer module ready")


if __name__ == "__main__":
    main()

