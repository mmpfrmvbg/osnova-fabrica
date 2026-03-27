from __future__ import annotations

from datetime import date
from pathlib import Path

try:
    from forge.common import atomic_write_json, env_paths, load_json, setup_logging
except ImportError:  # pragma: no cover
    from common import atomic_write_json, env_paths, load_json, setup_logging

LOG = setup_logging("qwenbudget")
DAILY_LIMIT = 900


def _path() -> Path:
    return Path(env_paths()["OSNOVA_FORGE"]) / "qwen-budget.json"


def _state() -> dict:
    return load_json(_path(), default={"day": date.today().isoformat(), "used": 0, "limit": DAILY_LIMIT})


def maybe_reset() -> None:
    state = _state()
    today = date.today().isoformat()
    if state.get("day") != today:
        state = {"day": today, "used": 0, "limit": DAILY_LIMIT}
        atomic_write_json(_path(), state)
        LOG.info("Qwen budget reset for day %s", today)


def can_call() -> bool:
    maybe_reset()
    state = _state()
    return int(state.get("used", 0)) < int(state.get("limit", DAILY_LIMIT))


def record(amount: int = 1) -> dict:
    maybe_reset()
    state = _state()
    state["used"] = int(state.get("used", 0)) + max(1, int(amount))
    atomic_write_json(_path(), state)
    return state


def main() -> None:
    LOG.info("can_call=%s", can_call())


if __name__ == "__main__":
    main()

