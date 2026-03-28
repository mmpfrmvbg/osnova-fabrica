from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any

import yaml

try:
    from forge.common import (
        SUBPROCESS_TEXT,
        atomic_write_yaml,
        env_paths,
        qwen_headless_argv,
        resolve_executable,
        setup_logging,
    )
except ImportError:  # pragma: no cover
    from common import (
        SUBPROCESS_TEXT,
        atomic_write_yaml,
        env_paths,
        qwen_headless_argv,
        resolve_executable,
        setup_logging,
    )

LOG = setup_logging("atomizer")

_DEFAULT_ATOMIZER_S = 180


def _atomizer_timeout() -> int:
    raw = os.environ.get("FORGE_ATOMIZER_TIMEOUT", "").strip()
    if raw.isdigit():
        return max(30, int(raw))
    return _DEFAULT_ATOMIZER_S


def _atomizer_attempts() -> int:
    """1 + FORGE_ATOMIZER_RETRIES runs (default retries=1 → two tries if first output is garbage)."""
    raw = os.environ.get("FORGE_ATOMIZER_RETRIES", "1").strip()
    retries = int(raw) if raw.isdigit() else 1
    return 1 + max(0, retries)


def _atomizer_fallback_enabled() -> bool:
    v = os.environ.get("FORGE_ATOMIZER_FALLBACK", "1").strip().lower()
    return v not in ("0", "false", "no")


def _atomizer_use_stdin() -> bool:
    """Pass prompt on stdin (-p -) to avoid Windows ~8191-char command-line truncation."""
    v = os.environ.get("FORGE_ATOMIZER_USE_STDIN", "1").strip().lower()
    return v not in ("0", "false", "no")


def _epic_trailer(epic: dict[str, Any]) -> str:
    """Short repeated summary so the model sees id/goal/scope even if long YAML is truncated upstream."""
    eid = epic.get("id", "")
    goal = str(epic.get("goal", ""))[:600]
    scope = epic.get("scope") or []
    paths = ", ".join(str(p).split("—")[0].strip() for p in scope[:12] if p)
    done = str(epic.get("done", ""))[:200]
    return (
        "\n---\n"
        "REPEAT (do not ignore): EPIC id, goal, and scope are HERE — not in a file on disk.\n"
        f"  id: {eid!r}\n"
        f"  goal: {goal}\n"
        f"  scope paths: {paths or '(none)'}\n"
        f"  done: {done}\n"
        "You MUST output a non-empty YAML list (2-5 items). Never output []. Never ask for the EPIC text.\n"
    )


def _prompt(epic: dict[str, Any]) -> str:
    dumped = yaml.safe_dump(epic, allow_unicode=True, sort_keys=False)
    return (
        "You are the OSNOVA forge atomizer. Split the EPIC below into 2-5 ATM tasks.\n\n"
        "CRITICAL — read before answering:\n"
        "- The EPIC is the YAML block below. It is NOT a filename. "
        "Do NOT search the repo for pipeline.yaml, spec.yaml, or files named EPIC.\n"
        "- Do NOT ask questions. Do NOT explain. Do NOT refuse. Do NOT output an empty list [].\n"
        "- Output ONLY machine-readable structure: a YAML list (dash-prefixed items) OR a JSON array of objects.\n"
        "- Optional: wrap the list in a ```yaml or ```json fenced block.\n\n"
        "Each ATM item must include: seq, zone, risk, goal, scope (list of paths), notouch, steps (list), deps (list). "
        "Optional: id, executor (cursor|qwen).\n"
        "Routing: MEDIUM/HIGH risk and src/**/*.ts (incl. tests) → prefer executor: cursor. "
        "Small docs/yaml-only → qwen. In scope[], path first; optional note after em-dash — .\n"
        "Use the epic's `done` command as reference; repeat or split across atoms as needed.\n\n"
        "EPIC (complete YAML — this is the only source of truth):\n"
        f"{dumped}"
        f"{_epic_trailer(epic)}"
    )


def _prompt_retry(epic: dict[str, Any], bad_tail: str) -> str:
    dumped = yaml.safe_dump(epic, allow_unicode=True, sort_keys=False)
    return (
        "Your previous reply was NOT valid: empty [], questions, or not parseable. "
        "Reply with ONLY a non-empty YAML list or JSON array — no prose, no [].\n\n"
        "Example shape (YAML):\n"
        "```yaml\n"
        "- seq: 1\n  zone: lang\n  risk: MEDIUM\n  goal: \"...\"\n  scope: [src/foo.ts]\n"
        "  notouch: []\n  steps: [\"step\"]\n  deps: []\n"
        "- seq: 2\n  ...\n"
        "```\n\n"
        f"EPIC:\n{dumped}\n"
        f"{_epic_trailer(epic)}\n"
        "Invalid output began like:\n"
        f"{bad_tail[:1200]}"
    )


def _fence_payload(text: str) -> str:
    for pat in (
        r"```ya?ml\s*(.*?)\s*```",
        r"```json\s*(.*?)\s*```",
        r"```\s*(.*?)\s*```",
    ):
        m = re.search(pat, text, flags=re.DOTALL | re.IGNORECASE)
        if m:
            return m.group(1).strip()
    return text.strip()


def _extract_json_array_by_brackets(text: str) -> Any:
    """If the model prefixed chit-chat, parse the first JSON value starting at '['."""
    i = text.find("[")
    if i < 0:
        return None
    dec = json.JSONDecoder()
    try:
        obj, _ = dec.raw_decode(text, i)
        return obj
    except json.JSONDecodeError:
        return None


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
        data = _extract_json_array_by_brackets(text)
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


