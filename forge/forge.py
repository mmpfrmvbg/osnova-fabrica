from __future__ import annotations

import argparse
import os
import subprocess
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


def _origin_is_ssh(url: str) -> bool:
    u = url.strip()
    return u.startswith("git@") or u.startswith("ssh://")


def _git_pull_project(dry_run: bool) -> None:
    if dry_run:
        LOG.info("[dry-run] Would run: git pull --rebase")
        return
    project = Path(env_paths()["OSNOVA_PROJECT"])
    paths = env_paths()
    token = (paths.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN", "")).strip().lstrip("\ufeff")
    ghrepo = paths.get("GHREPO", "mmpfrmvbg/osnova-fabrica").strip()
    pat_only = os.environ.get("FORGE_GIT_PULL_PAT_ONLY", "").lower() in ("1", "true", "yes")

    run_env = os.environ.copy()
    run_env["GIT_TERMINAL_PROMPT"] = "0"
    git_no_prompt = ["git", "-c", "credential.helper="]
    proc: subprocess.CompletedProcess[str] | None = None
    try:
        if not pat_only:
            proc = subprocess.run(
                ["git", "pull", "--rebase"],
                cwd=project,
                env=run_env,
                capture_output=True,
                text=True,
                timeout=120,
                check=False,
            )
            if proc.returncode == 0:
                LOG.info("git pull --rebase ok (system credentials / GCM / SSH)")
                return
            LOG.info(
                "git pull with system creds failed (%s); will try PAT if GH_TOKEN is set",
                proc.returncode,
            )

        if not token:
            if pat_only:
                LOG.warning("FORGE_GIT_PULL_PAT_ONLY set but GH_TOKEN is empty")
            elif proc is not None:
                LOG.warning(
                    "git pull --rebase failed (%s): %s",
                    proc.returncode,
                    (proc.stderr or proc.stdout or "").strip(),
                )
            else:
                LOG.warning("git pull: no GH_TOKEN for PAT fallback")
            return

        url_probe = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            cwd=project,
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        if url_probe.returncode != 0:
            LOG.warning("git pull: no origin remote (%s)", (url_probe.stderr or "").strip())
            return
        orig_url = url_probe.stdout.strip()
        if _origin_is_ssh(orig_url):
            LOG.warning(
                "git pull: origin is SSH; fix SSH auth or switch origin to HTTPS for PAT fallback"
            )
            return

        run_pat = os.environ.copy()
        run_pat["GIT_TERMINAL_PROMPT"] = "0"
        run_pat["GCM_INTERACTIVE"] = "Never"
        auth_url = f"https://x-access-token:{token}@github.com/{ghrepo}.git"
        if subprocess.run(
            git_no_prompt + ["remote", "set-url", "origin", auth_url],
            cwd=project,
            env=run_pat,
            timeout=15,
            check=False,
        ).returncode != 0:
            LOG.warning("git pull: could not set authenticated origin URL")
            return
        try:
            proc2 = subprocess.run(
                git_no_prompt + ["pull", "--rebase"],
                cwd=project,
                env=run_pat,
                capture_output=True,
                text=True,
                timeout=120,
                check=False,
            )
        finally:
            restore = subprocess.run(
                git_no_prompt + ["remote", "set-url", "origin", orig_url],
                cwd=project,
                env=run_pat,
                timeout=15,
                check=False,
            )
            if restore.returncode != 0:
                LOG.error(
                    "git pull: failed to restore origin; run: git remote set-url origin %s",
                    orig_url,
                )
        if proc2.returncode != 0:
            LOG.warning(
                "git pull --rebase failed with PAT (%s): %s",
                proc2.returncode,
                (proc2.stderr or proc2.stdout or "").strip(),
            )
        else:
            LOG.info("git pull --rebase ok (GH_TOKEN / PAT)")
    except subprocess.TimeoutExpired:
        LOG.warning("git pull --rebase timed out")
    except Exception as exc:
        LOG.warning("git pull --rebase error: %s", exc)


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
    _git_pull_project(dry_run=dry_run)
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

