"""
Git worktree helpers: prune stale entries after crashes (Forge parallel waves).
"""
from __future__ import annotations

import subprocess
from pathlib import Path

try:
    from forge.common import SUBPROCESS_TEXT, setup_logging
except ImportError:  # pragma: no cover
    from common import SUBPROCESS_TEXT, setup_logging

LOG = setup_logging("worktree_manager")


def _git_run(project: Path, argv: list[str], *, timeout: int = 120) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *argv],
        cwd=project,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
        **SUBPROCESS_TEXT,
    )


def cleanup_stale_worktrees(project: Path | str) -> None:
    """``git worktree prune`` on repo root (removes stale admin files; does not remove locked dirs)."""
    root = Path(project).resolve()
    proc = _git_run(root, ["worktree", "prune"], timeout=60)
    if proc.returncode != 0:
        LOG.warning(
            "worktree_manager: git worktree prune failed: %s",
            (proc.stderr or proc.stdout or "").strip()[:200],
        )
    else:
        LOG.debug("worktree_manager: git worktree prune ok")
