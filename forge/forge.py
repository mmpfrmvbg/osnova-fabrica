from __future__ import annotations

import argparse
import os
import subprocess
import sys
import threading
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

try:
    from forge.atomizer import _normalize_deps_list, atomize
    from forge.atm_store import (
        apply_report_to_atom,
        build_retry_context,
        get_pending_atms,
        load_all_atms_from_disk,
        mark_epic_complete_in_state_yaml,
        max_retries_for_atom,
        all_atms_successfully_done,
        normalize_atm_status,
        save_atm_yaml,
        set_atom_in_progress,
        should_skip_atomize,
    )
    from forge.blk_classify import classify_blk
    from forge.brain_context import build_brain_context, decide_brain_action, resume_epic_if_pending
    from forge.codebase_state import merge_codebase_into_state_yaml
    from forge.worktree_manager import cleanup_stale_worktrees
    from forge.brain_fallback import generate_fallback_epic
    from forge.common import (
        SUBPROCESS_TEXT,
        _github_bearer_value,
        atomic_write_text,
        ensure_stdio_utf8,
        env_paths,
        epic_queue_path,
        forge_dotenv_setting,
        gh_request,
        heartbeat_path,
        load_forge_state,
        now_iso,
        save_forge_state,
        setup_logging,
    )
    from forge.courier import git_commit_atm_report, process_result
    from forge.cursorexec import run_atom as run_cursor_atom
    from forge.degradation import get_available
    from forge.epic_socket import accept_epic_event, ensure_listener
    from forge.epicwatcher import fetch_epic, poll_next_github_epic, watch_once
    from forge.parallel_executor import (
        cleanup_wave_worktrees,
        compute_epic_waves,
        effective_max_parallel,
        execute_wave_parallel,
        forge_wave_max_workers,
        forge_wave_parallel_enabled,
        integrate_wave_branches,
        parallel_workers,
        prepare_wave_worktrees,
        state_yaml_stashed_for_wave,
        wave_scopes_overlap,
    )
    from forge.qwenexec import run_atom as run_qwen_atom
    from forge.reviewer import review
    from forge.humanlog import epic_done_tests, epic_start_snapshot, hlog
    from forge.retrospective import finalize_epic
    from forge.router import choose_executor
except ImportError:  # pragma: no cover
    from atomizer import _normalize_deps_list, atomize
    from atm_store import (
        apply_report_to_atom,
        build_retry_context,
        get_pending_atms,
        load_all_atms_from_disk,
        mark_epic_complete_in_state_yaml,
        max_retries_for_atom,
        all_atms_successfully_done,
        normalize_atm_status,
        save_atm_yaml,
        set_atom_in_progress,
        should_skip_atomize,
    )
    from blk_classify import classify_blk
    from brain_context import build_brain_context, decide_brain_action, resume_epic_if_pending
    from codebase_state import merge_codebase_into_state_yaml
    from worktree_manager import cleanup_stale_worktrees
    from brain_fallback import generate_fallback_epic
    from common import (
        SUBPROCESS_TEXT,
        _github_bearer_value,
        atomic_write_text,
        ensure_stdio_utf8,
        env_paths,
        epic_queue_path,
        forge_dotenv_setting,
        gh_request,
        heartbeat_path,
        load_forge_state,
        now_iso,
        save_forge_state,
        setup_logging,
    )
    from courier import git_commit_atm_report, process_result
    from cursorexec import run_atom as run_cursor_atom
    from degradation import get_available
    from epic_socket import accept_epic_event, ensure_listener
    from epicwatcher import fetch_epic, poll_next_github_epic, watch_once
    from parallel_executor import (
        cleanup_wave_worktrees,
        compute_epic_waves,
        effective_max_parallel,
        execute_wave_parallel,
        forge_wave_max_workers,
        forge_wave_parallel_enabled,
        integrate_wave_branches,
        parallel_workers,
        prepare_wave_worktrees,
        state_yaml_stashed_for_wave,
        wave_scopes_overlap,
    )
    from qwenexec import run_atom as run_qwen_atom
    from reviewer import review
    from humanlog import epic_done_tests, epic_start_snapshot, hlog
    from retrospective import finalize_epic
    from router import choose_executor

LOG = setup_logging("forge")
_NO_EXECUTOR_WARN_EMITTED = False

OnAtomUpdate = Callable[[str, str, Any], None]


def _persist_merge_conflict_atom(
    project: Path,
    atom: dict[str, Any],
    rep: dict[str, Any],
    dry_run: bool,
) -> None:
    if str(rep.get("s") or "").upper() != "MERGE_CONFLICT":
        return
    apply_report_to_atom(atom, rep)
    save_atm_yaml(project, atom, dry_run=dry_run)


