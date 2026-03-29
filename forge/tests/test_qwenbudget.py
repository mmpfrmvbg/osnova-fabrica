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


class TestClassifyQwenApiLimit(unittest.TestCase):
    def test_classify_reason_codes_and_phrases(self) -> None:
        from forge.qwenbudget import classify_qwen_api_limit

        self.assertEqual(
            classify_qwen_api_limit('{"error":{"reason":"QuotaExceeded","code":429}}'),
            "quota_exceeded",
        )
        self.assertEqual(
            classify_qwen_api_limit("HTTP 429 reason=RateLimit retry after 60s"),
            "rate_limit",
        )
        self.assertEqual(
            classify_qwen_api_limit("Error: rate limit exceeded for requests per minute"),
            "rate_limit",
        )
        self.assertEqual(
            classify_qwen_api_limit("HTTP 429 Too Many Requests"),
            "rate_limit",
        )
        self.assertEqual(
            classify_qwen_api_limit('{"httpStatus":429}'),
            "unknown_limit",
        )

    def test_format_qwen_limit_for_log_truncates(self) -> None:
        from forge.qwenbudget import format_qwen_limit_for_log

        long = "x" * 2000
        out = format_qwen_limit_for_log(long, max_chars=100)
        self.assertIn(" … ", out)
        self.assertEqual(len(out), 100)

        prefix = '{"error":"QuotaExceeded"}'
        huge = prefix + " " + ("y" * 5000)
        out2 = format_qwen_limit_for_log(huge, max_chars=200)
        self.assertIn("QuotaExceeded", out2)


class TestWarnApproachingLimit(unittest.TestCase):
    def test_warn_logs_when_over_threshold(self) -> None:
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

            with patch.object(qb, "env_paths", _paths):
                qb.maybe_reset()
                st = qb._migrate_legacy_state(qb._state())  # type: ignore[attr-defined]
                st["used_executor"] = 900
                st["limit_executor"] = 1000
                st["used_atomizer"] = 0
                st["limit_atomizer"] = 200
                qb.atomic_write_json(qb._path(), st)  # type: ignore[attr-defined]
                qb._warn_last.clear()  # type: ignore[attr-defined]
                with self.assertLogs("forge.qwenbudget", level="WARNING") as cm:
                    qb.warn_if_approaching_limit(threshold=0.85, min_interval_s=0.0)
                self.assertTrue(any("executor" in x for x in cm.output))


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

            with patch.object(qb, "env_paths", _paths), patch.object(qb, "effective_limit_executor", lambda: 100):
                qb.maybe_reset()
                st = qb.record(served=True, role="executor")
                self.assertEqual(int(st["used_executor"]), 1)

                data = json.loads((forge_d / "qwen-budget.json").read_text(encoding="utf-8"))
                self.assertEqual(data["used_executor"], 1)

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

            with patch.object(qb, "env_paths", _paths), patch.object(qb, "effective_limit_executor", lambda: 100):
                qb.maybe_reset()
                qb.record(served=True, role="executor")
                self.assertEqual(
                    json.loads((forge_d / "qwen-budget.json").read_text(encoding="utf-8"))["used_executor"],
                    1,
                )
                qb.record(served=False)
                data = json.loads((forge_d / "qwen-budget.json").read_text(encoding="utf-8"))
                self.assertEqual(data["used_executor"], 1)


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
                patch.object(reviewer, "_git_diff_range", return_value=""),
                patch.object(reviewer, "_git_diff_for_review", return_value=""),
                patch.object(
                    reviewer,
                    "_qwen_review",
                    return_value=("API said quota exceeded", True, False),
                ),
                patch.object(
                    reviewer, "_prepare_done_invocation", return_value=(["cmd", "/c", "echo", "x"], {})
                ),
                patch("forge.reviewer.subprocess.run") as mock_run,
            ):
                mock_run.return_value = MagicMock(returncode=0)
                ok, reason, elapsed, _ver, _meta = reviewer.review(atom, dry_run=False, run_done=True)
        self.assertTrue(ok)
        self.assertIn("auto-approved", reason)
        self.assertGreaterEqual(elapsed, 0)

    def test_pass_when_done_ok_even_if_qwen_text_has_no_pass_line(self) -> None:
        """passed follows done exit code; Qwen text is advisory only when done is set."""
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
                patch.object(reviewer, "_git_diff_range", return_value=""),
                patch.object(reviewer, "_git_diff_for_review", return_value=""),
                patch.object(
                    reviewer,
                    "_qwen_review",
                    return_value=("no PASS line here", False, False),
                ),
                patch.object(
                    reviewer, "_prepare_done_invocation", return_value=(["cmd", "/c", "echo", "x"], {})
                ),
                patch("forge.reviewer.subprocess.run") as mock_run,
            ):
                mock_run.return_value = MagicMock(returncode=0)
                ok, reason, elapsed, _ver, _meta = reviewer.review(atom, dry_run=False, run_done=True)
        self.assertTrue(ok)

    def test_fail_when_done_command_nonzero(self) -> None:
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
                patch.object(reviewer, "_git_diff_range", return_value=""),
                patch.object(reviewer, "_git_diff_for_review", return_value=""),
                patch.object(
                    reviewer,
                    "_qwen_review",
                    return_value=("would parse PASS", False, True),
                ),
                patch.object(
                    reviewer, "_prepare_done_invocation", return_value=(["cmd", "/c", "echo", "x"], {})
                ),
                patch("forge.reviewer.subprocess.run") as mock_run,
            ):
                mock_run.return_value = MagicMock(returncode=1)
                ok, reason, elapsed, _ver, _meta = reviewer.review(atom, dry_run=False, run_done=True)
        self.assertFalse(ok)


if __name__ == "__main__":
    unittest.main()
