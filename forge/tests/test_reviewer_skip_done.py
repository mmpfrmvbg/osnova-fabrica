"""Reviewer: skip duplicate done after Qwen Code agent."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


class TestSkipDoneAfterQwen(unittest.TestCase):
    def test_skip_done_command_does_not_run_prepare_or_subprocess(self) -> None:
        from forge import reviewer

        atom = {
            "id": "ATM-1",
            "goal": "g",
            "scope": [],
            "done": "npx vitest run src/a.test.ts",
            "notouch": [],
        }
        with tempfile.TemporaryDirectory() as td:
            proj = Path(td)
            (proj / ".osnova").mkdir(parents=True)
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
                patch.object(reviewer, "_git_diff", return_value="diff"),
                patch.object(reviewer, "_git_diff_range", return_value="diff"),
                patch.object(reviewer, "_git_diff_for_review", return_value="diff"),
                patch.object(
                    reviewer,
                    "_qwen_review",
                    return_value=("PASS: looks good", False, True),
                ),
                patch.object(reviewer, "_prepare_done_invocation") as mock_prep,
                patch("forge.reviewer.subprocess.run") as mock_run,
            ):
                ok, reason, elapsed, _ver, _meta = reviewer.review(
                    atom,
                    dry_run=False,
                    run_done=True,
                    skip_done_command=True,
                )
        mock_prep.assert_not_called()
        mock_run.assert_not_called()
        self.assertTrue(ok)
        self.assertGreaterEqual(elapsed, 0)


if __name__ == "__main__":
    unittest.main()
