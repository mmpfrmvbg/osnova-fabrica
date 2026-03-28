"""osnova watch — live dashboard; опционально watchdog на .osnova/ и клавиши q/p."""
from __future__ import annotations

import sys
import threading
import time
from typing import Callable, Optional

import typer
from rich.console import Group
from rich.live import Live
from rich.panel import Panel
from rich.text import Text

from osnova.config import osnova_dir
from osnova.engine import ForgeEngine
from osnova.render import console, make_atm_table, make_health_panel, make_progress_bar

engine = ForgeEngine()


def _pause_toggle() -> None:
    fs = engine.get_forge_state()
    if fs.get("paused"):
        engine.resume_forge()
    else:
        engine.pause_forge()


def _spawn_key_thread(
    stop: threading.Event,
    dirty: threading.Event,
    on_pause_toggle: Callable[[], None],
) -> None:
    def loop() -> None:
        if sys.platform == "win32":
            try:
                import msvcrt
            except ImportError:
                return
            while not stop.is_set():
                if msvcrt.kbhit():
                    c = msvcrt.getch()
                    if c in (b"q", b"Q"):
                        stop.set()
                        return
                    if c in (b"p", b"P"):
                        on_pause_toggle()
                        dirty.set()
                time.sleep(0.05)
            return
        try:
            import select
            import termios
            import tty
        except ImportError:
            return
        fd = sys.stdin.fileno()
        if not sys.stdin.isatty():
            return
        old = termios.tcgetattr(fd)
        try:
            tty.setcbreak(fd)
            while not stop.is_set():
                r, _, _ = select.select([sys.stdin], [], [], 0.15)
                if r:
                    c = sys.stdin.read(1)
                    if c in ("q", "Q"):
                        stop.set()
                        return
                    if c in ("p", "P"):
                        on_pause_toggle()
                        dirty.set()
        except (OSError, ValueError, termios.error):
            pass
        finally:
            try:
                termios.tcsetattr(fd, termios.TCSADRAIN, old)
            except (OSError, termios.error):
                pass

    threading.Thread(target=loop, daemon=True).start()


def _spawn_watchdog(dirty: threading.Event, stop: threading.Event) -> Optional[object]:
    try:
        from watchdog.events import FileSystemEventHandler
        from watchdog.observers import Observer
    except ImportError:
        return None

    class _H(FileSystemEventHandler):
        def on_any_event(self, event):  # type: ignore[override]
            if stop.is_set() or event.is_directory:
                return
            dirty.set()

    root = osnova_dir()
    if not root.is_dir():
        return None
    obs = Observer()
    obs.schedule(_H(), str(root), recursive=True)
    obs.start()
    return obs


def watch(
    interval: float = typer.Option(2.0, "--interval", "-i", help="Интервал опроса (сек)"),
):
    """Периодически обновляемый снимок; при изменении файлов в .osnova/ — чаще. [q] выход, [p] пауза/продолжить."""

    def render_panel():
        h = engine.get_health()
        hist = engine.get_history(limit=1)
        last = hist[0] if hist else None
        atms = (last or {}).get("atms") or []
        ok = sum(1 for a in atms if str(a.get("s")).upper() == "OK")
        total = len(atms)
        parts: list = [
            Panel(
                Text.from_markup(
                    f"[bold]{last.get('epic_id', '?') if last else '?'}[/]\n"
                    f"{make_progress_bar(ok, total)}"
                ),
                title="Last EPIC",
            ),
            make_health_panel(h),
        ]
        if atms:
            parts.append(make_atm_table(atms[-12:]))
        parts.append(
            Panel(
                "[dim]q[/] выход   [dim]p[/] пауза/продолжить   [dim]Ctrl+C[/] выход",
                style="dim",
            )
        )
        return Panel(Group(*parts), title="osnova watch", expand=False)

    stop = threading.Event()
    dirty = threading.Event()
    _spawn_key_thread(stop, dirty, _pause_toggle)
    obs = _spawn_watchdog(dirty, stop)

    tick = max(0.15, min(interval, 30.0))
    try:
        with Live(
            render_panel(),
            console=console,
            refresh_per_second=max(1, int(1 / tick)),
            screen=True,
        ) as live:
            while not stop.is_set():
                live.update(render_panel())
                waited = 0.0
                while waited < interval and not stop.is_set():
                    if dirty.is_set():
                        dirty.clear()
                        break
                    time.sleep(0.1)
                    waited += 0.1
    except KeyboardInterrupt:
        pass
    finally:
        if obs is not None:
            obs.stop()
            obs.join(timeout=3)
