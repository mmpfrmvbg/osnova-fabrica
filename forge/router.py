from __future__ import annotations

from pathlib import Path
from typing import Any

try:
    from forge.common import env_paths, load_yaml, setup_logging
    from forge.degradation import resolve_executor
except ImportError:  # pragma: no cover
    from common import env_paths, load_yaml, setup_logging
    from degradation import resolve_executor

LOG = setup_logging("router")


def _scope_text(atom: dict[str, Any]) -> str:
    scope = atom.get("scope", [])
    if isinstance(scope, str):
        return scope
    return "\n".join(str(s) for s in scope)


def choose_executor(atom: dict[str, Any], avail: dict[str, Any]) -> str:
    raw_ex = atom.get("executor")
    if raw_ex is not None and str(raw_ex).strip():
        e = str(raw_ex).strip().lower()
        if e in ("cursor", "qwen"):
            atom["executor"] = e
            return resolve_executor(atom, avail)

    scope = _scope_text(atom)
    risk = str(atom.get("risk", "")).upper()
    zone = str(atom.get("zone", "")).lower()
    priority = str(atom.get("priority", "")).upper()

    # Default: Qwen Code executor. Cursor smith: P0, HIGH, GitHub workflows, infra.
    chosen = "qwen"
    if priority == "P0" or risk == "HIGH":
        chosen = "cursor"
    elif ".github/" in scope or ".github/workflows" in scope:
        chosen = "cursor"
    elif zone == "infra":
        chosen = "cursor"
    atom["executor"] = chosen
    return resolve_executor(atom, avail)


def load_rules() -> dict[str, Any]:
    p = Path(env_paths()["OSNOVA_FORGE"]) / "router.yaml"
    return load_yaml(p, default={}) or {}


def main() -> None:
    LOG.info("router rules loaded: %s", bool(load_rules()))


if __name__ == "__main__":
    main()

