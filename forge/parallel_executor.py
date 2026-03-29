from __future__ import annotations

import os
import re
import subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from itertools import combinations
from pathlib import Path
from typing import Any, Callable, Iterator

try:
    from forge.atomizer import _coerce_dep_to_atm_id
    from forge.common import SUBPROCESS_TEXT, forge_dotenv_setting, set_thread_project, setup_logging
except ImportError:  # pragma: no cover
    from atomizer import _coerce_dep_to_atm_id
    from common import SUBPROCESS_TEXT, forge_dotenv_setting, set_thread_project, setup_logging

LOG = setup_logging("parallel_executor")

MAX_PARALLEL = int(os.environ.get("OSNOVA_MAX_PARALLEL", "3"))

# Незакоммиченный state.yaml мешает worktree/cherry-pick; см. .gitattributes merge=ours.
_STATE_YAML_REL = ".osnova/state.yaml"
_STASH_MSG = "forge-pre-wave-state-yaml"


def _state_yaml_dirty(project: Path, rel: str = _STATE_YAML_REL) -> bool:
    if not (project / rel).is_file():
        return False
    if _git_run(project, ["diff", "--quiet", "--", rel]).returncode != 0:
        return True
    return _git_run(project, ["diff", "--cached", "--quiet", "--", rel]).returncode != 0


@contextmanager
def state_yaml_stashed_for_wave(project: Path) -> Iterator[bool]:
    """
    Перед параллельной волной: убрать незакоммиченные изменения ``.osnova/state.yaml`` в stash,
    чтобы ``git worktree add`` / ``cherry-pick`` опирались на ``HEAD``. После волны — ``stash pop``.

    ``FORGE_SKIP_STATE_YAML_STASH=1`` — отключить (отладка).
    Yields: ``True`` если stash был создан.
    """
    root = project.resolve()
    rel = _STATE_YAML_REL
    if forge_dotenv_setting("FORGE_SKIP_STATE_YAML_STASH", "0").strip().lower() in ("1", "true", "yes"):
        yield False
        return
    if not _state_yaml_dirty(root, rel):
        yield False
        return
    st = _git_run(
        root,
        ["stash", "push", "-m", _STASH_MSG, "--", rel],
        timeout=120,
    )
    if st.returncode != 0:
        LOG.warning(
            "parallel_executor: git stash push %s failed: %s",
            rel,
            (st.stderr or st.stdout or "").strip()[:300],
        )
        yield False
        return
    LOG.info("parallel_executor: stashed %s before parallel wave", rel)
    try:
        yield True
    finally:
        pop = _git_run(root, ["stash", "pop"], timeout=120)
        if pop.returncode != 0:
            LOG.warning(
                "parallel_executor: git stash pop after wave failed (check `git stash list`): %s",
                (pop.stderr or pop.stdout or "").strip()[:400],
            )
        else:
            LOG.info("parallel_executor: restored %s from stash after parallel wave", rel)


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


def build_waves(
    atoms: list[dict[str, Any]],
    max_parallel: int | None = None,
    *,
    completed_ids: set[str] | frozenset[str] | None = None,
) -> list[list[dict[str, Any]]]:
    """Topological waves by deps; inside wave, cap width with scope conflicts (v5.2).

    If ``completed_ids`` is set, those ATM ids are treated as already satisfied for deps
    (stateful resume: pending-only list + prereq done ids).
    """
    cap = max_parallel if max_parallel is not None else MAX_PARALLEL
    done_ids: set[str] = set(completed_ids) if completed_ids else set()
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


def forge_wave_parallel_enabled() -> bool:
    """Reads each call: ``os.environ`` then forge/project ``.env`` (same merge as :func:`forge_dotenv_setting`)."""
    v = forge_dotenv_setting("FORGE_WAVE_PARALLEL", "0").strip().lower()
    return v in ("1", "true", "yes")


def forge_wave_max_workers() -> int:
    try:
        return max(1, int(forge_dotenv_setting("FORGE_WAVE_MAX_WORKERS", "4").strip()))
    except ValueError:
        return 4


