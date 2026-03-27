from __future__ import annotations

import subprocess
import time
from pathlib import Path
from typing import Any

try:
    from forge.common import env_paths, resolve_executable, setup_logging
except ImportError:  # pragma: no cover
    from common import env_paths, resolve_executable, setup_logging

LOG = setup_logging("reviewer")


def _git_diff(project: Path) -> str:
    proc = subprocess.run(
        ["git", "diff", "HEAD~1"],
        cwd=project,
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    return proc.stdout if proc.returncode == 0 else ""


def _qwen_review(atom: dict[str, Any], diff: str) -> tuple[bool, str]:
    prompt = (
        "Review ATM result. Return one line: PASS: reason OR FAIL: reason.\n"
        f"Goal: {atom.get('goal')}\nScope: {atom.get('scope')}\n"
        f"Done command: {atom.get('done')}\nDiff:\n{diff}\n"
    )
    proc = subprocess.run(
        [resolve_executable(env_paths()["QWENBIN"]), "run", prompt],
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    text = (proc.stdout or proc.stderr).strip()
    passed = text.upper().startswith("PASS")
    reason = text if text else "No reviewer output"
    return passed, reason


def review(atom: dict[str, Any], dry_run: bool = False) -> tuple[bool, str, int]:
    start = time.time()
    project = Path(env_paths()["OSNOVA_PROJECT"])
    if dry_run:
        return True, "dry-run: reviewer skipped", 0
    diff = _git_diff(project)
    llm_pass, llm_reason = _qwen_review(atom, diff)
    done_cmd = str(atom.get("done", "")).strip()
    if not done_cmd:
        elapsed = int(time.time() - start)
        return llm_pass, llm_reason, elapsed
    done = subprocess.run(done_cmd, cwd=project, shell=True, timeout=900, check=False)
    passed = llm_pass and done.returncode == 0
    reason = llm_reason if done.returncode == 0 else f"{llm_reason}; done command failed: {done.returncode}"
    elapsed = int(time.time() - start)
    return passed, reason, elapsed


def main() -> None:
    LOG.info("reviewer module ready")


if __name__ == "__main__":
    main()

