"""brain_context: resume, decide, escalation dedup."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import yaml

from forge.brain_context import (
    append_escalation,
    build_brain_context,
    decide_brain_action,
    resume_epic_if_pending,
)


class TestBrainContext(unittest.TestCase):
    def test_resume_when_pending_todo(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ed = root / ".osnova" / "epics"
            ed.mkdir(parents=True)
            epic = {
                "t": "EPK",
                "id": "EPK-T-RESUME",
                "goal": "g",
                "scope": [],
                "done": "true",
                "priority": "P2",
                "githubissue": 99,
            }
            (ed / "EPK-T-RESUME.yaml").write_text(
                yaml.safe_dump(epic, allow_unicode=True),
                encoding="utf-8",
            )
            atm_d = ed / "EPK-T-RESUME"
            atm_d.mkdir(parents=True)
            (atm_d / "ATM-EPK-T-RESUME-001.yaml").write_text(
                yaml.safe_dump(
                    {
                        "id": "ATM-EPK-T-RESUME-001",
                        "epic": "EPK-T-RESUME",
                        "seq": 1,
                        "status": "todo",
                        "goal": "x",
                        "scope": [],
                        "done": "true",
                        "deps": [],
                    },
                    allow_unicode=True,
                ),
                encoding="utf-8",
            )
            got = resume_epic_if_pending(root)
            self.assertIsNotNone(got)
            assert got is not None
            self.assertEqual(got.get("id"), "EPK-T-RESUME")
            self.assertEqual(got.get("githubissue"), 99)

    def test_decide_continue_via_resume(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ed = root / ".osnova" / "epics"
            ed.mkdir(parents=True)
            (ed / "EPK-T2.yaml").write_text(
                yaml.safe_dump(
                    {
                        "t": "EPK",
                        "id": "EPK-T2",
                        "goal": "g",
                        "scope": [],
                        "done": "x",
                        "priority": "P2",
                    },
                    allow_unicode=True,
                ),
                encoding="utf-8",
            )
            atm_dir = ed / "EPK-T2"
            atm_dir.mkdir(parents=True)
            (atm_dir / "ATM-EPK-T2-001.yaml").write_text(
                yaml.safe_dump(
                    {
                        "id": "ATM-EPK-T2-001",
                        "epic": "EPK-T2",
                        "seq": 1,
                        "status": "blk",
                        "retries": 0,
                        "max_retries": 3,
                        "goal": "x",
                        "scope": [],
                        "done": "x",
                        "deps": [],
                    },
                    allow_unicode=True,
                ),
                encoding="utf-8",
            )
            ctx = build_brain_context(root)
            self.assertIsInstance(ctx.get("epics_summary"), list)
            act = decide_brain_action(ctx, project=root)
            self.assertEqual(act.get("decision"), "CONTINUE")

    def test_escalation_dedup(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            append_escalation(root, "review_diff_missing", 5, "a")
            append_escalation(root, "review_diff_missing", 5, "b")
            p = root / ".osnova" / "meta" / "escalations.yaml"
            data = yaml.safe_load(p.read_text(encoding="utf-8"))
            self.assertEqual(len(data.get("items")), 1)


if __name__ == "__main__":
    unittest.main()
