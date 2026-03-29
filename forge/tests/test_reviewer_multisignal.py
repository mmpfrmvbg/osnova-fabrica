"""Multi-signal reviewer: expected_files, diff range, review_mismatch."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from forge.reviewer import (
    check_files_in_diff,
    expected_files_for_atom,
    scope_derived_expected_files,
)


class TestReviewerMultisignal(unittest.TestCase):
    def test_scope_derives_path_before_em_dash(self) -> None:
        s = scope_derived_expected_files(["scripts/foo.test.ts — описание"])
        self.assertEqual(s, ["scripts/foo.test.ts"])

    def test_expected_files_explicit(self) -> None:
        atom = {"expected_files": ["a/b.ts"], "scope": []}
        self.assertEqual(expected_files_for_atom(atom), ["a/b.ts"])

    def test_check_files_in_diff(self) -> None:
        diff = "diff --git a/scripts/foo.ts b/scripts/foo.ts\n+ok"
        self.assertTrue(check_files_in_diff(diff, ["scripts/foo.ts"]))
        self.assertFalse(check_files_in_diff(diff, ["other.ts"]))

    def test_multisignal_pass_skip_qwen(self) -> None:
        from forge import reviewer

        with tempfile.TemporaryDirectory() as td:
            proj = Path(td)
            (proj / "src" / "x.ts").parent.mkdir(parents=True)
            (proj / "src" / "x.ts").write_text("//x", encoding="utf-8")
            atom = {
                "id": "ATM-1",
                "goal": "g",
                "expected_files": ["src/x.ts"],
                "scope": [],
                "done": "echo ok",
            }
            fake_env = {
                "OSNOVA_PROJECT": str(proj),
                "OSNOVA_FORGE": str(proj / "forge"),
                "GHREPO": "o/r",
                "GH_TOKEN": "",
                "QWENBIN": "qwen",
                "CURSORBIN": "agent",
            }
            diff_text = "diff --git a/src/x.ts b/src/x.ts\n+x"
            with (
                patch.object(reviewer, "env_paths", return_value=fake_env),
                patch.object(reviewer, "_git_diff_for_review", return_value=diff_text),
                patch.object(reviewer, "_paths_changed_since_base", return_value=True),
                patch.object(
                    reviewer,
                    "_qwen_review",
                    return_value=("PASS: json", False, True),
                ),
                patch.object(
                    reviewer, "_prepare_done_invocation", return_value=(["cmd", "/c", "echo", "x"], {})
                ),
                patch("forge.reviewer.subprocess.run") as mock_run,
            ):
                mock_run.return_value = MagicMock(returncode=0)
                ok, reason, elapsed, ver, meta = reviewer.review(atom, dry_run=False, run_done=True)
            self.assertTrue(ok)
            self.assertIsNone(ver)
            self.assertIn("multi-signal", reason)
            self.assertEqual(meta.get("skip_reason"), None)
            self.assertTrue(meta.get("scope_lines_changed"))

    def test_multisignal_pre_existing_when_no_scope_git_change_but_done_ok(self) -> None:
        """Done passes but git shows no edits in scope vs base → explicit pre_existing (not silent OK)."""
        from forge import reviewer

        with tempfile.TemporaryDirectory() as td:
            proj = Path(td)
            (proj / "src" / "x.ts").parent.mkdir(parents=True)
            (proj / "src" / "x.ts").write_text("//x", encoding="utf-8")
            atom = {
                "id": "ATM-1",
                "goal": "g",
                "expected_files": ["src/x.ts"],
                "scope": [],
                "done": "echo ok",
                "review_base_sha": "deadbeef",
            }
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
                patch.object(reviewer, "_git_diff_for_review", return_value=""),
                patch.object(reviewer, "_paths_changed_since_base", return_value=False),
                patch.object(
                    reviewer,
                    "_qwen_review",
                    return_value=("PASS: json", False, True),
                ),
                patch.object(
                    reviewer, "_prepare_done_invocation", return_value=(["cmd", "/c", "echo", "x"], {})
                ),
                patch("forge.reviewer.subprocess.run") as mock_run,
            ):
                mock_run.return_value = MagicMock(returncode=0)
                ok, reason, _elapsed, ver, meta = reviewer.review(atom, dry_run=False, run_done=True)
            self.assertTrue(ok)
            self.assertIsNone(ver)
            self.assertIn("pre_existing", reason)
            self.assertEqual(meta.get("skip_reason"), "pre_existing")
            self.assertFalse(meta.get("scope_lines_changed"))


if __name__ == "__main__":
    unittest.main()
