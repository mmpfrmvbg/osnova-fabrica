from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Any

try:
    from forge.common import atomic_write_yaml, env_paths, gh_request, load_forge_state, load_yaml, now_iso, save_forge_state, setup_logging
except ImportError:  # pragma: no cover
    from common import atomic_write_yaml, env_paths, gh_request, load_forge_state, load_yaml, now_iso, save_forge_state, setup_logging

LOG = setup_logging("courier")


def _blocker_title(atm_id: Any) -> str:
    return f"ATM blocked: {atm_id}"


def _find_open_blocker_issue(repo: str, atm_id: Any) -> int | None:
    """Ищет открытый issue с меткой blocker и заголовком «ATM blocked: {id}»."""
    raw = gh_request("GET", f"/repos/{repo}/issues?state=open&labels=blocker&per_page=100")
    if not isinstance(raw, list):
        return None
    want = _blocker_title(atm_id)
    for iss in raw:
        if not isinstance(iss, dict):
            continue
        if iss.get("pull_request"):
            continue
        if (iss.get("title") or "").strip() != want:
            continue
        num = iss.get("number")
        if isinstance(num, int):
            return num
    return None


def _upsert_blocker_in_project_state(atm_id: Any, issue_num: int) -> None:
    """Добавляет/обновляет запись в ``.osnova/state.yaml`` ``blockers`` и ``ci.openblockerissues``."""
    project = Path(env_paths()["OSNOVA_PROJECT"])
    p = project / ".osnova" / "state.yaml"
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        data: Any = load_yaml(p, default={}) or {}
        if not isinstance(data, dict):
            data = {}
        blockers = data.get("blockers")
        if not isinstance(blockers, list):
            blockers = []
        else:
            blockers = [b for b in blockers if isinstance(b, dict)]
        aid = str(atm_id)
        found = False
        for b in blockers:
            if str(b.get("atm_id", "")) == aid:
                b["issue"] = issue_num
                b["open"] = True
                b["updated"] = now_iso()
                found = True
                break
        if not found:
            blockers.append({"issue": issue_num, "atm_id": aid, "open": True, "updated": now_iso()})
        data["blockers"] = blockers
        ci = data.get("ci")
        if not isinstance(ci, dict):
            ci = {}
        else:
            ci = dict(ci)
        ci["openblockerissues"] = len([x for x in blockers if x.get("open", True)])
        data["ci"] = ci
        data["updatedat"] = now_iso()
        atomic_write_yaml(p, data)
    except Exception as exc:
        LOG.warning("Could not sync .osnova/state.yaml blockers: %s", exc)


def _remove_blocker_from_project_state(atm_id: Any) -> None:
    """Убирает ATM из ``state.yaml`` ``blockers`` после успешного прохода (не BLK)."""
    project = Path(env_paths()["OSNOVA_PROJECT"])
    p = project / ".osnova" / "state.yaml"
    try:
        if not p.is_file():
            return
        data: Any = load_yaml(p, default={}) or {}
        if not isinstance(data, dict):
            return
        blockers = data.get("blockers")
        if not isinstance(blockers, list):
            return
        aid = str(atm_id)
        new_b = [b for b in blockers if isinstance(b, dict) and str(b.get("atm_id", "")) != aid]
        if len(new_b) == len(blockers):
            return
        data["blockers"] = new_b
        ci = data.get("ci")
        if not isinstance(ci, dict):
            ci = {}
        else:
            ci = dict(ci)
        ci["openblockerissues"] = len([x for x in new_b if x.get("open", True)])
        data["ci"] = ci
        data["updatedat"] = now_iso()
        atomic_write_yaml(p, data)
    except Exception as exc:
        LOG.warning("Could not remove blocker from .osnova/state.yaml: %s", exc)


def _create_blocker_issue(atom: dict[str, Any], report: dict[str, Any]) -> None:
    if os.environ.get("FORGE_SKIP_BLOCKER_ISSUES", "").strip().lower() in ("1", "true", "yes"):
        LOG.info("FORGE_SKIP_BLOCKER_ISSUES: skip GitHub blocker for ATM %s", atom.get("id"))
        return
    repo = env_paths()["GHREPO"]
    atm_id = atom.get("id")
    title = _blocker_title(atm_id)
    body = f"ATM `{atm_id}` blocked.\n\nError: {report.get('err')}\nReview: {report.get('review')}"
    existing = _find_open_blocker_issue(repo, atm_id)
    if existing is not None:
        gh_request("POST", f"/repos/{repo}/issues/{existing}/comments", {"body": body})
        _upsert_blocker_in_project_state(atm_id, existing)
        try:
            from forge.humanlog import hlog

            hlog("blocker_comment", issue_number=existing, atm_id=atm_id)
        except Exception:
            pass
        LOG.info("Blocker dedup: commented on issue #%s for %s", existing, atm_id)
        return
    resp = gh_request("POST", f"/repos/{repo}/issues", {"title": title, "body": body, "labels": ["blocker"]})
    num = resp.get("number")
    if num is not None:
        inum = int(num)
        _upsert_blocker_in_project_state(atm_id, inum)
        try:
            from forge.humanlog import hlog

            hlog("blocker_created", issue_number=inum, atm_id=atm_id)
        except Exception:
            pass


def alerthuman(state: dict[str, Any], atom: dict[str, Any]) -> None:
    LOG.error("Three or more consecutive failures. Human attention required for %s", atom.get("id"))


def process_result(atom: dict[str, Any], report: dict[str, Any], dry_run: bool = False) -> None:
    project = Path(env_paths()["OSNOVA_PROJECT"])
    state = load_forge_state()
    changed = report.get("changed") or []
    status = report.get("s", "BLK")
    if dry_run:
        LOG.info("[dry-run] Would git commit ATM %s status=%s", atom.get("id"), status)
    else:
        if changed:
            subprocess.run(["git", "add", *changed], cwd=project, check=False)
        else:
            subprocess.run(["git", "add", "."], cwd=project, check=False)
        subprocess.run(["git", "commit", "-m", f"ATM {atom.get('id')} {status}"], cwd=project, check=False)
        subprocess.run(["git", "push", "origin", "main"], cwd=project, check=False)
        try:
            from forge.humanlog import git_last_push_stats, hlog

            br, fc, ins = git_last_push_stats(project)
            hlog("git_push", branch=br, files_changed=fc, insertions=ins)
        except Exception:
            pass
    if status == "BLK":
        state["consecutive_failures"] = int(state.get("consecutive_failures", 0)) + 1
        if not dry_run:
            try:
                _create_blocker_issue(atom, report)
            except Exception as exc:
                LOG.warning("Could not create blocker issue: %s", exc)
    else:
        state["consecutive_failures"] = 0
        if not dry_run:
            try:
                _remove_blocker_from_project_state(atom.get("id"))
            except Exception as exc:
                LOG.warning("Could not update blockers in state.yaml: %s", exc)
    if int(state.get("consecutive_failures", 0)) >= 3:
        alerthuman(state, atom)
    save_forge_state(state)


def main() -> None:
    LOG.info("courier module ready")


if __name__ == "__main__":
    main()
