"""Validate file path tokens in ATM ``done`` shell commands."""

from __future__ import annotations

import shlex
from pathlib import Path

_CODE_SUFFIXES = frozenset(
    {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".mts", ".cts"},
)


def check_done_cmd_paths(done_cmd: str, cwd: Path) -> list[str]:
    """
    Parse ``done_cmd``, extract path arguments with code-like suffixes,
    return paths that do not exist relative to ``cwd`` (or absolute paths missing on disk).
    """
    if not (done_cmd or "").strip():
        return []
    try:
        tokens = shlex.split(done_cmd, posix=False)
    except ValueError:
        tokens = done_cmd.split()
    missing: list[str] = []
    for token in tokens:
        token = token.strip().strip('"').strip("'")
        if not token or token.startswith("-"):
            continue
        p = Path(token)
        if p.suffix.lower() not in _CODE_SUFFIXES:
            continue
        full = p if p.is_absolute() else (cwd / p)
        if not full.exists():
            missing.append(token)
    return missing
