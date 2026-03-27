from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

try:
    from forge.common import atomic_write_yaml, env_paths, load_yaml, setup_logging
except ImportError:  # pragma: no cover
    from common import atomic_write_yaml, env_paths, load_yaml, setup_logging

LOG = setup_logging("cursorexec")


def run_atom(atom: dict[str, Any], dry_run: bool = False) -> tuple[bool, dict[str, Any]]:
    project = Path(env_paths()["OSNOVA_PROJECT"])
    task_file = project / ".osnova" / "task.yaml"
    report_file = project / ".osnova" / "report.yaml"
    atomic_write_yaml(task_file, atom)
    if dry_run:
        LOG.info("[dry-run] Would call smith.sh for %s", atom.get("id"))
        return True, {"v": 5, "t": "RPT", "id": atom.get("id"), "s": "OK", "changed": [], "elapsed": 0}
    smith = Path(env_paths()["OSNOVA_FORGE"]) / "smith.sh"
    proc = subprocess.run([str(smith)], cwd=project, capture_output=True, text=True, timeout=300, check=False)
    if proc.returncode != 0:
        LOG.warning("smith failed: %s", proc.stderr.strip())
    report = load_yaml(report_file, default={}) or {}
    success = report.get("s") == "OK"
    return success, report


def main() -> None:
    LOG.info("cursorexec module ready")


if __name__ == "__main__":
    main()

