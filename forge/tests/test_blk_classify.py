"""Tests for forge/blk_classify.py."""

from __future__ import annotations

import unittest


class TestClassifyBlk(unittest.TestCase):
    def test_review_failure_is_permanent(self) -> None:
        from forge.blk_classify import classify_blk

        self.assertEqual(
            classify_blk(
                exec_report_ok=True,
                review_passed=False,
                report={"s": "BLK", "err": "", "review": {"reason": "bad code"}},
            ),
            "permanent",
        )

    def test_executor_timeout_transient(self) -> None:
        from forge.blk_classify import classify_blk

        self.assertEqual(
            classify_blk(
                exec_report_ok=False,
                review_passed=False,
                report={"s": "BLK", "err": "connection refused to api"},
            ),
            "transient",
        )

    def test_executor_blk_unknown_permanent(self) -> None:
        from forge.blk_classify import classify_blk

        self.assertEqual(
            classify_blk(
                exec_report_ok=False,
                review_passed=False,
                report={"s": "BLK", "err": "syntax error in file"},
            ),
            "permanent",
        )

    def test_executor_fatal_turn_limit_transient(self) -> None:
        from forge.blk_classify import classify_blk

        self.assertEqual(
            classify_blk(
                exec_report_ok=False,
                review_passed=False,
                report={
                    "s": "BLK",
                    "err": "qwen code FatalTurnLimitedError (code 53) after retry with higher max-session-turns",
                },
            ),
            "transient",
        )

    def test_transient_patterns_nonempty(self) -> None:
        from forge.blk_classify import TRANSIENT_SUBSTRINGS

        self.assertGreaterEqual(len(TRANSIENT_SUBSTRINGS), 5)


if __name__ == "__main__":
    unittest.main()
