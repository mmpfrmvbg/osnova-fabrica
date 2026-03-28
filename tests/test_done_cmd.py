import tempfile
from pathlib import Path

from osnova.done_cmd import (
    get_done_cmd,
    read_done_from_epic_atm_file,
    resolve_done_cmd,
)


def test_get_done_cmd_prefers_atm():
    assert get_done_cmd({"done": "npm run ci"}, {}) == "npm run ci"


def test_get_done_cmd_falls_back_to_state_unit():
    st = {"testcommands": {"unit": "npx vitest run src/"}}
    assert get_done_cmd({}, st) == "npx vitest run src/"


def test_get_done_cmd_default_npm_test():
    assert get_done_cmd({}, {}) == "npm test"


def test_resolve_reads_done_from_epic_yaml():
    root = Path(tempfile.mkdtemp())
    atm_dir = root / ".osnova" / "epics" / "EPK-TEST-001"
    atm_dir.mkdir(parents=True)
    (atm_dir / "ATM-EPK-TEST-001-001.yaml").write_text(
        "id: ATM-EPK-TEST-001-001\ndone: npx vitest run src/foo/\n",
        encoding="utf-8",
    )
    assert (
        read_done_from_epic_atm_file(root, "EPK-TEST-001", "ATM-EPK-TEST-001-001")
        == "npx vitest run src/foo/"
    )
    assert (
        resolve_done_cmd(
            {"id": "ATM-EPK-TEST-001-001", "s": "BLK"},
            {},
            epic_id="EPK-TEST-001",
            repo_root=root,
        )
        == "npx vitest run src/foo/"
    )


def test_resolve_epic_yaml_before_testcommands_unit():
    root = Path(tempfile.mkdtemp())
    atm_dir = root / ".osnova" / "epics" / "EPK-X"
    atm_dir.mkdir(parents=True)
    (atm_dir / "ATM-1.yaml").write_text("done: from-epic\n", encoding="utf-8")
    st = {"testcommands": {"unit": "from-state"}}
    assert (
        resolve_done_cmd({"id": "ATM-1"}, st, epic_id="EPK-X", repo_root=root) == "from-epic"
    )
