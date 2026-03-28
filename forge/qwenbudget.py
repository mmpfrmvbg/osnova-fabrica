from __future__ import annotations

import os
from datetime import date
from pathlib import Path
from typing import Any

try:
    from forge.common import atomic_write_json, atomic_write_yaml, env_paths, load_json, load_yaml, setup_logging
except ImportError:  # pragma: no cover
    from common import atomic_write_json, atomic_write_yaml, env_paths, load_json, load_yaml, setup_logging

LOG = setup_logging("qwenbudget")

# Совпадает с типичным state.yaml; переопределение: FORGE_QWEN_DAILY_LIMIT или budget.qwenlimit в state.yaml
_DEFAULT_DAILY_LIMIT = 1000


def _path() -> Path:
    return Path(env_paths()["OSNOVA_FORGE"]) / "qwen-budget.json"


def _project_state_yaml() -> Path:
    return Path(env_paths()["OSNOVA_PROJECT"]) / ".osnova" / "state.yaml"


def effective_limit() -> int:
    raw = os.environ.get("FORGE_QWEN_DAILY_LIMIT", "").strip()
    if raw.isdigit():
        return max(1, int(raw))
    p = _project_state_yaml()
    if p.is_file():
        data = load_yaml(p, default={}) or {}
        b = data.get("budget")
        if isinstance(b, dict):
            lim = b.get("qwenlimit")
            if lim is not None and str(lim).strip().isdigit():
                return max(1, int(str(lim).strip()))
    return _DEFAULT_DAILY_LIMIT


def _state() -> dict[str, Any]:
    lim = effective_limit()
    return load_json(
        _path(),
        default={"day": date.today().isoformat(), "used": 0, "limit": lim},
    )


def _sync_state_yaml_budget(used: int, limit: int) -> None:
    """Дублирует счётчик в ``.osnova/state.yaml`` (budget.qwenusedtoday / qwenlimit), сразу после изменения JSON."""
    proj = Path(env_paths()["OSNOVA_PROJECT"])
    osnova = proj / ".osnova"
    p = osnova / "state.yaml"
    try:
        osnova.mkdir(parents=True, exist_ok=True)
        data: Any = load_yaml(p, default={}) or {}
        if not isinstance(data, dict):
            data = {}
        budget = data.get("budget")
        if not isinstance(budget, dict):
            budget = {}
        else:
            budget = dict(budget)
        budget["qwenusedtoday"] = int(used)
        budget["qwenlimit"] = int(limit)
        data["budget"] = budget
        atomic_write_yaml(p, data)
    except Exception as exc:
        LOG.warning("qwen budget: could not sync .osnova/state.yaml: %s", exc)


def maybe_reset() -> None:
    state = _state()
    today = date.today().isoformat()
    lim = effective_limit()
    if state.get("day") != today:
        state = {"day": today, "used": 0, "limit": lim}
        atomic_write_json(_path(), state)
        _sync_state_yaml_budget(0, lim)
        LOG.info("Qwen budget reset for day %s (limit=%s)", today, lim)


def can_call() -> bool:
    maybe_reset()
    state = _state()
    lim = int(state.get("limit", effective_limit()))
    return int(state.get("used", 0)) < lim


def is_quota_exhausted_output(text: str) -> bool:
    """Текст stdout/stderr Qwen CLI: лимит исчерпан на стороне API — вызов не считаем в дневной счётчик forge."""
    if not (text or "").strip():
        return False
    t = text.lower()
    needles = (
        "quota exceeded",
        "exceeded your quota",
        "rate limit",
        "quota limit",
        "resource exhausted",
        "insufficient quota",
        "quota exhausted",
        "too many requests",
        " 429",
        "429 ",
        "limit: 0",
    )
    return any(n in t for n in needles)


def record(*, served: bool = True, amount: int = 1) -> dict[str, Any]:
    """
    Увеличить счётчик после фактического вызова Qwen (served=True).
    При served=False (например ответ «quota exceeded») счётчик не меняем.
    """
    maybe_reset()
    if not served:
        return _state()
    state = _state()
    lim = int(state.get("limit", effective_limit()))
    state["used"] = int(state.get("used", 0)) + max(1, int(amount))
    state["limit"] = lim
    atomic_write_json(_path(), state)
    _sync_state_yaml_budget(int(state["used"]), lim)
    return state


def main() -> None:
    LOG.info("can_call=%s state=%s", can_call(), _state())


if __name__ == "__main__":
    main()
