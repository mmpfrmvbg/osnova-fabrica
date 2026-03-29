"""
Хвост ``state.yaml`` для Brain: ``recent``, ``last_scopes``, ``ci.passrate7d`` / ``lastrun`` / ``laststatus``.

Без отдельных GitHub get_issue Anti-Loop и P1 по истории могут опираться на данные в репо.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

try:
    from forge.atm_store import load_all_atms_from_disk
    from forge.common import atomic_write_yaml, load_yaml, now_iso, setup_logging
except ImportError:  # pragma: no cover
    from atm_store import load_all_atms_from_disk
    from common import atomic_write_yaml, load_yaml, now_iso, setup_logging

LOG = setup_logging("state_epic_tail")

RECENT_MAX = 50
LAST_SCOPES_N = 3


def _norm_scope_entries(raw: list[Any]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for x in raw:
        s = str(x).strip().replace("\\", "/")
        if s and s not in seen:
            seen.add(s)
            out.append(s)
    return out


def _atom_scope_lines(atom: dict[str, Any]) -> list[str]:
    sc = atom.get("scope")
    if isinstance(sc, list):
        return _norm_scope_entries([str(x) for x in sc])
    if isinstance(sc, str) and sc.strip():
        return _norm_scope_entries([sc.strip()])
    return []


def collect_epic_scope_paths(project: Path, epic: dict[str, Any]) -> list[str]:
    """Scope EPIC из YAML или объединение scope ATM на диске."""
    sc = epic.get("scope")
    if isinstance(sc, list) and any(str(x).strip() for x in sc):
        return _norm_scope_entries(sc)
    eid = str(epic.get("id") or "").strip()
    if not eid:
        return []
    merged: list[str] = []
    seen: set[str] = set()
    try:
        for a in load_all_atms_from_disk(project, eid):
            for line in _atom_scope_lines(a):
                if line not in seen:
                    seen.add(line)
                    merged.append(line)
    except Exception as exc:
        LOG.warning("collect_epic_scope_paths: %s", exc)
    return merged


def recent_result_label(atom_ok: int, atom_total: int) -> str:
    if atom_total == 0:
        return "no-atoms"
    if atom_ok == atom_total:
        return "ok"
    if atom_ok == 0:
        return "retry-exhausted"
    return "partial"


def _ci_status_token(status_upper: str) -> str:
    return status_upper.strip().lower()


def compute_passrate_7d_from_history(project: Path) -> float | None:
    """Средний ``summary.passrate`` по файлам ``.osnova/history/*.yaml`` за последние 7 дней."""
    hist = project / ".osnova" / "history"
    if not hist.is_dir():
        return None
    cutoff = datetime.now(timezone.utc) - timedelta(days=7)
    rates: list[float] = []
    for p in hist.glob("*.yaml"):
        d = load_yaml(p, default={}) or {}
        if not isinstance(d, dict):
            continue
        ts = d.get("createdat") or ""
        try:
            t = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
            if t.tzinfo is None:
                t = t.replace(tzinfo=timezone.utc)
        except Exception:
            try:
                t = datetime.fromtimestamp(p.stat().st_mtime, tz=timezone.utc)
            except OSError:
                continue
        if t < cutoff:
            continue
        summ = d.get("summary") or {}
        if isinstance(summ, dict) and summ.get("passrate") is not None:
            try:
                rates.append(float(summ["passrate"]))
            except (TypeError, ValueError):
                continue
    if not rates:
        return None
    return sum(rates) / len(rates)


def apply_epic_tail_to_state_dict(
    state: dict[str, Any],
    project: Path,
    epic: dict[str, Any],
    results: list[dict[str, Any]],
    summary: dict[str, Any],
    status_upper: str,
) -> None:
    """Мутирует ``state``: ``recent``, ``last_scopes``, ``ci`` (без записи на диск)."""
    epic_id = str(epic.get("id") or "").strip() or "unknown"
    atom_ok = int(summary.get("atomsdone") or 0)
    atom_total = int(summary.get("atomstotal") or 0)
    scope = collect_epic_scope_paths(project, epic)
    entry = {
        "epic": epic_id,
        "scope": scope,
        "result": recent_result_label(atom_ok, atom_total),
        "status": _ci_status_token(status_upper),
        "passrate": float(summary.get("passrate") or 0.0),
        "updated": now_iso(),
    }
    recent = state.get("recent")
    if not isinstance(recent, list):
        recent = []
    recent = [x for x in recent if isinstance(x, dict) and str(x.get("epic") or "") != epic_id]
    recent.insert(0, entry)
    state["recent"] = recent[:RECENT_MAX]

    ls: list[list[str]] = []
    for item in state["recent"][:LAST_SCOPES_N]:
        if isinstance(item, dict):
            sc = item.get("scope")
            if isinstance(sc, list):
                ls.append([str(x) for x in sc if str(x).strip()])
            else:
                ls.append([])
        else:
            ls.append([])
    state["last_scopes"] = ls

    ci = state.get("ci")
    if not isinstance(ci, dict):
        ci = {}
    ci = dict(ci)
    ci["lastrun"] = now_iso()
    ci["laststatus"] = _ci_status_token(status_upper)
    pr7 = compute_passrate_7d_from_history(project)
    if pr7 is not None:
        ci["passrate7d"] = round(pr7, 4)
    state["ci"] = ci


def append_epic_tail_only(
    project: Path,
    epic: dict[str, Any],
    results: list[dict[str, Any]],
    summary: dict[str, Any],
    status_upper: str,
) -> None:
    """Только хвост (без sessionstats): путь ``skip_session_stats`` в ``finalize_epic``."""
    p = project / ".osnova" / "state.yaml"
    state = load_yaml(p, default={}) or {}
    if not isinstance(state, dict):
        state = {}
    apply_epic_tail_to_state_dict(state, project, epic, results, summary, status_upper)
    state["updatedat"] = now_iso()
    atomic_write_yaml(p, state)


def merge_epic_tail_into_state_before_write(
    state: dict[str, Any],
    project: Path,
    epic: dict[str, Any],
    results: list[dict[str, Any]],
    summary: dict[str, Any],
    status_upper: str,
) -> None:
    """Вызов из ``_update_project_state`` перед ``atomic_write_yaml``."""
    apply_epic_tail_to_state_dict(state, project, epic, results, summary, status_upper)
