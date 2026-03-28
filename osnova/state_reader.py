"""
Read .osnova YAML/JSON and normalize for CLI.
Project state uses keys like currentepic, sessionstats (see forge retrospective).
History files use epic, summary, results, createdat.
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any

import yaml

from osnova.config import forge_state_file, heartbeat_file, osnova_dir, project_dir


def read_state_raw() -> dict[str, Any]:
    """Raw .osnova/state.yaml."""
    path = osnova_dir() / "state.yaml"
    if not path.exists():
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            data = yaml.safe_load(f)
            return data if isinstance(data, dict) else {}
    except yaml.YAMLError:
        return {"_parse_error": True}


def read_task() -> dict[str, Any]:
    path = osnova_dir() / "task.yaml"
    if not path.exists():
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            data = yaml.safe_load(f)
            return data if isinstance(data, dict) else {}
    except yaml.YAMLError:
        return {}


def read_history_files(limit: int = 10) -> list[dict[str, Any]]:
    """Read newest N history YAML files (any name *.yaml)."""
    hist = osnova_dir() / "history"
    if not hist.exists():
        return []
    files = sorted(hist.glob("*.yaml"), reverse=True)[:limit]
    out: list[dict[str, Any]] = []
    for f in files:
        try:
            with open(f, encoding="utf-8") as fh:
                data = yaml.safe_load(fh)
                if isinstance(data, dict):
                    data["_filename"] = f.name
                    out.append(data)
        except (yaml.YAMLError, OSError):
            continue
    return out


def normalize_history_entry(raw: dict[str, Any]) -> dict[str, Any]:
    """
    Map real history shape to a stable CLI view:
    epic_id, goal, atms (from results), started_at, summary, raw.
    """
    epic_id = raw.get("epic_id") or raw.get("epic") or "?"
    goal = ""
    if isinstance(raw.get("summary"), dict):
        goal = str(raw["summary"].get("goal") or "")
    results = raw.get("results") or raw.get("atms") or []
    if not isinstance(results, list):
        results = []
    atms: list[dict[str, Any]] = []
    for r in results:
        if isinstance(r, dict):
            # `done` почти всегда только в .osnova/epics/<EPK>/<ATM>.yaml, не в history RPT
            a = {
                "id": r.get("id"),
                "s": r.get("s"),
                "goal": r.get("goal"),
                "done": r.get("done"),
                "elapsed_s": r.get("elapsed_s") if r.get("elapsed_s") is not None else r.get("elapsed"),
                "executor": r.get("executor"),
                "blk_reason": r.get("err") or (r.get("review") or {}).get("reason"),
            }
            atms.append(a)
    return {
        "epic_id": epic_id,
        "goal": goal,
        "atms": atms,
        "started_at": raw.get("createdat") or raw.get("started_at") or "",
        "summary": raw.get("summary") if isinstance(raw.get("summary"), dict) else {},
        "_filename": raw.get("_filename"),
        "_raw": raw,
    }


def read_history_normalized(limit: int = 10) -> list[dict[str, Any]]:
    return [normalize_history_entry(h) for h in read_history_files(limit)]


def read_retrospective() -> dict[str, Any]:
    path = osnova_dir() / "meta" / "retrospective-latest.yaml"
    if not path.exists():
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            data = yaml.safe_load(f)
            return data if isinstance(data, dict) else {}
    except yaml.YAMLError:
        return {}


def read_forge_state() -> dict[str, Any]:
    p = forge_state_file()
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"_parse_error": True}


def read_heartbeat_age() -> float | None:
    hb = heartbeat_file()
    if not hb.exists():
        return None
    return time.time() - hb.stat().st_mtime


def list_epic_manifests(limit: int = 50) -> list[Path]:
    """Top-level EPK-*.yaml under .osnova/epics/."""
    ep = osnova_dir() / "epics"
    if not ep.exists():
        return []
    files = sorted(ep.glob("EPK-*.yaml"), reverse=True)[:limit]
    return [f for f in files if f.is_file()]


def read_epic_manifest(path: Path) -> dict[str, Any]:
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (yaml.YAMLError, OSError):
        return {}


def compute_passrate_from_atms(atms: list[dict[str, Any]]) -> float:
    total = 0
    ok = 0
    for a in atms:
        total += 1
        if str(a.get("s") or "").upper() == "OK":
            ok += 1
    return ok / total if total else 0.0


def get_blk_patterns_from_atms(atms: list[dict[str, Any]]) -> list[dict[str, Any]]:
    patterns: dict[str, int] = {}
    for atm in atms:
        if str(atm.get("s") or "").upper() == "BLK":
            reason = str(atm.get("blk_reason") or atm.get("err") or "unknown")
            key = re.sub(r"/[\w./]+", "<path>", reason)[:80]
            patterns[key] = patterns.get(key, 0) + 1
    return sorted(({"reason": k, "count": v} for k, v in patterns.items()), key=lambda x: -x["count"])


def read_osnova_md() -> dict[str, Any]:
    """Best-effort parse OSNOVA.md sections (optional file)."""
    path = project_dir() / "OSNOVA.md"
    if not path.exists():
        return {}
    content = path.read_text(encoding="utf-8")
    cfg: dict[str, Any] = {
        "stack": {},
        "executor_priority": {},
        "done_commands": {},
        "notouch": [],
        "brain": {},
    }
    section_map = {
        "stack": "stack",
        "executor_priority": "executor_priority",
        "executor priority": "executor_priority",
        "done_commands": "done_commands",
        "done commands": "done_commands",
        "notouch": "notouch",
        "brain": "brain",
    }
    current: str | None = None
    for line in content.splitlines():
        line = line.rstrip()
        if line.startswith("## "):
            raw = line[3:].strip().lower().replace(" ", "_")
            current = section_map.get(raw.replace("_", " ")) or section_map.get(raw)
            if current is None:
                for k, v in section_map.items():
                    if raw == k.replace(" ", "_"):
                        current = v
                        break
            continue
        if not current or not line.startswith("- "):
            continue
        item = line[2:].strip()
        if current == "notouch":
            cfg["notouch"].append(item.split("#", 1)[0].strip())
        elif ":" in item:
            k, _, v = item.partition(":")
            k = k.strip()
            v = v.split("#", 1)[0].strip()
            if current in cfg and isinstance(cfg[current], dict):
                cfg[current][k] = v
    return cfg
