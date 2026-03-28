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
except ImportError:  # pragma: no cover
    from common import (
        SUBPROCESS_TEXT,
        env_paths,
        qwen_headless_argv,
        resolve_executable,
        setup_logging,
    )

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
    Qwen often returns prose before PASS:/FAIL:. Old logic used startswith('PASS') and misclassified those.
    Prefer first line-level PASS:/FAIL:, else first in-text PASS: before FAIL:.
    """
    if not (text or "").strip():
        return False
    for line in text.splitlines():
        v = _line_verdict(line)
        if v is not None:
            return v
    m_fail = re.search(r"(?i)(?:^|[\s;,.])FAIL\s*:", text)
    m_pass = re.search(r"(?i)(?:^|[\s;,.])PASS\s*:", text)
    if m_fail and (not m_pass or m_fail.start() < m_pass.start()):
        return False
    if m_pass:
        return True
    return text.lstrip().upper().startswith("PASS")


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


def _qwen_review(atom: dict[str, Any], diff: str) -> tuple[bool, str]:
    prompt = (
        "Review ATM result. You MUST include either PASS: or FAIL: (with colon). "
        "Put PASS: or FAIL: at the start of a line — not only at the end of a long paragraph.\n"
        f"Goal: {atom.get('goal')}\nScope: {atom.get('scope')}\n"
        f"Done command: {atom.get('done')}\nDiff:\n{diff}\n"
    )
    rev_s = _qwen_review_timeout()
    try:
        proc = _run_qwen_review_subprocess(prompt, rev_s)
    except TimeoutExpired:
        return False, f"FAIL: qwen review timeout after {rev_s}s (FORGE_QWEN_REVIEW_TIMEOUT)"
    text = (proc.stdout or proc.stderr).strip()
    passed = _parse_qwen_review_pass(text)
    reason = text if text else "No reviewer output"
    return passed, reason


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
    llm_pass, llm_reason = _qwen_review(atom, diff)
    done_cmd = str(atom.get("done", "")).strip()
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
        )
    passed = llm_pass and done.returncode == 0
    if done.returncode == 0 and not llm_pass:
        LOG.warning(
            "reviewer: done command succeeded but LLM verdict was not PASS — "
            "check Qwen output (expect PASS: or FAIL: on a line). Head: %s",
            (llm_reason[:900] + "…") if len(llm_reason) > 900 else llm_reason,
        )
    reason = llm_reason if done.returncode == 0 else f"{llm_reason}; done command failed: {done.returncode}"
    elapsed = int(time.time() - start)
    return passed, reason, elapsed


def main() -> None:
    LOG.info("reviewer module ready")


if __name__ == "__main__":
    main()