def _atm_commit_or_process(
    atom: dict[str, Any],
    report: dict[str, Any],
    dry_run: bool,
    defer_process_result: bool,
) -> None:
    """Parallel worktree workers: commit only + parent ``process_result(..., state_only=True)`` later."""
    if defer_process_result:
        if not dry_run:
            git_commit_atm_report(Path(env_paths()["OSNOVA_PROJECT"]), atom, report, dry_run=False)
    else:
        process_result(atom, report, dry_run=dry_run)


def resolve_atoms_for_epic(epic: dict[str, Any], dry_run: bool) -> list[dict[str, Any]]:
    project = Path(env_paths()["OSNOVA_PROJECT"])
    if dry_run:
        return atomize(epic, dry_run=True)
    if should_skip_atomize(project, epic):
        loaded = load_all_atms_from_disk(project, str(epic["id"]))
        if loaded:
            epic_id = str(epic["id"])
            known = {str(a["id"]) for a in loaded}
            for a in loaded:
                a["deps"] = _normalize_deps_list(a.get("deps"), epic_id, known)
            LOG.info("EPIC %s: loaded %s ATM from disk (skip atomize)", epic_id, len(loaded))
            return loaded
    return atomize(epic, dry_run=False)


def _synthetic_results_from_stored_atms(atoms_sorted: list[dict[str, Any]]) -> list[dict[str, Any]]:
    r: list[dict[str, Any]] = []
    for a in atoms_sorted:
        st = normalize_atm_status(a.get("status", "todo"))
        if st in ("done", "superseded", "obsolete", "review_mismatch"):
            pf = a.get("produced_files")
            r.append(
                {
                    "id": a.get("id"),
                    "s": "OK",
                    "changed": pf if isinstance(pf, list) else [],
                }
            )
        else:
            r.append(
                {
                    "id": a.get("id"),
                    "s": "BLK",
                    "err": str(a.get("last_failure") or "BLK"),
                    "changed": [],
                }
            )
    return r


