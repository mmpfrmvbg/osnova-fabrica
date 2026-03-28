"""Bridge CLI to forge modules."""
from __future__ import annotations

import os
import platform
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Optional

from osnova.paths import ensure_forge_imports

ensure_forge_imports()

import forge.qwenbudget as qwenbudget  # noqa: E402

from forge.common import load_forge_state, qwen_headless_argv, save_forge_state, SUBPROCESS_TEXT  # noqa: E402
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

        if platform.system() == "Windows":
            systemd_str = "n/a (Windows)"
            heart_systemd = "n/a (Windows)"
        else:
            forge_running = self._systemd_active("osnova-forge")
            systemd_str = "active" if forge_running else "inactive"
            heart_systemd = "active" if self._systemd_active("osnova-heart") else "inactive"

        heart_raw = st.get("heart") if isinstance(st.get("heart"), dict) else {}
        restarts_today = int(heart_raw.get("restartstoday") or heart_raw.get("restarts_today") or 0)
        brain_src = st.get("brainsource") or st.get("brain_source") or "?"
        last_epic_at = st.get("lastepicreceivedat") or st.get("last_epic_received_at")

        ci = st.get("ci") if isinstance(st.get("ci"), dict) else {}
        blockers_raw = st.get("blockers") if isinstance(st.get("blockers"), list) else []
        blockers: list[dict[str, Any]] = [b for b in blockers_raw if isinstance(b, dict)]

        return {
            "forge": {
                "status": forge_status,
                "detail": detail,
                "systemd": systemd_str,
                "paused": bool(fs.get("paused")),
                "restarts_today": restarts_today,
            },
            "heart": {
                "systemd": heart_systemd,
                "restarts_today": restarts_today,
            },
            "brain": {
                "source": str(brain_src),
                "last_epic_at": last_epic_at,
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
            "ci": {
                "openblockerissues": int(ci.get("openblockerissues") or 0),
            },
            "blockers": blockers,
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

    def pause_forge(self) -> str:
        """``already_paused`` | ``paused`` | ``error``."""
        st = load_forge_state()
        if st.get("paused"):
            return "already_paused"
        st["paused"] = True
        try:
            save_forge_state(st)
            return "paused"
        except Exception:
            return "error"

    def resume_forge(self) -> str:
        """``already_running`` | ``resumed`` | ``error``."""
        st = load_forge_state()
        if not st.get("paused"):
            return "already_running"
        st["paused"] = False
        try:
            save_forge_state(st)
            return "resumed"
        except Exception:
            return "error"

    def kill_current_epic(self) -> bool:
        fs = self.get_forge_state()
        pid = fs.get("smith_pid")
        if not pid:
            return False
        try:
            os.kill(int(pid), signal.SIGTERM)
            return True
        except (ProcessLookupError, PermissionError, ValueError):
            return False

    def start_forge_daemon(self, *, detach: bool = False) -> tuple[int | None, str | None]:
        """
        Запуск основного цикла forge: ``python -m forge.forge``.
        PID сохраняется в ``forge-state.json`` как ``forge_loop_pid`` (не путать с ``smith_pid``).
        """
        cmd = [sys.executable, "-m", "forge.forge"]
        repo = self.repo_root
        log_path = repo / "forge.log"
        creation_new = getattr(subprocess, "CREATE_NEW_CONSOLE", 0x00000010)
        creation_det = getattr(subprocess, "DETACHED_PROCESS", 0x00000008)
        try:
            if sys.platform == "win32":
                if detach:
                    log_f = open(log_path, "a", encoding="utf-8", buffering=1)
                    proc = subprocess.Popen(
                        cmd,
                        cwd=str(repo),
                        stdout=log_f,
                        stderr=subprocess.STDOUT,
                        stdin=subprocess.DEVNULL,
                        creationflags=creation_det,
                    )
                else:
                    proc = subprocess.Popen(
                        cmd,
                        cwd=str(repo),
                        creationflags=creation_new,
                    )
            elif detach:
                log_f = open(log_path, "a", encoding="utf-8", buffering=1)
                proc = subprocess.Popen(
                    cmd,
                    cwd=str(repo),
                    stdout=log_f,
                    stderr=subprocess.STDOUT,
                    stdin=subprocess.DEVNULL,
                    start_new_session=True,
                )
            else:
                proc = subprocess.Popen(cmd, cwd=str(repo))
        except OSError as e:
            return None, str(e)

        st = load_forge_state()
        st["forge_loop_pid"] = proc.pid
        try:
            save_forge_state(st)
        except Exception as e:
            return proc.pid, f"PID {proc.pid}, но запись forge-state не удалась: {e}"
        return proc.pid, None

    def stop_forge_daemon(self) -> tuple[bool, str | None]:
        """
        SIGTERM процессу по PID из forge-state: сначала ``forge_loop_pid`` (osnova forge start),
        иначе ``smith_pid`` (запуск forge не через CLI — эвристика).
        Сбрасывается только тот ключ, по которому убивали.
        """
        st = load_forge_state()
        pid_key: str | None = None
        raw = st.get("forge_loop_pid")
        if raw is not None and str(raw).strip() != "":
            pid_key = "forge_loop_pid"
        else:
            raw = st.get("smith_pid")
            if raw is not None and str(raw).strip() != "":
                pid_key = "smith_pid"
        if pid_key is None:
            return (
                False,
                "forge_loop_pid и smith_pid не заданы — forge не через CLI или PID не записан",
            )
        try:
            pid = int(raw)
        except (TypeError, ValueError):
            return False, f"некорректный {pid_key}: {raw!r}"
        err: str | None = None
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            err = "процесс уже завершён"
        except OSError as e:
            if sys.platform == "win32":
                tr = subprocess.run(
                    ["taskkill", "/PID", str(pid), "/T", "/F"],
                    capture_output=True,
                    text=True,
                    timeout=45,
                )
                if tr.returncode != 0:
                    err = (tr.stderr or tr.stdout or "taskkill failed")[:300]
            else:
                err = str(e)
        st[pid_key] = None
        try:
            save_forge_state(st)
        except Exception as e:
            return True, (err or "остановлен") + f"; state: {e}"
        return True, err

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

    def plan_from_goal(self, goal: str, executor: str = "auto", full: bool = False) -> dict[str, Any]:
        """Plan EPIC: dry_run=True → stub ATMs (no Qwen); full=True → real atomizer (Qwen)."""
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
            atoms = atomize(epic, dry_run=not full)
            return {
                "id": epic["id"],
                "goal": goal,
                "atms": atoms,
                "executor": executor,
                "full": full,
            }
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

    def do_single(
        self,
        goal: str,
        *,
        scope: list[str] | None = None,
        done_cmd: str | None = None,
        executor: str = "auto",
        dry_run: bool = False,
    ) -> dict[str, Any] | None:
        """
        Один ATM без атомайзера: ``done`` из ``testcommands.unit`` в state или переданный.
        При ``dry_run`` только описание ATM (без вызова forge).
        """
        st = self.get_state()
        tc = st.get("testcommands") if isinstance(st.get("testcommands"), dict) else {}
        default_done = str(tc.get("unit") or "npm test").strip() or "npm test"
        done = (done_cmd or default_done).strip() or "npm test"
        scopes = list(scope or [])
        atm_id = f"LOCAL-{uuid.uuid4().hex[:6].upper()}"
        preview: dict[str, Any] = {
            "id": atm_id,
            "goal": goal,
            "scope": scopes,
            "done": done,
            "priority": "P2",
            "executor": executor,
        }
        if dry_run:
            return {"dry_run": True, "atm": preview}
        return self.run_single(goal, scopes, done, executor)

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
        run_s = 120
        raw_to = os.environ.get("FORGE_QWEN_TIMEOUT", "").strip()
        if raw_to.isdigit():
            run_s = max(30, int(raw_to))

        if not qwenbudget.can_call():
            return "Qwen: дневной лимит forge исчерпан (qwenbudget)."

        cmd = qwen_headless_argv(prompt)
        try:
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=min(run_s, 900),
                check=False,
                cwd=str(self.repo_root),
                **SUBPROCESS_TEXT,
            )
        except FileNotFoundError:
            return self._ask_qwen_plain_cli(prompt, timeout_s=min(run_s, 900))
        except subprocess.TimeoutExpired as e:
            return f"Qwen timeout ({run_s}s): {e}"

        out = proc.stdout or ""
        err = proc.stderr or ""
        if proc.returncode == 0:
            qwenbudget.record(served=True)
            return out.strip()
        return f"qwen error (rc={proc.returncode}): {(err or out)[:500]}"

    def _ask_qwen_plain_cli(self, prompt: str, *, timeout_s: int = 120) -> str:
        """Fallback: `qwen -p` без forge argv (если бинарь из qwen_headless_argv не найден)."""
        bin_qwen = config.qwen_bin()
        try:
            proc = subprocess.run(
                [bin_qwen, "-p", prompt],
                capture_output=True,
                text=True,
                timeout=timeout_s,
                cwd=str(self.repo_root),
            )
            if proc.returncode == 0:
                qwenbudget.record(served=True)
                return (proc.stdout or "").strip()
            return f"qwen error (rc={proc.returncode}): {(proc.stderr or '')[:400]}"
        except (subprocess.TimeoutExpired, FileNotFoundError) as e:
            return f"Qwen недоступен: {e}"
