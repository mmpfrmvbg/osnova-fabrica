from __future__ import annotations

import json
import os
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

_DEFAULT_ATOMIZER_S = 180


def _atomizer_timeout() -> int:
    raw = os.environ.get("FORGE_ATOMIZER_TIMEOUT", "").strip()
    if raw.isdigit():
        return max(30, int(raw))
    return _DEFAULT_ATOMIZER_S


def _prompt(epic: dict[str, Any]) -> str:
    return (
        "Split EPIC into 2-5 ATM tasks. Output ONLY a YAML list (dash-prefixed items), not a single mapping.\n"
        "Optional wrapper keys are accepted: atoms: | tasks: | items: each with a list value.\n"
        "Each item must have: id, seq, zone, risk, executor, goal, scope, notouch, done, steps, deps.\n"
        "Routing: MEDIUM/HIGH risk, src/**/*.ts (including src/**.test.ts), multi-file refactors → "
        "executor: cursor. Only root tests/, docs *.md, small *.yaml → qwen.\n"
        "In scope[], put the file path first, optional description after em-dash — (router parses path before —).\n"
        f"EPIC:\n{yaml.safe_dump(epic, allow_unicode=True, sort_keys=False)}"
    )


def _fence_payload(text: str) -> str:
    for pat in (r"```ya?ml\s*(.*?)\s*```", r"```\s*(.*?)\s*```"):
        m = re.search(pat, text, flags=re.DOTALL | re.IGNORECASE)
        if m:
            return m.group(1).strip()
    return text.strip()


def _parse_atomizer_payload(chunk: str) -> Any:
    chunk = chunk.strip()
    if not chunk:
        return None
    try:
        return yaml.safe_load(chunk)
    except yaml.YAMLError:
        pass
    try:
        return json.loads(chunk)
    except json.JSONDecodeError:
        return None


def _coerce_atom_list(data: Any) -> list[dict[str, Any]]:
    """Normalize model output to list[dict] (Qwen often returns a mapping wrapper or one atom)."""
    if data is None:
        return []
    if isinstance(data, list):
        if not data:
            return []
        if all(isinstance(x, dict) for x in data):
            return data
        LOG.warning("atomizer: list has non-dict items — dropping invalid entries")
        return [x for x in data if isinstance(x, dict)]
    if isinstance(data, dict):
        for key in ("atoms", "tasks", "atms", "items", "atm_list", "list"):
            v = data.get(key)
            if isinstance(v, list) and v and all(isinstance(x, dict) for x in v):
                LOG.info("atomizer: unwrapped list from key %r", key)
                return v
        one = data.get("atm")
        if isinstance(one, dict):
            LOG.info("atomizer: unwrapped single key 'atm'")
            return [one]
        if any(k in data for k in ("goal", "scope", "steps", "seq")):
            LOG.warning("atomizer: one top-level mapping — treating as single ATM (model should return a list)")
            return [data]
    return []


def _extract_yaml(text: str | None) -> list[dict[str, Any]]:
    if not text or not isinstance(text, str):
        raise ValueError("Atomizer output is empty (subprocess decode failed or no stdout)")
    chunk = _fence_payload(text)
    data = _parse_atomizer_payload(chunk)
    if data is None:
        tail = text.replace("\r\n", "\n").strip()[-2500:]
        LOG.error("atomizer: not valid YAML/JSON\n--- tail ---\n%s", tail)
        raise ValueError("Atomizer output is not valid YAML or JSON")
    atoms = _coerce_atom_list(data)
    if not atoms:
        tail = text.replace("\r\n", "\n").strip()[-2500:]
        LOG.error("atomizer: could not get list of ATM dicts\n--- tail ---\n%s", tail)
        raise ValueError("Atomizer output must be a YAML list of ATM objects (or atoms:/tasks: wrapper)")
    return atoms


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
        tmo = _atomizer_timeout()
        LOG.info("atomizer: qwen run timeout %ss (FORGE_ATOMIZER_TIMEOUT)", tmo)
        cmd = [resolve_executable(env_paths()["QWENBIN"]), "run", _prompt(epic)]
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=tmo, check=False, **SUBPROCESS_TEXT
        )
        if proc.returncode != 0:
            raise RuntimeError(f"Qwen atomizer failed: {(proc.stderr or '').strip()}")
        raw_atoms = _extract_yaml(proc.stdout or "")
        if not (1 <= len(raw_atoms) <= 5):
            raise ValueError(f"Atomizer must return 1-5 ATM items, got {len(raw_atoms)}")
        if len(raw_atoms) < 2:
            LOG.warning("atomizer: only %s ATM(s) — consider richer decomposition", len(raw_atoms))
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

