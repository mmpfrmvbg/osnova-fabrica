"""courier: git add path filtering."""

from __future__ import annotations

import unittest


class TestPathsForGitAdd(unittest.TestCase):
    def test_filters_line_placeholder(self) -> None:
        from forge.courier import paths_for_git_add

        self.assertEqual(paths_for_git_add(["~60 lines", "src/foo.ts"]), ["src/foo.ts"])

    def test_all_placeholders_means_empty(self) -> None:
        from forge.courier import paths_for_git_add

        self.assertEqual(paths_for_git_add(["~2 lines"]), [])

    def test_case_insensitive(self) -> None:
        from forge.courier import paths_for_git_add

        self.assertEqual(paths_for_git_add(["~10 LINES"]), [])


if __name__ == "__main__":
    unittest.main()
