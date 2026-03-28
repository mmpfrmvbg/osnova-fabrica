"""Resolve repo root and sys.path for `forge` package imports."""
from __future__ import annotations

import os
import sys
from pathlib import Path


def repo_root() -> Path:
    """Directory containing forge/ and .osnova."""
    p = os.environ.get("OSNOVA_PROJECT", "").strip()
    if p:
        return Path(p).expanduser().resolve()
    return Path.cwd().resolve()


def ensure_forge_imports() -> Path:
    """Ensure repository root is on sys.path so `import forge.*` works."""
    root = repo_root()
    s = str(root)
    if s not in sys.path:
        sys.path.insert(0, s)
    return root
