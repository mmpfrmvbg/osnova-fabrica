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
# Qwen CLI: FatalTurnLimitedError / exit 53 when session hits --max-session-turns (tsc-style ATM).
_DEFAULT_MAX_SESSION_TURNS = "40"


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


def _effective_max_session_turns(override: str | None) -> str:
    if override is not None:
        s = override.strip()
        return s if s else _DEFAULT_MAX_SESSION_TURNS
    raw = os.environ.get("FORGE_QWEN_MAX_SESSION_TURNS", _DEFAULT_MAX_SESSION_TURNS).strip()
    return raw or _DEFAULT_MAX_SESSION_TURNS


def _retry_max_session_turns_after_limit(base: str) -> str:
    """Second attempt after FatalTurnLimitedError; override: FORGE_QWEN_MAX_SESSION_TURNS_RETRY."""
    raw = os.environ.get("FORGE_QWEN_MAX_SESSION_TURNS_RETRY", "").strip()
    if raw.isdigit():
        try:
            b = max(1, int(base)) if base.isdigit() else 1
        except ValueError:
            b = 1
        return str(max(int(raw), b))
    try:
        b = max(1, int(base)) if base.isdigit() else int(_DEFAULT_MAX_SESSION_TURNS)
    except ValueError:
        b = 40
    return str(max(b * 3, 80))


def _qwen_shared_flags(*, max_session_turns: str | None = None) -> list[str]:
    tools = os.environ.get(
        "FORGE_QWEN_ALLOWED_TOOLS",
        "write_file,edit,read_file,run_shell_command,grep_search,glob",
    ).strip()
    turns = _effective_max_session_turns(max_session_turns)
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


def _qwen_code_invocation(prompt: str, *, max_session_turns: str | None = None) -> tuple[list[str], str | None, str]:
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
    tail = _qwen_shared_flags(max_session_turns=max_session_turns)
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
    argv, _stdin, _via = _qwen_code_invocation(prompt, max_session_turns=None)
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
    # Не логировать список через %s: str(list) даёт repr элементов → C:\\\\\\ в путях.
    LOG.info("qwenexec: FORGE_QWEN_CODE_PROMPT_VIA=%s argv=%s", via, subprocess.list2cmdline(safe))


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


