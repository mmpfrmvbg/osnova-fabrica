from __future__ import annotations

import os
from typing import Any, Callable

try:
    from forge.common import setup_logging
except ImportError:  # pragma: no cover
    from common import setup_logging

LOG = setup_logging("parallel_executor")

MAX_PARALLEL = int(os.environ.get("OSNOVA_MAX_PARALLEL", "3"))


def _scopes(a: dict[str, Any]) -> set[str]:
    return {str(x) for x in (a.get("scope") or []) if x is not None}


def scope_conflicts_safe(a1: dict[str, Any], a2: dict[str, Any]) -> bool:
    s1, s2 = _scopes(a1), _scopes(a2)
    if not s1 or not s2:
        return False
    return bool(s1 & s2)


def build_waves(atoms: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """Topological waves by deps; inside wave, cap width with scope conflicts (v5.2)."""
    done_ids: set[str] = set()
    remaining = list(atoms)
    waves: list[list[dict[str, Any]]] = []

    while remaining:
        ready = [a for a in remaining if all(str(d) in done_ids for d in (a.get("deps") or []))]
        if not ready:
            LOG.warning("Unresolved ATM deps — running remaining sequentially")
            waves.append(list(remaining))
            break

        wave_group: list[dict[str, Any]] = []
        for atom in ready:
            conflict = any(scope_conflicts_safe(atom, a) for a in wave_group)
            if not conflict and len(wave_group) < MAX_PARALLEL:
                wave_group.append(atom)
        if not wave_group:
            wave_group = [ready[0]]

        waves.append(wave_group)
        for a in wave_group:
            done_ids.add(str(a["id"]))
            remaining.remove(a)

    return waves


def run_waves_sequential(
    waves: list[list[dict[str, Any]]],
    run_one: Callable[[dict[str, Any]], None],
) -> None:
    """Execute each wave: atoms run sequentially (single git worktree)."""
    for i, wave in enumerate(waves):
        LOG.info("Wave %s/%s: %s", i + 1, len(waves), [a.get("id") for a in wave])
        for atom in wave:
            run_one(atom)


def main() -> None:
    sample = [{"id": "a", "deps": [], "scope": ["x"]}, {"id": "b", "deps": ["a"], "scope": ["y"]}]
    LOG.info("waves=%s", [[x["id"] for x in w] for w in build_waves(sample)])


if __name__ == "__main__":
    main()
