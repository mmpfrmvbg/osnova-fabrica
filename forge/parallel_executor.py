from __future__ import annotations

import os
import re
import subprocess
from itertools import combinations
from pathlib import Path
from typing import Any, Callable

try:
    from forge.atomizer import _coerce_dep_to_atm_id
    from forge.common import SUBPROCESS_TEXT, setup_logging
except ImportError:  # pragma: no cover
    from atomizer import _coerce_dep_to_atm_id
    from common import SUBPROCESS_TEXT, setup_logging

LOG = setup_logging("parallel_executor")

MAX_PARALLEL = int(os.environ.get("OSNOVA_MAX_PARALLEL", "3"))


def effective_max_parallel() -> int:
    """``min(OSNOVA_MAX_PARALLEL, max(1, FORGE_PARALLEL_WORKERS))`` for wave width."""
    try:
        mp = int(os.environ.get("OSNOVA_MAX_PARALLEL", "3"))
    except ValueError:
        mp = 3
    try:
        fw = int(os.environ.get("FORGE_PARALLEL_WORKERS", "1"))
    except ValueError:
        fw = 1
    return min(max(1, mp), max(1, fw))


def parallel_workers() -> int:
    try:
        return max(1, int(os.environ.get("FORGE_PARALLEL_WORKERS", "1")))
    except ValueError:
        return 1


def _scopes(a: dict[str, Any]) -> set[str]:
    return {str(x) for x in (a.get("scope") or []) if x is not None}


def scope_conflicts_safe(a1: dict[str, Any], a2: dict[str, Any]) -> bool:
    s1, s2 = _scopes(a1), _scopes(a2)
    if not s1 or not s2:
        return False
    return bool(s1 & s2)


def wave_scopes_overlap(wave: list[dict[str, Any]]) -> bool:
    """True if some pair shares a non-empty scope intersection (insurance beyond :func:`build_waves`)."""
    for a, b in combinations(wave, 2):
        sa = {str(x) for x in (a.get("scope") or []) if x is not None}
        sb = {str(x) for x in (b.get("scope") or []) if x is not None}
        if sa and sb and (sa & sb):
            return True
    return False


def build_waves(atoms: list[dict[str, Any]], max_parallel: int | None = None) -> list[list[dict[str, Any]]]:
    """Topological waves by deps; inside wave, cap width with scope conflicts (v5.2)."""
    cap = max_parallel if max_parallel is not None else MAX_PARALLEL
    done_ids: set[str] = set()
    remaining = list(atoms)
    waves: list[list[dict[str, Any]]] = []

    while remaining:
        ready = [a for a in remaining if all(str(d) in done_ids for d in (a.get("deps") or []))]
        if not ready:
            LOG.warning("Unresolved ATM deps — running remaining sequentially")
            waves.append(list(remaining))
            break

        wave_group: list[dict[str, Any]] = []
        for atom in ready:
            conflict = any(scope_conflicts_safe(atom, a) for a in wave_group)
            if not conflict and len(wave_group) < cap:
                wave_group.append(atom)
        if not wave_group:
            wave_group = [ready[0]]

        waves.append(wave_group)
        for a in wave_group:
            done_ids.add(str(a["id"]))
            remaining.remove(a)

    return waves


def waves_from_epic_override(
    epic: dict[str, Any],
    atoms: list[dict[str, Any]],
) -> list[list[dict[str, Any]]] | None:
    """
    Если в EPIC задано поле ``waves`` (список волн, каждая волна — список ссылок на ATM),
    строим волны **только** по нему и **игнорируем** ``deps`` для порядка.

    Ссылки резолвятся через :func:`forge.atomizer._coerce_dep_to_atm_id` (полный id, seq, ``ATM-…`` и т.д.).
    При любой ошибке возвращаем ``None`` — вызывающий код падает обратно на :func:`build_waves`.
    """
    raw = epic.get("waves")
    if raw is None:
        return None
    if not isinstance(raw, list) or not raw:
        if raw == []:
            return None
        LOG.warning("parallel_executor: epic['waves'] must be a non-empty list — ignoring")
        return None
    by_id = {str(a["id"]): a for a in atoms}
    if not by_id:
        return None
    known = set(by_id.keys())
    eid = str(epic.get("id") or "").strip()
    out: list[list[dict[str, Any]]] = []
    for wi, wave in enumerate(raw):
        if not isinstance(wave, list):
            LOG.error(
                "parallel_executor: epic['waves'][%s] must be a list — falling back to deps-based waves",
                wi,
            )
            return None
        row: list[dict[str, Any]] = []
        for ref in wave:
            aid = _coerce_dep_to_atm_id(ref, eid, known)
            if aid not in by_id:
                LOG.error(
                    "parallel_executor: epic['waves'][%s] unknown ATM ref %r — falling back to deps-based waves",
                    wi,
                    ref,
                )
                return None
            row.append(by_id[aid])
        out.append(row)
    LOG.info(
        "parallel_executor: using epic['waves'] (%s wave(s)); ATM deps ignored for ordering",
        len(out),
    )
    return out


