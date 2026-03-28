#!/usr/bin/env python3
"""Called from CI on main when tests passed: close Issue with pending-ci if state.yaml says so."""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

try:
    import yaml
except ImportError:
    print("PyYAML required", file=sys.stderr)
    sys.exit(0)


def _request(method: str, url: str, data: dict | None, token: str) -> tuple[int, str]:
    body: bytes | None = None
    if data is not None:
        body = json.dumps(data).encode("utf-8")
    hdrs = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "osnova-forge-close-pending-ci",
    }
    if body:
        hdrs["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, method=method, headers=hdrs)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.getcode(), (resp.read().decode("utf-8", errors="replace") or "")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")[:500]


def main() -> None:
    root = Path(os.environ.get("GITHUB_WORKSPACE", ".")).resolve()
    state_path = root / ".osnova" / "state.yaml"
    if not state_path.exists():
        print("no state.yaml")
        return
    try:
        st = yaml.safe_load(state_path.read_text(encoding="utf-8")) or {}
    except Exception as exc:
        print("parse state.yaml failed:", exc)
        return
    issue = st.get("ci_pending_issue")
    if issue is None:
        print("no ci_pending_issue")
        return
    token = (os.environ.get("GITHUB_TOKEN") or "").strip()
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    if not token or not repo:
        print("missing GITHUB_TOKEN or GITHUB_REPOSITORY")
        return
    owner, name = repo.split("/", 1)
    api = f"https://api.github.com/repos/{owner}/{name}"
    inum = int(issue)

    code, body = _request("PATCH", f"{api}/issues/{inum}", {"state": "closed"}, token)
    if code not in (200, 201):
        print("close issue failed:", code, body)
        return

    label_url = f"{api}/issues/{inum}/labels/pending-ci"
    c2, _b = _request("DELETE", label_url, None, token)
    if c2 not in (200, 204, 404):
        print("remove pending-ci label:", c2)

    st.pop("ci_pending_issue", None)
    st.pop("ci_pending_epic", None)
    state_path.write_text(
        yaml.safe_dump(st, allow_unicode=True, sort_keys=False, default_flow_style=False),
        encoding="utf-8",
    )
    print(f"closed issue #{inum} and cleared ci_pending_* from state.yaml (local file)")


if __name__ == "__main__":
    main()
