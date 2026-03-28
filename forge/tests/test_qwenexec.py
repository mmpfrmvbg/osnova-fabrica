"""qwenexec: JSON result parsing and BLK mapping (stdlib unittest)."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch


class TestQwenCodeArgv(unittest.TestCase):
    def test_argv_uses_dash_p_for_headless_by_default(self) -> None:
        from forge import qwenexec as qe

        argv = qe._qwen_code_argv("hello world")
        self.assertGreaterEqual(len(argv), 4)
        self.assertEqual(argv[1], "-p")
        self.assertEqual(argv[2], "hello world")
        self.assertIn("--output-format", argv)
        self.assertIn("json", argv)

    def test_argv_positional_when_env_positional(self) -> None:
        from forge import qwenexec as qe

        with patch.dict("os.environ", {"FORGE_QWEN_CODE_PROMPT_VIA": "positional"}):
            argv = qe._qwen_code_argv("hi")
        self.assertEqual(argv[1], "hi")
        self.assertNotEqual(argv[2], "-p")


class TestParseResultEvent(unittest.TestCase):
    def test_ndjson_last_result_wins(self) -> None:
        from forge import qwenexec as qe

        stdout = (
            json.dumps({"type": "log", "msg": "x"})
            + "\n"
            + json.dumps({"type": "result", "is_error": False, "stats": {"files": {"totalLinesAdded": 3, "totalLinesRemoved": 1}}})
        )
        r = qe._parse_result_event(stdout)
        self.assertIsNotNone(r)
        assert r is not None
        self.assertEqual(r.get("type"), "result")
        self.assertFalse(r.get("is_error"))

    def test_files_delta(self) -> None:
        from forge import qwenexec as qe

        r = {"stats": {"files": {"totalLinesAdded": 2, "totalLinesRemoved": 5}}}
        self.assertEqual(qe._files_delta(r), 7)


class TestRunAtomMocked(unittest.TestCase):
    def test_ok_when_result_ok_and_lines(self) -> None:
        from forge import qwenexec as qe

        out = json.dumps(
            {
                "type": "result",
                "is_error": False,
                "stats": {"files": {"totalLinesAdded": 1, "totalLinesRemoved": 0}},
            }
        )
        atom = {"id": "ATM-1", "goal": "g", "scope": ["a.ts"], "steps": [], "done": "true", "notouch": []}

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

            def _paths() -> dict[str, str]:
                return fake_env

            mock_proc = MagicMock(returncode=0, stdout=out + "\n", stderr="")

            with (
                patch.object(qe, "env_paths", _paths),
                patch.object(qe, "can_call_executor", return_value=True),
                patch.object(qe, "record", return_value={}),
                patch("forge.qwenexec.subprocess.run", return_value=mock_proc),
            ):
                ok, rep = qe.run_atom(atom, dry_run=False)
        self.assertTrue(ok)
        self.assertEqual(rep.get("s"), "OK")
        self.assertTrue(rep.get("reviewer_skip_done"))

    def test_blk_no_result_retries_cursor(self) -> None:
        from forge import qwenexec as qe

        atom = {"id": "ATM-1", "goal": "g", "scope": [], "steps": [], "done": "true", "notouch": []}

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

            def _paths() -> dict[str, str]:
                return fake_env

            mock_proc = MagicMock(returncode=0, stdout="not json\n", stderr="")

            with (
                patch.object(qe, "env_paths", _paths),
                patch.object(qe, "can_call_executor", return_value=True),
                patch.object(qe, "record", return_value={}),
                patch("forge.qwenexec.subprocess.run", return_value=mock_proc),
            ):
                ok, rep = qe.run_atom(atom, dry_run=False)
        self.assertFalse(ok)
        self.assertEqual(rep.get("s"), "BLK")
        self.assertEqual(rep.get("forge_retry_executor"), "cursor")


if __name__ == "__main__":
    unittest.main()
