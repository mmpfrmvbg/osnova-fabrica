"""state_epic_tail: recent, last_scopes, ci.passrate7d from history."""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

import yaml

from forge.brain_context import build_brain_context
from forge.common import atomic_write_yaml, load_yaml, now_iso
from forge.retrospective import finalize_epic
from forge.state_epic_tail import (
    backfill_state_tail_from_history,
    collect_epic_scope_paths,
    compute_passrate_7d_from_history,
    recent_result_label,
)


class TestStateEpicTail(unittest.TestCase):
    def test_recent_result_label(self) -> None:
        self.assertEqual(recent_result_label(3, 3), "ok")
        self.assertEqual(recent_result_label(0, 3), "retry-exhausted")
        self.assertEqual(recent_result_label(1, 3), "partial")

    def test_scope_from_epic_yaml(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            epic = {
                "id": "EPK-T",
                "scope": ["src/a.ts", "src/b.ts"],
            }
            self.assertEqual(collect_epic_scope_paths(root, epic), ["src/a.ts", "src/b.ts"])

    def test_passrate_7d_from_history(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            h = root / ".osnova" / "history"
            h.mkdir(parents=True)
            atomic_write_yaml(
                h / "x.yaml",
                {
                    "summary": {"passrate": 0.8},
                    "createdat": now_iso(),
                },
            )
            atomic_write_yaml(
                h / "y.yaml",
                {
                    "summary": {"passrate": 0.6},
                    "createdat": now_iso(),
                },
            )
            pr = compute_passrate_7d_from_history(root)
            self.assertIsNotNone(pr)
            assert pr is not None
            self.assertAlmostEqual(pr, 0.7, places=5)

    def test_finalize_updates_recent_and_ci(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            osn = root / ".osnova"
            osn.mkdir(parents=True)
            (osn / "history").mkdir(parents=True)
            (osn / "meta").mkdir(parents=True)
            state = {
                "v": 5,
                "sessionstats": {
                    "epicsreceived": 0,
                    "epicsdone": 0,
                    "epicsblocked": 0,
                    "atomstotal": 0,
                    "atomsdone": 0,
                    "atomsblocked": 0,
                    "passrate": 0.0,
                },
                "ci": {"lastrun": None, "laststatus": None, "passrate7d": None},
                "recent": [],
                "blockers": [],
            }
            atomic_write_yaml(osn / "state.yaml", state)
            epic = {
                "id": "EPK-UNIT",
                "scope": ["src/z.ts"],
                "goal": "t",
                "done": "true",
            }
            results = [{"id": "A1", "s": "OK"}]
            prev = os.environ.get("OSNOVA_PROJECT")
            try:
                os.environ["OSNOVA_PROJECT"] = str(root)
                finalize_epic(epic, results, dry_run=True, skip_session_stats=False)
            finally:
                if prev is None:
                    os.environ.pop("OSNOVA_PROJECT", None)
                else:
                    os.environ["OSNOVA_PROJECT"] = prev
            st = load_yaml(osn / "state.yaml", default={}) or {}
            recent = st.get("recent") or []
            self.assertTrue(recent)
            self.assertEqual(recent[0].get("epic"), "EPK-UNIT")
            self.assertEqual(recent[0].get("scope"), ["src/z.ts"])
            self.assertEqual(recent[0].get("result"), "ok")
            self.assertIsInstance(st.get("last_scopes"), list)
            self.assertEqual(st["last_scopes"][0], ["src/z.ts"])
            ci = st.get("ci") or {}
            self.assertIn("lastrun", ci)
            self.assertEqual(ci.get("laststatus"), "ok")
            self.assertIsNotNone(ci.get("passrate7d"))

    def test_backfill_from_history(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            osn = root / ".osnova"
            h = osn / "history"
            h.mkdir(parents=True)
            ed = osn / "epics"
            ed.mkdir(parents=True)
            atomic_write_yaml(
                ed / "EPK-A.yaml",
                {"id": "EPK-A", "scope": ["src/x.ts"], "goal": "g", "done": "true"},
            )
            atomic_write_yaml(
                h / "t1.yaml",
                {
                    "epic": "EPK-A",
                    "summary": {
                        "status": "OK",
                        "passrate": 1.0,
                        "atomsdone": 1,
                        "atomstotal": 1,
                    },
                    "createdat": "2026-03-29T12:00:00+00:00",
                },
            )
            atomic_write_yaml(osn / "state.yaml", {"v": 1, "ci": {}, "recent": []})
            backfill_state_tail_from_history(root)
            st = load_yaml(osn / "state.yaml", default={}) or {}
            self.assertEqual(len(st.get("recent") or []), 1)
            self.assertEqual(st["recent"][0]["epic"], "EPK-A")
            self.assertEqual(st["last_scopes"], [["src/x.ts"]])
            self.assertEqual(st["ci"].get("laststatus"), "ok")

    def test_build_brain_context_uses_ci_passrate7d(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            osn = root / ".osnova"
            osn.mkdir(parents=True)
            atomic_write_yaml(
                osn / "state.yaml",
                {
                    "sessionstats": {"passrate": 0.11},
                    "ci": {"passrate7d": 0.88, "laststatus": "ok"},
                    "recent": [],
                    "blockers": [],
                },
            )
            ctx = build_brain_context(root)
            self.assertAlmostEqual(float(ctx.get("passrate") or 0), 0.88)
            self.assertEqual(ctx.get("passrate_source"), "ci.passrate7d")


if __name__ == "__main__":
    unittest.main()
