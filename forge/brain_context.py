"""
Aggregate git + .osnova state for Brain-style decisions (CONTINUE / REFORMULATE / ESCALATE / …).
"""
from __future__ import annotations

import subprocess
from collections import Counter
from pathlib import Path
from typing import Any

try:
    from forge.atm_store import (
        all_atms_successfully_done,
        get_pending_atms,
        load_all_atms_from_disk,
        normalize_atm_status,
    )
    from forge.common import SUBPROCESS_TEXT, load_yaml, now_iso, setup_logging
except ImportError:  # pragma: no cover
    from atm_store import (
        all_atms_successfully_done,
        get_pending_atms,
        load_all_atms_from_disk,
        normalize_atm_status,
    )
    from common import SUBPROCESS_TEXT, load_yaml, now_iso, setup_logging

LOG = setup_logging("brain_context")


def _git_oneline_log(project: Path, n: int = 20) -> list[str]:
    try:
        proc = subprocess.run(
            ["git", "log", f"-{n}", "--oneline", "--no-decorate"],
            cwd=project,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
            **SUBPROCESS_TEXT,
        )
        if proc.returncode != 0:
            return []
        return [ln.strip() for ln in (proc.stdout or "").splitlines() if ln.strip()]
    except Exception:
        return []


def _discover_epic_ids(epics_root: Path) -> list[str]:
    ids: set[str] = set()
    if not epics_root.is_dir():
        return []
    for f in epics_root.glob("EPK-*.yaml"):
        ids.add(f.stem)
    for d in epics_root.iterdir():
        if d.is_dir() and d.name.startswith("EPK-"):
            ids.add(d.name)
    return sorted(ids)


def _epic_status_summary(project: Path, epic_id: str) -> dict[str, Any]:
    epic_path = project / ".osnova" / "epics" / f"{epic_id}.yaml"
    meta = load_yaml(epic_path, default={}) or {}
    if not isinstance(meta, dict):
        meta = {}
    atoms = load_all_atms_from_disk(project, epic_id)
    if not atoms:
        return {
            "id": epic_id,
            "status": "unknown",
            "progress": "0/0",
            "pending_atms": 0,
            "blk_atms": 0,
            "top_blk_reason": "",
        }
    pending = get_pending_atms(atoms)
    blk_reasons: list[str] = []
    blk_n = 0
    for a in atoms:
        st = normalize_atm_status(a.get("status", "todo"))
        if st == "blk":
            blk_n += 1
            lf = str(a.get("last_failure") or "").strip()
            if lf:
                blk_reasons.append(lf[:200])
    top_blk = ""
    if blk_reasons:
        top_blk = Counter(blk_reasons).most_common(1)[0][0]
    done_n = sum(
        1
        for a in atoms
        if normalize_atm_status(a.get("status", "todo"))
        in ("done", "superseded", "obsolete", "review_mismatch")
    )
    if pending:
        st = "in_progress"
    elif all_atms_successfully_done(atoms):
        st = "done"
    elif not pending and atoms:
        st = "stuck"
    else:
        st = "in_progress"
    return {
        "id": epic_id,
        "status": st,
        "progress": f"{done_n}/{len(atoms)} ATM done",
        "pending_atms": len(pending),
        "blk_atms": blk_n,
        "top_blk_reason": top_blk,
        "githubissue": meta.get("githubissue"),
    }


def _failure_patterns_from_atoms(project: Path) -> list[dict[str, Any]]:
    epics_root = project / ".osnova" / "epics"
    buckets: Counter[str] = Counter()
    samples: dict[str, str] = {}
    for eid in _discover_epic_ids(epics_root):
        for a in load_all_atms_from_disk(project, eid):
            lf = str(a.get("last_failure") or "").strip()
            if not lf:
                continue
            key = _classify_failure(lf)
            buckets[key] += 1
            samples.setdefault(key, lf[:300])
    out: list[dict[str, Any]] = []
    for pat, cnt in buckets.most_common(20):
        if cnt < 1:
            continue
        out.append(
            {
                "pattern": pat,
                "count": cnt,
                "description": samples.get(pat, pat),
            }
        )
    return out


