from __future__ import annotations

import argparse
import time
from pathlib import Path
from typing import Any

try:
    from forge.atomizer import atomize
    from forge.common import atomic_write_text, env_paths, load_forge_state, now_iso, save_forge_state, setup_logging
    from forge.courier import process_result
    from forge.cursorexec import run_atom as run_cursor_atom
    from forge.degradation import get_available
    from forge.epicwatcher import watch_once
    from forge.qwenexec import run_atom as run_qwen_atom
    from forge.reviewer import review
    from forge.retrospective import finalize_epic
    from forge.router import choose_executor
except ImportError:  # pragma: no cover
    from atomizer import atomize
    from common import atomic_write_text, env_paths, load_forge_state, now_iso, save_forge_state, setup_logging
    from courier import process_result
    from cursorexec import run_atom as run_cursor_atom
    from degradation import get_available
    from epicwatcher import watch_once
    from qwenexec import run_atom as run_qwen_atom
    from reviewer import review
    from retrospective import finalize_epic
    from router import choose_executor

LOG = setup_logging("forge")


def _heartbeat() -> None:
    hb = Path(env_paths()["OSNOVA_FORGE"]) / "forge.heartbeat"
    atomic_write_text(hb, now_iso() + "\n")


def _process_epic(epic: dict[str, Any], state: dict[str, Any], dry_run: bool) -> None:
    state["current_epic"] = epic.get("id")
    state["current_epic_issue"] = epic.get("githubissue")
    save_forge_state(state)
    atoms = atomize(epic, dry_run=dry_run)
    avail = get_available()
    results: list[dict[str, Any]] = []
    for atom in sorted(atoms, key=lambda x: int(x.get("seq", 0))):
        executor = choose_executor(atom, avail)
        atom["executor"] = executor
        if executor == "none":
            report = {"id": atom.get("id"), "s": "BLK", "err": "No executor available", "changed": []}
            success = False
        elif executor == "qwen":
            success, report = run_qwen_atom(atom, dry_run=dry_run)
        else:
            success, report = run_cursor_atom(atom, dry_run=dry_run)
        passed, reason, elapsed = review(atom, dry_run=dry_run)
        report["review"] = {"passed": passed, "reason": reason, "elapsed": elapsed}
        report["s"] = "OK" if (success and passed) else "BLK"
        process_result(atom, report, dry_run=dry_run)
        results.append(report)
    finalize_epic(epic, results, dry_run=dry_run)
    state["current_epic"] = None
    state["current_epic_issue"] = None
    save_forge_state(state)


def cycle(dry_run: bool = False) -> None:
    state = load_forge_state()
    _heartbeat()
    if state.get("paused"):
        LOG.info("Forge paused")
        return
    epic = watch_once()
    if not epic:
        LOG.info("No EPIC in queue")
        return
    if dry_run:
        LOG.info("[dry-run] EPIC picked: %s", epic.get("id"))
    _process_epic(epic, state, dry_run=dry_run)


def main() -> None:
    parser = argparse.ArgumentParser(description="OSNOVA Forge loop")
    parser.add_argument("--dry-run", action="store_true", help="Run one cycle without external execution")
    args = parser.parse_args()
    try:
        if args.dry_run:
            cycle(dry_run=True)
            return
        while True:
            cycle(dry_run=False)
            time.sleep(60)
    except Exception as exc:
        LOG.exception("forge loop failed: %s", exc)


if __name__ == "__main__":
    main()

