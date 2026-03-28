"""
Windows System Tray для forge: фоновый цикл + иконка (pystray + Pillow).

Главный поток: tkinter + очередь действий (безопасно для UI).
Поток pystray: ``icon.run()`` и периодическое обновление цвета иконки.
"""
from __future__ import annotations

import os
import queue
import subprocess
import sys
import threading
import time
import tkinter as tk
from tkinter import messagebox, scrolledtext
from typing import Any, Literal

from osnova.engine import ForgeEngine
from osnova.state_reader import read_heartbeat_age

ColorName = Literal["green", "yellow", "red"]

_UPDATE_INTERVAL_SEC = 3.0
_LOG_TAIL_LINES = 50


def _pid_running(pid: int) -> bool:
    if pid <= 0:
        return False
    if sys.platform == "win32":
        try:
            r = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
                capture_output=True,
                text=True,
                timeout=15,
            )
            return str(pid) in (r.stdout or "")
        except (OSError, subprocess.TimeoutExpired):
            return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    else:
        return True


def _make_circle_icon(color: ColorName, size: int = 64) -> Any:
    """PIL RGBA: круг заданного цвета (без внешнего .ico)."""
    from PIL import Image, ImageDraw

    colors = {
        "green": (46, 204, 113, 255),
        "yellow": (241, 196, 15, 255),
        "red": (231, 76, 60, 255),
    }
    fill = colors[color]
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    margin = 4
    draw.ellipse((margin, margin, size - margin - 1, size - margin - 1), fill=fill)
    return img


def _tray_color(engine: ForgeEngine) -> ColorName:
    """
    🟢 зелёный — forge жив, не на паузе, есть работа ATM (smith или current в epicprogress).
    🟡 жёлтый — пауза или простой (нет активного ATM).
    🔴 красный — нет heartbeat / stale / нет исполнителей (healthy=false).
    """
    fs = engine.get_forge_state()
    deg = engine.get_degradation_status()
    st = engine.get_state()
    h = engine.get_health()
    forge = h.get("forge") if isinstance(h.get("forge"), dict) else {}
    status = str(forge.get("status") or "")
    paused = bool(forge.get("paused"))

    if not bool(deg.get("healthy")):
        return "red"
    if status in ("DEAD", "STALE"):
        return "red"
    if paused:
        return "yellow"

    hb_age = read_heartbeat_age()
    if hb_age is None:
        return "red"

    if status not in ("ALIVE", "SLOW"):
        return "yellow"

    smith = fs.get("smith_pid")
    ep = st.get("epicprogress") if isinstance(st.get("epicprogress"), dict) else {}
    cur_atm = ep.get("current")
    if smith or cur_atm:
        return "green"
    return "yellow"


def _tray_title(engine: ForgeEngine) -> str:
    h = engine.get_health()
    forge = h.get("forge") if isinstance(h.get("forge"), dict) else {}
    st = engine.get_state()
    sess = st.get("sessionstats") if isinstance(st.get("sessionstats"), dict) else {}
    fs = engine.get_forge_state()
    epic = str(st.get("currentepic") or fs.get("current_epic") or "—")
    pr = float(sess.get("passrate") or 0)
    col = _tray_color(engine)
    return f"Forge [{col}] {forge.get('status', '?')} | EPIC {epic} | pass {pr:.0%}"


def _status_text(engine: ForgeEngine) -> str:
    st = engine.get_state()
    sess = st.get("sessionstats") if isinstance(st.get("sessionstats"), dict) else {}
    fs = engine.get_forge_state()
    h = engine.get_health()
    forge = h.get("forge") if isinstance(h.get("forge"), dict) else {}
    ep = st.get("epicprogress") if isinstance(st.get("epicprogress"), dict) else {}
    lines = [
        f"Forge: {forge.get('status', '?')}  {forge.get('detail', '')}",
        f"Paused: {forge.get('paused', False)}",
        f"Current EPIC: {st.get('currentepic') or fs.get('current_epic') or '—'}",
        f"Pass rate (session): {float(sess.get('passrate') or 0):.1%}",
        f"ATM current: {ep.get('current') or '—'}",
        f"smith_pid: {fs.get('smith_pid') or '—'}",
        f"Executors OK: {engine.get_degradation_status().get('healthy', False)}",
    ]
    return "\n".join(lines)


def _tail_forge_log(repo_root: Any, n: int = _LOG_TAIL_LINES) -> str:
    path = repo_root / "forge.log"
    if not path.is_file():
        return f"(нет файла {path})"
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        return str(e)
    lines = text.splitlines()
    return "\n".join(lines[-n:]) if lines else "(пусто)"