def _execute_atom_with_retries(
    atom: dict[str, Any],
    epic: dict[str, Any],
    state: dict[str, Any],
    dry_run: bool,
    avail: dict[str, Any],
    epic_issue: Any,
    atm_total: int,
    on_update: OnAtomUpdate | None = None,
    *,
    defer_process_result: bool = False,
) -> dict[str, Any]:
    """One ATM: executor + review + process_result path (extracted from _process_epic._run_one)."""
    aid = atom.get("id")
    project = Path(env_paths()["OSNOVA_PROJECT"])
    executor = choose_executor(atom, avail)
    atom["executor"] = executor
    mr = max_retries_for_atom(atom)
    safety_cap = max(25, mr + 5)

    def _failure_reason(rep: dict[str, Any], review_passed: bool, review_reason: str) -> str:
        if isinstance(rep.get("review"), dict) and rep["review"].get("reason"):
            return str(rep["review"]["reason"])
        return str(rep.get("err") or review_reason or "BLK")

    if int(atom.get("retries") or 0) >= mr:
        report = {
            "id": atom.get("id"),
            "s": "BLK",
            "err": str(atom.get("last_failure") or "max_retries exhausted"),
            "changed": [],
            "review": {"passed": False, "reason": "skipped — retries exhausted", "elapsed": 0},
        }
        apply_report_to_atom(atom, report)
        save_atm_yaml(project, atom, dry_run=dry_run)
        if not defer_process_result:
            _bump_issue_attempts_on_permanent_blk(state, epic_issue)
        _atm_commit_or_process(atom, report, dry_run, defer_process_result)
        if on_update:
            on_update(str(aid or ""), "BLK", report)
        return report

    attempt = 0
    while attempt < safety_cap:
        attempt += 1
        set_atom_in_progress(atom)
        if not dry_run:
            sha = _git_rev_parse_head(project)
            if sha:
                atom["review_base_sha"] = sha
        save_atm_yaml(project, atom, dry_run=dry_run)
        if on_update:
            on_update(str(aid or ""), "RUN", atom)
        hlog(
            "atm_start",
            atm_id=aid,
            seq=int(atom.get("seq") or 0),
            atm_total=atm_total,
            goal=str(atom.get("goal", "")),
        )
        LOG.info(
            "ATM %s — executor=%s forge attempt %s (max_retries=%s)",
            aid,
            atom["executor"],
            attempt,
            mr,
        )
        ex = atom["executor"]
        if ex == "none":
            report = {
                "id": atom.get("id"),
                "s": "BLK",
                "err": "No executor available",
                "changed": [],
            }
            apply_report_to_atom(atom, report)
            save_atm_yaml(project, atom, dry_run=dry_run)
            if not defer_process_result:
                _bump_issue_attempts_on_permanent_blk(state, epic_issue)
            _atm_commit_or_process(atom, report, dry_run, defer_process_result)
            if on_update:
                on_update(str(aid or ""), str(report.get("s", "BLK")), report)
            return report
        if ex == "qwen":
            success, report = run_qwen_atom(atom, dry_run=dry_run)
            fb_raw = forge_dotenv_setting("FORGE_QWEN_CURSOR_FALLBACK", "").strip()
            if not fb_raw:
                fb_raw = forge_dotenv_setting("FORGE_QWEN_QUOTA_FALLBACK", "1").strip()
            fb = fb_raw.lower()
            want_cursor_fb = (
                fb not in ("0", "false", "no")
                and avail.get("cursor")
                and not report.get("forge_done_cmd_invalid")
                and (
                    report.get("forge_retry_executor") == "cursor"
                    or str(report.get("s") or "").strip().upper() == "BLK"
                )
            )
            if want_cursor_fb:
                LOG.warning("ATM %s — Qwen BLK, falling back to Cursor", aid)
                why = str(report.get("err") or "").strip() or "(no err in report)"
                if len(why) > 600:
                    why = why[:520] + "…(" + str(len(why)) + " chars)"
                LOG.warning("ATM %s — Qwen report err: %s", aid, why)
                atom["executor"] = "cursor"
                success, report = run_cursor_atom(atom, dry_run=dry_run)
                report.pop("forge_retry_executor", None)
            elif report.get("forge_done_cmd_invalid"):
                LOG.warning(
                    "ATM %s — invalid done command paths (ATM_DONE_CMD_INVALID), skipping Cursor fallback",
                    aid,
                )
                report.setdefault(
                    "review",
                    {"passed": False, "reason": str(report.get("err") or ""), "elapsed": 0},
                )
                apply_report_to_atom(atom, report)
                save_atm_yaml(project, atom, dry_run=dry_run)
                _atm_commit_or_process(atom, report, dry_run, defer_process_result)
                if on_update:
                    on_update(str(aid or ""), "WARN", report)
                return report
        else:
            success, report = run_cursor_atom(atom, dry_run=dry_run)
        LOG.info(
            "ATM %s — executor finished (report s=%s), starting review",
            aid,
            report.get("s"),
        )
        exec_report_ok = str(report.get("s") or "").strip().upper() == "OK"
        run_done = exec_report_ok
        skip_done = False
        if exec_report_ok and report.get("reviewer_skip_done") and str(atom.get("executor") or "").lower() == "qwen":
            # Default 0: re-run done in reviewer so git/diff and vitest match post-commit tree (avoids false ❌).
            skip_raw = forge_dotenv_setting("FORGE_REVIEWER_SKIP_DONE_AFTER_QWEN", "0").strip().lower()
            skip_done = skip_raw not in ("0", "false", "no")
        if not run_done:
            LOG.info(
                "ATM %s — review fast-path (success=%s report.s=%s)",
                aid,
                success,
                report.get("s"),
            )
        passed, reason, elapsed, verdict, review_extras = review(
            atom,
            dry_run=dry_run,
            run_done=run_done,
            skip_done_command=skip_done,
            executor_report=report,
        )
        report["review"] = {"passed": passed, "reason": reason, "elapsed": elapsed}
        if review_extras:
            report["review"].update(review_extras)
        if verdict == "review_mismatch":
            report["s"] = "REVIEW_MISMATCH"
        else:
            report["s"] = "OK" if (success and passed) else "BLK"
        LOG.info("ATM %s — review done passed=%s elapsed=%ss", aid, passed, elapsed)
        if report.get("s") == "OK":
            hlog("atm_ok", atm_id=aid, elapsed_s=elapsed)
            apply_report_to_atom(atom, report)
            save_atm_yaml(project, atom, dry_run=dry_run)
            _atm_commit_or_process(atom, report, dry_run, defer_process_result)
            if on_update:
                on_update(str(aid or ""), "OK", report)
            return report
        if report.get("s") == "REVIEW_MISMATCH":
            hlog("atm_ok", atm_id=aid, elapsed_s=elapsed)
            apply_report_to_atom(atom, report)
            save_atm_yaml(project, atom, dry_run=dry_run)
            _atm_commit_or_process(atom, report, dry_run, defer_process_result)
            if on_update:
                on_update(str(aid or ""), "REVIEW_MISMATCH", report)
            return report
        hlog(
            "atm_blk",
            atm_id=aid,
            reason=str(report.get("err") or report.get("review") or "BLK"),
        )
        kind = classify_blk(
            exec_report_ok=exec_report_ok,
            review_passed=passed,
            report=report,
        )
        prev_reason = _failure_reason(report, passed, reason)
        atom["retries"] = int(atom.get("retries") or 0) + 1
        atom["retry_context"] = build_retry_context(atom, int(atom["retries"]) + 1, prev_reason)
        apply_report_to_atom(atom, report)
        save_atm_yaml(project, atom, dry_run=dry_run)
        if kind == "transient" and int(atom["retries"]) < mr:
            LOG.warning(
                "ATM %s — transient BLK, yaml retries=%s/%s forge loop attempt=%s",
                aid,
                atom["retries"],
                mr,
                attempt,
            )
            continue
        if kind == "permanent" and not defer_process_result:
            _bump_issue_attempts_on_permanent_blk(state, epic_issue)
        _atm_commit_or_process(atom, report, dry_run, defer_process_result)
        if on_update:
            on_update(str(aid or ""), str(report.get("s", "BLK")), report)
        return report
    report = {
        "id": aid,
        "s": "BLK",
        "err": "max iterations exceeded",
    }
    apply_report_to_atom(atom, report)
    save_atm_yaml(project, atom, dry_run=dry_run)
    if on_update:
        on_update(str(aid or ""), "BLK", report)
    return report


