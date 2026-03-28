from __future__ import annotations

import html
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

import yaml

try:
    from forge.common import (
        _github_bearer_value,
        atomic_write_yaml,
        env_paths,
        epic_queue_path,
        forge_dotenv_setting,
        gh_request,
        setup_logging,
    )
except ImportError:  # pragma: no cover
    from common import (
        _github_bearer_value,
        atomic_write_yaml,
        env_paths,
        epic_queue_path,
        forge_dotenv_setting,
        gh_request,
        setup_logging,
    )

LOG = setup_logging("epicwatcher")


def _headers() -> dict[str, str]:
    token = _github_bearer_value(env_paths()["GH_TOKEN"])
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "osnova-forge",
    }


def _yaml_from_issue_body(body: str) -> dict[str, Any]:
    # ``` yaml / ```yml / ```YAML — допускаем пробел после тройных кавычек (часто в GitHub UI)
    match = re.search(
        r"```\s*(?:yaml|yml)\s*(?:\r?\n)?(.*?)\s*```",
        body,
        flags=re.DOTALL | re.IGNORECASE,
    )
    if not match:
        raise ValueError(
            "В теле issue нет fenced-блока ```yaml … ``` (или ```yml). "
            "Вставьте EPIC одним блоком, например:\n"
            "```yaml\n"
            "t: EPK\n"
            "id: EPK-...\n"
            "goal: \"...\"\n"
            "scope: []\n"
            "done: \"...\"\n"
            "priority: low\n"
            "```"
        )
    data = yaml.safe_load(match.group(1)) or {}
    if not isinstance(data, dict):
        raise ValueError("YAML block must be mapping")
    required = ["t", "id", "goal", "scope", "done", "priority"]
    missing = [k for k in required if k not in data]
    if missing:
        raise ValueError(f"EPIC missing required fields: {missing}")
    if str(data.get("t")) != "EPK":
        raise ValueError("EPIC field t must be EPK")
    return data


def _request(method: str, url: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    body = None
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, method=method, data=body, headers=_headers())
    with urllib.request.urlopen(req, timeout=20) as resp:
        raw = resp.read().decode("utf-8")
    return json.loads(raw) if raw else {}


def _comment(issue_num: int, msg: str) -> None:
    repo = env_paths()["GHREPO"]
    url = f"https://api.github.com/repos/{repo}/issues/{issue_num}/comments"
    try:
        _request("POST", url, {"body": msg})
    except urllib.error.URLError as exc:
        LOG.warning("Could not post issue comment: %s", exc)


def pop_issue_number(queue_file: Path) -> int | None:
    if not queue_file.exists():
        return None
    # utf-8-sig strips UTF-8 BOM (\ufeff) from PowerShell Set-Content -Encoding utf8
    text = queue_file.read_text(encoding="utf-8-sig")
    lines = [x.strip().lstrip("\ufeff") for x in text.splitlines() if x.strip()]
    if not lines:
        return None
    issue = int(lines[0])
    queue_file.write_text("\n".join(lines[1:]) + ("\n" if len(lines) > 1 else ""), encoding="utf-8")
    return issue


def prepend_issue_to_queue(issue_num: int, queue_file: Path | None = None) -> None:
    """Put issue number at the front of the FIFO; drop duplicate lines of the same issue."""
    q = queue_file or epic_queue_path()
    q.parent.mkdir(parents=True, exist_ok=True)
    key = str(int(issue_num))
    rest: list[str] = []
    if q.exists():
        text = q.read_text(encoding="utf-8-sig")
        for line in text.splitlines():
            s = line.strip().lstrip("\ufeff")
            if not s or s == key:
                continue
            rest.append(s)
    out = [key, *rest]
    q.write_text("\n".join(out) + ("\n" if out else ""), encoding="utf-8")


def fetch_epic(issue_num: int) -> dict[str, Any]:
    repo = env_paths()["GHREPO"]
    url = f"https://api.github.com/repos/{repo}/issues/{issue_num}"
    issue = _request("GET", url)
    body_clean = html.unescape(issue.get("body", "") or "")
    try:
        epic = _yaml_from_issue_body(body_clean)
    except ValueError as exc:
        raise ValueError(f"GitHub issue #{issue_num}: {exc}") from exc
    epic["githubissue"] = issue_num

    project = Path(env_paths()["OSNOVA_PROJECT"])
    epic_path = project / ".osnova" / "epics" / f"{epic['id']}.yaml"
    atomic_write_yaml(epic_path, epic)
    _comment(issue_num, f"🏭 Forge: received EPK `{epic['id']}`, atomizing…")
    return epic


def watch_once() -> dict[str, Any] | None:
    queue = epic_queue_path()
    issue_num = pop_issue_number(queue)
    if issue_num is None:
        return None
    return fetch_epic(issue_num)


def list_open_brain_epic_candidates(
    *,
    epic_label: str,
    skip_labels: set[str],
    current_issue: int | None,
) -> list[dict[str, Any]]:
    """Open issues with ``epic_label``, exclude PRs, ``skip_labels``, and ``current_issue``."""
    token = _github_bearer_value(env_paths()["GH_TOKEN"])
    if not token or len(token) < 8:
        return []
    repo = env_paths()["GHREPO"]
    skip_lower = {x.lower() for x in skip_labels if x}
    label_q = urllib.parse.quote(epic_label)
    out: list[dict[str, Any]] = []
    page = 1
    while True:
        path = (
            f"/repos/{repo}/issues?state=open&labels={label_q}"
            "&sort=created&direction=asc&per_page=100&page="
            f"{page}"
        )
        try:
            batch = gh_request("GET", path)
        except Exception as exc:
            LOG.warning("GitHub list issues failed: %s", exc)
            break
        if not batch:
            break
        if not isinstance(batch, list):
            break
        out.extend(batch)
        if len(batch) < 100:
            break
        page += 1

    result: list[dict[str, Any]] = []
    for issue in out:
        if issue.get("pull_request"):
            continue
        num = issue.get("number")
        if num is None:
            continue
        if current_issue is not None and int(num) == int(current_issue):
            continue
        names = {str(x.get("name", "")).lower() for x in (issue.get("labels") or [])}
        if names & skip_lower:
            continue
        result.append(issue)
    return result


def poll_next_github_epic(current_issue: int | None) -> dict[str, Any] | None:
    """Next open brain-epic issue from GitHub API (FIFO by creation). On by default; set FORGE_POLL_OPEN_BRAIN_EPICS=0 to disable."""
    poll = forge_dotenv_setting("FORGE_POLL_OPEN_BRAIN_EPICS", "1").strip().lower() not in (
        "0",
        "false",
        "no",
    )
    if not poll:
        return None
    epic_label = forge_dotenv_setting("FORGE_BRAIN_EPIC_LABEL", "brain-epic")
    # Default must not include "blocker": brain-epic issues may share that label with ATM blockers.
    raw = forge_dotenv_setting("FORGE_EPIC_SKIP_LABELS", "forge-stale")
    skip = {x.strip() for x in raw.split(",") if x.strip()}
    candidates = list_open_brain_epic_candidates(
        epic_label=epic_label,
        skip_labels=skip,
        current_issue=current_issue,
    )
    if not candidates:
        return None
    num = int(candidates[0]["number"])
    return fetch_epic(num)


def main() -> None:
    try:
        epic = watch_once()
        LOG.info("EPIC: %s", epic.get("id") if epic else None)
    except Exception as exc:
        LOG.exception("epicwatcher failed: %s", exc)


if __name__ == "__main__":
    main()

