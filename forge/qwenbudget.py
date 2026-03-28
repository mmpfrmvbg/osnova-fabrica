from __future__ import annotations

import os
import re
import time
from datetime import date
from pathlib import Path
from typing import Any, Literal

try:
    from forge.common import atomic_write_json, atomic_write_yaml, env_paths, load_json, load_yaml, setup_logging
except ImportError:  # pragma: no cover
    from common import atomic_write_json, atomic_write_yaml, env_paths, load_json, load_yaml, setup_logging

LOG = setup_logging("qwenbudget")

# Совпадает с типичным state.yaml; переопределение: FORGE_QWEN_*_DAILY_LIMIT или budget.qwenlimit в state.yaml
_DEFAULT_EXECUTOR_LIMIT = 1000
_DEFAULT_ATOMIZER_LIMIT = 200

Role = Literal["executor", "atomizer"]


def _path() -> Path:
    return Path(env_paths()["OSNOVA_FORGE"]) / "qwen-budget.json"


def _project_state_yaml() -> Path:
    return Path(env_paths()["OSNOVA_PROJECT"]) / ".osnova" / "state.yaml"


def effective_limit_executor() -> int:
    raw = os.environ.get("FORGE_QWEN_EXECUTOR_DAILY_LIMIT", "").strip()
    if raw.isdigit():
        return max(1, int(raw))
    legacy = os.environ.get("FORGE_QWEN_DAILY_LIMIT", "").strip()
    if legacy.isdigit():
        return max(1, int(legacy))
    p = _project_state_yaml()
    if p.is_file():
        data = load_yaml(p, default={}) or {}
        b = data.get("budget")
        if isinstance(b, dict):
            lim = b.get("qwenlimit")
            if lim is not None and str(lim).strip().isdigit():
                return max(1, int(str(lim).strip()))
    return _DEFAULT_EXECUTOR_LIMIT


def effective_limit_atomizer() -> int:
    raw = os.environ.get("FORGE_QWEN_ATOMIZER_DAILY_LIMIT", "").strip()
    if raw.isdigit():
        return max(1, int(raw))
    legacy = os.environ.get("FORGE_QWEN_DAILY_LIMIT", "").strip()
    if legacy.isdigit():
        return max(1, int(legacy))
    return _DEFAULT_ATOMIZER_LIMIT


def effective_limit() -> int:
    """Backward compat: same as ``effective_limit_executor`` (osnova/engine.py)."""
    return effective_limit_executor()


def _state() -> dict[str, Any]:
    lim_e = effective_limit_executor()
    lim_a = effective_limit_atomizer()
    return load_json(
        _path(),
        default={"day": date.today().isoformat(), "used_executor": 0, "used_atomizer": 0, "limit_executor": lim_e, "limit_atomizer": lim_a},
    )


def _migrate_legacy_state(state: dict[str, Any]) -> dict[str, Any]:
    """Older qwen-budget.json had ``used`` / ``limit`` only (executor bucket)."""
    if "used_executor" not in state and "used" in state:
        state = dict(state)
        state["used_executor"] = int(state.get("used") or 0)
    if "used_atomizer" not in state:
        state = dict(state)
        state["used_atomizer"] = 0
    if "limit_executor" not in state:
        state = dict(state)
        state["limit_executor"] = int(state.get("limit", effective_limit_executor()))
    if "limit_atomizer" not in state:
        state = dict(state)
        state["limit_atomizer"] = effective_limit_atomizer()
    return state


def _sync_state_yaml_budget(used_e: int, used_a: int, lim_e: int, lim_a: int) -> None:
    """Дублирует счётчики в ``.osnova/state.yaml`` (budget.qwenusedtoday = executor; qwenatomizerusedtoday optional)."""
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
        budget["qwenusedtoday"] = int(used_e)
        budget["qwenatomizerusedtoday"] = int(used_a)
        budget["qwenlimit"] = int(lim_e)
        budget["qwenatomizerlimit"] = int(lim_a)
        data["budget"] = budget
        atomic_write_yaml(p, data)
    except Exception as exc:
        LOG.warning("qwen budget: could not sync .osnova/state.yaml: %s", exc)


def maybe_reset() -> None:
    state = _migrate_legacy_state(_state())
    today = date.today().isoformat()
    lim_e = effective_limit_executor()
    lim_a = effective_limit_atomizer()
    if state.get("day") != today:
        state = {
            "day": today,
            "used_executor": 0,
            "used_atomizer": 0,
            "limit_executor": lim_e,
            "limit_atomizer": lim_a,
        }
        atomic_write_json(_path(), state)
        _sync_state_yaml_budget(0, 0, lim_e, lim_a)
        LOG.info("Qwen budget reset for day %s (executor_limit=%s atomizer_limit=%s)", today, lim_e, lim_a)


def can_call_executor() -> bool:
    maybe_reset()
    state = _migrate_legacy_state(_state())
    lim = int(state.get("limit_executor", effective_limit_executor()))
    return int(state.get("used_executor", 0)) < lim


def can_call_atomizer() -> bool:
    maybe_reset()
    state = _migrate_legacy_state(_state())
    lim = int(state.get("limit_atomizer", effective_limit_atomizer()))
    return int(state.get("used_atomizer", 0)) < lim


def can_call() -> bool:
    """Backward compat: same as ``can_call_executor`` (reviewer, legacy callers)."""
    return can_call_executor()


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


