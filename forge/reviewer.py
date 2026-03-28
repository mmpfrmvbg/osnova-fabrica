from __future__ import annotations

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
    Build shell command + env for atom `done` checks. On Windows, harden Vitest when spawned
    from Forge (avoid empty suites / wrong npx resolution / inherited NODE_OPTIONS).
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

    if "npx vitest run" in cmd and "--pool=forks" not in cmd:
        cmd = cmd.replace(
            "npx vitest run",
            "npx vitest run --pool=forks --no-file-parallelism --no-isolate",
        )

    mjs = (project / "node_modules" / "vitest" / "vitest.mjs").resolve()
    if mjs.is_file() and "npx vitest" in cmd:
        cmd = cmd.replace("npx vitest", f'node "{mjs}"')

    if "--no-isolate" not in cmd and "run --pool=forks --no-file-parallelism" in cmd:
        cmd = cmd.replace(
            "run --pool=forks --no-file-parallelism",
            "run --pool=forks --no-file-parallelism --no-isolate",
        )

    return cmd, done_env


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


def _qwen_review(
    atom: dict[str, Any], diff: str
) -> tuple[bool, str, bool]:
    """
    Returns (llm_pass, reason, need_done_fallback).
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
        return False, "FAIL: forge Qwen daily budget exhausted (local)", True

    prompt = (
        "Review ATM result. You MUST include either PASS: or FAIL: (with colon). "
        "Put PASS: or FAIL: at the start of a line — not only at the end of a long paragraph.\n"
        f"Goal: {atom.get('goal')}\nScope: {atom.get('scope')}\n"
        f"Done command: {atom.get('done')}\nDiff:\n{diff}\n"
        "Последняя строка твоего ответа ДОЛЖНА быть ровно одним из двух вариантов:\n"
        "PASS: <одна фраза причина>\n"
        "FAIL: <одна фраза причина>\n"
        "Никакого текста после этой строки.\n"
    )
    rev_s = _qwen_review_timeout()
    try:
        proc = _run_qwen_review_subprocess(prompt, rev_s)
    except TimeoutExpired:
        record(served=True)
        return False, f"FAIL: qwen review timeout after {rev_s}s (FORGE_QWEN_REVIEW_TIMEOUT)", False
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
        return False, combined.strip() or "FAIL: Qwen quota exceeded", True

    record(served=True)
    text = combined.strip()
    passed = _parse_qwen_review_pass(text)
    reason = text if text else "No reviewer output"
    return passed, reason, False


def review(
    atom: dict[str, Any],
    dry_run: bool = False,
    *,
    run_done: bool = True,
) -> tuple[bool, str, int]:
    start = time.time()
    project = Path(env_paths()["OSNOVA_PROJECT"])
    if dry_run:
        return True, "dry-run: reviewer skipped", 0
    if not run_done:
        LOG.info(
            "reviewer: skipping LLM + done-cmd — executor report was not OK (avoids long Qwen + broken vitest)"
        )
        elapsed = int(time.time() - start)
        return False, "FAIL: executor BLK — reviewer skipped", elapsed
    diff = _git_diff(project)
    llm_pass, llm_reason, need_done_fallback = _qwen_review(atom, diff)
    done_cmd = str(atom.get("done", "")).strip()
    done_cmd = done_cmd.replace(" && ", " ; ") if sys.platform == "win32" else done_cmd
    if not done_cmd:
        elapsed = int(time.time() - start)
        return llm_pass, llm_reason, elapsed
    cmd_eff, done_env = _prepare_done_invocation(project, done_cmd)
    log_cmd = " ".join(cmd_eff) if isinstance(cmd_eff, list) else cmd_eff
    LOG.info(
        "reviewer: running ATM done-command (up to 900s, no log until finish): %s",
        log_cmd[:500] + ("…" if len(log_cmd) > 500 else ""),
    )
    cwd = str(project.resolve())
    if isinstance(cmd_eff, list):
        done = subprocess.run(
            cmd_eff,
            cwd=cwd,
            shell=False,
            timeout=900,
            check=False,
            env=done_env,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            **SUBPROCESS_TEXT,
        )
    else:
        done = subprocess.run(
            cmd_eff,
            cwd=cwd,
            shell=True,
            timeout=900,
            check=False,
            env=done_env,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            **SUBPROCESS_TEXT,
        )
    try:
        from forge.humanlog import hlog_tests_run_from_output

        hlog_tests_run_from_output(done.stdout or "", done.stderr or "")
    except Exception:
        pass
    if done.returncode != 0:
        passed = False
    elif need_done_fallback:
        passed = True
        llm_reason = (
            "PASS: Qwen review unavailable (quota/budget); auto-approved because done-command exited 0."
        )
        LOG.warning("reviewer: %s", llm_reason)
    else:
        passed = llm_pass
        if not llm_pass:
            LOG.warning(
                "reviewer: done command succeeded but LLM verdict was not PASS — "
                "check Qwen output (expect PASS: or FAIL: on a line). Head: %s",
                (llm_reason[:900] + "…") if len(llm_reason) > 900 else llm_reason,
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
                    reason=(llm_reason or "")[:80],
                    elapsed_s=elapsed,
                )
        except Exception:
            pass
    LOG.debug("reviewer passed=%s reason_head=%s", passed, (reason[:100] if reason else ""))
    return passed, reason, elapsed


def main() -> None:
    LOG.info("reviewer module ready")


if __name__ == "__main__":
    main()

