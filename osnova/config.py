"""Paths and env: delegate to forge.common.env_paths after loading .env."""
from __future__ import annotations

from pathlib import Path

try:
    from dotenv import load_dotenv
except ImportError:

    def load_dotenv(*_a, **_k) -> None:  # type: ignore[misc]
        pass


from osnova.paths import ensure_forge_imports, repo_root

ensure_forge_imports()

# Optional repo-root .env (forge/common also merges forge/.env)
_env = repo_root() / ".env"
if _env.exists():
    load_dotenv(_env)


def _paths() -> dict[str, str]:
    from forge.common import env_paths

    return env_paths()


def project_dir() -> Path:
    return Path(_paths()["OSNOVA_PROJECT"]).resolve()


def forge_dir() -> Path:
    return Path(_paths()["OSNOVA_FORGE"]).resolve()


def osnova_dir() -> Path:
    return project_dir() / ".osnova"


def forge_state_file() -> Path:
    from forge.common import forge_state_path

    return forge_state_path()


def heartbeat_file() -> Path:
    from forge.common import heartbeat_path

    return heartbeat_path()


def qwen_bin() -> str:
    return _paths().get("QWENBIN", "qwen")


def cursor_bin() -> str:
    return _paths().get("CURSORBIN", "cursor-agent")