def _parallel_atom_worker(payload: tuple[Any, ...]) -> dict[str, Any]:
    """Top-level entry for ``ProcessPoolExecutor`` (required for Windows spawn)."""
    atom, epic, state, dry_run, avail, epic_issue, atm_total, worktree_path = payload
    os.environ["OSNOVA_PROJECT"] = str(worktree_path)
    os.environ["FORGE_SKIP_GIT_PUSH"] = "1"
    return _execute_atom_with_retries(
        atom,
        epic,
        state,
        dry_run,
        avail,
        epic_issue,
        atm_total,
        on_update=None,
        defer_process_result=True,
    )


# Idle backoff between cycles (cap 90s); does not change socket accept inside _resolve_epic.
IDLE_STEPS_SEC = [60, 60, 90, 90]


def _git_rev_parse_head(project: Path) -> str:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=project,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
            **SUBPROCESS_TEXT,
        )
        if out.returncode == 0 and (out.stdout or "").strip():
            return (out.stdout or "").strip()
    except Exception:
        pass
    return ""


def _maybe_abandon_stale_epic(state: dict[str, Any]) -> None:
    """Clear stale lock after FORGE_EPIC_TTL_SECONDS; comment + forge-stale on GitHub issue."""
    epic_id = state.get("current_epic")
    started = state.get("current_epic_started_at")
    issue = state.get("current_epic_issue")
    if not epic_id or not started:
        return
    ttl = int(forge_dotenv_setting("FORGE_EPIC_TTL_SECONDS", str(3 * 3600)))
    try:
        t0 = datetime.fromisoformat(str(started).replace("Z", "+00:00"))
        if t0.tzinfo is None:
            t0 = t0.replace(tzinfo=timezone.utc)
        age = (datetime.now(timezone.utc) - t0.astimezone(timezone.utc)).total_seconds()
    except Exception:
        return
    if age <= float(ttl):
        return
    LOG.warning("[TTL] EPIC %s expired after %.0fs — abandoning lock", epic_id, age)
    repo = env_paths()["GHREPO"]
    if issue:
        try:
            body = (
                f"⚠️ **FORGE ABANDONED**: TTL ({ttl // 3600}h) exceeded. "
                "No RETRO produced for this run. Label `forge-stale`."
            )
            gh_request("POST", f"/repos/{repo}/issues/{issue}/comments", {"body": body})
            gh_request("POST", f"/repos/{repo}/issues/{issue}/labels", {"labels": ["forge-stale"]})
        except Exception as exc:
            LOG.warning("TTL abandon GitHub: %s", exc)
    state["current_epic"] = None
    state["current_epic_issue"] = None
    state["current_epic_started_at"] = None
    state["epic_popped_from_queue"] = False
    save_forge_state(state)


