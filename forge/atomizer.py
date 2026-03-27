from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Any

import yaml

try:
    from forge.common import SUBPROCESS_TEXT, atomic_write_yaml, env_paths, resolve_executable, setup_logging
except ImportError:  # pragma: no cover
    from common import SUBPROCESS_TEXT, atomic_write_yaml, env_paths, resolve_executable, setup_logging

LOG = setup_logging("atomizer")


def _prompt(epic: dict[str, Any]) -> str:
    return (
        "Split EPIC into 2-5 ATM tasks. Output ONLY YAML list.\n"
        "Each item must have: id, seq, zone, risk, executor, goal, scope, notouch, done, steps, deps.\n"
        "Routing: MEDIUM/HIGH risk, multi-file refactors, or scope touching .ts/.js/.rs/.py → "
        "executor: cursor (Cursor CLI). LOW risk, single test/doc/config file → executor: qwen.\n"
        "In scope[], put the file path first, optional description after em-dash — (router parses path before —).\n"
        f"EPIC:\n{yaml.safe_dump(epic, allow_unicode=True, sort_keys=False)}"
    )


def _extract_yaml(text: str | None) -> list[dict[str, Any]]:
    if not text or not isinstance(text, str):
        raise ValueError("Atomizer output is empty (subprocess decode failed or no stdout)")
    match = re.search(r"```yaml\s*(.*?)\s*```", text, flags=re.DOTALL | re.IGNORECASE)
    chunk = match.group(1) if match else text
    data = yaml.safe_load(chunk) or []
    if not isinstance(data, list):
        raise ValueError("Atomizer output must be YAML list")
    return data


def _normalize_atoms(epic: dict[str, Any], atoms: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    epic_id = str(epic["id"])
    done_cmd = epic["done"]
    for idx, atom in enumerate(atoms, start=1):
        seq = int(atom.get("seq", idx))
        atom_id = atom.get("id") or f"ATM-{epic_id}-{seq:03d}"
        out.append(
            {
                "id": atom_id,
                "epic": epic_id,
                "seq": seq,
                "zone": atom.get("zone", epic.get("zone", "lang")),
                "risk": atom.get("risk", epic.get("risk", "MEDIUM")),
                "executor": atom.get("executor", "cursor"),
                "goal": atom.get("goal", ""),
                "scope": atom.get("scope", []),
                "notouch": atom.get("notouch", epic.get("notouch", [])),
                "done": done_cmd,
                "steps": atom.get("steps", []),
                "deps": atom.get("deps", []),
                "maxiter": 3,
                "retries": 0,
                "status": "PENDING",
                "priority": epic.get("priority", "P2"),
            }
        )
    return out


def atomize(epic: dict[str, Any], dry_run: bool = False) -> list[dict[str, Any]]:
    if dry_run:
        atoms = _normalize_atoms(epic, [])
        if not atoms:
            atoms = _normalize_atoms(epic, [{"seq": 1, "goal": epic.get("goal", ""), "scope": epic.get("scope", [])}])
    else:
        cmd = [resolve_executable(env_paths()["QWENBIN"]), "run", _prompt(epic)]
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=120, check=False, **SUBPROCESS_TEXT
        )
        if proc.returncode != 0:
            raise RuntimeError(f"Qwen atomizer failed: {(proc.stderr or '').strip()}")
        raw_atoms = _extract_yaml(proc.stdout or "")
        if not (2 <= len(raw_atoms) <= 5):
            raise ValueError("Atomizer must return 2-5 items")
        atoms = _normalize_atoms(epic, raw_atoms)

    base = Path(env_paths()["OSNOVA_PROJECT"]) / ".osnova" / "epics" / str(epic["id"])
    base.mkdir(parents=True, exist_ok=True)
    for atom in atoms:
        atomic_write_yaml(base / f"{atom['id']}.yaml", atom)
    return atoms


def main() -> None:
    LOG.info("atomizer module ready")


if __name__ == "__main__":
    main()

