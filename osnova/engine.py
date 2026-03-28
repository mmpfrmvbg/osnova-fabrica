"""Bridge CLI to forge modules."""
from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable, Optional

from osnova.paths import ensure_forge_imports

ensure_forge_imports()

import forge.qwenbudget as qwenbudget  # noqa: E402

from forge.common import load_forge_state, save_forge_state  # noqa: E402
from forge.degradation import get_available  # noqa: E402

from osnova import config  # noqa: E402
from osnova.state_reader import (  # noqa: E402
    list_epic_manifests,
    read_epic_manifest,
    read_forge_state,
    read_heartbeat_age,
    read_history_normalized,
    read_osnova_md,
    read_retrospective,
    read_state_raw,
    read_task,
)


class ForgeEngine:
    def __init__(self) -> None:
        self.repo_root = config.project_dir()
        ensure_forge_imports()
        forge_path = self.repo_root / "forge"
        if forge_path.is_dir() and str(forge_path) not in sys.path:
            sys.path.insert(0, str(forge_path))

    def get_state(self) -> dict[str, Any]:
        return read_state_raw()

    def get_task(self) -> dict[str, Any]:
        return read_task()

    def get_history(self, limit: int = 10) -> list[dict[str, Any]]:
        return read_history_normalized(limit)

    def get_retrospective(self) -> dict[str, Any]:
        return read_retrospective()

    def get_forge_state(self) -> dict[str, Any]:
        return read_forge_state()

    def get_project_config(self) -> dict[str, Any]:
        return read_osnova_md()

    def get_quota_info(self) -> dict[str, Any]:
        try:
            qwenbudget.maybe_reset()
            st = qwenbudget._state()
            lim = int(st.get("limit", qwenbudget.effective_limit()))
            used = int(st.get("used", 0))
            return {
                "qwen_used": used,
                "qwen_limit": lim,
                "qwen_remaining": max(0, lim - used),
                "qwen_available": used < lim,
            }
        except Exception:
            raw = read_state_raw()
            b = raw.get("budget") if isinstance(raw.get("budget"), dict) else {}
            return {
                "qwen_used": int(b.get("qwenusedtoday") or 0),
                "qwen_limit": int(b.get("qwenlimit") or 1000),
                "qwen_remaining": "?",
                "qwen_available": True,
            }

    def get_degradation_status(self) -> dict[str, Any]:
        try:
            return get_available()
        except Exception:
            return {"qwen": False, "cursor": False, "healthy": False, "executors": []}

    def get_health(self) -> dict[str, Any]:
        hb_age = read_heartbeat_age()
        fs = self.get_forge_state()
        st = self.get_state()
        sess = st.get("sessionstats") if isinstance(st.get("sessionstats"), dict) else {}

        if hb_age is None:
            forge_status, detail = "DEAD", "heartbeat missing"
        elif hb_age > 300:
            forge_status, detail = "STALE", f"no pulse {hb_age:.0f}s"
        elif hb_age > 120:
            forge_status, detail = "SLOW", f"last {hb_age:.0f}s ago"
        else:
            forge_status, detail = "ALIVE", f"last {hb_age:.0f}s ago"

        forge_running = self._systemd_active("osnova-forge")

        return {
            "forge": {
                "status": forge_status,
                "detail": detail,
                "systemd": "active" if forge_running else "inactive",
                "paused": bool(fs.get("paused")),
            },
            "executors": {
                "qwen": self.get_degradation_status().get("qwen"),
                "cursor": self.get_degradation_status().get("cursor"),
                "healthy": self.get_degradation_status().get("healthy"),
            },
            "stats": {
                "passrate": float(sess.get("passrate") or 0),
                "epics_today": int(sess.get("epicsreceived") or 0),
                "atms_ok": int(sess.get("atomsdone") or 0),
                "atms_blk": int(sess.get("atomsblocked") or 0),
            },
        }

    def _systemd_active(self, unit: str) -> bool:
        try:
            r = subprocess.run(
                ["systemctl", "is-active", unit],
                capture_output=True,
                text=True,
                timeout=3,
            )
            return r.stdout.strip() == "active"
        except (OSError, subprocess.TimeoutExpired, FileNotFoundError):
            return False

    def pause_forge(self) -> bool:
        st = load_forge_state()
        st["paused"] = True
        try:
            save_forge_state(st)
            return True
        except Exception:
            return False

    def resume_forge(self) -> bool:
        st = load_forge_state()
        st["paused"] = False
        try:
            save_forge_state(st)
            return True
        except Exception:
            return False

    def kill_current_epic(self) -> bool:
        fs = self.get_forge_state()
        pid = fs.get("smith_pid")
        if not pid:
            return False
        try:
            os.kill(int(pid), __import__("signal").SIGTERM)
            return True
        except (ProcessLookupError, PermissionError, ValueError):
            return False

    def list_epics(self, limit: int = 20) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for p in list_epic_manifests(limit):
            m = read_epic_manifest(p)
            m["_path"] = str(p)
            m.setdefault("id", p.stem)
            out.append(m)
        return out

    def run_from_goal(
        self,
        goal: str,
        auto: bool = False,
        executor: str = "auto",
        dry_run: bool = False,
        on_update: Optional[Callable[[str, str, Any], None]] = None,
    ) -> dict[str, Any]:
        from forge.forge import run_epic_from_dict

        ts = int(time.time())
        eid = f"EPK-CLI-{ts}"
        default_done = os.environ.get(
            "OSNOVA_DEFAULT_DONE",
            "npx tsc -p tsconfig.typecheck.json --noEmit",
        )
        epic = {
            "id": eid,
            "t": "EPK",
            "goal": goal,
            "scope": [],
            "done": default_done,
            "priority": "P2",
            "githubissue": None,
            "executor": executor,
        }
        return run_epic_from_dict(epic, dry_run=dry_run, on_update=on_update)

    def plan_from_goal(self, goal: str, executor: str = "auto") -> dict[str, Any]:
        """Cheap plan: atomize(epic, dry_run=True) — stub ATMs, no Qwen."""
        ensure_forge_imports()
        from forge.atomizer import atomize

        ts = int(time.time())
        epic = {
            "id": f"EPK-PLAN-{ts}",
            "t": "EPK",
            "goal": goal,
            "scope": [],
            "done": "npx tsc --noEmit",
            "priority": "P2",
            "githubissue": None,
            "executor": executor,
        }
        try:
            atoms = atomize(epic, dry_run=True)
            return {"id": epic["id"], "goal": goal, "atms": atoms, "executor": executor}
        except Exception as e:
            return {"error": str(e)}

    def run_single(
        self,
        goal: str,
        scope: list[str],
        done: str,
        executor: str = "auto",
    ) -> dict[str, Any]:
        from forge.forge import run_single_atm

        return run_single_atm(goal, scope, done, executor)

    def ask_qwen(self, question: str, context_files: Optional[list[str]] = None) -> str:
        import yaml as _yaml

        ctx: list[str] = []
        st = self.get_state()
        if st:
            ctx.append("=== state.yaml ===\n" + _yaml.dump(st, allow_unicode=True))
        hist = read_history_normalized(3)
        if hist:
            ctx.append("=== history ===\n" + _yaml.dump(hist, allow_unicode=True))
        retro = self.get_retrospective()
        if retro:
            ctx.append("=== retrospective ===\n" + _yaml.dump(retro, allow_unicode=True))
        if context_files:
            for fp in context_files:
                p = Path(fp)
                if p.is_file():
                    ctx.append(f"=== {fp} ===\n{p.read_text(encoding='utf-8', errors='replace')[:3000]}")
        prompt = (
            "Ты — OSNOVA Brain. Отвечай по-русски, кратко.\n\n"
            + "\n\n".join(ctx)
            + f"\n\nВопрос: {question}"
        )
        bin_qwen = config.qwen_bin()
        try:
            proc = subprocess.run(
                [bin_qwen, "-p", prompt],
                capture_output=True,
                text=True,
                timeout=120,
                cwd=str(self.repo_root),
            )
            if proc.returncode == 0:
                return (proc.stdout or "").strip()
            return f"qwen error (rc={proc.returncode}): {(proc.stderr or '')[:400]}"
        except (subprocess.TimeoutExpired, FileNotFoundError) as e:
            return f"Qwen недоступен: {e}"