def _bump_issue_attempts_on_permanent_blk(state: dict[str, Any], issue_num: int | None) -> None:
    if issue_num is None:
        return
    key = str(int(issue_num))
    attempts = state.setdefault("issue_attempts", {})
    n = int(attempts.get(key, 0) or 0) + 1
    attempts[key] = n
    save_forge_state(state)
    threshold = int(forge_dotenv_setting("FORGE_ISSUE_ATTEMPTS_MAX", "3"))
    if n < threshold:
        return
    repo = env_paths()["GHREPO"]
    try:
        gh_request(
            "POST",
            f"/repos/{repo}/issues/{int(issue_num)}/labels",
            {"labels": ["retry-exhausted"]},
        )
    except Exception as exc:
        LOG.warning("Could not add retry-exhausted label: %s", exc)


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
                **SUBPROCESS_TEXT,
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
            **SUBPROCESS_TEXT,
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
                **SUBPROCESS_TEXT,
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


def _snapshot_epic_queue_lines() -> list[str]:
    q = epic_queue_path()
    if not q.exists():
        return []
    text = q.read_text(encoding="utf-8-sig")
    return [x.strip().lstrip("\ufeff") for x in text.splitlines() if x.strip()]


def _merge_epic_queue_after_git_pull(pre_lines: list[str]) -> None:
    """`git pull` replaces tracked forge/epic-queue.txt; re-apply lines that only existed locally."""
    if not pre_lines:
        return
    q = epic_queue_path()
    if not q.exists():
        q.parent.mkdir(parents=True, exist_ok=True)
        post_lines: list[str] = []
    else:
        raw = q.read_text(encoding="utf-8-sig")
        post_lines = [x.strip().lstrip("\ufeff") for x in raw.splitlines() if x.strip()]
    post_set = set(post_lines)
    lost = [x for x in pre_lines if x not in post_set]
    if not lost:
        return
    merged = lost + [x for x in post_lines if x not in set(lost)]
    q.write_text("\n".join(merged) + ("\n" if merged else ""), encoding="utf-8")
    LOG.info(
        "epic-queue: restored local issue row(s) %s after git pull — "
        "push queue to origin or GHA will overwrite on next intake",
        lost,
    )


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
    state["epic_popped_from_queue"] = False
    if not dry_run:
        try:
            resumed = resume_epic_if_pending()
            if resumed:
                state["brain_source"] = "resume_disk"
                LOG.info("[BRAIN] CONTINUE — resume EPIC %s from disk", resumed.get("id"))
                return resumed
        except Exception as exc:
            LOG.warning("resume_epic_if_pending failed: %s", exc)
    cur_issue = state.get("current_epic_issue")
    epic = watch_once()
    if epic:
        state["brain_source"] = "queue"
        state["epic_popped_from_queue"] = True
        return epic
    if dry_run:
        state["brain_source"] = "idle"
        return None
    evt = accept_epic_event()
    if evt and evt.get("issue_number") is not None:
        try:
            epic = fetch_epic(int(evt["issue_number"]))
            state["brain_source"] = "socket"
            return epic
        except Exception as exc:
            LOG.warning("Epic socket fetch failed: %s", exc)
    epic = watch_once()
    if epic:
        state["brain_source"] = "queue"
        state["epic_popped_from_queue"] = True
        return epic
    try:
        epic = poll_next_github_epic(cur_issue)
        if epic:
            state["brain_source"] = "github_poll"
            return epic
    except Exception as exc:
        LOG.warning("github_poll failed: %s", exc)
    fb = generate_fallback_epic(state)
    if fb:
        fb["githubissue"] = None
        state["brain_source"] = "fallback_local"
        return fb
    state["brain_source"] = "idle"
    return None


