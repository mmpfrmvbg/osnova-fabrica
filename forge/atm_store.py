"""
ATM YAML on disk under ``.osnova/epics/{epic_id}/``: load/save, status normalization,
pending queue for stateful EPIC resume.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any

try:
    from forge.common import atomic_write_yaml, env_paths, load_yaml, now_iso, setup_logging
except ImportError:  # pragma: no cover
    from common import atomic_write_yaml, env_paths, load_yaml, now_iso, setup_logging

LOG = setup_logging("atm_store")

_STATUS_ALIASES = {
    "pending": "todo",
    "PENDING": "todo",
    "TODO": "todo",
    "DONE": "done",
    "BLK": "blk",
    "IN_PROGRESS": "in_progress",
    "REVIEW_MISMATCH": "review_mismatch",
    "MERGE_CONFLICT": "merge_conflict",
}


def normalize_atm_status(raw: Any) -> str:
    s = str(raw or "todo").strip()
    return _STATUS_ALIASES.get(s, s.lower())


def epic_atm_dir(project: Path | str, epic_id: str) -> Path:
    return Path(project) / ".osnova" / "epics" / str(epic_id)


def compute_epic_digest(epic: dict[str, Any]) -> str:
    key = {
        "id": str(epic.get("id", "")),
        "goal": str(epic.get("goal", "")),
        "scope": epic.get("scope"),
        "done": str(epic.get("done", "")),
    }
    blob = json.dumps(key, sort_keys=True, ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()[:16]


def _atm_yaml_paths(epic_dir: Path) -> list[Path]:
    if not epic_dir.is_dir():
        return []
    out: list[Path] = []
    for p in sorted(epic_dir.glob("*.yaml")):
        name = p.name
        if name == "atomizer_meta.yaml":
            continue
        if re.match(r"^ATM-", name, re.IGNORECASE):
            out.append(p)
    return out


def load_atm_yaml(path: Path) -> dict[str, Any] | None:
    data = load_yaml(path, default=None)
    if not isinstance(data, dict):
        return None
    aid = data.get("id")
    if not aid:
        return None
    data["status"] = normalize_atm_status(data.get("status", "todo"))
    if "max_retries" not in data:
        data["max_retries"] = 3
    data["retries"] = int(data.get("retries") or 0)
    return data


def load_all_atms_from_disk(project: Path | str, epic_id: str) -> list[dict[str, Any]]:
    d = epic_atm_dir(project, epic_id)
    atoms: list[dict[str, Any]] = []
    for p in _atm_yaml_paths(d):
        a = load_atm_yaml(p)
        if a:
            atoms.append(a)
    atoms.sort(key=lambda x: int(x.get("seq") or 0))
    return atoms


def load_atomizer_meta(epic_dir: Path) -> dict[str, Any]:
    p = epic_dir / "atomizer_meta.yaml"
    m = load_yaml(p, default={}) or {}
    return m if isinstance(m, dict) else {}


def should_skip_atomize(project: Path | str, epic: dict[str, Any]) -> bool:
    if os.environ.get("FORGE_FORCE_ATOMIZE", "").strip().lower() in ("1", "true", "yes"):
        return False
    eid = str(epic.get("id") or "").strip()
    if not eid:
        return False
    d = epic_atm_dir(project, eid)
    paths = _atm_yaml_paths(d)
    if not paths:
        return False
    meta = load_atomizer_meta(d)
    digest = compute_epic_digest(epic)
    if meta.get("epic_digest") == digest:
        return True
    if not meta or meta.get("epic_digest") is None:
        LOG.info(
            "atm_store: EPIC %s has ATM files but no atomizer_meta — resume without re-atomize (legacy)",
            eid,
        )
        return True
    LOG.info(
        "atm_store: EPIC %s epic_digest mismatch (meta=%s current=%s) — will re-atomize",
        eid,
        meta.get("epic_digest"),
        digest,
    )
    return False


def write_atomizer_meta(epic_dir: Path, epic: dict[str, Any]) -> None:
    epic_dir.mkdir(parents=True, exist_ok=True)
    atomic_write_yaml(
        epic_dir / "atomizer_meta.yaml",
        {"epic_digest": compute_epic_digest(epic), "updated": now_iso()},
    )


def max_retries_for_atom(atom: dict[str, Any]) -> int:
    try:
        return max(1, int(atom.get("max_retries") or 3))
    except (TypeError, ValueError):
        return 3


def get_pending_atms(atoms: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    From loaded ATM dicts, return those that still need executor work.
    Excludes: done, superseded, obsolete, review_mismatch;
    blk when retries >= max_retries.
    Includes: todo, in_progress (crash recovery), blk with room to retry, merge_conflict.
    """
    out: list[dict[str, Any]] = []
    for a in atoms:
        st = normalize_atm_status(a.get("status", "todo"))
        mr = max_retries_for_atom(a)
        r = int(a.get("retries") or 0)
        if st in ("done", "superseded", "obsolete", "review_mismatch"):
            continue
        if st == "blk" and r >= mr:
            continue
        out.append(a)
    return out