def _ensure_forge_started(engine: ForgeEngine) -> tuple[bool, str | None]:
    fs = engine.get_forge_state()
    raw = fs.get("forge_loop_pid")
    if raw is not None:
        try:
            pid = int(raw)
        except (TypeError, ValueError):
            pid = 0
        if pid and _pid_running(pid):
            return True, None
    pid, err = engine.start_forge_daemon(detach=True)
    if pid is None:
        return False, err or "start_forge_daemon failed"
    return True, None


def run_forge_tray() -> None:
    try:
        from pystray import Icon, Menu, MenuItem
    except ImportError as e:
        sys.stderr.write(
            'Требуются зависимости: pip install "osnova-cli[dev]" (pystray, Pillow). '
            f"Ошибка: {e}\n"
        )
        raise SystemExit(1) from e

    engine = ForgeEngine()
    ok, err = _ensure_forge_started(engine)
    if not ok:
        sys.stderr.write(f"Не удалось запустить forge: {err}\n")
        raise SystemExit(1)

    action_q: queue.Queue[str] = queue.Queue()
    holder: dict[str, Any] = {"icon": None, "stop_updates": threading.Event()}

    def enqueue(kind: str) -> None:
        action_q.put(kind)

    def on_activate(_icon: Any, _item: Any = None) -> None:  # noqa: ANN401
        enqueue("log")

    def build_menu() -> Menu:
        return Menu(
            MenuItem("Show log", lambda _i, _it: enqueue("log")),
            MenuItem("Pause / Resume", lambda _i, _it: enqueue("pause_toggle")),
            MenuItem("Status", lambda _i, _it: enqueue("status")),
            Menu.SEPARATOR,
            MenuItem("Exit", lambda _i, _it: enqueue("exit")),
        )

    def tray_thread_main() -> None:
        icon = Icon(
            "osnova_forge",
            _make_circle_icon("yellow"),
            menu=build_menu(),
            on_activate=on_activate,
        )
        holder["icon"] = icon

        def updater() -> None:
            while not holder["stop_updates"].wait(_UPDATE_INTERVAL_SEC):
                ic = holder.get("icon")
                if ic is None:
                    continue
                try:
                    c = _tray_color(engine)
                    ic.icon = _make_circle_icon(c)
                    ic.title = _tray_title(engine)
                except Exception:
                    pass

        threading.Thread(target=updater, daemon=True).start()
        icon.run()
        holder["icon"] = None

    threading.Thread(target=tray_thread_main, name="pystray", daemon=True).start()

    # Дождаться создания иконки
    for _ in range(100):
        if holder.get("icon") is not None:
            break
        time.sleep(0.05)
    else:
        sys.stderr.write("pystray: иконка не поднялась за 5 с\n")
        raise SystemExit(1)

    root = tk.Tk()
    root.withdraw()
    root.title("OSNOVA Forge")

    def show_log_window() -> None:
        body = _tail_forge_log(engine.repo_root)
        win = tk.Toplevel(root)
        win.title(f"forge.log (последние {_LOG_TAIL_LINES} строк)")
        win.geometry("720x420")
        txt = scrolledtext.ScrolledText(win, wrap=tk.WORD, font=("Consolas", 10))
        txt.pack(fill=tk.BOTH, expand=True)
        txt.insert(tk.END, body)
        txt.configure(state=tk.DISABLED)

    def process_queue() -> None:
        try:
            while True:
                kind = action_q.get_nowait()
                if kind == "log":
                    show_log_window()
                elif kind == "status":
                    messagebox.showinfo("Forge status", _status_text(engine), parent=root)
                elif kind == "pause_toggle":
                    fs = engine.get_forge_state()
                    if fs.get("paused"):
                        engine.resume_forge()
                    else:
                        engine.pause_forge()
                elif kind == "exit":
                    holder["stop_updates"].set()
                    try:
                        engine.stop_forge_daemon()
                    except Exception:
                        pass
                    ic = holder.get("icon")
                    if ic is not None:
                        try:
                            ic.stop()
                        except Exception:
                            pass
                    root.after(100, root.quit)
                    return
        except queue.Empty:
            pass
        root.after(150, process_queue)

    root.after(200, process_queue)
    root.mainloop()


def main() -> None:
    run_forge_tray()


if __name__ == "__main__":  # pragma: no cover
    main()
