from __future__ import annotations

import json
import re
import subprocess
from typing import Any

import yaml

try:
    from forge.common import SUBPROCESS_TEXT, env_paths, resolve_executable, setup_logging
    from forge.qwenbudget import can_call, record
except ImportError:  # pragma: no cover
    from common import SUBPROCESS_TEXT, env_paths, resolve_executable, setup_logging
    from qwenbudget import can_call, record

LOG = setup_logging("qwenexec")


def _prompt(atom: dict[str, Any]) -> str:
    scope = atom.get("scope", [])
    steps = atom.get("steps", [])
    return (
        "Implement ATM and output ONLY report YAML in ```yaml block.\n"
        f"Goal: {atom.get('goal')}\n"
        f"Scope: {scope}\n"
        f"Steps: {steps}\n"
        f"Done command: {atom.get('done')}\n"
        f"ATM ID: {atom.get('id')}\n"
    )


def _parse_report(stdout: str, atom_id: str) -> dict[str, Any]:
    match = re.search(r"```yaml\s*(.*?)\s*```", stdout, flags=re.DOTALL | re.IGNORECASE)
    raw = match.group(1) if match else stdout
    try:
        report = yaml.safe_load(raw)
    except Exception:
        report = json.loads(raw)
    if not isinstance(report, dict):
        raise ValueError("Qwen report must be an object")
    report.setdefault("id", atom_id)
    report.setdefault("t", "RPT")
    report.setdefault("v", 5)
    report.setdefault("s", "OK")
    return report


def run_atom(atom: dict[str, Any], dry_run: bool = False) -> tuple[bool, dict[str, Any]]:
    if dry_run:
        LOG.info("[dry-run] Would call qwen for %s", atom.get("id"))
        return True, {"v": 5, "t": "RPT", "id": atom.get("id"), "s": "OK", "changed": [], "elapsed": 0}
    if not can_call():
        return False, {"v": 5, "t": "RPT", "id": atom.get("id"), "s": "BLK", "err": "Qwen daily budget exhausted"}
    cmd = [resolve_executable(env_paths()["QWENBIN"]), "run", _prompt(atom)]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120, check=False, **SUBPROCESS_TEXT)
    record()
    if proc.returncode != 0:
        return False, {"v": 5, "t": "RPT", "id": atom.get("id"), "s": "BLK", "err": proc.stderr.strip()}
    report = _parse_report(proc.stdout, str(atom.get("id")))
    return report.get("s") == "OK", report


def main() -> None:
    LOG.info("qwenexec module ready")


if __name__ == "__main__":
    main()

