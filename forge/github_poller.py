"""
Синхронизация GitHub Issues (brain-epic) с ``.osnova/epics/*.yaml`` и счётчиков в ``state.yaml``.

Вызывается из ``forge.cycle`` до ``_resolve_epic``: если открыт Issue с меткой ``brain-epic``,
без ``done``, и локального ``EPK-*.yaml`` ещё нет — парсит YAML из тела Issue и записывает файл.
"""
from __future__ import annotations

import html
import urllib.parse
from pathlib import Path
from typing import Any

try:
    from forge.common import (
        _github_bearer_value,
        atomic_write_yaml,
        env_paths,
        gh_request,
        load_yaml,
        now_iso,
        setup_logging,
    )
    from forge.epicwatcher import _yaml_from_issue_body
except ImportError:  # pragma: no cover
    from common import (
        _github_bearer_value,
        atomic_write_yaml,
        env_paths,
        gh_request,
        load_yaml,
        now_iso,
        setup_logging,
    )
    from epicwatcher import _yaml_from_issue_body

LOG = setup_logging("github_poller")


def _github_token_ok() -> bool:
    t = _github_bearer_value(env_paths()["GH_TOKEN"])
    return bool(t and len(t) >= 8)


def count_open_blocker_issues(repo: str) -> int:
    """Число открытых Issues с меткой ``blocker`` (без PR), без ``brain-epic``."""
    page = 1
    total = 0
    label_q = urllib.parse.quote("blocker")
    while True:
        path = (
            f"/repos/{repo}/issues?state=open&labels={label_q}"
            f"&sort=created&direction=asc&per_page=100&page={page}"
        )
        try:
            batch = gh_request("GET", path)
        except Exception as exc:
            LOG.warning("github_poller: list blocker issues failed: %s", exc)
            break
        if not batch or not isinstance(batch, list):
            break
        for issue in batch:
            if not isinstance(issue, dict):
                continue
            if issue.get("pull_request"):
                continue
            names = {str(x.get("name", "")).lower() for x in (issue.get("labels") or []) if isinstance(x, dict)}
            if "brain-epic" in names:
                continue
            total += 1
        if len(batch) < 100:
            break
        page += 1
    return total


def _list_open_brain_epic_issues(repo: str, *, epic_label: str = "brain-epic") -> list[dict[str, Any]]:
    """Открытые Issues с меткой ``epic_label``, без метки ``done``, не PR."""
    label_q = urllib.parse.quote(epic_label)
    out: list[dict[str, Any]] = []
    page = 1
    while True:
        path = (
            f"/repos/{repo}/issues?state=open&labels={label_q}"
            f"&sort=created&direction=asc&per_page=100&page={page}"
        )
        try:
            batch = gh_request("GET", path)
        except Exception as exc:
            LOG.warning("github_poller: list brain-epic issues failed: %s", exc)
            break
        if not batch or not isinstance(batch, list):
            break
        out.extend(batch)
        if len(batch) < 100:
            break
        page += 1

    result: list[dict[str, Any]] = []
    for issue in out:
        if not isinstance(issue, dict):
            continue
        if issue.get("pull_request"):
            continue
        names = {str(x.get("name", "")).lower() for x in (issue.get("labels") or []) if isinstance(x, dict)}
        if "done" in names:
            continue
        result.append(issue)
    return result


def _update_project_state_yaml(
    project: Path,
    *,
    open_blocker_count: int,
    set_brainsource_github: bool,
) -> None:
    p = project / ".osnova" / "state.yaml"
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        data: Any = load_yaml(p, default={}) or {}
        if not isinstance(data, dict):
            data = {}
        ci = data.get("ci")
        if not isinstance(ci, dict):
            ci = {}
        else:
            ci = dict(ci)
        ci["openblockerissues"] = open_blocker_count
        data["ci"] = ci
        if set_brainsource_github:
            data["brainsource"] = "github"
        data["updatedat"] = now_iso()
        atomic_write_yaml(p, data)
    except Exception as exc:
        LOG.warning("github_poller: could not update .osnova/state.yaml: %s", exc)


def poll_brain_epics_and_sync_state() -> None:
    """
    Для каждого открытого ``brain-epic`` без ``done``: если нет ``.osnova/epics/{id}.yaml``,
    парсит YAML из тела Issue и записывает файл. Затем пересчитывает ``ci.openblockerissues``.
    ``brainsource: github`` — только если в этом проходе записан хотя бы один новый yaml.
    """
    if not _github_token_ok():
        return

    paths = env_paths()
    repo = paths["GHREPO"]
    project = Path(paths["OSNOVA_PROJECT"])
    epics_dir = project / ".osnova" / "epics"
    epics_dir.mkdir(parents=True, exist_ok=True)

    issues = _list_open_brain_epic_issues(repo)
    wrote = False
    for issue in issues:
        num = issue.get("number")
        if num is None:
            continue
        body_raw = issue.get("body") or ""
        body_clean = html.unescape(str(body_raw))
        try:
            epic = _yaml_from_issue_body(body_clean)
        except ValueError as exc:
            LOG.warning("github_poller issue #%s: skip parse: %s", num, exc)
            continue
        epic_id = str(epic.get("id", "")).strip()
        if not epic_id:
            LOG.warning("github_poller issue #%s: EPIC id empty", num)
            continue
        epic["githubissue"] = int(num)
        target = epics_dir / f"{epic_id}.yaml"
        if target.is_file():
            continue
        LOG.info("[CYCLE] source=github issue=%s", int(num))
        atomic_write_yaml(target, epic)
        wrote = True

    blocker_n = count_open_blocker_issues(repo)
    _update_project_state_yaml(
        project,
        open_blocker_count=blocker_n,
        set_brainsource_github=wrote,
    )
