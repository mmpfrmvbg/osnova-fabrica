from __future__ import annotations

import os
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml

try:
    from forge.common import SUBPROCESS_TEXT, env_paths, epic_queue_path, resolve_executable, setup_logging
except ImportError:  # pragma: no cover
    from common import SUBPROCESS_TEXT, env_paths, epic_queue_path, resolve_executable, setup_logging

LOG = setup_logging("brain_fallback")

IDLE_THRESHOLD = int(os.environ.get("BRAIN_IDLE_THRESHOLD", "2400"))

FALLBACK_PLANNER_PROMPT = """
Ты — резервный планировщик автономной фабрики OSNOVA v5.2.
Основной мозг (Perplexity) временно недоступен. Сгенерируй следующий EPIC.

КОНТЕКСТ:
```yaml
{context_yaml}
```

ПРАВИЛА:
1. Максимальный приоритет: P2 (не P0 — резерв; P1 только self-fix при явных blockers)
2. Scope ≤ 5 файлов
3. origin: fallback-local (обязательно)
4. Зона: lang | infra; done: реальная команда тестов проекта (npm / vitest и т.д.)

Верни ТОЛЬКО YAML EPIC в markdown code block ```yaml ... ```.
Поля: v, t, id, origin, zone, goal, scope, notouch, done, priority, context, risk
"""


def _project_dir() -> Path:
    return Path(env_paths()["OSNOVA_PROJECT"])


def _forge_dir() -> Path:
    return Path(env_paths()["OSNOVA_FORGE"])


def build_context(state: dict[str, Any]) -> dict[str, Any]:
    ctx: dict[str, Any] = {"forge_state": {k: state.get(k) for k in ("session", "brain_source", "last_epic_received_at")}}
    project = _project_dir()
    retro_file = project / ".osnova" / "meta" / "retrospective-latest.yaml"
    if retro_file.exists():
        try:
            ctx["retro"] = yaml.safe_load(retro_file.read_text(encoding="utf-8"))
        except Exception:
            ctx["retro"] = None
    state_file = project / ".osnova" / "state.yaml"
    if state_file.exists():
        try:
            ctx["state"] = yaml.safe_load(state_file.read_text(encoding="utf-8"))
        except Exception:
            ctx["state"] = None
    history_dir = project / ".osnova" / "history"
    history: list[Any] = []
    if history_dir.exists():
        for f in sorted(history_dir.glob("*.yaml"), reverse=True)[:5]:
            try:
                history.append(yaml.safe_load(f.read_text(encoding="utf-8")))
            except Exception:
                pass
    ctx["history"] = history
    return ctx


def parse_epic_from_output(output: str) -> dict[str, Any] | None:
    match = re.search(r"```ya?ml\s*(.*?)```", output, re.DOTALL | re.IGNORECASE)
    if not match:
        return None
    try:
        epic = yaml.safe_load(match.group(1))
    except yaml.YAMLError:
        return None
    if not epic or epic.get("t") != "EPK":
        return None
    if epic.get("priority") == "P0":
        epic["priority"] = "P1"
    epic["origin"] = "fallback-local"
    return epic


def run_qwen_planner(context_yaml: str) -> dict[str, Any] | None:
    prompt = FALLBACK_PLANNER_PROMPT.format(context_yaml=context_yaml)
    try:
        result = subprocess.run(
            [resolve_executable(env_paths()["QWENBIN"]), "--yolo", "--model", "qwen3-coder-plus", "-p", prompt],
            capture_output=True,
            text=True,
            timeout=120,
            cwd=str(_project_dir()),
            **SUBPROCESS_TEXT,
        )
        if result.returncode == 0:
            return parse_epic_from_output(result.stdout or "")
    except (subprocess.TimeoutExpired, FileNotFoundError) as exc:
        LOG.warning("Qwen planner failed: %s", exc)
    return None


def _cursor_cli_candidates() -> list[str]:
    seen: list[str] = []
    for name in (env_paths()["CURSORBIN"], "agent", "cursor-agent"):
        n = (name or "").strip()
        if not n:
            continue
        exe = resolve_executable(n)
        if exe and exe not in seen:
            seen.append(exe)
    return seen


def run_cursor_planner(context_yaml: str) -> dict[str, Any] | None:
    forge = _forge_dir()
    prompt_file = forge / "fallback-prompt.txt"
    try:
        prompt_file.write_text(FALLBACK_PLANNER_PROMPT.format(context_yaml=context_yaml), encoding="utf-8")
        for cursor_exe in _cursor_cli_candidates():
            try:
                result = subprocess.run(
                    [
                        cursor_exe,
                        "-p",
                        "--force",
                        "--model",
                        "auto",
                        "--output-format",
                        "text",
                        str(prompt_file),
                    ],
                    capture_output=True,
                    text=True,
                    timeout=180,
                    cwd=str(_project_dir()),
                    **SUBPROCESS_TEXT,
                )
                if result.returncode == 0:
                    return parse_epic_from_output((result.stdout or "") + (result.stderr or ""))
            except FileNotFoundError:
                continue
    except (subprocess.TimeoutExpired, FileNotFoundError) as exc:
        LOG.warning("Cursor planner failed: %s", exc)
    return None


def is_brain_silent(state: dict[str, Any]) -> bool:
    """True if no new EPIC from primary brain longer than IDLE_THRESHOLD (v5.2)."""
    last_str = state.get("last_epic_received_at") or state.get("forge_started_at")
    if not last_str:
        return False
    try:
        last = datetime.fromisoformat(str(last_str).replace("Z", "+00:00"))
        silence = (datetime.now(timezone.utc) - last.astimezone(timezone.utc)).total_seconds()
        return silence > IDLE_THRESHOLD
    except Exception:
        return False


def has_pending_brain_epic() -> bool:
    """Non-empty queue means GHA already lined up work for the primary brain."""
    queue_file = epic_queue_path()
    return bool(queue_file.exists() and queue_file.read_text(encoding="utf-8").strip())


def generate_fallback_epic(state: dict[str, Any]) -> dict[str, Any] | None:
    if not is_brain_silent(state):
        return None
    if has_pending_brain_epic():
        LOG.info("Brain silent but pending EPIC in queue/epics — skip fallback")
        return None
    LOG.warning("Perplexity idle >%ss — brain_fallback", IDLE_THRESHOLD)
    ctx = build_context(state)
    context_yaml = yaml.dump(ctx, allow_unicode=True, sort_keys=False)
    for name, fn in (("qwen", run_qwen_planner), ("cursor", run_cursor_planner)):
        epic = fn(context_yaml)
        if epic:
            ts = datetime.now(timezone.utc).strftime("%y%m%d")
            seq = int((ctx.get("state") or {}).get("sessionstats", {}).get("epicsreceived", 0) or 0) + 1
            epic["id"] = f"EPK-{ts}-FBK{seq:03d}"
            LOG.info("Fallback EPIC via %s: %s", name, epic["id"])
            return epic
    LOG.error("All fallback planners failed")
    return None


def main() -> None:
    st: dict[str, Any] = {"last_epic_received_at": None}
    e = generate_fallback_epic(st)
    LOG.info("epic=%s", e.get("id") if e else None)


if __name__ == "__main__":
    main()
