from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path
from subprocess import TimeoutExpired
from typing import Any

try:
    from forge.common import SUBPROCESS_TEXT, env_paths, qwen_headless_argv, setup_logging
except ImportError:  # pragma: no cover
    from common import SUBPROCESS_TEXT, env_paths, qwen_headless_argv, setup_logging

LOG = setup_logging("reviewer")


def _prepare_done_invocation(project: Path, done_cmd: str) -> tuple[str, dict[str, str]]:
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

    if "npx vitest run" in cmd and "--pool=forks" not in cmd:
        cmd = cmd.replace(
            "npx vitest run",
            "npx vitest run --pool=forks --no-file-parallelism",
        )

    mjs = (project / "node_modules" / "vitest" / "vitest.mjs").resolve()
    if mjs.is_file() and "npx vitest" in cmd:
        cmd = cmd.replace("npx vitest", f'node "{mjs}"')

    return cmd, done_env


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


def _qwen_review(atom: dict[str, Any], diff: str) -> tuple[bool, str]:
    prompt = (
        "Review ATM result. Return one line: PASS: reason OR FAIL: reason.\n"
        f"Goal: {atom.get('goal')}\nScope: {atom.get('scope')}\n"
        f"Done command: {atom.get('done')}\nDiff:\n{diff}\n"
    )
    rev_s = _qwen_review_timeout()
    try:
        proc = subprocess.run(
            qwen_headless_argv(prompt),
            capture_output=True,
            text=True,
            timeout=rev_s,
            check=False,
            **SUBPROCESS_TEXT,
        )
    except TimeoutExpired:
        return False, f"FAIL: qwen review timeout after {rev_s}s (FORGE_QWEN_REVIEW_TIMEOUT)"
    text = (proc.stdout or proc.stderr).strip()
    passed = text.upper().startswith("PASS")
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
    LOG.info(
        "reviewer: running ATM done-command (up to 900s, no log until finish): %s",
        cmd_eff[:500] + ("…" if len(cmd_eff) > 500 else ""),
    )
    done = subprocess.run(
        cmd_eff, cwd=project, shell=True, timeout=900, check=False, env=done_env
    )
    passed = llm_pass and done.returncode == 0
    reason = llm_reason if done.returncode == 0 else f"{llm_reason}; done command failed: {done.returncode}"
    elapsed = int(time.time() - start)
    return passed, reason, elapsed


def main() -> None:
    LOG.info("reviewer module ready")


if __name__ == "__main__":
    main()

