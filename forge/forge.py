from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

try:
    from forge.atomizer import atomize
    from forge.brain_fallback import generate_fallback_epic
    from forge.common import _github_bearer_value, atomic_write_text, env_paths, gh_request, heartbeat_path, load_forge_state, now_iso, save_forge_state, setup_logging
    from forge.courier import process_result
    from forge.cursorexec import run_atom as run_cursor_atom
    from forge.degradation import get_available
    from forge.epic_socket import accept_epic_event, ensure_listener
    from forge.epicwatcher import fetch_epic, watch_once
    from forge.parallel_executor import build_waves, run_waves_sequential
    from forge.qwenexec import run_atom as run_qwen_atom
    from forge.reviewer import review
    from forge.retrospective import finalize_epic
    from forge.router import choose_executor
except ImportError:  # pragma: no cover
    from atomizer import atomize
    from brain_fallback import generate_fallback_epic
    from common import _github_bearer_value, atomic_write_text, env_paths, gh_request, heartbeat_path, load_forge_state, now_iso, save_forge_state, setup_logging
    from courier import process_result
    from cursorexec import run_atom as run_cursor_atom
    from degradation import get_available
    from epic_socket import accept_epic_event, ensure_listener
    from epicwatcher import fetch_epic, watch_once
    from parallel_executor import build_waves, run_waves_sequential
    from qwenexec import run_atom as run_qwen_atom
    from reviewer import review
    from retrospective import finalize_epic
    from router import choose_executor

LOG = setup_logging("forge")
_NO_EXECUTOR_WARN_EMITTED = False


def _origin_is_ssh(url: str) -> bool:
    u = url.strip()
    return u.startswith("git@") or u.startswith("ssh://")


def _git_pull_rebase_argv() -> list[str]:
    argv = ["pull", "--rebase"]
    if os.environ.get("FORGE_GIT_PULL_AUTOSTASH", "1").lower() not in ("0", "false", "no"):
        argv.append("--autostash")
    return argv


