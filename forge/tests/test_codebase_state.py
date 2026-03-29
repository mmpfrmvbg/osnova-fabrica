"""codebase_state: implemented scan, pending from ATM scope, state.yaml merge."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import yaml

from forge.codebase_state import (
    collect_pending_ts_paths,
    format_codebase_block,
    merge_codebase_into_state_yaml,
    scan_implemented_ts,
)


class TestCodebaseState(unittest.TestCase):
    def test_format_block_comments(self) -> None:
        s = format_codebase_block(
            ["src/a.ts", "src/b.ts"],
            ["src/missing.ts"],
        )
        self.assertIn("codebase:", s)
        self.assertIn("src/a.ts", s)
        self.assertIn("# ✅ done", s)
        self.assertIn("src/missing.ts", s)
        self.assertIn("# ❌ not yet", s)
        d = yaml.safe_load(s)
        self.assertEqual(sorted(d["codebase"]["implemented"]), ["src/a.ts", "src/b.ts"])
        self.assertEqual(d["codebase"]["pending"], ["src/missing.ts"])

    def test_format_empty_lists(self) -> None:
        s = format_codebase_block([], [])
        d = yaml.safe_load(s)
        self.assertEqual(d["codebase"]["implemented"], [])
        self.assertEqual(d["codebase"]["pending"], [])

    def test_scan_implemented_skips_empty(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "src").mkdir(parents=True)
            (root / "src" / "full.ts").write_text("export const x = 1;\n", encoding="utf-8")
            (root / "src" / "empty.ts").write_text("  \n  ", encoding="utf-8")
            got = scan_implemented_ts(root)
            self.assertIn("src/full.ts", got)
            self.assertNotIn("src/empty.ts", got)

    def test_pending_from_scope(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ed = root / ".osnova" / "epics" / "EPK-X"
            ed.mkdir(parents=True)
            (root / ".osnova" / "epics" / "EPK-X.yaml").write_text(
                yaml.safe_dump(
                    {"t": "EPK", "id": "EPK-X", "goal": "g", "scope": [], "done": "x"},
                    allow_unicode=True,
                ),
                encoding="utf-8",
            )
            (ed / "ATM-1.yaml").write_text(
                yaml.safe_dump(
                    {
                        "id": "ATM-1",
                        "epic": "EPK-X",
                        "seq": 1,
                        "status": "todo",
                        "scope": ["src/new-file.ts", "src/exists.ts", "docs/x.md"],
                        "done": "x",
                        "deps": [],
                    },
                    allow_unicode=True,
                ),
                encoding="utf-8",
            )
            (root / "src").mkdir(parents=True)
            (root / "src" / "exists.ts").write_text("ok\n", encoding="utf-8")
            imp = set(scan_implemented_ts(root))
            pend = collect_pending_ts_paths(root, imp)
            self.assertIn("src/new-file.ts", pend)
            self.assertNotIn("src/exists.ts", pend)

    def test_merge_replaces_block(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            osn = root / ".osnova"
            osn.mkdir(parents=True)
            (root / "src").mkdir(parents=True)
            (root / "src" / "x.ts").write_text("// x\n", encoding="utf-8")
            before = """v: 1
zonemap:
  lang:
  - src/
codebase:
  implemented:
    - src/old.ts        # ✅ done
  pending: []
testcommands:
  all: npm test
"""
            p = osn / "state.yaml"
            p.write_text(before, encoding="utf-8")
            merge_codebase_into_state_yaml(root)
            after = p.read_text(encoding="utf-8")
            self.assertIn("src/x.ts", after)
            self.assertNotIn("src/old.ts", after)
            self.assertIn("testcommands:", after)
            self.assertIn("zonemap:", after)
            d = yaml.safe_load(after)
            self.assertIn("src/x.ts", d["codebase"]["implemented"])


if __name__ == "__main__":
    unittest.main()
