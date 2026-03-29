"""qwenexec: JSON result parsing and BLK mapping (stdlib unittest)."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch


class TestQwenCodeInvocation(unittest.TestCase):
    def test_dash_p_approval_mode_and_prompt_in_argv(self) -> None:
        from forge import qwenexec as qe

        with patch.object(qe, "forge_dotenv_setting", return_value="dash_p"):
            argv, stdin_payload, via = qe._qwen_code_invocation("hello world")
        self.assertIsNone(stdin_payload)
        self.assertEqual(via, "dash_p")
        self.assertEqual(argv[1], "-p")
        self.assertEqual(argv[2], "hello world")
        self.assertIn("--approval-mode", argv)
        self.assertIn("--output-format", argv)
        self.assertNotIn("--yolo", argv)

    def test_stdin_mode_no_prompt_in_argv(self) -> None:
        from forge import qwenexec as qe

        with patch.object(qe, "forge_dotenv_setting", return_value="stdin"):
            argv, stdin_payload, via = qe._qwen_code_invocation("hi\nthere")
        self.assertEqual(stdin_payload, "hi\nthere")
        self.assertEqual(via, "stdin")
        self.assertEqual(argv[1], "--approval-mode")
        self.assertNotIn("-p", argv)
        self.assertNotIn("--yolo", argv)
        self.assertNotIn("hi", argv)

    def test_positional_debug_mode(self) -> None:
        from forge import qwenexec as qe

        with patch.object(qe, "forge_dotenv_setting", return_value="positional"):
            argv, stdin_payload, _via = qe._qwen_code_invocation("hi")
        self.assertIsNone(stdin_payload)
        self.assertEqual(argv[1], "hi")

    def test_max_session_turns_override(self) -> None:
        from forge import qwenexec as qe

        with patch.object(qe, "forge_dotenv_setting", return_value="stdin"):
            argv, _, _ = qe._qwen_code_invocation("x", max_session_turns="77")
        i = argv.index("--max-session-turns")
        self.assertEqual(argv[i + 1], "77")


class TestFatalTurnLimit(unittest.TestCase):
    def test_exit_53(self) -> None:
        from forge import qwenexec as qe

        self.assertTrue(qe._is_fatal_turn_limit_error("", 53))

    def test_json_error_line(self) -> None:
        from forge import qwenexec as qe

        line = '{"error": {"type": "FatalTurnLimitedError", "code": 53}}'
        self.assertTrue(qe._is_fatal_turn_limit_error(line + "\n", 1))

    def test_not_turn_limit(self) -> None:
        from forge import qwenexec as qe

        self.assertFalse(qe._is_fatal_turn_limit_error("hello", 1))


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
        self.assertEqual(rep.get("changed"), [])

    def test_ok_zero_line_delta_when_done_exits_zero(self) -> None:
        from forge import qwenexec as qe

        out = json.dumps(
            {
                "type": "result",
                "is_error": False,
                "stats": {"files": {"totalLinesAdded": 0, "totalLinesRemoved": 0}},
            }
        )
        atom = {"id": "ATM-1", "goal": "g", "scope": ["a.ts"], "steps": [], "done": "true", "notouch": []}
        mock_qwen = MagicMock(returncode=0, stdout=out + "\n", stderr="")
        mock_done = MagicMock(returncode=0, stdout="", stderr="")

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

            with (
                patch.object(qe, "env_paths", _paths),
                patch.object(qe, "can_call_executor", return_value=True),
                patch.object(qe, "record", return_value={}),
                patch("forge.qwenexec.subprocess.run", return_value=mock_qwen),
                patch("forge.reviewer.run_atom_done_subprocess", return_value=mock_done),
            ):
                ok, rep = qe.run_atom(atom, dry_run=False)
        self.assertTrue(ok)
        self.assertEqual(rep.get("s"), "OK")
        self.assertTrue((rep.get("qwen_result") or {}).get("zero_line_delta_done_verified"))
        self.assertEqual(rep.get("changed"), [])

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

    def test_turn_limit_retries_once_then_ok(self) -> None:
        from forge import qwenexec as qe

        ok_json = json.dumps(
            {
                "type": "result",
                "is_error": False,
                "stats": {"files": {"totalLinesAdded": 1, "totalLinesRemoved": 0}},
            }
        )
        lim_json = json.dumps({"error": {"type": "FatalTurnLimitedError", "code": 53}})
        mock_lim = MagicMock(returncode=1, stdout=lim_json, stderr="")
        mock_ok = MagicMock(returncode=0, stdout=ok_json + "\n", stderr="")
        calls = {"n": 0}

        def side_effect(*_a: object, **_k: object) -> MagicMock:
            calls["n"] += 1
            return mock_lim if calls["n"] == 1 else mock_ok

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

            record_mock = MagicMock()

            with (
                patch.object(qe, "env_paths", _paths),
                patch.object(qe, "can_call_executor", return_value=True),
                patch.object(qe, "record", record_mock),
                patch("forge.qwenexec.subprocess.run", side_effect=side_effect),
            ):
                ok, rep = qe.run_atom(atom, dry_run=False)
        self.assertTrue(ok)
        self.assertEqual(rep.get("s"), "OK")
        self.assertEqual(calls["n"], 2)
        record_mock.assert_called_once_with(served=True, role="executor")


if __name__ == "__main__":
    unittest.main()
