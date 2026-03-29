"""worktree_manager: prune hook."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from forge.worktree_manager import cleanup_stale_worktrees


class TestWorktreeManager(unittest.TestCase):
    def test_cleanup_calls_git_prune(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with patch("forge.worktree_manager.subprocess.run") as mock_run:
                mock_run.return_value.returncode = 0
                cleanup_stale_worktrees(root)
            mock_run.assert_called()
            argv = mock_run.call_args[0][0]
            self.assertIn("worktree", argv)
            self.assertIn("prune", argv)


if __name__ == "__main__":
    unittest.main()
