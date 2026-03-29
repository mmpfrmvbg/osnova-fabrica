from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

import yaml

try:
    from forge.common import (
        SUBPROCESS_TEXT,
        atomic_write_yaml,
        cursor_cli_available,
        cursor_headless_argv,
        env_paths,
        find_cursor_agent_node_bundle,
        qwen_headless_argv,
        resolve_executable,
        setup_logging,
    )
    from forge.qwenbudget import can_call_atomizer, is_quota_exhausted_output, log_remote_qwen_limit, record
except ImportError:  # pragma: no cover
    from common import (
        SUBPROCESS_TEXT,
        atomic_write_yaml,
        cursor_cli_available,
        cursor_headless_argv,
        env_paths,
        find_cursor_agent_node_bundle,
        qwen_headless_argv,
        resolve_executable,
        setup_logging,
    )
    from qwenbudget import can_call_atomizer, is_quota_exhausted_output, log_remote_qwen_limit, record

LOG = setup_logging("atomizer")

_DEFAULT_ATOMIZER_S = 180

# EPIC decomposition targets (see forge plan: Cursor atomizer + Qwen executor)
ATM_TARGET_MIN = 12
ATM_TARGET_MAX = 16
ATM_COUNT_MIN = 8
ATM_COUNT_MAX = 20
MAX_SCOPE_FILES_EPIC = 12

_ATOM_LIST_WRAPPER_KEYS = frozenset({"atoms", "tasks", "atms", "items", "atm_list", "list"})
_SINGLE_ATOM_TOP_KEYS = frozenset(
    {"goal", "scope", "steps", "seq", "id", "name", "zone", "risk", "done", "notouch", "deps", "executor"},
)
_ATM_OR_NUMERIC_KEY_RE = re.compile(r"^(ATM-[A-Za-z0-9_.-]+|[0-9]+)$")


def _atomizer_timeout() -> int:
    raw = os.environ.get("FORGE_ATOMIZER_TIMEOUT", "").strip()
    if raw.isdigit():
        return max(30, int(raw))
    return _DEFAULT_ATOMIZER_S


def _atomizer_cursor_timeout() -> int:
    raw = os.environ.get("FORGE_ATOMIZER_CURSOR_TIMEOUT", "").strip()
    if raw.isdigit():
        return max(60, int(raw))
    return max(_atomizer_timeout(), 300)


def _atomizer_engine() -> str:
    v = os.environ.get("FORGE_ATOMIZER_ENGINE", "cursor").strip().lower()
    return v if v in ("cursor", "qwen") else "cursor"


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


def _epic_for_atomizer_prompt(epic: dict[str, Any], *, engine: str) -> dict[str, Any]:
    """
    Для Cursor: в тексте промпта подменяем ``id`` с дефисами на подчёркивания — часть PS/CLI цепочек
    некорректно парсит hyphenated slug рядом с другими флагами. На данные epics/*.yaml не влияет.
    """
    if engine != "cursor":
        return epic
    e = dict(epic)
    oid = e.get("id")
    if oid is not None and str(oid).strip():
        e["id"] = str(oid).strip().replace("-", "_")
    return e


def _epic_trailer(epic: dict[str, Any], *, engine: str) -> str:
    """Short repeated summary so the model sees id/goal/scope even if long YAML is truncated upstream."""
    eid = _epic_for_atomizer_prompt(epic, engine=engine).get("id", "")
    goal = str(epic.get("goal", ""))[:600]
    scope = epic.get("scope") or []
    paths = ", ".join(str(p).split("—")[0].strip() for p in scope[:MAX_SCOPE_FILES_EPIC] if p)
    done = str(epic.get("done", ""))[:200]
    extra = ""
    if engine == "cursor":
        extra = (
            "You have the full git workspace — use it to name exact files and one test file per ATM for `done`.\n"
        )
    return (
        "\n---\n"
        "REPEAT (do not ignore): EPIC id, goal, and scope are HERE — not in a file on disk.\n"
        f"  id: {eid!r}\n"
        f"  goal: {goal}\n"
        f"  scope paths: {paths or '(none)'}\n"
        f"  done (epic reference): {done}\n"
        f"{extra}"
        f"You MUST output a non-empty YAML list with {ATM_TARGET_MIN}-{ATM_TARGET_MAX} items (hard range {ATM_COUNT_MIN}-{ATM_COUNT_MAX}). "
        f"Epic-wide file list must not exceed {MAX_SCOPE_FILES_EPIC} unique paths. Never output []. Never ask for the EPIC text.\n"
    )