def _normalized_executor(atom: dict[str, Any], epic: dict[str, Any]) -> str | None:
    """cursor | qwen if set on atom or epic; None = let forge/router choose by heuristics."""
    for src in (atom, epic):
        if "executor" not in src:
            continue
        raw = src.get("executor")
        if raw is None:
            continue
        s = str(raw).strip().lower()
        if s in ("cursor", "qwen"):
            return s
    return None


def _fallback_atoms_from_epic(epic: dict[str, Any]) -> list[dict[str, Any]]:
    """Last-resort decomposition without LLM (1 ATM with full scope, or one ATM per file up to 5)."""
    epic_id = str(epic.get("id", "EPK"))
    raw_scope = epic.get("scope") or []
    paths: list[str] = []
    for x in raw_scope:
        if not x:
            continue
        paths.append(str(x).split("—")[0].split("--")[0].strip())
    goal = str(epic.get("goal", ""))
    zone = str(epic.get("zone", "lang"))
    notouch = list(epic.get("notouch") or [])
    if not paths:
        return [
            {
                "seq": 1,
                "zone": zone,
                "risk": "MEDIUM",
                "goal": goal,
                "scope": [],
                "notouch": notouch,
                "steps": ["Implement epic", "Run done"],
                "deps": [],
            }
        ]
    if len(paths) == 1 or len(paths) > 5:
        return [
            {
                "seq": 1,
                "zone": zone,
                "risk": "MEDIUM",
                "goal": goal,
                "scope": paths[:5],
                "notouch": notouch,
                "steps": ["Edit scoped files", "Run done"],
                "deps": [],
            }
        ]
    out: list[dict[str, Any]] = []
    for i, p in enumerate(paths, start=1):
        prev = f"ATM-{epic_id}-{i - 1:03d}" if i > 1 else None
        out.append(
            {
                "seq": i,
                "zone": zone,
                "risk": "MEDIUM",
                "goal": f"{goal} (part {i}/{len(paths)}: {p})",
                "scope": [p],
                "notouch": notouch,
                "steps": [f"Implement changes in {p}"],
                "deps": [prev] if prev else [],
            }
        )
    return out


def _run_qwen_atomizer(prompt: str, timeout: int) -> subprocess.CompletedProcess:
    """Invoke Qwen; prefer stdin for prompt so Windows does not truncate the command line."""
    exe = resolve_executable(env_paths()["QWENBIN"])
    if os.environ.get("FORGE_QWEN_LEGACY_RUN", "").strip().lower() in ("1", "true", "yes"):
        return subprocess.run(
            [exe, "run", prompt],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            **SUBPROCESS_TEXT,
        )
    if _atomizer_use_stdin():
        argv = [exe, "--yolo"]
        model = os.environ.get("FORGE_QWEN_MODEL", "").strip()
        if model:
            argv.extend(["--model", model])
        argv.extend(["-p", "-"])
        return subprocess.run(
            argv,
            input=prompt,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            **SUBPROCESS_TEXT,
        )
    return subprocess.run(
        qwen_headless_argv(prompt),
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
        **SUBPROCESS_TEXT,
    )


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
                "executor": _normalized_executor(atom, epic),
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
        attempts = _atomizer_attempts()
        LOG.info(
            "atomizer: qwen timeout %ss; %s attempt(s); prompt via %s (Windows long prompts: keep stdin on)",
            tmo,
            attempts,
            "stdin (-p -)" if _atomizer_use_stdin() else "argv (-p) — risk of truncation on Windows",
        )
        stdout_last = ""
        last_parse_err: Exception | None = None
        atoms: list[dict[str, Any]] | None = None
        for attempt in range(attempts):
            prompt = _prompt(epic) if attempt == 0 else _prompt_retry(epic, stdout_last)
            proc = _run_qwen_atomizer(prompt, tmo)
            if proc.returncode != 0:
                err_tail = (proc.stderr or proc.stdout or "").strip()[-800:]
                LOG.error("atomizer: Qwen exit %s — %s", proc.returncode, err_tail)
                last_parse_err = RuntimeError(f"Qwen atomizer failed (exit {proc.returncode})")
                if attempt >= attempts - 1:
                    break
                LOG.warning("atomizer: Qwen failed, retry %s/%s", attempt + 1, attempts)
                continue
            stdout_last = proc.stdout or ""
            try:
                raw_atoms = _extract_yaml(stdout_last)
                if not (1 <= len(raw_atoms) <= 5):
                    raise ValueError(f"Atomizer must return 1-5 ATM items, got {len(raw_atoms)}")
                if len(raw_atoms) < 2:
                    LOG.warning("atomizer: only %s ATM(s) — consider richer decomposition", len(raw_atoms))
                atoms = _normalize_atoms(epic, raw_atoms)
                break
            except ValueError as e:
                last_parse_err = e
                if attempt >= attempts - 1:
                    break
                LOG.warning("atomizer: parse failed, retry %s/%s — %s", attempt + 1, attempts, e)

        if atoms is None:
            if _atomizer_fallback_enabled():
                LOG.warning(
                    "atomizer: Qwen did not yield usable ATMs — using deterministic fallback from EPIC scope "
                    "(set FORGE_ATOMIZER_FALLBACK=0 to hard-fail instead)"
                )
                atoms = _normalize_atoms(epic, _fallback_atoms_from_epic(epic))
            elif isinstance(last_parse_err, Exception):
                raise last_parse_err
            else:
                raise ValueError("Atomizer produced no result")

    base = Path(env_paths()["OSNOVA_PROJECT"]) / ".osnova" / "epics" / str(epic["id"])
    base.mkdir(parents=True, exist_ok=True)
    for atom in atoms:
        atomic_write_yaml(base / f"{atom['id']}.yaml", atom)
    return atoms


def main() -> None:
    LOG.info("atomizer module ready")


if __name__ == "__main__":
    main()