def _process_epic(
    epic: dict[str, Any],
    state: dict[str, Any],
    dry_run: bool,
    avail: dict[str, Any],
    on_update: OnAtomUpdate | None = None,
) -> list[dict[str, Any]]:
    wave_par_eff = forge_dotenv_setting("FORGE_WAVE_PARALLEL", "0")
    LOG.info(
        "parallel_executor: FORGE_WAVE_PARALLEL effective=%r (process env unset=%s), wave_parallel_enabled=%s",
        wave_par_eff,
        os.environ.get("FORGE_WAVE_PARALLEL") is None,
        forge_wave_parallel_enabled(),
    )
    state["current_epic"] = epic.get("id")
    state["current_epic_issue"] = epic.get("githubissue")
    state["current_epic_started_at"] = now_iso()
    save_forge_state(state)

    # cycle() only touches heartbeat at loop start; atomize / smith / qwen can block for many minutes.
    # Pulse while the epic runs so heart.py does not report a false stale Forge.
    hb_thread: threading.Thread | None = None
    hb_stop: threading.Event | None = None
    if not dry_run:
        _heartbeat()
        hb_stop = threading.Event()

        def _epic_heartbeat_pulse() -> None:
            assert hb_stop is not None
            while not hb_stop.wait(60.0):
                _heartbeat()

        hb_thread = threading.Thread(
            target=_epic_heartbeat_pulse, daemon=True, name="forge-epic-heartbeat"
        )
        hb_thread.start()
    results: list[dict[str, Any]] = []
    project = Path(env_paths()["OSNOVA_PROJECT"])
    try:
        atoms = resolve_atoms_for_epic(epic, dry_run=dry_run)
        atoms_sorted = sorted(atoms, key=lambda x: int(x.get("seq", 0)))
        pending = get_pending_atms(atoms_sorted)

        if not pending and atoms_sorted:
            LOG.info("EPIC %s: no pending ATM — all terminal (resume / already done)", epic.get("id"))
            synth = _synthetic_results_from_stored_atms(atoms_sorted)
            if not dry_run:
                mark_epic_complete_in_state_yaml(
                    project,
                    str(epic.get("id") or ""),
                    all_success=all_atms_successfully_done(atoms_sorted),
                )
            finalize_epic(
                epic,
                synth,
                dry_run=dry_run,
                forge_state=state,
                skip_session_stats=True,
            )
            state["current_epic"] = None
            state["current_epic_issue"] = None
            state["current_epic_started_at"] = None
            state["epic_popped_from_queue"] = False
            save_forge_state(state)
            return synth

        epic_start_snapshot()
        LOG.info(
            "EPIC %s: %s ATM total, %s pending (resume-aware)",
            epic.get("id"),
            len(atoms_sorted),
            len(pending),
        )
        hlog(
            "epic_start",
            epic_id=epic.get("id"),
            goal=str(epic.get("goal", "")),
            atm_total=len(atoms_sorted),
        )
        cap = effective_max_parallel()
        waves = compute_epic_waves(epic, atoms_sorted, pending, max_parallel=cap)
        LOG.info("EPIC %s waves: %s", epic.get("id"), [[a.get("id") for a in w] for w in waves])
        if (
            len(pending) > 1
            and len(waves) == len(pending)
            and all(len(w) == 1 for w in waves)
        ):
            LOG.info(
                "parallel_executor: one ATM per wave — usually linear deps between pending ATMs or scope "
                "conflicts under cap=%s. Missing atomizer_meta does not force this; meta only skips re-atomize. "
                "Override with epic['waves'] or relax deps/scopes.",
                cap,
            )
        atm_total = len(atoms_sorted)
        epic_issue = epic.get("githubissue")
        pw = parallel_workers()

        def _run_one(atom: dict[str, Any]) -> None:
            report = _execute_atom_with_retries(
                atom,
                epic,
                state,
                dry_run,
                avail,
                epic_issue,
                atm_total,
                on_update=on_update,
            )
            results.append(report)

        for wi, wave in enumerate(waves):
            LOG.info(
                "EPIC %s wave %s/%s: %s",
                epic.get("id"),
                wi + 1,
                len(waves),
                [a.get("id") for a in wave],
            )
            LOG.info(
                "parallel_executor: wave %d scopes_overlap=%s",
                wi + 1,
                wave_scopes_overlap(wave),
            )
            if forge_wave_parallel_enabled() and len(wave) > 1 and not dry_run:

                def _wave_run(atom: dict[str, Any], cwd: Path) -> dict[str, Any]:
                    defer = cwd.resolve() != project.resolve()
                    return _execute_atom_with_retries(
                        atom,
                        epic,
                        state,
                        dry_run,
                        avail,
                        epic_issue,
                        atm_total,
                        on_update=on_update,
                        defer_process_result=defer,
                    )

                wave_reports = execute_wave_parallel(
                    wave,
                    wi,
                    epic,
                    project,
                    _wave_run,
                    max_workers=forge_wave_max_workers(),
                    dry_run=dry_run,
                )
                for rep in wave_reports:
                    results.append(rep)
                if not dry_run:
                    subprocess.run(
                        ["git", "push", "origin", "main"],
                        cwd=project,
                        capture_output=True,
                        text=True,
                        timeout=120,
                        check=False,
                        **SUBPROCESS_TEXT,
                    )
                for atom, rep in zip(wave, wave_reports, strict=True):
                    _persist_merge_conflict_atom(project, atom, rep, dry_run)
                    process_result(atom, rep, dry_run=dry_run, state_only=True)
                continue

            use_parallel = not dry_run and len(wave) > 1 and pw > 1
            if not use_parallel:
                if len(wave) > 1 and pw > 1 and not dry_run and wave_scopes_overlap(wave):
                    LOG.warning("scope overlap in wave — sequential (FORGE_PARALLEL_WORKERS=1 or single worker)")
                for atom in wave:
                    _run_one(atom)
                continue

            wt: list[tuple[Path, str]] = []
            with state_yaml_stashed_for_wave(project):
                try:
                    wt = prepare_wave_worktrees(project, len(wave), str(epic.get("id") or "epic"), wi + 1)
                    branches = [b for _, b in wt]
                    futs: dict[Any, int] = {}
                    with ProcessPoolExecutor(max_workers=len(wave)) as pool:
                        for idx, atom in enumerate(wave):
                            payload = (
                                atom,
                                epic,
                                state,
                                dry_run,
                                avail,
                                epic_issue,
                                atm_total,
                                str(wt[idx][0]),
                            )
                            fut = pool.submit(_parallel_atom_worker, payload)
                            futs[fut] = idx
                        chunk: dict[int, dict[str, Any]] = {}
                        for fut in as_completed(futs):
                            chunk[futs[fut]] = fut.result()
                        ordered_reports = [chunk[i] for i in sorted(chunk)]
                    for rep in ordered_reports:
                        results.append(rep)
                    if not dry_run:
                        integrate_wave_branches(project, branches)
                        subprocess.run(
                            ["git", "push", "origin", "main"],
                            cwd=project,
                            capture_output=True,
                            text=True,
                            timeout=120,
                            check=False,
                            **SUBPROCESS_TEXT,
                        )
                    for atom, rep in zip(wave, ordered_reports, strict=True):
                        _persist_merge_conflict_atom(project, atom, rep, dry_run)
                        process_result(atom, rep, dry_run=dry_run, state_only=True)
                finally:
                    if wt and not dry_run:
                        cleanup_wave_worktrees(project, [p for p, _ in wt])
        finalize_epic(epic, results, dry_run=dry_run, forge_state=state)
        state["current_epic"] = None
        state["current_epic_issue"] = None
        state["current_epic_started_at"] = None
        state["epic_popped_from_queue"] = False
        save_forge_state(state)
    finally:
        if hb_stop is not None:
            hb_stop.set()
        if hb_thread is not None:
            hb_thread.join(timeout=5.0)
        if not dry_run:
            _heartbeat()
    return results


