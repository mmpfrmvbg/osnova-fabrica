"""
Qwen **Code** CLI (агент с tools), не LLM-only.

Не использует ``qwen_headless_argv()`` из ``common.py`` — тот путь ``qwen --yolo -p …``
без ``--output-format json`` и без ``--approval-mode``; он рассчитан на старый режим и YAML в stdout.

Здесь: **обязательно** ``-p`` / ``--prompt`` для headless (см. Qwen Code docs); позиционный промпт без ``-p``
может открыть интерактив/приветствие вместо JSON. Разбор последнего ``{"type": "result"}`` в stdout+stderr.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path
from subprocess import TimeoutExpired
from typing import Any

try:
    from forge.common import (
        SUBPROCESS_TEXT,
        atomic_write_yaml,
        env_paths,
        forge_dotenv_setting,
        resolve_executable,
        setup_logging,
    )
    from forge.qwenbudget import (
        can_call_executor,
        is_quota_exhausted_output,
        log_remote_qwen_limit,
        record,
    )
except ImportError:  # pragma: no cover
    from common import (
        SUBPROCESS_TEXT,
        atomic_write_yaml,
        env_paths,
        forge_dotenv_setting,
        resolve_executable,
        setup_logging,
    )
    from qwenbudget import (
        can_call_executor,
        is_quota_exhausted_output,
        log_remote_qwen_limit,
        record,
    )

LOG = setup_logging("qwenexec")

_DEFAULT_QWEN_RUN_S = 900


def _qwen_run_timeout() -> int:
    raw = os.environ.get("FORGE_QWEN_TIMEOUT", "").strip()
    if raw.isdigit():
        return max(30, int(raw))
    return _DEFAULT_QWEN_RUN_S


def _prompt(atom: dict[str, Any]) -> str:
    project = env_paths()["OSNOVA_PROJECT"]
    return (
        "Ты — forge smith. Репозиторий: "
        f"{project}.\n"
        f"Задача: {atom.get('goal')}\n"
        f"Файлы scope (прочти перед правкой): {atom.get('scope')}\n"
        f"Шаги: {atom.get('steps')}\n"
        f"Проверка: запусти {atom.get('done')} и убедись что exit code 0.\n"
        f"Не трогай: {atom.get('notouch')}\n"
        "Ответь кратко что изменил.\n"
    )


def _qwen_code_argv(prompt: str) -> list[str]:
    """
    Qwen Code headless: ``qwen -p \"…\" --approval-mode yolo --output-format json …``
    (официальная документация: headless только с ``--prompt`` / ``-p``).

    ``FORGE_QWEN_CODE_PROMPT_VIA=positional`` — экспериментально ``qwen <prompt> …`` (может **не** быть headless).
    """
    exe = resolve_executable(env_paths()["QWENBIN"])
    tools = os.environ.get(
        "FORGE_QWEN_ALLOWED_TOOLS",
        "write_file,edit,read_file,run_shell_command,grep_search,glob",
    ).strip()
    turns = os.environ.get("FORGE_QWEN_MAX_SESSION_TURNS", "10").strip() or "10"
    # Default dash_p: headless requires ``qwen -p …``; empty/unset must not fall through to positional.
    via = forge_dotenv_setting("FORGE_QWEN_CODE_PROMPT_VIA", "dash_p").strip().lower()
    flags: list[str] = [
        "--approval-mode",
        "yolo",
        "--output-format",
        "json",
        "--max-session-turns",
        turns,
        "--allowed-tools",
        tools,
    ]
    if via == "positional":
        return [exe, prompt, *flags]
    return [exe, "-p", prompt, *flags]


def _parse_result_event(stdout: str) -> dict[str, Any] | None:
    """Find last JSON object with type==result (NDJSON lines or one blob or array)."""
    events: list[dict[str, Any]] = []
    for line in (stdout or "").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
            if isinstance(obj, dict):
                events.append(obj)
        except json.JSONDecodeError:
            continue
    for r in reversed(events):
        if r.get("type") == "result":
            return r
    blob = (stdout or "").strip()
    if not blob:
        return None
    try:
        data = json.loads(blob)
        if isinstance(data, dict) and data.get("type") == "result":
            return data
        if isinstance(data, list):
            for r in reversed(data):
                if isinstance(r, dict) and r.get("type") == "result":
                    return r
    except json.JSONDecodeError:
        pass
    for m in re.finditer(r"\{[^{}]*\"type\"\s*:\s*\"result\"[^{}]*\}", blob, flags=re.DOTALL):
        try:
            obj = json.loads(m.group(0))
            if isinstance(obj, dict):
                return obj
        except json.JSONDecodeError:
            continue
    return None


def _files_delta(result: dict[str, Any]) -> int:
    try:
        st = result.get("stats") or {}
        files = st.get("files") or {}
        return int(files.get("totalLinesAdded", 0) or 0) + int(files.get("totalLinesRemoved", 0) or 0)
    except (TypeError, ValueError):
        return 0


def _write_report(project: Path, atom_id: str, report: dict[str, Any]) -> None:
    try:
        p = project / ".osnova" / "report.yaml"
        p.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_yaml(p, report)
    except Exception as exc:
        LOG.warning("qwenexec: could not write report.yaml: %s", exc)


def run_atom(atom: dict[str, Any], dry_run: bool = False) -> tuple[bool, dict[str, Any]]:
    atom_id = str(atom.get("id") or "")
    if dry_run:
        LOG.info("[dry-run] Would call Qwen Code for %s", atom_id)
        return True, {"v": 5, "t": "RPT", "id": atom_id, "s": "OK", "changed": [], "elapsed": 0}

    run_s = _qwen_run_timeout()
    project = Path(env_paths()["OSNOVA_PROJECT"])
    LOG.info(
        "qwenexec: Qwen Code CLI for %s (timeout %ss; FORGE_QWEN_TIMEOUT)",
        atom_id,
        run_s,
    )

    def _blk(
        err: str,
        *,
        retry_cursor: bool = True,
    ) -> tuple[bool, dict[str, Any]]:
        r: dict[str, Any] = {
            "v": 5,
            "t": "RPT",
            "id": atom_id,
            "s": "BLK",
            "err": err,
            "changed": [],
        }
        if retry_cursor:
            r["forge_retry_executor"] = "cursor"
        _write_report(project, atom_id, r)
        return False, r

    if not can_call_executor():
        return _blk("Qwen executor daily budget exhausted", retry_cursor=True)

    cmd = _qwen_code_argv(_prompt(atom))
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(project),
            capture_output=True,
            text=True,
            timeout=run_s,
            check=False,
            **SUBPROCESS_TEXT,
        )
    except TimeoutExpired:
        LOG.error("qwenexec: timeout after %ss for %s", run_s, atom_id)
        record(served=True, role="executor")
        return _blk(f"qwen code timeout after {run_s}s", retry_cursor=True)

    out = proc.stdout or ""
    err = proc.stderr or ""
    combined = f"{out}\n{err}"
    if is_quota_exhausted_output(combined):
        log_remote_qwen_limit("qwenexec", combined, ref=atom_id)
        record(served=False)
        return _blk("Qwen API quota / rate limit", retry_cursor=True)

    record(served=True, role="executor")

    if proc.returncode != 0:
        tail = combined.strip()[-2000:]
        LOG.warning("qwenexec: exit %s for %s — %s", proc.returncode, atom_id, tail)
        return _blk(f"qwen code exit {proc.returncode}", retry_cursor=True)

    # JSON может оказаться в stderr (редко) или весь буфер — склеиваем
    result = _parse_result_event(f"{out}\n{err}")
    if result is None:
        tail = f"{out}\n{err}".replace("\r\n", "\n").strip()[-2000:]
        LOG.warning("qwenexec: no type=result JSON for %s — tail:\n%s", atom_id, tail)
        return _blk("qwen code output has no type=result JSON", retry_cursor=True)

    is_err = bool(result.get("is_error"))
    delta = _files_delta(result)
    if is_err:
        return _blk("qwen code result.is_error true", retry_cursor=True)
    if delta <= 0:
        return _blk("qwen code made no file changes (stats)", retry_cursor=True)

    report: dict[str, Any] = {
        "v": 5,
        "t": "RPT",
        "id": atom_id,
        "s": "OK",
        "changed": [f"~{delta} lines"],
        "elapsed": 0,
        "qwen_result": {"lines_delta": delta},
        # Agent prompt already runs `done`; reviewer can skip second vitest (see forge.review skip_done_command).
        "reviewer_skip_done": True,
    }
    _write_report(project, atom_id, report)
    return True, report


def main() -> None:
    LOG.info("qwenexec module ready")


if __name__ == "__main__":
    main()
