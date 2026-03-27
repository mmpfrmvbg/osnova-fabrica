#!/usr/bin/env python3
"""
CLI entrypoint for GHA: `python3 /opt/osnova-forge/epic_watcher.py <issue_number>`
Delegates to epicwatcher.fetch_epic (urllib-based GitHub API).
"""
from __future__ import annotations

import sys

try:
    from forge.epicwatcher import fetch_epic
except ImportError:  # pragma: no cover
    from epicwatcher import fetch_epic


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: epic_watcher.py <issue_number>", file=sys.stderr)
        sys.exit(2)
    num = int(sys.argv[1])
    epic = fetch_epic(num)
    print(f"EPIC_ID={epic.get('id')}")
    print(f"ISSUE_NUMBER={num}")


if __name__ == "__main__":
    main()
