"""Resolve default `done` command for ATM fix / verify."""
from __future__ import annotations

from typing import Any


def get_done_cmd(atm: dict[str, Any], state: dict[str, Any]) -> str:
    """Prefer ATM `done`, then state.testcommands.unit, then npm test."""
    d = atm.get("done")
    if d is not None and str(d).strip():
        return str(d).strip()
    tc = state.get("testcommands") if isinstance(state.get("testcommands"), dict) else {}
    unit = tc.get("unit")
    if unit is not None and str(unit).strip():
        return str(unit).strip()
    return "npm test"
