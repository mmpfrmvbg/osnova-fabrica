"""
Человекочитаемый русскоязычный слой логов для forge (дополняет logging, не заменяет).
"""

from __future__ import annotations

import re
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any

try:
    from forge.common import env_paths
except ImportError:  # pragma: no cover
    from common import env_paths

_last_vitest_total: int = 0
_epic_tests_before: int = 0

try:
    from colorama import Fore, Style, init as colorama_init

    colorama_init(autoreset=True)
    _HAS_COLOR = True
except Exception:
    Fore = Style = None  # type: ignore[misc, assignment]
    _HAS_COLOR = False


def _ts() -> str:
    return datetime.now().astimezone().strftime("%H:%M")


def _log_path() -> Path:
    root = Path(env_paths()["OSNOVA_PROJECT"])
    d = root / "logs"
    d.mkdir(parents=True, exist_ok=True)
    return d / "human.log"


def parse_vitest_output(text: str) -> tuple[int, int, float]:
    """Vitest stdout: сумма passed, оценка total, последняя Duration в секундах."""
    if not text or not text.strip():
        return 0, 0, 0.0
    passed_sum = 0
    for m in re.finditer(r"Tests\s+(\d+)\s+passed(?:\s+\((\d+)\))?", text, re.IGNORECASE):
        passed_sum += int(m.group(1))
    failed_sum = 0
    for m in re.finditer(r"Tests\s+(\d+)\s+failed", text, re.IGNORECASE):
        failed_sum += int(m.group(1))
    total = passed_sum + failed_sum
    if total == 0 and passed_sum > 0:
        total = passed_sum

    dur_s = 0.0
    for m in re.finditer(r"Duration\s+([\d.]+)\s*(ms|s)", text, re.IGNORECASE):
        val = float(m.group(1))
        unit = (m.group(2) or "s").lower()
        dur_s = val / 1000.0 if unit == "ms" else val
    return passed_sum, max(total, passed_sum), dur_s


def epic_start_snapshot() -> None:
    global _epic_tests_before
    _epic_tests_before = _last_vitest_total


def epic_done_tests() -> tuple[int, int]:
    return _epic_tests_before, _last_vitest_total


def _format_message(event: str, **kwargs: Any) -> str:
    t = _ts()
    if event == "epic_start":
        eid = kwargs.get("epic_id", "?")
        goal = (kwargs.get("goal") or "")[:300]
        n = int(kwargs.get("atm_total") or 0)
        return f"🚀 [{t}] Новый EPIC {eid}: {goal} ({n} задач)"
    if event == "atm_start":
        seq = int(kwargs.get("seq") or 0)
        tot = int(kwargs.get("atm_total") or 0)
        goal = (kwargs.get("goal") or "")[:200]
        return f"🔄 [{t}] Задача {seq}/{tot}: {goal}"
    if event == "smith_heartbeat":
        elapsed = int(kwargs.get("elapsed_s") or 0)
        return f"⏳ [{t}] Cursor работает... ({elapsed} сек)"
    if event == "smith_done":
        aid = kwargs.get("atm_id", "?")
        fc = kwargs.get("files_changed")
        if fc is not None:
            return f"🤖 [{t}] Cursor завершил задачу {aid}. Изменено файлов: {int(fc)}"
        return f"🤖 [{t}] Cursor завершил задачу {aid}."
    if event == "tests_run":
        p = int(kwargs.get("passed") or 0)
        tot = int(kwargs.get("total") or 0)
        d = float(kwargs.get("duration_s") or 0.0)
        sym = "✅" if p == tot and tot > 0 else "❌"
        return f"🧪 [{t}] Тесты: {p}/{tot} {sym} ({d:.1f} сек)"
    if event == "review_pass":
        e = int(kwargs.get("elapsed_s") or 0)
        return f"✅ [{t}] Ревью пройдено ({e} сек)"
    if event == "review_fail":
        reason = (kwargs.get("reason") or "")[:80]
        e = int(kwargs.get("elapsed_s") or 0)
        return f"❌ [{t}] Ревью не пройдено: {reason} ({e} сек)"
    if event == "review_skip":
        reason = (kwargs.get("reason") or "")[:120]
        return f"⚠️  [{t}] Ревью пропущено — {reason}. Авто-PASS (тесты зелёные)."
    if event == "atm_ok":
        e = int(kwargs.get("elapsed_s") or 0)
        return f"✅ [{t}] Задача выполнена ({e} сек)"
    if event == "atm_blk":
        aid = kwargs.get("atm_id", "?")
        reason = (kwargs.get("reason") or "")[:120]
        return f"❌ [{t}] Задача заблокирована: {reason} — {aid}"
    if event == "epic_done":
        eid = kwargs.get("epic_id", "?")
        ok = int(kwargs.get("ok") or 0)
        tot = int(kwargs.get("total") or 0)
        tb = int(kwargs.get("tests_before") or 0)
        ta = int(kwargs.get("tests_after") or 0)
        delta = ta - tb
        return (
            f"📦 [{t}] EPIC {eid} завершён: {ok}/{tot} задач OK\n"
            f"    Тестов: {tb} → {ta} ({delta:+d})\n"
            f"    Код отправлен в GitHub ✅"
        )
    if event == "qwen_quota":
        detail = (kwargs.get("detail") or "").strip()
        if detail:
            return f"⚠️  [{t}] Qwen: {detail}"
        return f"⚠️  [{t}] Qwen исчерпал дневной лимит запросов"
    if event == "blocker_created":
        num = kwargs.get("issue_number", "?")
        aid = kwargs.get("atm_id", "?")
        return f"🚨 [{t}] Создан blocker Issue #{num} для задачи {aid}"
    if event == "git_push":
        br = kwargs.get("branch", "main")
        fc = int(kwargs.get("files_changed") or 0)
        ins = int(kwargs.get("insertions") or 0)
        return f"📤 [{t}] Отправлено в GitHub ({br}): {fc} файлов, +{ins} строк"
    return f"• [{t}] {event} {kwargs}"