def _is_fatal_turn_limit_error(combined: str, returncode: int) -> bool:
    """Qwen CLI: ``FatalTurnLimitedError`` / code 53 — не списываем бюджет на первой попытке, retry с большим ``--max-session-turns``."""
    if returncode == 53:
        return True
    for line in (combined or "").splitlines():
        s = line.strip()
        if not s.startswith("{"):
            continue
        try:
            obj = json.loads(s)
        except json.JSONDecodeError:
            continue
        if not isinstance(obj, dict):
            continue
        err = obj.get("error")
        if isinstance(err, dict):
            if err.get("type") == "FatalTurnLimitedError":
                return True
            try:
                if int(err.get("code", 0) or 0) == 53:
                    return True
            except (TypeError, ValueError):
                pass
    return False


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
        proc_returncode: int | None = None,
        output_tail: str | None = None,
    ) -> tuple[bool, dict[str, Any]]:
        tail = (output_tail or "").replace("\r\n", "\n").strip()
        if len(tail) > 2000:
            tail = tail[-2000:]
        rc = "n/a" if proc_returncode is None else str(proc_returncode)
        LOG.warning(
            "qwenexec: BLK %s returncode=%s err=%s — tail:\n%s",
            atom_id,
            rc,
            err,
            tail if tail else "(no capture)",
        )
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
        return _blk("Qwen executor daily budget exhausted", retry_cursor=True, output_tail="budget gate (can_call_executor false)")

    prompt = _prompt(atom)
    base_turns = _effective_max_session_turns(None)
    retry_turns = _retry_max_session_turns_after_limit(base_turns)

    def _run_once(turns: str) -> subprocess.CompletedProcess[str]:
        cmd, stdin_payload, via = _qwen_code_invocation(prompt, max_session_turns=turns)
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
        return _run_qwen(cmd, run_kw)

    try:
        proc = _run_once(base_turns)
    except TimeoutExpired:
        record(served=True, role="executor")
        return _blk(
            f"qwen code timeout after {run_s}s",
            retry_cursor=True,
            output_tail=f"TimeoutExpired after {run_s}s",
        )

    out = proc.stdout or ""
    err = proc.stderr or ""
    combined = f"{out}\n{err}"
    if is_quota_exhausted_output(combined):
        log_remote_qwen_limit("qwenexec", combined, ref=atom_id)
        record(served=False)
        return _blk(
            "Qwen API quota / rate limit",
            retry_cursor=True,
            proc_returncode=proc.returncode,
            output_tail=combined,
        )

    if _is_fatal_turn_limit_error(combined, proc.returncode):
        LOG.warning(
            "qwenexec: FatalTurnLimitedError / exit 53 for %s — retry without budget debit; --max-session-turns %s→%s",
            atom_id,
            base_turns,
            retry_turns,
        )
        try:
            proc = _run_once(retry_turns)
        except TimeoutExpired:
            record(served=True, role="executor")
            return _blk(
                f"qwen code timeout after {run_s}s",
                retry_cursor=True,
                output_tail=f"TimeoutExpired after {run_s}s (after turn-limit retry)",
            )
        out = proc.stdout or ""
        err = proc.stderr or ""
        combined = f"{out}\n{err}"
        if is_quota_exhausted_output(combined):
            log_remote_qwen_limit("qwenexec", combined, ref=atom_id)
            record(served=False)
            return _blk(
                "Qwen API quota / rate limit",
                retry_cursor=True,
                proc_returncode=proc.returncode,
                output_tail=combined,
            )

    record(served=True, role="executor")

    if proc.returncode != 0:
        tail = combined.strip()[-2000:]
        if _is_fatal_turn_limit_error(combined, proc.returncode):
            return _blk(
                "qwen code FatalTurnLimitedError (code 53) after retry with higher max-session-turns",
                retry_cursor=True,
                proc_returncode=proc.returncode,
                output_tail=tail,
            )
        return _blk(
            f"qwen code exit {proc.returncode}",
            retry_cursor=True,
            proc_returncode=proc.returncode,
            output_tail=tail,
        )

    # JSON может оказаться в stderr (редко) или весь буфер — склеиваем
    result = _parse_result_event(f"{out}\n{err}")
    if result is None:
        tail = f"{out}\n{err}".replace("\r\n", "\n").strip()[-2000:]
        return _blk(
            "qwen code output has no type=result JSON",
            retry_cursor=True,
            proc_returncode=proc.returncode,
            output_tail=tail,
        )

    is_err = bool(result.get("is_error"))
    delta = _files_delta(result)
    if is_err:
        return _blk(
            "qwen code result.is_error true",
            retry_cursor=True,
            proc_returncode=proc.returncode,
            output_tail=json.dumps(result, ensure_ascii=False)[:2000],
        )
    if delta <= 0:
        try:
            from forge.reviewer import run_atom_done_subprocess
        except ImportError:  # pragma: no cover
            from reviewer import run_atom_done_subprocess
        done_proc = run_atom_done_subprocess(atom, timeout_s=900)
        if done_proc is None:
            return _blk(
                "qwen code made no file changes (stats) and atom has no done command",
                retry_cursor=True,
                proc_returncode=proc.returncode,
                output_tail=json.dumps(result, ensure_ascii=False)[:2000],
            )
        if done_proc.returncode == 0:
            report_ok: dict[str, Any] = {
                "v": 5,
                "t": "RPT",
                "id": atom_id,
                "s": "OK",
                "changed": [],
                "elapsed": 0,
                "qwen_result": {
                    "lines_delta": delta,
                    "zero_line_delta_done_verified": True,
                },
                "reviewer_skip_done": True,
            }
            _write_report(project, atom_id, report_ok)
            return True, report_ok
        done_tail = f"{done_proc.stdout or ''}\n{done_proc.stderr or ''}".strip()[-2000:]
        return _blk(
            "qwen code zero line delta; ATM done command failed after OK agent result",
            retry_cursor=True,
            proc_returncode=done_proc.returncode,
            output_tail=f"{json.dumps(result, ensure_ascii=False)[:1200]}\n--- done ---\n{done_tail}",
        )

    report: dict[str, Any] = {
        "v": 5,
        "t": "RPT",
        "id": atom_id,
        "s": "OK",
        "changed": [],
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