def _classify_failure(msg: str) -> str:
    low = msg.lower()
    if "diff" in low and ("not" in low or "fail" in low or "missing" in low):
        return "review_diff_missing"
    if "review" in low and "fail" in low:
        return "review_fail"
    if "timeout" in low or "timed out" in low:
        return "timeout"
    if "quota" in low or "rate limit" in low:
        return "quota"
    if "merge" in low or "conflict" in low:
        return "merge_conflict"
    return "other"


def build_brain_context(project: Path | None = None) -> dict[str, Any]:
    try:
        from forge.common import env_paths
    except ImportError:  # pragma: no cover
        from common import env_paths

    proj = Path(project) if project is not None else Path(env_paths()["OSNOVA_PROJECT"])
    state_path = proj / ".osnova" / "state.yaml"
    state = load_yaml(state_path, default={}) or {}
    if not isinstance(state, dict):
        state = {}
    stats = state.get("sessionstats") or {}
    ci = state.get("ci") if isinstance(state.get("ci"), dict) else {}
    pr_ci_raw = ci.get("passrate7d")
    passrate_from_ci = False
    if pr_ci_raw is not None:
        try:
            pr = float(pr_ci_raw)
            passrate_from_ci = True
        except (TypeError, ValueError):
            pr = float(stats.get("passrate") or 0.0)
    else:
        pr = float(stats.get("passrate") or 0.0)
    trend = "stable"
    try:
        hist = sorted((proj / ".osnova" / "history").glob("*.yaml"))
        tail = hist[-5:]
        rates: list[float] = []
        for h in tail:
            d = load_yaml(h, default={}) or {}
            if not isinstance(d, dict):
                continue
            summ = d.get("summary") or {}
            if isinstance(summ, dict) and summ.get("passrate") is not None:
                rates.append(float(summ["passrate"]))
        if len(rates) >= 2:
            if rates[-1] < rates[0] - 0.05:
                trend = "declining"
            elif rates[-1] > rates[0] + 0.05:
                trend = "improving"
    except Exception:
        pass

    epics_root = proj / ".osnova" / "epics"
    epics_summary = [_epic_status_summary(proj, eid) for eid in _discover_epic_ids(epics_root)]

    cb = state.get("codebase")
    if not isinstance(cb, dict):
        cb = {}

    recent = state.get("recent") if isinstance(state.get("recent"), list) else []
    last_scopes = state.get("last_scopes") if isinstance(state.get("last_scopes"), list) else []

    last_epic_atm_review: dict[str, Any] = {}
    if recent and isinstance(recent[0], dict):
        ar0 = recent[0].get("atm_review")
        if isinstance(ar0, dict):
            last_epic_atm_review = dict(ar0)

    return {
        "recent_commits": _git_oneline_log(proj, 20),
        "epics_summary": epics_summary,
        "failure_patterns": _failure_patterns_from_atoms(proj),
        "open_blockers": state.get("blockers") or [],
        "passrate": pr,
        "passrate_trend": trend,
        "passrate_source": "ci.passrate7d" if passrate_from_ci else "sessionstats.passrate",
        "session_passrate": float(stats.get("passrate") or 0.0),
        "ci": ci,
        "recent": recent,
        "last_scopes": last_scopes,
        "last_epic_atm_review": last_epic_atm_review,
        "codebase": cb,
    }


def append_escalation(project: Path, pattern: str, count: int, note: str = "") -> None:
    try:
        from forge.common import atomic_write_yaml
    except ImportError:  # pragma: no cover
        from common import atomic_write_yaml

    meta = project / ".osnova" / "meta"
    meta.mkdir(parents=True, exist_ok=True)
    path = meta / "escalations.yaml"
    data = load_yaml(path, default={}) or {}
    if not isinstance(data, dict):
        data = {}
    items = data.get("items")
    if not isinstance(items, list):
        items = []
    for it in items[-8:]:
        if isinstance(it, dict) and str(it.get("pattern")) == pattern:
            return
    items.append(
        {
            "ts": now_iso(),
            "pattern": pattern,
            "count": count,
            "note": note,
        }
    )
    data["items"] = items[-200:]
    atomic_write_yaml(path, data)