def _sanitize_branch_segment(s: str) -> str:
    t = re.sub(r"[^a-zA-Z0-9._/-]+", "-", str(s)).strip("-")
    return (t[:80] or "epic").replace("/", "-")


def _git_run(project: Path, argv: list[str], *, timeout: int = 120) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *argv],
        cwd=project,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
        **SUBPROCESS_TEXT,
    )


def prepare_wave_worktrees(
    project: Path,
    count: int,
    epic_id: str,
    wave_index: int,
) -> list[tuple[Path, str]]:
    """
    ``git worktree add`` for ``.forge-worker-1`` … ``.forge-worker-{count}`` with unique branches.
    Returns ``(path, branch)`` in order. Caller must ensure a clean main working tree when possible.
    """
    safe = _sanitize_branch_segment(epic_id)
    out: list[tuple[Path, str]] = []
    for i in range(1, count + 1):
        rel = Path(f".forge-worker-{i}")
        path = project / rel
        branch = f"forge/parallel/{safe}/w{wave_index}-wt{i}"
        proc = _git_run(project, ["worktree", "add", str(rel), "-b", branch, "HEAD"])
        if proc.returncode != 0:
            err = (proc.stderr or proc.stdout or "").strip()
            raise RuntimeError(f"git worktree add failed ({path}): {err}")
        out.append((path.resolve(), branch))
        LOG.info("parallel_executor: worktree %s branch %s", path, branch)
    return out


def cleanup_wave_worktrees(project: Path, paths: list[Path]) -> None:
    for p in paths:
        proc = _git_run(project, ["worktree", "remove", "--force", str(p.resolve())])
        if proc.returncode != 0:
            LOG.warning("git worktree remove failed %s: %s", p, (proc.stderr or proc.stdout or "").strip()[:200])


def integrate_wave_branches(project: Path, branches_ordered: list[str]) -> None:
    """Rebase each worker branch onto ``main``, then fast-forward merge into ``main`` (order matters)."""
    cur = _git_run(project, ["branch", "--show-current"])
    branch_now = (cur.stdout or "").strip()
    if branch_now != "main":
        sw = _git_run(project, ["checkout", "main"])
        if sw.returncode != 0:
            raise RuntimeError(f"git checkout main failed: {(sw.stderr or sw.stdout or '').strip()}")

    for br in branches_ordered:
        co = _git_run(project, ["checkout", br])
        if co.returncode != 0:
            raise RuntimeError(f"git checkout {br} failed: {(co.stderr or co.stdout or '').strip()}")
        rb = _git_run(project, ["rebase", "main"])
        if rb.returncode != 0:
            raise RuntimeError(f"git rebase main failed on {br}: {(rb.stderr or rb.stdout or '').strip()}")
        bk = _git_run(project, ["checkout", "main"])
        if bk.returncode != 0:
            raise RuntimeError(f"git checkout main after rebase failed: {(bk.stderr or bk.stdout or '').strip()}")
        mg = _git_run(project, ["merge", "--ff-only", br])
        if mg.returncode != 0:
            raise RuntimeError(f"git merge --ff-only {br} failed: {(mg.stderr or mg.stdout or '').strip()}")
        LOG.info("parallel_executor: merged %s into main", br)


def run_waves_sequential(
    waves: list[list[dict[str, Any]]],
    run_one: Callable[[dict[str, Any]], None],
) -> None:
    """Execute each wave: atoms run sequentially (single git worktree)."""
    for i, wave in enumerate(waves):
        LOG.info("Wave %s/%s: %s", i + 1, len(waves), [a.get("id") for a in wave])
        for atom in wave:
            run_one(atom)


def main() -> None:
    sample = [{"id": "a", "deps": [], "scope": ["x"]}, {"id": "b", "deps": ["a"], "scope": ["y"]}]
    LOG.info("waves=%s", [[x["id"] for x in w] for w in build_waves(sample)])


if __name__ == "__main__":
    main()