def all_atms_terminal(atoms: list[dict[str, Any]]) -> bool:
    """True when nothing left to run (pending queue empty)."""
    return len(get_pending_atms(atoms)) == 0


def all_atms_successfully_done(atoms: list[dict[str, Any]]) -> bool:
    """Every ATM is done/superseded/obsolete/review_mismatch (no blk/todo/in_progress left)."""
    if not atoms:
        return False
    for a in atoms:
        st = normalize_atm_status(a.get("status", "todo"))
        if st not in ("done", "superseded", "obsolete", "review_mismatch"):
            return False
    return True


def save_atm_yaml(project: Path | str, atom: dict[str, Any], *, dry_run: bool = False) -> None:
    if dry_run:
        return
    eid = str(atom.get("epic") or "").strip()
    aid = str(atom.get("id") or "").strip()
    if not eid or not aid:
        LOG.warning("atm_store: skip save — missing epic or id")
        return
    d = epic_atm_dir(project, eid)
    d.mkdir(parents=True, exist_ok=True)
    path = d / f"{aid}.yaml"
    atomic_write_yaml(path, atom)


def mark_epic_complete_in_state_yaml(
    project: Path | str,
    epic_id: str,
    *,
    all_success: bool,
) -> None:
    """Update ``.osnova/state.yaml`` when an EPIC has no pending ATM."""
    p = Path(project) / ".osnova" / "state.yaml"
    data: Any = load_yaml(p, default={}) or {}
    if not isinstance(data, dict):
        data = {}
    data["currentepic"] = None
    ep = data.get("epicprogress")
    if not isinstance(ep, dict):
        ep = {}
    else:
        ep = dict(ep)
    ep["totalatoms"] = 0
    ep["done"] = 0
    ep["blocked"] = 0
    ep["current"] = None
    data["epicprogress"] = ep
    data["last_completed_epic"] = epic_id
    data["last_completed_epic_all_success"] = bool(all_success)
    data["updatedat"] = now_iso()
    atomic_write_yaml(p, data)


def apply_report_to_atom(atom: dict[str, Any], report: dict[str, Any]) -> None:
    st = str(report.get("s") or "BLK").strip().upper()
    if st == "OK":
        atom["status"] = "done"
        atom.pop("retry_context", None)
        ch = report.get("changed")
        if isinstance(ch, list):
            atom["produced_files"] = ch
        return
    if st == "MERGE_CONFLICT":
        atom["status"] = "merge_conflict"
        atom["last_failure"] = str(report.get("err") or "merge_conflict")
        return
    atom["status"] = "blk"
    rev = report.get("review")
    reason = str(report.get("err") or "")
    if isinstance(rev, dict) and rev.get("reason"):
        reason = reason or str(rev.get("reason") or "")
    atom["last_failure"] = reason or "BLK"


def set_atom_in_progress(atom: dict[str, Any]) -> None:
    atom["status"] = "in_progress"


def build_retry_context(atom: dict[str, Any], attempt: int, previous_reason: str) -> dict[str, Any]:
    return {
        "attempt": attempt,
        "previous_failure": previous_reason[:2000] if previous_reason else "",
        "hint": "Убедись что файлы реально созданы и сохранены перед завершением; проверь scope и done-команду.",
    }