def decide_brain_action(ctx: dict[str, Any], *, project: Path | None = None) -> dict[str, Any]:
    """
    Priority-ordered suggestion. Forge applies CONTINUE by resuming disk EPIC before dequeuing queue.
    """
    try:
        from forge.common import env_paths
    except ImportError:  # pragma: no cover
        from common import env_paths

    proj = Path(env_paths()["OSNOVA_PROJECT"]) if project is None else Path(project)

    resume = _resume_epic_dict(proj)
    if resume:
        return {
            "decision": "CONTINUE",
            "decision_reason": f"Незавершённый EPIC {resume.get('id')} — pending ATM на диске",
            "continued_epic": str(resume.get("id") or ""),
        }

    stuck = _find_stuck_epic(proj)
    if stuck:
        return {
            "decision": "REFORMULATE",
            "decision_reason": f"EPIC {stuck[0]} застрял (нет pending, не все done)",
            "stuck_epic": stuck[0],
        }

    for fp in ctx.get("failure_patterns") or []:
        if isinstance(fp, dict) and int(fp.get("count") or 0) >= 3:
            pat = str(fp.get("pattern") or "unknown")
            append_escalation(proj, pat, int(fp["count"]), str(fp.get("description") or ""))
            return {
                "decision": "ESCALATE",
                "decision_reason": f"Паттерн {pat} повторяется {fp['count']}+ раз",
                "escalation_pattern": pat,
            }

    pr = float(ctx.get("passrate") or 0.0)
    blockers = ctx.get("open_blockers") or []
    open_n = len(blockers) if isinstance(blockers, list) else 0

    pr_src = str(ctx.get("passrate_source") or "passrate")
    if pr > 0.92 and open_n == 0:
        return {
            "decision": "RESEARCH",
            "decision_reason": f"Высокий {pr_src} ({pr:.2f}) и нет blockers — исследовательский EPIC",
        }

    if pr > 0.8 and not any(
        isinstance(e, dict) and e.get("pending_atms", 0) > 0 for e in (ctx.get("epics_summary") or [])
    ):
        return {
            "decision": "NEW",
            "decision_reason": f"Нет активного EPIC с pending; {pr_src} > 0.8 ({pr:.2f})",
        }

    return {
        "decision": "NEW",
        "decision_reason": "По умолчанию — следующий EPIC из очереди / поллера",
    }


def _resume_epic_dict(project: Path) -> dict[str, Any] | None:
    epics_root = project / ".osnova" / "epics"
    for eid in _discover_epic_ids(epics_root):
        epic_path = epics_root / f"{eid}.yaml"
        epic_data = load_yaml(epic_path, default={}) or {}
        if not isinstance(epic_data, dict):
            epic_data = {}
        epic_data.setdefault("id", eid)
        epic_data.setdefault("t", "EPK")
        epic_data.setdefault("goal", str(epic_data.get("goal") or ""))
        epic_data.setdefault("scope", epic_data.get("scope") or [])
        epic_data.setdefault("done", str(epic_data.get("done") or "npm test"))
        epic_data.setdefault("priority", epic_data.get("priority") or "P2")
        atoms = load_all_atms_from_disk(project, eid)
        if get_pending_atms(atoms):
            return epic_data
    return None


def _find_stuck_epic(project: Path) -> tuple[str, list[dict[str, Any]]] | None:
    epics_root = project / ".osnova" / "epics"
    for eid in _discover_epic_ids(epics_root):
        atoms = load_all_atms_from_disk(project, eid)
        if not atoms:
            continue
        if get_pending_atms(atoms):
            continue
        if all_atms_successfully_done(atoms):
            continue
        return eid, atoms
    return None


def resume_epic_if_pending(project: Path | None = None) -> dict[str, Any] | None:
    """If any EPIC has pending ATM on disk, return its epic dict (for Forge)."""
    try:
        from forge.common import env_paths
    except ImportError:  # pragma: no cover
        from common import env_paths

    proj = Path(env_paths()["OSNOVA_PROJECT"]) if project is None else Path(project)
    return _resume_epic_dict(proj)
