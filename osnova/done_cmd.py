"""Resolve `done` command for ATM fix / verify."""
from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml


def read_done_from_epic_atm_file(repo_root: Path, epic_id: str, atm_id: str) -> str | None:
    """
    Load `done` from .osnova/epics/<EPK>/<ATM>.yaml.
    History RPT rows usually omit `done`; it lives on the ATM spec file.
    """
    epic_id = (epic_id or "").strip()
    atm_id = (atm_id or "").strip()
    if not epic_id or not atm_id:
        return None
    p = repo_root / ".osnova" / "epics" / epic_id / f"{atm_id}.yaml"
    if not p.is_file():
        return None
    try:
        data = yaml.safe_load(p.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return None
        d = data.get("done")
        if d is not None and str(d).strip():
            return str(d).strip()
    except (OSError, yaml.YAMLError):
        return None
    return None


def resolve_done_cmd(
    atm: dict[str, Any],
    state: dict[str, Any],
    *,
    epic_id: str | None = None,
    repo_root: Path | None = None,
) -> str:
    """
    Order: ATM dict `done` (if present in normalized history) → epic ATM yaml →
    state.testcommands.unit → npm test.
    """
    d = atm.get("done")
    if d is not None and str(d).strip():
        return str(d).strip()

    aid = str(atm.get("id") or "").strip()
    if epic_id and aid and repo_root is not None:
        from_epic = read_done_from_epic_atm_file(repo_root, epic_id, aid)
        if from_epic:
            return from_epic

    tc = state.get("testcommands") if isinstance(state.get("testcommands"), dict) else {}
    unit = tc.get("unit")
    if unit is not None and str(unit).strip():
        return str(unit).strip()
    return "npm test"


def get_done_cmd(atm: dict[str, Any], state: dict[str, Any]) -> str:
    """Backward-compatible: resolve without epic (falls back to testcommands / npm test)."""
    return resolve_done_cmd(atm, state)