def _git_pull_project(dry_run: bool) -> None:
    if dry_run:
        LOG.info("[dry-run] Would run: git pull --rebase")
        return
    project = Path(env_paths()["OSNOVA_PROJECT"])
    paths = env_paths()
    token = _github_bearer_value(paths.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN", ""))
    ghrepo = paths.get("GHREPO", "mmpfrmvbg/osnova-fabrica").strip()
    pat_only = os.environ.get("FORGE_GIT_PULL_PAT_ONLY", "").lower() in ("1", "true", "yes")

    run_env = os.environ.copy()
    run_env["GIT_TERMINAL_PROMPT"] = "0"
    git_no_prompt = ["git", "-c", "credential.helper="]
    proc: subprocess.CompletedProcess[str] | None = None
    try:
        if not pat_only:
            proc = subprocess.run(
                ["git", *_git_pull_rebase_argv()],
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
                git_no_prompt + _git_pull_rebase_argv(),
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
    atomic_write_text(heartbeat_path(), now_iso() + "\n")


def _alert_executors_halt(dry_run: bool) -> None:
    LOG.critical(
        "All executors unavailable — halting cycle (install Qwen/Cursor, set QWENBIN/CURSORBIN, "
        "or set FORGE_ALLOW_NO_EXECUTORS=1 / on Windows omit FORGE_STRICT_EXECUTORS to continue)"
    )
    if dry_run:
        return
    repo = env_paths()["GHREPO"]
    token = _github_bearer_value(env_paths().get("GH_TOKEN", ""))
    if not token or len(token) < 8:
        LOG.warning("Skip executor-halt GitHub issue: set GH_TOKEN or GITHUB_TOKEN (repo scope)")
        return
    try:
        gh_request(
            "POST",
            f"/repos/{repo}/issues",
            {
                "title": "[FORGE] All executors down (Qwen + Cursor)",
                "body": "degradation probe: no Qwen and no Cursor. Check tooling on the forge host.",
                "labels": ["P0", "forge-alert", "blocker"],
            },
        )
    except Exception as exc:
        LOG.warning("Could not open executor-halt issue: %s", exc)


def _resolve_epic(state: dict[str, Any], dry_run: bool) -> dict[str, Any] | None:
    epic = watch_once()
    if epic:
        state["brain_source"] = "perplexity"
        return epic
    if dry_run:
        state["brain_source"] = "idle"
        return None
    evt = accept_epic_event()
    if evt and evt.get("issue_number") is not None:
        try:
            epic = fetch_epic(int(evt["issue_number"]))
            state["brain_source"] = "perplexity"
            return epic
        except Exception as exc:
            LOG.warning("Epic socket fetch failed: %s", exc)
    epic = watch_once()
    if epic:
        state["brain_source"] = "perplexity"
        return epic
    fb = generate_fallback_epic(state)
    if fb:
        fb["githubissue"] = None
        state["brain_source"] = "fallback-local"
        return fb
    state["brain_source"] = "idle"
    return None


def _process_epic(epic: dict[str, Any], state: dict[str, Any], dry_run: bool, avail: dict[str, Any]) -> None:
    state["current_epic"] = epic.get("id")
    state["current_epic_issue"] = epic.get("githubissue")
    save_forge_state(state)
    atoms = atomize(epic, dry_run=dry_run)
    waves = build_waves(sorted(atoms, key=lambda x: int(x.get("seq", 0))))
    LOG.info("EPIC %s waves: %s", epic.get("id"), [[a.get("id") for a in w] for w in waves])
    results: list[dict[str, Any]] = []

    def _run_one(atom: dict[str, Any]) -> None:
        executor = choose_executor(atom, avail)
        atom["executor"] = executor
        if executor == "none":
            report = {
                "id": atom.get("id"),
                "s": "BLK",
                "err": "No executor available",
                "changed": [],
            }
            process_result(atom, report, dry_run=dry_run)
            results.append(report)
            return
        if executor == "qwen":
            success, report = run_qwen_atom(atom, dry_run=dry_run)
        else:
            success, report = run_cursor_atom(atom, dry_run=dry_run)
        passed, reason, elapsed = review(atom, dry_run=dry_run)
        report["review"] = {"passed": passed, "reason": reason, "elapsed": elapsed}
        report["s"] = "OK" if (success and passed) else "BLK"
        process_result(atom, report, dry_run=dry_run)
        results.append(report)

    run_waves_sequential(waves, _run_one)
    finalize_epic(epic, results, dry_run=dry_run, forge_state=state)
    state["current_epic"] = None
    state["current_epic_issue"] = None
    save_forge_state(state)


def cycle(dry_run: bool = False) -> None:
    _heartbeat()
    _git_pull_project(dry_run=dry_run)
    state = load_forge_state()
    save_forge_state(state)

    if state.get("paused"):
        LOG.info("Forge paused")
        return

    if dry_run:
        avail = {"qwen": True, "cursor": True, "healthy": True, "executors": ["qwen", "cursor"]}
    else:
        avail = get_available()

    raw_allow = os.environ.get("FORGE_ALLOW_NO_EXECUTORS", "").strip().lower()
    strict = os.environ.get("FORGE_STRICT_EXECUTORS", "").strip().lower() in ("1", "true", "yes")
    if raw_allow in ("1", "true", "yes"):
        allow_no_exec = True
    elif raw_allow in ("0", "false", "no"):
        allow_no_exec = False
    elif sys.platform == "win32" and not strict:
        allow_no_exec = True
    else:
        allow_no_exec = False

    if not avail.get("healthy"):
        if allow_no_exec:
            global _NO_EXECUTOR_WARN_EMITTED
            if not _NO_EXECUTOR_WARN_EMITTED:
                LOG.warning(
                    "No Qwen/Cursor in PATH — continuing this cycle. "
                    "ATM/atomizer will fail until tools exist or QWENBIN/CURSORBIN are set. "
                    "Set FORGE_STRICT_EXECUTORS=1 on Windows to halt instead."
                )
                _NO_EXECUTOR_WARN_EMITTED = True
        else:
            _alert_executors_halt(dry_run=dry_run)
            time.sleep(60)
            return

    epic = _resolve_epic(state, dry_run=dry_run)
    if not epic:
        LOG.info("No EPIC in queue (brain_source=%s)", state.get("brain_source"))
        save_forge_state(state)
        return

    state["last_epic_received_at"] = now_iso()
    save_forge_state(state)

    if dry_run:
        LOG.info("[dry-run] EPIC picked: %s (%s)", epic.get("id"), state.get("brain_source"))

    _process_epic(epic, state, dry_run=dry_run, avail=avail)


def main() -> None:
    parser = argparse.ArgumentParser(description="OSNOVA Forge loop (v5.2 resilient)")
    parser.add_argument("--dry-run", action="store_true", help="Run one cycle without external execution")
    args = parser.parse_args()
    ensure_listener()
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
