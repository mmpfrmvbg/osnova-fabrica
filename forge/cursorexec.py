from __future__ import annotations

import os
import subprocess
from pathlib import Path
from subprocess import TimeoutExpired
from typing import Any

try:
    from forge.common import SUBPROCESS_TEXT, atomic_write_yaml, bash_executable, env_paths, load_yaml, setup_logging
except ImportError:  # pragma: no cover
    from common import SUBPROCESS_TEXT, atomic_write_yaml, bash_executable, env_paths, load_yaml, setup_logging

LOG = setup_logging("cursorexec")

# smith.sh tries up to 3 Cursor models, each SMITH_TIMEOUT (default 300s) — parent must not kill bash early
_DEFAULT_WRAP = 1080


def _smith_wrap_timeout() -> int:
    raw = os.environ.get("FORGE_SMITH_WRAP_TIMEOUT", "").strip()
    if raw.isdigit():
        return max(60, int(raw))
    return _DEFAULT_WRAP


def run_atom(atom: dict[str, Any], dry_run: bool = False) -> tuple[bool, dict[str, Any]]:
    project = Path(env_paths()["OSNOVA_PROJECT"])
    task_file = project / ".osnova" / "task.yaml"
    report_file = project / ".osnova" / "report.yaml"
    atomic_write_yaml(task_file, atom)
    if dry_run:
        LOG.info("[dry-run] Would call smith.sh for %s", atom.get("id"))
        return True, {"v": 5, "t": "RPT", "id": atom.get("id"), "s": "OK", "changed": [], "elapsed": 0}
    wrap_s = _smith_wrap_timeout()
    LOG.info(
        "cursorexec: starting smith.sh for %s (subprocess timeout %ss; set FORGE_SMITH_WRAP_TIMEOUT if needed)",
        atom.get("id"),
        wrap_s,
    )
    smith = Path(env_paths()["OSNOVA_FORGE"]) / "smith.sh"
    bash = bash_executable()
    if not bash:
        LOG.error(
            "smith.sh needs bash (Git for Windows). Set FORGE_BASH to bash.exe or add bash to PATH."
        )
        return False, {
            "v": 5,
            "t": "RPT",
            "id": atom.get("id"),
            "s": "BLK",
            "err": "bash not found (WinError 193 fix: run smith under bash)",
            "changed": [],
        }
    try:
        proc = subprocess.run(
            [bash, str(smith)],
            cwd=project,
            capture_output=True,
            text=True,
            timeout=wrap_s,
            check=False,
            **SUBPROCESS_TEXT,
        )
    except TimeoutExpired:
        LOG.error(
            "smith.sh timed out after %ss for %s — raise FORGE_SMITH_WRAP_TIMEOUT or lower SMITH_TIMEOUT in smith.sh",
            wrap_s,
            atom.get("id"),
        )
        return False, {
            "v": 5,
            "t": "RPT",
            "id": atom.get("id"),
            "s": "BLK",
            "err": f"smith.sh subprocess timeout {wrap_s}s",
            "changed": [],
        }
    if proc.returncode != 0:
        LOG.warning("smith failed: %s", proc.stderr.strip())
    report = load_yaml(report_file, default={}) or {}
    success = report.get("s") == "OK"
    if not success:
        err = (report.get("err") or "").strip()
        LOG.warning(
            "smith ATM %s → BLK (cursor-agent exit=%s). err=%s\n--- stderr tail ---\n%s\n--- stdout tail ---\n%s",
            atom.get("id"),
            proc.returncode,
            err or "(see report.yaml)",
            (proc.stderr or "")[-1500:],
            (proc.stdout or "")[-1500:],
        )
    return success, report


def main() -> None:
    LOG.info("cursorexec module ready")


if __name__ == "__main__":
    main()

