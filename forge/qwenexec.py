"""
Qwen **Code** CLI (агент с tools), не LLM-only.

Не использует ``qwen_headless_argv()`` из ``common.py`` — тот путь с ``--yolo`` и ``-p …``
без ``--output-format json``; здесь только ``--approval-mode yolo`` (не смешивать с ``--yolo`` — CLI падает в help).

Здесь: **обязательно** ``-p`` / ``--prompt`` для headless (см. Qwen Code docs); позиционный промпт без ``-p``
может открыть интерактив/приветствие вместо JSON. Разбор последнего ``{"type": "result"}`` в stdout+stderr.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
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


def _default_prompt_via() -> str:
    """Windows npm ``qwen.cmd`` часто ломает длинный ``-p``; надёжнее stdin (как ``echo | qwen`` в доке)."""
    return "stdin" if sys.platform == "win32" else "dash_p"


def _qwen_shared_flags() -> list[str]:
    tools = os.environ.get(
        "FORGE_QWEN_ALLOWED_TOOLS",
        "write_file,edit,read_file,run_shell_command,grep_search,glob",
    ).strip()
    turns = os.environ.get("FORGE_QWEN_MAX_SESSION_TURNS", "10").strip() or "10"
    return [
        "--approval-mode",
        "yolo",
        "--output-format",
        "json",
        "--max-session-turns",
        turns,
        "--allowed-tools",
        tools,
    ]


def _qwen_code_invocation(prompt: str) -> tuple[list[str], str | None, str]:
    """
    Возвращает ``(argv, stdin_or_none, via)``.

    - ``stdin``: ``qwen`` + флаги из ``_qwen_shared_flags()`` + промпт в stdin.
    - ``dash_p``: ``qwen -p PROMPT`` + те же флаги (headless в доке).
    - ``positional``: отладка — ``qwen PROMPT …`` (часто уходит в чат).

    Авто-approve только через ``--approval-mode yolo`` в ``_qwen_shared_flags``; отдельный ``--yolo``
    с ним конфликтует и ведёт к exit 1 / usage.
    """
    exe = resolve_executable(env_paths()["QWENBIN"])
    via_raw = forge_dotenv_setting("FORGE_QWEN_CODE_PROMPT_VIA", _default_prompt_via()).strip().lower()
    via = via_raw or _default_prompt_via().strip().lower()
    tail = _qwen_shared_flags()
    if via == "positional":
        return [exe, prompt, *tail], None, via
    if via == "stdin":
        return [exe, *tail], prompt, via
    # dash_p (явный дефолт на non-Windows) и любое неизвестное значение — безопасный headless
    if via not in ("dash_p", "-p", "p", ""):
        LOG.warning("qwenexec: unknown FORGE_QWEN_CODE_PROMPT_VIA=%r — using dash_p", via)
    return [exe, "-p", prompt, *tail], None, via


def _qwen_code_argv(prompt: str) -> list[str]:
    """Совместимость со старыми импортами; для stdin используйте ``_qwen_code_invocation``."""
    argv, _stdin, _via = _qwen_code_invocation(prompt)
    return argv


def _run_qwen(cmd: list[str], run_kw: dict[str, Any]) -> subprocess.CompletedProcess[str]:
    """
    Windows: ``CreateProcess`` не резолвит ``qwen`` как npm-.cmd; ``resolve_executable`` даёт путь к .cmd.
    Если файла всё ещё нет — ``shell=True`` + ``list2cmdline`` (cmd.exe ищет PATH).
    """
    exe = cmd[0]
    if sys.platform == "win32" and not Path(exe).is_file():
        exe2 = resolve_executable(env_paths()["QWENBIN"])
        if Path(exe2).is_file():
            cmd = [exe2] + list(cmd[1:])
        else:
            line = subprocess.list2cmdline(cmd)
            return subprocess.run(line, shell=True, **run_kw)
    return subprocess.run(cmd, **run_kw)


def _log_qwen_argv(cmd: list[str], via: str) -> None:
    safe: list[str] = []
    for i, a in enumerate(cmd):
        prev = cmd[i - 1] if i else ""
        if prev in ("-p", "--prompt") and len(a) > 100:
            safe.append(f"{a[:72]}…({len(a)} chars)")
        else:
            safe.append(a)
    LOG.info("qwenexec: FORGE_QWEN_CODE_PROMPT_VIA=%s argv=%s", via, safe)


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

    prompt = _prompt(atom)
    cmd, stdin_payload, via = _qwen_code_invocation(prompt)
    _log_qwen_argv(cmd, via)
    run_kw: dict[str, Any] = {
        "cwd": str(project),
        "capture_output": True,
        "text": True,
        "timeout": run_s,
        "check": False,
        **SUBPROCESS_TEXT,
    }
    if stdin_payload is not None:
        run_kw["input"] = stdin_payload
    else:
        run_kw["stdin"] = subprocess.DEVNULL
    try:
        proc = _run_qwen(cmd, run_kw)
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
