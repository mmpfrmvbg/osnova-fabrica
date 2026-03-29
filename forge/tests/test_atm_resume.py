"""Stateful ATM resume: get_pending_atms, skip atomize digest, mark epic complete."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import yaml

from forge.atm_store import (
    get_pending_atms,
    load_all_atms_from_disk,
    mark_epic_complete_in_state_yaml,
    should_skip_atomize,
    write_atomizer_meta,
)


class TestAtmResume(unittest.TestCase):
    def test_normalize_pending(self) -> None:
        atoms = [
            {"id": "ATM-X-001", "status": "done", "retries": 0},
            {"id": "ATM-X-002", "status": "blk", "retries": 1, "max_retries": 3},
            {"id": "ATM-X-003", "status": "blk", "retries": 3, "max_retries": 3},
            {"id": "ATM-X-004", "status": "todo", "retries": 0},
            {"id": "ATM-X-005", "status": "PENDING", "retries": 0},
            {"id": "ATM-X-006", "status": "review_mismatch", "retries": 0},
        ]
        p = get_pending_atms(atoms)
        ids = {a["id"] for a in p}
        self.assertIn("ATM-X-002", ids)
        self.assertIn("ATM-X-004", ids)
        self.assertIn("ATM-X-005", ids)
        self.assertNotIn("ATM-X-001", ids)
        self.assertNotIn("ATM-X-003", ids)
        self.assertNotIn("ATM-X-006", ids)

    def test_should_skip_atomize_digest(self) -> None:
        epic = {
            "id": "EPK-TEST-001",
            "goal": "g",
            "scope": ["a.ts"],
            "done": "npm test",
        }
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ed = root / ".osnova" / "epics" / "EPK-TEST-001"
            ed.mkdir(parents=True)
            (ed / "ATM-EPK-TEST-001-001.yaml").write_text(
                yaml.safe_dump(
                    {
                        "id": "ATM-EPK-TEST-001-001",
                        "epic": "EPK-TEST-001",
                        "seq": 1,
                        "status": "todo",
                        "goal": "x",
                        "scope": [],
                        "done": "x",
                        "deps": [],
                    },
                    allow_unicode=True,
                ),
                encoding="utf-8",
            )
            write_atomizer_meta(ed, epic)
            self.assertTrue(should_skip_atomize(root, epic))

            epic2 = dict(epic)
            epic2["goal"] = "changed"
            self.assertFalse(should_skip_atomize(root, epic2))

    def test_mark_epic_complete_state_yaml(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            p = root / ".osnova" / "state.yaml"
            p.parent.mkdir(parents=True)
            p.write_text(
                yaml.safe_dump({"v": 5, "currentepic": "EPK-OLD", "epicprogress": {"totalatoms": 5}}),
                encoding="utf-8",
            )
            mark_epic_complete_in_state_yaml(root, "EPK-DONE", all_success=True)
            data = yaml.safe_load(p.read_text(encoding="utf-8"))
            self.assertIsNone(data.get("currentepic"))
            self.assertEqual(data.get("last_completed_epic"), "EPK-DONE")
            self.assertTrue(data.get("last_completed_epic_all_success"))

    def test_load_all_atms_sorts_seq(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ed = root / ".osnova" / "epics" / "EPK-SORT"
            ed.mkdir(parents=True)
            for seq, aid in [(2, "ATM-EPK-SORT-002"), (1, "ATM-EPK-SORT-001")]:
                (ed / f"{aid}.yaml").write_text(
                    yaml.safe_dump(
                        {"id": aid, "epic": "EPK-SORT", "seq": seq, "status": "todo", "deps": []},
                        allow_unicode=True,
                    ),
                    encoding="utf-8",
                )
            lst = load_all_atms_from_disk(root, "EPK-SORT")
            self.assertEqual([a["seq"] for a in lst], [1, 2])


if __name__ == "__main__":
    unittest.main()