def _prompt(epic: dict[str, Any], *, engine: str) -> str:
    dumped = yaml.safe_dump(_epic_for_atomizer_prompt(epic, engine=engine), allow_unicode=True, sort_keys=False)
    core_rules = (
        "CRITICAL — read before answering:\n"
        "- The EPIC is the YAML block below. It is NOT a filename. "
        "Do NOT search the repo for pipeline.yaml, spec.yaml, or files named EPIC.\n"
        "- Do NOT ask questions. Do NOT explain. Do NOT refuse. Do NOT output an empty list [].\n"
        "- Output ONLY machine-readable structure: a YAML list (dash-prefixed items) OR a JSON array of objects.\n"
        "- Optional: wrap the list in a ```yaml or ```json fenced block.\n\n"
        f"Each ATM item MUST include: seq, zone, risk, goal, scope (exactly ONE file path string in scope), "
        f"notouch, steps (list), deps (list), done (one narrow command, typically one vitest file), "
        f"executor: qwen. "
        f"Executor policy: Qwen Code runs implementation; Cursor is only for P0/HIGH risk or fallback — "
        f"output executor: qwen for every ATM here.\n"
        "In scope[], a single path first; optional note after em-dash — .\n"
        "Split the epic `done` reference into per-ATM narrow `done` commands (one test file each).\n\n"
        "EPIC (complete YAML — this is the only source of truth):\n"
        f"{dumped}"
        f"{_epic_trailer(epic, engine=engine)}"
    )
    if engine == "cursor":
        return (
            "You are the OSNOVA forge atomizer (Cursor). Split the EPIC into "
            f"{ATM_TARGET_MIN}-{ATM_TARGET_MAX} tiny ATM tasks (max {MAX_SCOPE_FILES_EPIC} distinct files across the epic). "
            "Use the repository checkout to pick concrete paths.\n\n"
            + core_rules
        )
    return (
        "You are the OSNOVA forge atomizer (Qwen). Split the EPIC into "
        f"{ATM_TARGET_MIN}-{ATM_TARGET_MAX} tiny ATM tasks (max {MAX_SCOPE_FILES_EPIC} distinct files across the epic).\n\n"
        + core_rules
    )


