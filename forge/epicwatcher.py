from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

import yaml

try:
    from forge.common import atomic_write_yaml, env_paths, setup_logging
except ImportError:  # pragma: no cover
    from common import atomic_write_yaml, env_paths, setup_logging

LOG = setup_logging("epicwatcher")


def _headers() -> dict[str, str]:
    token = env_paths()["GH_TOKEN"]
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "osnova-forge",
    }


def _yaml_from_issue_body(body: str) -> dict[str, Any]:
    match = re.search(r"```yaml\s*(.*?)\s*```", body, flags=re.DOTALL | re.IGNORECASE)
    if not match:
        raise ValueError("No ```yaml block in issue body")
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
    lines = [x.strip() for x in queue_file.read_text(encoding="utf-8").splitlines() if x.strip()]
    if not lines:
        return None
    issue = int(lines[0])
    queue_file.write_text("\n".join(lines[1:]) + ("\n" if len(lines) > 1 else ""), encoding="utf-8")
    return issue


def fetch_epic(issue_num: int) -> dict[str, Any]:
    repo = env_paths()["GHREPO"]
    url = f"https://api.github.com/repos/{repo}/issues/{issue_num}"
    issue = _request("GET", url)
    epic = _yaml_from_issue_body(issue.get("body", ""))
    epic["githubissue"] = issue_num

    project = Path(env_paths()["OSNOVA_PROJECT"])
    epic_path = project / ".osnova" / "epics" / f"{epic['id']}.yaml"
    atomic_write_yaml(epic_path, epic)
    _comment(issue_num, f"Forge received {epic['id']}, atomizing...")
    return epic


def watch_once() -> dict[str, Any] | None:
    queue = Path(env_paths()["OSNOVA_FORGE"]) / "epic-queue.txt"
    issue_num = pop_issue_number(queue)
    if issue_num is None:
        return None
    return fetch_epic(issue_num)


def main() -> None:
    try:
        epic = watch_once()
        LOG.info("EPIC: %s", epic.get("id") if epic else None)
    except Exception as exc:
        LOG.exception("epicwatcher failed: %s", exc)


if __name__ == "__main__":
    main()

