from __future__ import annotations

import os
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any

import yaml

try:
    from forge.common import atomic_write_yaml, env_paths, gh_request, load_yaml, now_iso, setup_logging
    from forge.epicwatcher import prepend_issue_to_queue
    from forge.humanlog import epic_done_tests, hlog
except ImportError:  # pragma: no cover
    from common import atomic_write_yaml, env_paths, gh_request, load_yaml, now_iso, setup_logging
    from epicwatcher import prepend_issue_to_queue
    from humanlog import epic_done_tests, hlog

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


def finalize_epic(
    epic: dict[str, Any],
    results: list[dict[str, Any]],
    dry_run: bool = False,
    forge_state: dict[str, Any] | None = None,
) -> dict[str, Any]:
    atom_total = len(results)
    atom_ok = sum(1 for r in results if r.get("s") == "OK")
    atom_blk = atom_total - atom_ok
    status = _status(atom_total, atom_ok)
    passrate = atom_ok / atom_total if atom_total else 0.0
    summary = {"status": status, "passrate": passrate, "atomsdone": atom_ok, "atomstotal": atom_total}

    requeue = (
        not dry_run
        and atom_total > 0
        and atom_ok == 0
        and bool((forge_state or {}).get("epic_popped_from_queue"))
        and epic.get("githubissue") is not None
        and os.environ.get("FORGE_REQUEUE_FAILED_QUEUE_EPIC", "1").strip().lower()
        not in ("0", "false", "no")
    )
    if requeue:
        n = int(epic["githubissue"])
        prepend_issue_to_queue(n)
        LOG.warning(
            "All ATMs failed — re-queued GitHub issue %s at the front of forge/epic-queue.txt", n
        )

    project = Path(env_paths()["OSNOVA_PROJECT"])
    stamp = datetime.now().strftime("%Y-%m-%dT%H%M%S")
    history_path = project / ".osnova" / "history" / f"{stamp}-{epic.get('id')}.yaml"
    atomic_write_yaml(history_path, {"epic": epic.get("id"), "summary": summary, "results": results, "createdat": now_iso()})
    _update_project_state(epic, atom_total, atom_ok, atom_blk)

    latest_path = project / ".osnova" / "meta" / "retrospective-latest.yaml"
    latest = load_yaml(latest_path, default={}) or {}
    brain = (forge_state or {}).get("brain_source") or "idle"
    latest["brain_source"] = brain
    proj_state = load_yaml(project / ".osnova" / "state.yaml", default={}) or {}
    gha = proj_state.get("gha") or {}
    ci_pr = gha.get("ci_pass_rate_7d")
    latest.setdefault("daily", {})
    if ci_pr is not None:
        latest["daily"]["ci_pass_rate"] = ci_pr
    heart_restarts = int((forge_state or {}).get("heart_restarts", 0))
    latest["heart"] = {
        "restarts_recorded": heart_restarts,
        "last_beat": (forge_state or {}).get("last_heart_restart"),
    }
    atomic_write_yaml(latest_path, latest)

    issue = epic.get("githubissue")
    repo = env_paths()["GHREPO"]
    if issue and not dry_run:
        icon = {"OK": "✅", "PARTIAL": "⚠️", "BLK": "🔴"}[status]
        lines = [
            f"## {icon} RETRO `{epic.get('id')}` — {status}",
            "",
            "| | |",
            "|---|---|",
            f"| brain_source | `{brain}` |",
            f"| ATMs | {atom_ok}/{atom_total} PASS |",
            f"| passrate (ATM) | {passrate:.0%} |",
        ]
        if ci_pr is not None:
            lines.append(f"| CI pass (7d) | {float(ci_pr):.0%} |")
        lines.append("")
        lines.append("<details><summary>YAML</summary>\n\n```yaml\n")
        lines.append(
            yaml.safe_dump(
                {"v": 5, "t": "RETRO", "lastepic": latest.get("lastepic"), "daily": latest.get("daily")},
                allow_unicode=True,
                sort_keys=False,
            )
        )
        lines.append("```\n</details>")
        gh_request("POST", f"/repos/{repo}/issues/{issue}/comments", {"body": "\n".join(lines)})
        if status in {"OK", "PARTIAL"}:
            gh_request("PATCH", f"/repos/{repo}/issues/{issue}", {"state": "closed"})
        elif status == "BLK":
            gh_request("POST", f"/repos/{repo}/issues/{issue}/labels", {"labels": ["blocker"]})
        subprocess.run(["git", "add", ".osnova"], cwd=project, check=False)
        subprocess.run(["git", "commit", "-m", f"Retrospective {epic.get('id')} {status}"], cwd=project, check=False)
        subprocess.run(["git", "push"], cwd=project, check=False)
        try:
            from forge.humanlog import git_last_push_stats

            br, fc, ins = git_last_push_stats(project)
            hlog("git_push", branch=br, files_changed=fc, insertions=ins)
        except Exception:
            pass
    tb, ta = epic_done_tests()
    try:
        hlog(
            "epic_done",
            epic_id=epic.get("id"),
            ok=atom_ok,
            total=atom_total,
            tests_before=tb,
            tests_after=ta,
        )
    except Exception:
        pass
    return summary


def main() -> None:
    LOG.info("retrospective module ready")


if __name__ == "__main__":
    main()