def execute_wave_parallel(
    wave_atoms: list[dict[str, Any]],
    wave_index: int,
    epic: dict[str, Any],
    repo_root: Path,
    run_one_fn: Callable[[dict[str, Any], Path], dict[str, Any]],
    *,
    max_workers: int = 4,
    dry_run: bool = False,
) -> list[dict[str, Any]]:
    """
    Run a wave in parallel using ``.forge-worktrees/{atm_id}``, cherry-pick OK commits onto ``main``.
    ``run_one_fn(atom, cwd)`` must respect ``env_paths()['OSNOVA_PROJECT']`` (thread-local per worker).
    When ``cwd`` is the main repo, use ``defer_process_result=False`` inside ``run_one_fn``.
    """
    n = len(wave_atoms)
    if n == 0:
        return []

    root = repo_root.resolve()

    def _sequential_on_main() -> list[dict[str, Any]]:
        return [run_one_fn(a, root) for a in wave_atoms]

    if dry_run or n == 1:
        return _sequential_on_main()

    if wave_scopes_overlap(wave_atoms):
        LOG.warning(
            "parallel_executor: wave %d scopes overlap — continuing parallel (worktrees isolate scopes)",
            wave_index + 1,
        )

    pool_n = min(n, max(1, max_workers))
    LOG.info(
        "parallel_executor: wave %d — running %d ATMs in parallel (worktrees)",
        wave_index + 1,
        pool_n,
    )

    def _parallel_wave_body() -> list[dict[str, Any]]:
        safe_epic = _sanitize_branch_segment(str(epic.get("id") or "epic"))
        worktrees: list[tuple[str, Path, str]] = []
        try:
            for atom in wave_atoms:
                atm_id = str(atom.get("id") or "atm")
                safe_atm = _sanitize_branch_segment(atm_id)
                branch = f"forge-wave/{safe_epic}/w{wave_index + 1}-{safe_atm}"
                wt_path = (root / ".forge-worktrees" / atm_id).resolve()
                wt_path.parent.mkdir(parents=True, exist_ok=True)
                try:
                    wt_arg = str(wt_path.relative_to(root))
                except ValueError:
                    wt_arg = str(wt_path)
                proc = _git_run(root, ["worktree", "add", wt_arg, "-b", branch, "HEAD"])
                if proc.returncode != 0:
                    err = (proc.stderr or proc.stdout or "").strip()
                    raise RuntimeError(f"git worktree add failed for {atm_id}: {err}")
                worktrees.append((atm_id, wt_path, branch))
                LOG.info("parallel_executor: worktree %s branch %s", wt_path, branch)

            ordered_reports: list[dict[str, Any] | None] = [None] * n
            futures: dict[Any, int] = {}

            def _worker(idx: int, atom: dict[str, Any], wt: Path) -> dict[str, Any]:
                set_thread_project(str(wt))
                try:
                    return run_one_fn(atom, wt)
                finally:
                    set_thread_project(None)

            with ThreadPoolExecutor(max_workers=pool_n) as pool:
                for i, atom in enumerate(wave_atoms):
                    _wt = worktrees[i][1]
                    fut = pool.submit(_worker, i, atom, _wt)
                    futures[fut] = i
                for fut in as_completed(futures):
                    idx = futures[fut]
                    atm_id = str(wave_atoms[idx].get("id") or "")
                    try:
                        ordered_reports[idx] = fut.result()
                    except Exception as exc:
                        LOG.error("parallel_executor: ATM %s raised exception: %s", atm_id, exc)
                        ordered_reports[idx] = {
                            "v": 5,
                            "t": "RPT",
                            "id": atm_id,
                            "s": "BLK",
                            "err": str(exc),
                            "changed": [],
                        }

            reports_out = [
                r
                if r is not None
                else {
                    "v": 5,
                    "t": "RPT",
                    "s": "BLK",
                    "err": "missing report",
                    "changed": [],
                }
                for r in ordered_reports
            ]

            cur = _git_run(root, ["branch", "--show-current"])
            if (cur.stdout or "").strip() != "main":
                sw = _git_run(root, ["checkout", "main"])
                if sw.returncode != 0:
                    LOG.error(
                        "parallel_executor: checkout main failed: %s",
                        (sw.stderr or sw.stdout or "").strip(),
                    )
                    return reports_out

            for i, (atm_id, wt_path, _branch) in enumerate(worktrees):
                rep = reports_out[i]
                if not rep or str(rep.get("s") or "").upper() not in ("OK", "REVIEW_MISMATCH"):
                    LOG.info(
                        "parallel_executor: skip cherry-pick for %s (s=%s)",
                        atm_id,
                        rep.get("s") if rep else "None",
                    )
                    continue
                sha_r = _git_run(wt_path, ["rev-parse", "HEAD"], timeout=60)
                if sha_r.returncode != 0:
                    LOG.error("parallel_executor: cannot get SHA for %s", atm_id)
                    continue
                sha = (sha_r.stdout or "").strip()
                if not sha:
                    LOG.error("parallel_executor: empty SHA for %s", atm_id)
                    continue
                cp = _git_run(root, ["cherry-pick", sha], timeout=300)
                if cp.returncode != 0:
                    tail = (cp.stderr or cp.stdout or "").strip()[:300]
                    LOG.error(
                        "parallel_executor: cherry-pick failed for %s (sha=%s): %s",
                        atm_id,
                        sha[:8],
                        tail,
                    )
                    _git_run(root, ["cherry-pick", "--abort"], timeout=60)
                    reports_out[i] = {
                        **rep,
                        "s": "MERGE_CONFLICT",
                        "err": f"cherry-pick conflict: {tail}",
                    }
                else:
                    LOG.info("parallel_executor: cherry-pick OK for %s (%s)", atm_id, sha[:8])

            return reports_out
        finally:
            for _atm_id, wt_path, branch in worktrees:
                cleanup_wave_worktrees(root, [wt_path])
                bd = _git_run(root, ["branch", "-D", branch], timeout=60)
                if bd.returncode != 0:
                    LOG.debug(
                        "parallel_executor: branch -D %s: %s",
                        branch,
                        (bd.stderr or bd.stdout or "").strip()[:200],
                    )

    with state_yaml_stashed_for_wave(root):
        return _parallel_wave_body()


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
