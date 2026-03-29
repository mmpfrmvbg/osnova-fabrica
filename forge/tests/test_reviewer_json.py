"""Structured JSON verdict parsing for forge.reviewer."""

from __future__ import annotations

import unittest

from forge.reviewer import _normalize_qwen_review_output, _parse_review_json


class TestReviewerJson(unittest.TestCase):
    def test_parse_json_only(self) -> None:
        got = _parse_review_json('{"passed": true, "reason": "ok"}')
        assert got is not None
        self.assertTrue(got[0])
        self.assertEqual(got[1], "ok")

    def test_parse_json_false(self) -> None:
        got = _parse_review_json('{"passed": false, "reason": "broken"}')
        assert got is not None
        self.assertFalse(got[0])
        self.assertEqual(got[1], "broken")

    def test_parse_after_preamble_russian(self) -> None:
        text = 'Проанализирую дифф...\n{"passed": true, "reason": "всё ок"}'
        got = _parse_review_json(text)
        assert got is not None
        self.assertTrue(got[0])
        self.assertIn("ок", got[1])

    def test_parse_markdown_fence(self) -> None:
        text = '```json\n{"passed": false, "reason": "nope"}\n```'
        got = _parse_review_json(text)
        assert got is not None
        self.assertFalse(got[0])

    def test_normalize_prefers_json(self) -> None:
        reason, passed, used = _normalize_qwen_review_output('{"passed": true, "reason": "x"}')
        self.assertTrue(used)
        self.assertTrue(passed)
        self.assertTrue(reason.startswith("PASS:"))

    def test_normalize_fallback_pass_line(self) -> None:
        reason, passed, used = _normalize_qwen_review_output("Some text\nPASS: legacy")
        self.assertFalse(used)
        self.assertTrue(passed)
        self.assertIn("legacy", reason)


if __name__ == "__main__":
    unittest.main()
