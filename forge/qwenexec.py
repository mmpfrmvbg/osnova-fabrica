from __future__ import annotations

import json
import os
import re
import subprocess
from subprocess import TimeoutExpired
from typing import Any

import yaml

try:
    from forge.common import SUBPROCESS_TEXT, env_paths, qwen_headless_argv, setup_logging
    from forge.qwenbudget import can_call, record
except ImportError:  # pragma: no cover
    from common import SUBPROCESS_TEXT, env_paths, qwen_headless_argv, setup_logging
    from qwenbudget import can_call, record

LOG = setup_logging("qwenexec")

_DEFAULT_QWEN_RUN_S = 900


def _qwen_run_timeout() -> int:
    raw = os.environ.get("FORGE_QWEN_TIMEOUT", "").strip()
    if raw.isdigit():
        return max(30, int(raw))
    return _DEFAULT_QWEN_RUN_S


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


def _extract_report_payload(stdout: str) -> str:
    for pat in (
        r"```ya?ml\s*(.*?)\s*```",
        r"```\s*(.*?)\s*```",
    ):
        m = re.search(pat, stdout, flags=re.DOTALL | re.IGNORECASE)
        if m:
            return m.group(1).strip()
    return (stdout or "").strip()


def _parse_report(stdout: str, atom_id: str) -> tuple[dict[str, Any] | None, str | None]:
    """Returns (report, None) on success, or (None, error_message). Never raises."""
    payload = _extract_report_payload(stdout)
    if not payload:
        return None, "empty qwen stdout (no report)"
    report: Any = None
    try:
        report = yaml.safe_load(payload)
    except yaml.YAMLError:
        report = None
    if report is None:
        try:
            report = json.loads(payload)
        except json.JSONDecodeError:
            return None, "qwen output is not valid YAML or JSON"
    if isinstance(report, list):
        if len(report) == 1 and isinstance(report[0], dict):
            LOG.warning("qwen returned YAML list of one mapping — unwrapping for %s", atom_id)
            report = report[0]
        else:
            return None, f"qwen report: expected mapping, got list of {len(report)} items"
    if not isinstance(report, dict):
        return None, f"qwen report: expected mapping, got {type(report).__name__}"
    report.setdefault("id", atom_id)
    report.setdefault("t", "RPT")
    report.setdefault("v", 5)
    report.setdefault("s", "OK")
    return report, None


def run_atom(atom: dict[str, Any], dry_run: bool = False) -> tuple[bool, dict[str, Any]]:
    if dry_run:
        LOG.info("[dry-run] Would call qwen for %s", atom.get("id"))
        return True, {"v": 5, "t": "RPT", "id": atom.get("id"), "s": "OK", "changed": [], "elapsed": 0}
    run_s = _qwen_run_timeout()
    LOG.info(
        "qwenexec: starting run for %s (timeout %ss; set FORGE_QWEN_TIMEOUT)",
        atom.get("id"),
        run_s,
    )
    if not can_call():
        return False, {"v": 5, "t": "RPT", "id": atom.get("id"), "s": "BLK", "err": "Qwen daily budget exhausted"}
    cmd = qwen_headless_argv(_prompt(atom))
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=run_s,
            check=False,
            **SUBPROCESS_TEXT,
        )
    except TimeoutExpired:
        LOG.error("qwen run timed out after %ss for %s", run_s, atom.get("id"))
        record()
        return False, {
            "v": 5,
            "t": "RPT",
            "id": atom.get("id"),
            "s": "BLK",
            "err": f"qwen run timeout after {run_s}s (raise FORGE_QWEN_TIMEOUT or use cursor executor)",
        }
    record()
    if proc.returncode != 0:
        return False, {"v": 5, "t": "RPT", "id": atom.get("id"), "s": "BLK", "err": proc.stderr.strip()}
    report, parse_err = _parse_report(proc.stdout or "", str(atom.get("id")))
    if parse_err:
        tail = (proc.stdout or "").replace("\r\n", "\n").strip()[-2000:]
        LOG.warning(
            "qwen parse failed for %s: %s\n--- stdout tail ---\n%s",
            atom.get("id"),
            parse_err,
            tail,
        )
        return False, {
            "v": 5,
            "t": "RPT",
            "id": atom.get("id"),
            "s": "BLK",
            "err": parse_err,
        }
    return report.get("s") == "OK", report


def main() -> None:
    LOG.info("qwenexec module ready")


if __name__ == "__main__":
    main()

