"""Atomizer: engine selection and normalization (mocked subprocess)."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch


def _env(proj: Path, forge_d: Path) -> dict[str, str]:
    return {
        "OSNOVA_PROJECT": str(proj),
        "OSNOVA_FORGE": str(forge_d),
        "GHREPO": "o/r",
        "GH_TOKEN": "",
        "QWENBIN": "qwen",
        "CURSORBIN": "agent",
    }


def _twelve_atm_yaml() -> str:
    lines: list[str] = []
    for i in range(1, 13):
        lines.extend(
            [
                f"- seq: {i}",
                "  zone: lang",
                "  risk: LOW",
                f'  goal: "task {i}"',
                "  scope: [src/a.ts]",
                "  notouch: []",
                "  steps: [s]",
                "  deps: []",
                "  done: npx vitest run src/a.test.ts",
                "  executor: qwen",
            ]
        )
    return "\n".join(lines)


class TestAtomizerEngineQwen(unittest.TestCase):
    def test_qwen_engine_skips_cursor(self) -> None:
        from forge import atomizer as at

        epic = {
            "id": "EPK-1",
            "done": "true",
            "goal": "g",
            "scope": ["src/a.ts"],
            "zone": "lang",
            "risk": "LOW",
        }
        yaml_out = _twelve_atm_yaml()
        mock_proc = MagicMock(returncode=0, stdout=yaml_out, stderr="")

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            forge_d = root / "forge"
            proj = root / "proj"
            forge_d.mkdir()
            (proj / ".osnova").mkdir(parents=True)
            env = _env(proj, forge_d)

            with (
                patch.dict("os.environ", {"FORGE_ATOMIZER_ENGINE": "qwen"}, clear=False),
                patch.object(at, "env_paths", lambda: env),
                patch.object(at, "cursor_cli_available", return_value=True),
                patch.object(at, "can_call_atomizer", return_value=True),
                patch.object(at, "_run_qwen_atomizer", return_value=mock_proc),
                patch.object(at, "record", return_value={}),
            ):
                with patch.object(at, "_run_cursor_atomizer") as mock_cursor:
                    atoms = at.atomize(epic, dry_run=False)
            mock_cursor.assert_not_called()
            self.assertEqual(len(atoms), 12)
            self.assertEqual(atoms[0].get("executor"), "qwen")
            self.assertIn("vitest", str(atoms[0].get("done")))


if __name__ == "__main__":
    unittest.main()
