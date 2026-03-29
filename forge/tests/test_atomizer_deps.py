"""Deps from the LLM atomizer are often seq numbers; they must match ATM ids for parallel_executor."""

from __future__ import annotations

import unittest
from typing import Any

from forge.atomizer import _coerce_dep_to_atm_id, _normalize_atoms
from forge.parallel_executor import build_waves, waves_from_epic_override

_EPIC = "EPK-260328-015"
_KNOWN = {f"ATM-{_EPIC}-{i:03d}" for i in range(1, 6)}


class TestAtomizerDepsNormalization(unittest.TestCase):
    def test_numeric_deps_become_atm_ids_and_waves_resolve(self) -> None:
        epic = {
            "id": "EPK-X",
            "done": "true",
            "zone": "lang",
            "risk": "LOW",
        }
        raw = [
            {"seq": 1, "goal": "a", "scope": [], "notouch": [], "steps": [], "deps": []},
            {"seq": 2, "goal": "b", "scope": [], "notouch": [], "steps": [], "deps": [1]},
            {"seq": 3, "goal": "c", "scope": [], "notouch": [], "steps": [], "deps": ["2"]},
        ]
        atoms = _normalize_atoms(epic, raw)
        self.assertEqual(atoms[1]["deps"], ["ATM-EPK-X-001"])
        self.assertEqual(atoms[2]["deps"], ["ATM-EPK-X-002"])
        waves = build_waves(sorted(atoms, key=lambda x: int(x.get("seq", 0))))
        self.assertEqual(len(waves), 3, msg=[[a.get("id") for a in w] for w in waves])

    def test_coerce_dep_formats_for_build_waves(self) -> None:
        """int, str digits, full ATM id, epic-seq without ATM-, last-epic-segment-seq shorthand."""
        want1 = f"ATM-{_EPIC}-001"
        cases: list[tuple[Any, str]] = [
            (1, want1),
            ("1", want1),
            (want1, want1),
            (f"{_EPIC}-001", want1),
            ("015-001", want1),
        ]
        for raw, expected in cases:
            got = _coerce_dep_to_atm_id(raw, _EPIC, _KNOWN)
            self.assertEqual(got, expected, msg=f"raw={raw!r} epic={_EPIC!r}")

    def test_mixed_formats_linear_chain_and_waves(self) -> None:
        epic = {"id": _EPIC, "done": "true", "zone": "lang", "risk": "LOW"}
        full1 = f"ATM-{_EPIC}-001"
        raw = [
            {"seq": 1, "goal": "a", "scope": [], "notouch": [], "steps": [], "deps": []},
            {
                "seq": 2,
                "goal": "b",
                "scope": [],
                "notouch": [],
                "steps": [],
                "deps": [full1, "015-001"],
            },
            {
                "seq": 3,
                "goal": "c",
                "scope": [],
                "notouch": [],
                "steps": [],
                # int 2 and epic-002 without ATM- (duplicate refs to ATM-002)
                "deps": [2, f"{_EPIC}-002"],
            },
        ]
        atoms = _normalize_atoms(epic, raw)
        self.assertEqual(atoms[1]["deps"], [full1])
        self.assertEqual(atoms[2]["deps"], [f"ATM-{_EPIC}-002"])
        waves = build_waves(sorted(atoms, key=lambda x: int(x.get("seq", 0))))
        self.assertEqual(len(waves), 3)

    def test_epic_waves_field_overrides_deps(self) -> None:
        """Explicit epic['waves'] fixes order; deps need not define a DAG."""
        epic = {
            "id": _EPIC,
            "done": "true",
            "zone": "lang",
            "risk": "LOW",
            "waves": [
                [1, 2],
                [3, 4, 5],
            ],
        }
        raw = [
            {"seq": i, "goal": f"g{i}", "scope": [], "notouch": [], "steps": [], "deps": []}
            for i in range(1, 6)
        ]
        atoms = _normalize_atoms(epic, raw)
        for a in atoms:
            a["deps"] = ["ATM-nonexistent"]
        got = waves_from_epic_override(epic, sorted(atoms, key=lambda x: int(x.get("seq", 0))))
        assert got is not None
        self.assertEqual([[x["id"] for x in w] for w in got], [[f"ATM-{_EPIC}-001", f"ATM-{_EPIC}-002"], [f"ATM-{_EPIC}-00{i}" for i in (3, 4, 5)]])


if __name__ == "__main__":
    unittest.main()