def classify_qwen_api_limit(text: str) -> str:
    """
    Уточняет тип ответа API, если is_quota_exhausted_output(text) уже True.
    Возвращает одно из: quota_exceeded | rate_limit | unknown_limit
    (429 без тела часто попадает в unknown_limit — смотри format_qwen_limit_for_log).
    """
    if not (text or "").strip():
        return "unknown_limit"
    u = text
    low = text.lower()
    if re.search(r"QuotaExceeded|quota_exceeded|QUOTA_EXCEEDED", u):
        return "quota_exceeded"
    if re.search(
        r"insufficient\s+quota|exceeded\s+your\s+quota|quota\s+exceeded|quota\s+exhausted",
        low,
    ):
        return "quota_exceeded"
    if re.search(r"RateLimit|rate_limit|RATE_LIMIT", u):
        return "rate_limit"
    if "rate limit" in low or "too many requests" in low:
        return "rate_limit"
    if " 429" in low or "429 " in low or "http 429" in low:
        return "unknown_limit"
    if "resource exhausted" in low:
        return "unknown_limit"
    if "limit: 0" in low:
        return "unknown_limit"
    return "unknown_limit"


def format_qwen_limit_for_log(text: str, *, max_chars: int = 1500) -> str:
    """
    Одна строка для логов из объединённого stdout+stderr (так делают reviewer, qwenexec, atomizer).

    Длинный вывод: начало и конец — ошибка может быть в начале stdout (прямой API) или в конце stderr (CLI JSON).
    """
    s = " ".join((text or "").split())
    if len(s) <= max_chars:
        return s
    sep = " … "
    head = min(max(60, max_chars // 5), max_chars // 2)
    tail_room = max_chars - len(sep) - head
    if tail_room < 40:
        head = max_chars // 2
        tail_room = max_chars - len(sep) - head
    return s[:head] + sep + s[-tail_room:]


def log_remote_qwen_limit(
    component: str,
    combined: str,
    *,
    ref: str | None = None,
) -> tuple[str, str]:
    """
    Логирует kind + сырой фрагмент объединённого stdout+stderr (см. format_qwen_limit_for_log).
    Возвращает (kind, excerpt) для humanlog и т.п.
    """
    kind = classify_qwen_api_limit(combined)
    excerpt = format_qwen_limit_for_log(combined)
    scope = f" ref={ref}" if (ref or "").strip() else ""
    LOG.warning(
        "%s: Qwen API limit kind=%s%s — rate_limit≈retry in ~1 min, quota_exceeded≈next day. Raw: %s",
        component,
        kind,
        scope,
        excerpt,
    )
    return kind, excerpt


def record(
    *,
    served: bool = True,
    amount: int = 1,
    role: Role | None = None,
) -> dict[str, Any]:
    """
    Увеличить счётчик после фактического вызова Qwen (served=True).
    При served=False (например ответ «quota exceeded») счётчик не меняем.

    ``role``: ``executor`` (qwenexec, reviewer) vs ``atomizer`` (Qwen fallback atomizer).
    Default ``None`` = executor (backward compat).
    """
    maybe_reset()
    if not served:
        return _migrate_legacy_state(_state())
    r: Role = role or "executor"
    state = _migrate_legacy_state(_state())
    lim_e = int(state.get("limit_executor", effective_limit_executor()))
    lim_a = int(state.get("limit_atomizer", effective_limit_atomizer()))
    amt = max(1, int(amount))
    if r == "atomizer":
        state["used_atomizer"] = int(state.get("used_atomizer", 0)) + amt
    else:
        state["used_executor"] = int(state.get("used_executor", 0)) + amt
    state["limit_executor"] = lim_e
    state["limit_atomizer"] = lim_a
    atomic_write_json(_path(), state)
    _sync_state_yaml_budget(
        int(state.get("used_executor", 0)),
        int(state.get("used_atomizer", 0)),
        lim_e,
        lim_a,
    )
    return state


_warn_last: dict[str, float] = {}


def warn_if_approaching_limit(
    *,
    threshold: float | None = None,
    min_interval_s: float | None = None,
) -> None:
    """
    Log WARNING when executor/atomizer usage crosses a fraction of the daily limit.
    Rate-limited per bucket so heart.py does not spam every 60s.

    - ``FORGE_QWEN_BUDGET_WARN_THRESHOLD`` — default 0.85
    - ``FORGE_QWEN_BUDGET_WARN_INTERVAL`` — seconds between repeats; default 3600
    """
    thr_raw = os.environ.get("FORGE_QWEN_BUDGET_WARN_THRESHOLD", "").strip()
    if threshold is None:
        try:
            threshold = float(thr_raw) if thr_raw else 0.85
        except ValueError:
            threshold = 0.85
    int_raw = os.environ.get("FORGE_QWEN_BUDGET_WARN_INTERVAL", "").strip()
    if min_interval_s is None:
        try:
            min_interval_s = float(int_raw) if int_raw else 3600.0
        except ValueError:
            min_interval_s = 3600.0

    maybe_reset()
    st = _migrate_legacy_state(_state())
    now = time.time()
    for label, ukey, lkey in (
        ("executor", "used_executor", "limit_executor"),
        ("atomizer", "used_atomizer", "limit_atomizer"),
    ):
        used = int(st.get(ukey, 0))
        lim = max(1, int(st.get(lkey, 1)))
        if used < lim * threshold:
            continue
        if now - _warn_last.get(label, 0.0) < min_interval_s:
            continue
        _warn_last[label] = now
        LOG.warning(
            "Qwen budget %s: %s/%s calls used (≥%.0f%% of daily limit)",
            label,
            used,
            lim,
            100 * threshold,
        )


def main() -> None:
    LOG.info(
        "can_call_executor=%s can_call_atomizer=%s state=%s",
        can_call_executor(),
        can_call_atomizer(),
        _migrate_legacy_state(_state()),
    )


if __name__ == "__main__":
    main()
