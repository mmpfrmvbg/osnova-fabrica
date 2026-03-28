"""Deps from the LLM atomizer are often seq numbers; they must match ATM ids for build_waves."""

import unittest

from forge.atomizer import _normalize_atoms
from forge.parallel_executor import build_waves


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


if __name__ == "__main__":
    unittest.main()
