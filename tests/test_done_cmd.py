from osnova.done_cmd import get_done_cmd


def test_get_done_cmd_prefers_atm():
    assert get_done_cmd({"done": "npm run ci"}, {}) == "npm run ci"


def test_get_done_cmd_falls_back_to_state_unit():
    st = {"testcommands": {"unit": "npx vitest run src/"}}
    assert get_done_cmd({}, st) == "npx vitest run src/"


def test_get_done_cmd_default_npm_test():
    assert get_done_cmd({}, {}) == "npm test"
