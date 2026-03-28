"""Tests for Qwen daily budget + reviewer quota fallback (stdlib unittest, no pytest)."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import yaml


class TestQuotaDetection(unittest.TestCase):
    def test_is_quota_exhausted_output_detects_api_messages(self) -> None:
        from forge.qwenbudget import is_quota_exhausted_output

        self.assertTrue(is_quota_exhausted_output("Error: quota exceeded for your account"))
        self.assertTrue(is_quota_exhausted_output("HTTP 429 Too Many Requests"))
        self.assertFalse(is_quota_exhausted_output("PASS: looks good"))
        self.assertFalse(is_quota_exhausted_output(""))


class TestRecordAndStateYaml(unittest.TestCase):
    def test_record_increments_json_and_state_yaml(self) -> None:
        from forge import qwenbudget as qb

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            forge_d = root / "forge"
            proj = root / "proj"
            forge_d.mkdir()
            (proj / ".osnova").mkdir(parents=True)

            def _paths() -> dict[str, str]:
                return {
                    "OSNOVA_FORGE": str(forge_d),
                    "OSNOVA_PROJECT": str(proj),
                    "GHREPO": "o/r",
                    "GH_TOKEN": "",
                    "QWENBIN": "qwen",
                    "CURSORBIN": "agent",
                }

            with patch.object(qb, "env_paths", _paths), patch.object(qb, "effective_limit", lambda: 100):
                qb.maybe_reset()
                st = qb.record(served=True)
                self.assertEqual(int(st["used"]), 1)

                data = json.loads((forge_d / "qwen-budget.json").read_text(encoding="utf-8"))
                self.assertEqual(data["used"], 1)

                sy = yaml.safe_load((proj / ".osnova" / "state.yaml").read_text(encoding="utf-8"))
                self.assertEqual(sy["budget"]["qwenusedtoday"], 1)
                self.assertEqual(sy["budget"]["qwenlimit"], 100)

    def test_record_skips_increment_when_not_served(self) -> None:
        from forge import qwenbudget as qb

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            forge_d = root / "forge"
            proj = root / "proj"
            forge_d.mkdir()
            (proj / ".osnova").mkdir(parents=True)

            def _paths() -> dict[str, str]:
                return {
                    "OSNOVA_FORGE": str(forge_d),
                    "OSNOVA_PROJECT": str(proj),
                    "GHREPO": "o/r",
                    "GH_TOKEN": "",
                    "QWENBIN": "qwen",
                    "CURSORBIN": "agent",
                }

            with patch.object(qb, "env_paths", _paths), patch.object(qb, "effective_limit", lambda: 100):
                qb.maybe_reset()
                qb.record(served=True)
                self.assertEqual(
                    json.loads((forge_d / "qwen-budget.json").read_text(encoding="utf-8"))["used"],
                    1,
                )
                qb.record(served=False)
                data = json.loads((forge_d / "qwen-budget.json").read_text(encoding="utf-8"))
                self.assertEqual(data["used"], 1)


class TestReviewerQuotaFallback(unittest.TestCase):
    def test_auto_pass_when_quota_fallback_and_done_ok(self) -> None:
        from forge import reviewer

        atom = {"id": "ATM-1", "goal": "g", "scope": [], "done": "echo ok"}
        with tempfile.TemporaryDirectory() as td:
            proj = Path(td)
            fake_env = {
                "OSNOVA_PROJECT": str(proj),
                "OSNOVA_FORGE": str(proj / "forge"),
                "GHREPO": "o/r",
                "GH_TOKEN": "",
                "QWENBIN": "qwen",
                "CURSORBIN": "agent",
            }
            with (
                patch.object(reviewer, "env_paths", return_value=fake_env),
                patch.object(reviewer, "_git_diff", return_value=""),
                patch.object(
                    reviewer,
                    "_qwen_review",
                    return_value=(False, "API said quota exceeded", True),
                ),
                patch.object(
                    reviewer, "_prepare_done_invocation", return_value=(["cmd", "/c", "echo", "x"], {})
                ),
                patch("forge.reviewer.subprocess.run") as mock_run,
            ):
                mock_run.return_value = MagicMock(returncode=0)
                ok, reason, elapsed = reviewer.review(atom, dry_run=False, run_done=True)
        self.assertTrue(ok)
        self.assertIn("auto-approved", reason)
        self.assertGreaterEqual(elapsed, 0)

    def test_fail_when_llm_fail_and_no_fallback(self) -> None:
        from forge import reviewer

        atom = {"id": "ATM-1", "goal": "g", "scope": [], "done": "echo ok"}
        with tempfile.TemporaryDirectory() as td:
            proj = Path(td)
            fake_env = {
                "OSNOVA_PROJECT": str(proj),
                "OSNOVA_FORGE": str(proj / "forge"),
                "GHREPO": "o/r",
                "GH_TOKEN": "",
                "QWENBIN": "qwen",
                "CURSORBIN": "agent",
            }
            with (
                patch.object(reviewer, "env_paths", return_value=fake_env),
                patch.object(reviewer, "_git_diff", return_value=""),
                patch.object(
                    reviewer,
                    "_qwen_review",
                    return_value=(False, "no PASS line here", False),
                ),
                patch.object(
                    reviewer, "_prepare_done_invocation", return_value=(["cmd", "/c", "echo", "x"], {})
                ),
                patch("forge.reviewer.subprocess.run") as mock_run,
            ):
                mock_run.return_value = MagicMock(returncode=0)
                ok, reason, elapsed = reviewer.review(atom, dry_run=False, run_done=True)
        self.assertFalse(ok)


if __name__ == "__main__":
    unittest.main()
