from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

try:
    from forge.common import env_paths, gh_request, load_forge_state, save_forge_state, setup_logging
except ImportError:  # pragma: no cover
    from common import env_paths, gh_request, load_forge_state, save_forge_state, setup_logging

LOG = setup_logging("courier")


def _create_blocker_issue(atom: dict[str, Any], report: dict[str, Any]) -> None:
    repo = env_paths()["GHREPO"]
    title = f"ATM blocked: {atom.get('id')}"
    body = f"ATM `{atom.get('id')}` blocked.\n\nError: {report.get('err')}\nReview: {report.get('review')}"
    gh_request("POST", f"/repos/{repo}/issues", {"title": title, "body": body, "labels": ["blocker"]})


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
    if status == "BLK":
        state["consecutive_failures"] = int(state.get("consecutive_failures", 0)) + 1
        if not dry_run:
            try:
                _create_blocker_issue(atom, report)
            except Exception as exc:
                LOG.warning("Could not create blocker issue: %s", exc)
    else:
        state["consecutive_failures"] = 0
    if int(state.get("consecutive_failures", 0)) >= 3:
        alerthuman(state, atom)
    save_forge_state(state)


def main() -> None:
    LOG.info("courier module ready")


if __name__ == "__main__":
    main()

