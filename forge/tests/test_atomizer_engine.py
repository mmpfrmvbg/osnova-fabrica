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


class TestAtomizerCoerceAndIds(unittest.TestCase):
    def test_coerce_dict_keyed_by_atm_ids(self) -> None:
        from forge import atomizer as at

        data = {
            "ATM-EPK-9-001": {"goal": "a", "scope": ["x.ts"], "zone": "lang", "risk": "LOW"},
            "ATM-EPK-9-002": {"goal": "b", "scope": ["y.ts"], "zone": "lang", "risk": "LOW"},
        }
        lst = at._coerce_atom_list(data)
        self.assertEqual(len(lst), 2)
        self.assertEqual(lst[0].get("id"), "ATM-EPK-9-001")

    def test_coerce_dict_numeric_keys_set_seq(self) -> None:
        from forge import atomizer as at

        data = {
            "1": {"goal": "a", "scope": ["x.ts"], "zone": "lang", "risk": "LOW"},
            "2": {"goal": "b", "scope": ["y.ts"], "zone": "lang", "risk": "LOW"},
        }
        lst = at._coerce_atom_list(data)
        self.assertEqual(lst[0].get("seq"), 1)
        self.assertEqual(lst[1].get("seq"), 2)

    def test_seq_string_as_full_atm_id(self) -> None:
        from forge import atomizer as at

        epic = {
            "id": "EPK-260329-019",
            "done": "npx vitest run x",
            "goal": "g",
            "scope": ["src/a.ts"],
            "zone": "lang",
            "risk": "LOW",
        }
        atoms = at._normalize_atoms(
            epic,
            [{"seq": "ATM-EPK-260329-019-009", "goal": "t", "scope": ["src/a.ts"]}],
        )
        self.assertEqual(atoms[0]["id"], "ATM-EPK-260329-019-009")
        self.assertEqual(atoms[0]["seq"], 9)

    def test_name_alias_for_id(self) -> None:
        from forge import atomizer as at

        epic = {
            "id": "EPK-1",
            "done": "true",
            "goal": "g",
            "scope": ["a.ts"],
            "zone": "lang",
            "risk": "LOW",
        }
        atoms = at._normalize_atoms(
            epic,
            [{"name": "ATM-EPK-1-003", "goal": "t", "scope": ["a.ts"]}],
        )
        self.assertEqual(atoms[0]["id"], "ATM-EPK-1-003")
        self.assertEqual(atoms[0]["seq"], 3)

    def test_epic_id_sanitized_for_cursor_prompt_only(self) -> None:
        from forge import atomizer as at

        epic = {"id": "EPK-260329-019", "goal": "g"}
        cur = at._epic_for_atomizer_prompt(epic, engine="cursor")
        self.assertEqual(cur["id"], "EPK_260329_019")
        q = at._epic_for_atomizer_prompt(epic, engine="qwen")
        self.assertEqual(q["id"], "EPK-260329-019")


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