def _prompt_retry(epic: dict[str, Any], bad_tail: str, *, engine: str) -> str:
    dumped = yaml.safe_dump(_epic_for_atomizer_prompt(epic, engine=engine), allow_unicode=True, sort_keys=False)
    return (
        "Your previous reply was NOT valid: empty [], questions, or not parseable. "
        "Reply with ONLY a non-empty YAML list or JSON array — no prose, no [].\n\n"
        "Example shape (YAML):\n"
        "```yaml\n"
        "- seq: 1\n  zone: lang\n  risk: MEDIUM\n  goal: \"...\"\n  scope: [src/foo.ts]\n"
        "  notouch: []\n  steps: [\"step\"]\n  deps: []\n  done: \"npx vitest run src/foo.test.ts\"\n  executor: qwen\n"
        "- seq: 2\n  ...\n"
        "```\n\n"
        f"EPIC:\n{dumped}\n"
        f"{_epic_trailer(epic, engine=engine)}\n"
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
        for key in _ATOM_LIST_WRAPPER_KEYS:
            v = data.get(key)
            if isinstance(v, list) and v and all(isinstance(x, dict) for x in v):
                LOG.info("atomizer: unwrapped list from key %r", key)
                return v
        one = data.get("atm")
        if isinstance(one, dict):
            LOG.info("atomizer: unwrapped single key 'atm'")
            return [one]
        if any(k in data for k in _SINGLE_ATOM_TOP_KEYS):
            LOG.warning("atomizer: one top-level mapping — treating as single ATM (model should return a list)")
            return [data]
        # Mapping keyed by ATM-… or numeric id → list of dicts (model omitted list dashes)
        if data and all(isinstance(v, dict) for v in data.values()):
            keys = [str(k) for k in data.keys()]
            if keys and all(_ATM_OR_NUMERIC_KEY_RE.match(k) for k in keys):
                if not any(k in data for k in _ATOM_LIST_WRAPPER_KEYS):
                    LOG.info("atomizer: coerced mapping keyed by ATM / seq id to list (%s items)", len(keys))
                    out: list[dict[str, Any]] = []
                    for k, v in data.items():
                        row = dict(v)
                        ks = str(k).strip()
                        if ks.isdigit():
                            row.setdefault("seq", int(ks))
                        elif not row.get("id") and not row.get("name"):
                            row["id"] = ks
                        out.append(row)
                    return out
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
    """cursor | qwen if set on atom or epic; None → default qwen in _normalize_atoms."""
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
    """Last-resort decomposition without LLM (1 ATM with full scope, or one ATM per file up to 10)."""
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
    if len(paths) == 1 or len(paths) > 10:
        return [
            {
                "seq": 1,
                "zone": zone,
                "risk": "MEDIUM",
                "goal": goal,
                "scope": paths[:10],
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


def _run_cursor_atomizer(prompt: str, timeout: int) -> subprocess.CompletedProcess:
    """Invoke Cursor agent for atomizer; prefer stdin for long prompts on Windows."""
    use_stdin = _atomizer_use_stdin()
    proj = env_paths()["OSNOVA_PROJECT"]
    kw: dict[str, Any] = {
        "capture_output": True,
        "text": True,
        "timeout": timeout,
        "check": False,
        **SUBPROCESS_TEXT,
    }
    if sys.platform == "win32":
        bundle = find_cursor_agent_node_bundle()
        if bundle:
            node_exe, index_js = bundle
            tail: list[str] = ["-p", "--yolo", "--trust", "--workspace", str(proj)]
            model = os.environ.get("FORGE_ATOMIZER_CURSOR_MODEL", "").strip()
            if model and model not in ("_", "-"):
                tail.extend(["--model", model])
            argv = [str(node_exe), str(index_js), *tail]
            # Do not pass "-" as argv: Cursor treats it as the literal prompt ("You only sent a dash").
            # Match cursorexec smith_native: either append prompt to argv or feed stdin via input= only.
            if use_stdin:
                kw.pop("stdin", None)
                kw["input"] = prompt
            else:
                argv.append(prompt)
                kw["stdin"] = subprocess.DEVNULL
            return subprocess.run(argv, **kw)
    argv = cursor_headless_argv("", workspace=proj, use_stdin=use_stdin)
    if use_stdin:
        kw["input"] = prompt
    else:
        kw["stdin"] = subprocess.DEVNULL
    return subprocess.run(argv, **kw)


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


def _seq_and_atom_id(atom: dict[str, Any], idx: int, epic_id: str) -> tuple[int, str]:
    """
    Числовой seq и стабильный id. Поддержка: ``id`` / ``name``; ``seq`` как int или строка ``ATM-…-009``.
    """
    raw_id = atom.get("id") or atom.get("name")
    if raw_id is not None:
        sid = str(raw_id).strip()
        if sid:
            m = re.search(r"-(\d{1,4})\s*$", sid)
            seq_guess = int(m.group(1)) if m and m.group(1).isdigit() else idx
            return seq_guess, sid
    raw = atom.get("seq")
    if raw is None:
        return idx, f"ATM-{epic_id}-{idx:03d}"
    if isinstance(raw, bool):
        return idx, f"ATM-{epic_id}-{idx:03d}"
    if isinstance(raw, int):
        return raw, f"ATM-{epic_id}-{raw:03d}"
    s = str(raw).strip()
    if s.isdigit():
        n = int(s)
        return n, f"ATM-{epic_id}-{n:03d}"
    if s.upper().startswith("ATM"):
        m = re.search(r"-(\d{1,4})\s*$", s)
        n = int(m.group(1)) if m and m.group(1).isdigit() else idx
        return n, s
    try:
        n = int(float(s))
        return n, f"ATM-{epic_id}-{n:03d}"
    except ValueError:
        return idx, f"ATM-{epic_id}-{idx:03d}"


def _ref_seq_key_for_suffix_match(s: str) -> str | None:
    """Numeric seq for matching atom id suffix (1 ↔ …-001). Returns None if not a short ref."""
    t = s.strip()
    if t.isdigit():
        return str(int(t))
    u = t.upper()
    if u.startswith("ATM-"):
        rest = t[4:]
        if rest.isdigit():
            return str(int(rest))
    return None


def _coerce_dep_to_atm_id(raw: Any, epic_id: str, known_ids: set[str]) -> str | None:
    """Map atomizer output (often seq numbers) to ATM-{epic}-{seq:03d} for parallel_executor."""
    if raw is None:
        return None
    s = str(raw).strip()
    if not s:
        return None
    if s in known_ids:
        return s
    if s.isdigit():
        cand = f"ATM-{epic_id}-{int(s):03d}"
        if cand in known_ids or not known_ids:
            return cand
    prefix = f"ATM-{epic_id}-"
    if s.startswith(prefix):
        tail = s[len(prefix) :]
        if tail.isdigit():
            cand = f"ATM-{epic_id}-{int(tail):03d}"
            if cand in known_ids or not known_ids:
                return cand
    # Without ATM- prefix: EPK-260328-015-001
    epic_hyphen = f"{epic_id}-"
    if s.startswith(epic_hyphen):
        tail = s[len(epic_hyphen) :]
        if tail.isdigit():
            cand = f"ATM-{epic_id}-{int(tail):03d}"
            if cand in known_ids or not known_ids:
                return cand
    # Shorthand last epic segment + seq: 015-001 for epic ...-015
    last_seg = epic_id.rsplit("-", 1)[-1] if epic_id else ""
    if last_seg and s.startswith(f"{last_seg}-"):
        tail = s[len(last_seg) + 1 :]
        if tail.isdigit():
            cand = f"ATM-{epic_id}-{int(tail):03d}"
            if cand in known_ids or not known_ids:
                return cand
    # Brain waves: ATM-001 / 1 while atoms are ATM-EPK-…-001 (deterministic fallback ids)
    sk = _ref_seq_key_for_suffix_match(s)
    if sk is not None:
        matches: list[str] = []
        for kid in known_ids:
            last = kid.rsplit("-", 1)[-1]
            if last.isdigit() and str(int(last)) == sk:
                matches.append(kid)
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            return sorted(matches)[0]
        return None
    return s


def _normalize_deps_list(deps: Any, epic_id: str, known_ids: set[str]) -> list[str]:
    if not isinstance(deps, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    unknown: list[str] = []
    for raw in deps:
        cid = _coerce_dep_to_atm_id(raw, epic_id, known_ids)
        if cid is None:
            continue
        if cid in seen:
            continue
        seen.add(cid)
        out.append(cid)
        if cid not in known_ids:
            unknown.append(cid)
    if unknown:
        LOG.warning(
            "atomizer: deps reference id(s) not in this epic (%s) — parallel waves may degrade",
            unknown[:8],
        )
    return out


def _normalize_atoms(epic: dict[str, Any], atoms: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    epic_id = str(epic["id"])
    done_cmd = epic["done"]
    for idx, atom in enumerate(atoms, start=1):
        seq, atom_id = _seq_and_atom_id(atom, idx, epic_id)
        ex = _normalized_executor(atom, epic)
        if ex is None:
            ex = "qwen"
        per_done = atom.get("done")
        if per_done is None or str(per_done).strip() == "":
            per_done = done_cmd
        out.append(
            {
                "id": atom_id,
                "epic": epic_id,
                "seq": seq,
                "zone": atom.get("zone", epic.get("zone", "lang")),
                "risk": atom.get("risk", epic.get("risk", "MEDIUM")),
                "executor": ex,
                "goal": atom.get("goal", ""),
                "scope": atom.get("scope", []),
                "notouch": atom.get("notouch", epic.get("notouch", [])),
                "done": per_done,
                "steps": atom.get("steps", []),
                "deps": atom.get("deps", []),
                "maxiter": 3,
                "retries": 0,
                "status": "PENDING",
                "priority": epic.get("priority", "P2"),
            }
        )
    known_ids = {a["id"] for a in out}
    for a in out:
        a["deps"] = _normalize_deps_list(a.get("deps"), epic_id, known_ids)
    return out


def atomize(epic: dict[str, Any], dry_run: bool = False) -> list[dict[str, Any]]:
    if dry_run:
        atoms = _normalize_atoms(epic, [])
        if not atoms:
            atoms = _normalize_atoms(epic, [{"seq": 1, "goal": epic.get("goal", ""), "scope": epic.get("scope", [])}])
    else:
        engine = _atomizer_engine()
        tmo_q = _atomizer_timeout()
        tmo_c = _atomizer_cursor_timeout()
        attempts = _atomizer_attempts()
        LOG.info(
            "atomizer: engine=%s; qwen_timeout=%ss cursor_timeout=%ss; %s attempt(s); stdin=%s",
            engine,
            tmo_q,
            tmo_c,
            attempts,
            "on" if _atomizer_use_stdin() else "off",
        )
        stdout_last = ""
        last_parse_err: Exception | None = None
        atoms: list[dict[str, Any]] | None = None
        for attempt in range(attempts):
            eng = engine
            prompt = _prompt(epic, engine=eng) if attempt == 0 else _prompt_retry(epic, stdout_last, engine=eng)
            proc: subprocess.CompletedProcess | None = None
            used_qwen = False
            out_text = ""

            want_cursor = eng == "cursor" and cursor_cli_available()
            if want_cursor:
                proc = _run_cursor_atomizer(prompt, tmo_c)
                out_text = proc.stdout or ""
                comb_c = f"{proc.stdout or ''}\n{proc.stderr or ''}"
                if proc.returncode != 0 and _atomizer_fallback_enabled() and can_call_atomizer():
                    err_fb = comb_c.strip()[-800:]
                    LOG.warning(
                        "atomizer: Cursor exit %s — fallback to Qwen atomizer; tail: %s",
                        proc.returncode,
                        err_fb or "(no stdout/stderr)",
                    )
                    proc = _run_qwen_atomizer(prompt, tmo_q)
                    used_qwen = True
                    out_text = proc.stdout or ""
                    comb = f"{proc.stdout or ''}\n{proc.stderr or ''}"
                    if is_quota_exhausted_output(comb):
                        log_remote_qwen_limit("atomizer", comb, ref=str(epic.get("id") or ""))
                        last_parse_err = RuntimeError("Qwen API quota exceeded")
                        break
                    record(served=True, role="atomizer")
                elif proc.returncode != 0:
                    err_tail = comb_c.strip()[-800:]
                    LOG.error("atomizer: Cursor exit %s — %s", proc.returncode, err_tail)
                    last_parse_err = RuntimeError(f"Cursor atomizer failed (exit {proc.returncode})")
                    if attempt >= attempts - 1:
                        break
                    LOG.warning("atomizer: Cursor failed, retry %s/%s", attempt + 1, attempts)
                    continue
            else:
                if eng == "cursor" and not cursor_cli_available():
                    LOG.warning("atomizer: CURSORBIN not available — using Qwen atomizer")
                if not can_call_atomizer():
                    LOG.warning("atomizer: Qwen atomizer daily budget exhausted")
                    last_parse_err = RuntimeError("Qwen atomizer budget exhausted (forge)")
                    break
                proc = _run_qwen_atomizer(prompt, tmo_q)
                used_qwen = True
                out_text = proc.stdout or ""
                comb = f"{proc.stdout or ''}\n{proc.stderr or ''}"
                if is_quota_exhausted_output(comb):
                    log_remote_qwen_limit("atomizer", comb, ref=str(epic.get("id") or ""))
                    last_parse_err = RuntimeError("Qwen API quota exceeded")
                    break
                record(served=True, role="atomizer")

            if proc is None:
                last_parse_err = RuntimeError("atomizer: no subprocess result")
                break

            if used_qwen and proc.returncode != 0:
                err_tail = (proc.stderr or proc.stdout or "").strip()[-800:]
                LOG.error("atomizer: Qwen exit %s — %s", proc.returncode, err_tail)
                last_parse_err = RuntimeError(f"Qwen atomizer failed (exit {proc.returncode})")
                if attempt >= attempts - 1:
                    break
                LOG.warning("atomizer: Qwen failed, retry %s/%s", attempt + 1, attempts)
                continue

            stdout_last = out_text
            try:
                raw_atoms = _extract_yaml(stdout_last)
                n = len(raw_atoms)
                if not (ATM_COUNT_MIN <= n <= ATM_COUNT_MAX):
                    raise ValueError(
                        f"Atomizer must return {ATM_COUNT_MIN}-{ATM_COUNT_MAX} ATM items, got {n}",
                    )
                if n < ATM_TARGET_MIN or n > ATM_TARGET_MAX:
                    LOG.warning(
                        "atomizer: %s ATM(s) — target is %s-%s per EPIC",
                        n,
                        ATM_TARGET_MIN,
                        ATM_TARGET_MAX,
                    )
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