def run_epic_from_dict(
    epic_data: dict[str, Any],
    dry_run: bool = False,
    on_update: OnAtomUpdate | None = None,
) -> dict[str, Any]:
    """
    Run one EPIC from an in-memory dict (CLI / tests). Uses the same pipeline as the forge loop.
    """
    started = time.time()
    state = load_forge_state()
    if dry_run:
        avail = {"qwen": True, "cursor": True, "healthy": True, "executors": ["qwen", "cursor"]}
    else:
        avail = get_available()
    try:
        results = _process_epic(epic_data, state, dry_run, avail, on_update=on_update)
    except Exception as e:
        LOG.exception("run_epic_from_dict failed")
        return {
            "error": str(e),
            "ok_count": 0,
            "blk_count": 0,
            "total": 0,
            "epic_id": epic_data.get("id"),
            "elapsed_s": round(time.time() - started, 1),
            "atms": [],
        }
    ok = sum(1 for r in results if r.get("s") in ("OK", "REVIEW_MISMATCH"))
    return {
        "ok_count": ok,
        "blk_count": len(results) - ok,
        "total": len(results),
        "epic_id": epic_data.get("id"),
        "elapsed_s": round(time.time() - started, 1),
        "atms": results,
    }


def run_single_atm(
    goal: str,
    scope: list[str],
    done: str,
    executor: str = "auto",
) -> dict[str, Any]:
    """Single ATM without atomizer (`osnova do`)."""
    state = load_forge_state()
    avail = get_available()
    ts = int(time.time())
    atom: dict[str, Any] = {
        "id": f"ATM-LOCAL-{ts}",
        "goal": goal,
        "scope": scope or [],
        "done": done,
        "executor": executor,
        "seq": 1,
        "priority": "P2",
        "risk": "LOW",
        "zone": "lang",
        "steps": [],
        "deps": [],
    }
    epic = {"id": f"EPK-LOCAL-{ts}", "goal": goal, "githubissue": None, "t": "EPK"}
    return _execute_atom_with_retries(
        atom,
        epic,
        state,
        dry_run=False,
        avail=avail,
        epic_issue=None,
        atm_total=1,
        on_update=None,
    )