def _color_for_line(msg: str) -> str | None:
    if not _HAS_COLOR or Fore is None:
        return None
    if msg.startswith(("🚀", "🔄", "⏳", "🤖", "📦", "📤")):
        return Fore.CYAN
    if msg.startswith("✅"):
        return Fore.GREEN
    if msg.startswith("🧪"):
        return Fore.RED if "❌" in msg else Fore.GREEN
    if msg.startswith(("❌", "🚨")):
        return Fore.RED
    if msg.startswith("⚠️"):
        return Fore.YELLOW
    return None


def hlog(event: str, **kwargs: Any) -> None:
    global _last_vitest_total
    try:
        msg = _format_message(event, **kwargs)
        if event == "tests_run":
            t = int(kwargs.get("total") or 0)
            if t > 0:
                _last_vitest_total = max(_last_vitest_total, t)

        with _log_path().open("a", encoding="utf-8") as f:
            f.write(msg + "\n")

        c = _color_for_line(msg)
        if c and Style:
            if "\n" in msg:
                print(f"{c}{msg}{Style.RESET_ALL}", flush=True)
            else:
                print(f"{c}{msg}{Style.RESET_ALL}", flush=True)
        else:
            print(msg, flush=True)
    except Exception:
        pass


def hlog_tests_run_from_output(stdout: str, stderr: str = "") -> None:
    try:
        text = f"{stdout}\n{stderr}"
        p, t, d = parse_vitest_output(text)
        if t == 0 and p == 0:
            return
        hlog("tests_run", passed=p, total=t, duration_s=d)
    except Exception:
        pass


def git_last_push_stats(project: Path) -> tuple[str, int, int]:
    branch = "main"
    try:
        b = subprocess.run(
            ["git", "branch", "--show-current"],
            cwd=project,
            capture_output=True,
            text=True,
            timeout=15,
            **{"encoding": "utf-8", "errors": "replace"},
        )
        if b.returncode == 0 and (b.stdout or "").strip():
            branch = (b.stdout or "").strip()
    except Exception:
        pass
    files_n = 0
    ins = 0
    try:
        proc = subprocess.run(
            ["git", "show", "-1", "--shortstat", "--format="],
            cwd=project,
            capture_output=True,
            text=True,
            timeout=15,
            **{"encoding": "utf-8", "errors": "replace"},
        )
        if proc.returncode == 0:
            s = proc.stdout or ""
            m = re.search(r"(\d+)\s+files? changed", s)
            if m:
                files_n = int(m.group(1))
            m = re.search(r"(\d+)\s+insertions?", s)
            if m:
                ins = int(m.group(1))
    except Exception:
        pass
    return branch, files_n, ins
