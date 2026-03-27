from __future__ import annotations

import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any

try:
    from forge.common import atomic_write_yaml, env_paths, gh_request, load_yaml, now_iso, setup_logging
except ImportError:  # pragma: no cover
    from common import atomic_write_yaml, env_paths, gh_request, load_yaml, now_iso, setup_logging

LOG = setup_logging("retrospective")


def _update_project_state(epic: dict[str, Any], atom_total: int, atom_ok: int, atom_blk: int) -> None:
    project = Path(env_paths()["OSNOVA_PROJECT"])
    state_path = project / ".osnova" / "state.yaml"
    state = load_yaml(state_path, default={}) or {}
    stats = state.setdefault("sessionstats", {})
    stats["epicsreceived"] = int(stats.get("epicsreceived", 0)) + 1
    stats["epicsdone"] = int(stats.get("epicsdone", 0)) + (1 if atom_ok > 0 else 0)
    stats["epicsblocked"] = int(stats.get("epicsblocked", 0)) + (1 if atom_ok == 0 else 0)
    stats["atomstotal"] = int(stats.get("atomstotal", 0)) + atom_total
    stats["atomsdone"] = int(stats.get("atomsdone", 0)) + atom_ok
    stats["atomsblocked"] = int(stats.get("atomsblocked", 0)) + atom_blk
    stats["passrate"] = (stats["atomsdone"] / stats["atomstotal"]) if stats["atomstotal"] else 0.0
    state["currentepic"] = None
    state["updatedat"] = now_iso()
    atomic_write_yaml(state_path, state)

    latest_path = project / ".osnova" / "meta" / "retrospective-latest.yaml"
    latest = load_yaml(latest_path, default={}) or {}
    latest["v"] = 5
    latest["t"] = "RETRO"
    latest["timestamp"] = now_iso()
    latest["lastepic"] = {
        "id": epic.get("id"),
        "githubissue": epic.get("githubissue"),
        "atomstotal": atom_total,
        "atomspass": atom_ok,
        "atomsblk": atom_blk,
    }
    latest.setdefault("daily", {})
    latest["daily"]["passrate"] = (atom_ok / atom_total) if atom_total else 0.0
    atomic_write_yaml(latest_path, latest)


def _status(atom_total: int, atom_ok: int) -> str:
    if atom_ok == atom_total:
        return "OK"
    if atom_ok > 0:
        return "PARTIAL"
    return "BLK"


def finalize_epic(epic: dict[str, Any], results: list[dict[str, Any]], dry_run: bool = False) -> dict[str, Any]:
    atom_total = len(results)
    atom_ok = sum(1 for r in results if r.get("s") == "OK")
    atom_blk = atom_total - atom_ok
    status = _status(atom_total, atom_ok)
    passrate = atom_ok / atom_total if atom_total else 0.0
    summary = {"status": status, "passrate": passrate, "atomsdone": atom_ok, "atomstotal": atom_total}

    project = Path(env_paths()["OSNOVA_PROJECT"])
    stamp = datetime.now().strftime("%Y-%m-%dT%H%M%S")
    history_path = project / ".osnova" / "history" / f"{stamp}-{epic.get('id')}.yaml"
    atomic_write_yaml(history_path, {"epic": epic.get("id"), "summary": summary, "results": results, "createdat": now_iso()})
    _update_project_state(epic, atom_total, atom_ok, atom_blk)

    issue = epic.get("githubissue")
    repo = env_paths()["GHREPO"]
    if issue and not dry_run:
        comment = f"EPIC `{epic.get('id')}` finished with status `{status}`. passrate={passrate:.2f}."
        gh_request("POST", f"/repos/{repo}/issues/{issue}/comments", {"body": comment})
        if status in {"OK", "PARTIAL"}:
            gh_request("PATCH", f"/repos/{repo}/issues/{issue}", {"state": "closed"})
        elif status == "BLK":
            gh_request("POST", f"/repos/{repo}/issues/{issue}/labels", {"labels": ["blocker"]})
        subprocess.run(["git", "add", ".osnova"], cwd=project, check=False)
        subprocess.run(["git", "commit", "-m", f"Retrospective {epic.get('id')} {status}"], cwd=project, check=False)
        subprocess.run(["git", "push"], cwd=project, check=False)
    return summary


def main() -> None:
    LOG.info("retrospective module ready")


if __name__ == "__main__":
    main()