def cycle(dry_run: bool = False) -> str:
    """Run one forge iteration. Returns cycle result label for backoff / metrics."""
    project = Path(env_paths()["OSNOVA_PROJECT"])
    _heartbeat()
    pre_queue = _snapshot_epic_queue_lines()
    q_before = len(pre_queue)
    sha_before = _git_rev_parse_head(project) if not dry_run else ""
    _git_pull_project(dry_run=dry_run)
    if not dry_run:
        _merge_epic_queue_after_git_pull(pre_queue)
    sha_after = _git_rev_parse_head(project) if not dry_run else ""
    if not dry_run:
        try:
            cleanup_stale_worktrees(project)
        except Exception as exc:
            LOG.warning("cleanup_stale_worktrees: %s", exc)
    pulled = "noop"
    if not dry_run and sha_before and sha_after:
        pulled = "changed" if sha_before != sha_after else "noop"
    elif not dry_run and not sha_before:
        pulled = "changed" if sha_after else "noop"

    q_after = len(_snapshot_epic_queue_lines())
    state = load_forge_state()
    if state.get("current_epic") and state.get("current_epic_started_at") is None:
        state["current_epic_started_at"] = now_iso()
        save_forge_state(state)
    _maybe_abandon_stale_epic(state)
    state = load_forge_state()
    save_forge_state(state)

    brain_src = state.get("brain_source") or "idle"
    chosen_display = "-"

    def _log_cycle(result: str, src: str) -> None:
        LOG.info(
            "[CYCLE] pull=%s queue=%s→%s issue=%s result=%s source=%s",
            pulled,
            q_before,
            q_after,
            chosen_display,
            result,
            src,
        )

    if state.get("paused"):
        LOG.info("Forge paused")
        _log_cycle("paused", "idle")
        return "paused"

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
            _log_cycle("halted", brain_src)
            return "halted"

    if not dry_run:
        try:
            from forge.github_poller import poll_brain_epics_and_sync_state

            poll_brain_epics_and_sync_state()
        except Exception as exc:
            LOG.warning("github_poller failed: %s", exc)

    if not dry_run:
        try:
            proj = Path(env_paths()["OSNOVA_PROJECT"])
            merge_codebase_into_state_yaml(proj)
            bc = build_brain_context(proj)
            act = decide_brain_action(bc, project=proj)
            LOG.info(
                "[BRAIN] decision=%s — %s",
                act.get("decision"),
                act.get("decision_reason"),
            )
            state = load_forge_state()
            state["last_brain_decision"] = act.get("decision")
            save_forge_state(state)
        except Exception as exc:
            LOG.warning("brain_context failed: %s", exc)

    epic = _resolve_epic(state, dry_run=dry_run)
    brain_src = state.get("brain_source") or "idle"
    if not epic:
        idx = min(int(state.get("idle_streak_index", 0)) + 1, len(IDLE_STEPS_SEC) - 1)
        state["idle_streak_index"] = idx
        save_forge_state(state)
        LOG.info("No EPIC in queue (brain_source=%s)", brain_src)
        _log_cycle("idle", brain_src)
        return "idle"

    state["idle_streak_index"] = 0
    state["last_epic_received_at"] = now_iso()
    save_forge_state(state)

    chosen_display = str(epic.get("githubissue") or epic.get("id") or "-")
    brain_src = state.get("brain_source") or "idle"

    if dry_run:
        LOG.info("[dry-run] EPIC picked: %s (%s)", epic.get("id"), brain_src)
        _log_cycle("dry_run", brain_src)
        return "dry_run"

    try:
        _process_epic(epic, state, dry_run=dry_run, avail=avail)
    except Exception:
        LOG.exception("EPIC processing failed")
        _log_cycle("error", brain_src)
        return "error"
    _log_cycle("completed", brain_src)
    return "completed"


def main() -> None:
    ensure_stdio_utf8()
    parser = argparse.ArgumentParser(description="OSNOVA Forge loop (v5.3)")
    parser.add_argument("--dry-run", action="store_true", help="Run one cycle without external execution")
    args = parser.parse_args()
    ensure_listener()
    try:
        if args.dry_run:
            cycle(dry_run=True)
            return
        while True:
            result = cycle(dry_run=False)
            state = load_forge_state()
            idx = int(state.get("idle_streak_index", 0))
            sleep_s = IDLE_STEPS_SEC[min(idx, len(IDLE_STEPS_SEC) - 1)]
            if result == "paused":
                sleep_s = 60
            time.sleep(sleep_s)
    except KeyboardInterrupt:
        LOG.info("Forge stopped by user")
    except Exception as exc:
        LOG.exception("forge loop failed: %s", exc)


if __name__ == "__main__":
    main()
