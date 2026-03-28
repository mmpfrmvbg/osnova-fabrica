"""osnova watch — live dashboard."""
from __future__ import annotations

import time

import typer
from rich.console import Group
from rich.live import Live
from rich.panel import Panel
from rich.text import Text

from osnova.engine import ForgeEngine
from osnova.render import console, make_atm_table, make_health_panel, make_progress_bar

engine = ForgeEngine()


def watch(
    interval: float = typer.Option(2.0, "--interval", "-i", help="Секунды между обновлениями"),
):
    """Периодически обновляемый снимок status/health. Ctrl+C выход."""

    def render():
        h = engine.get_health()
        hist = engine.get_history(limit=1)
        last = hist[0] if hist else None
        atms = (last or {}).get("atms") or []
        ok = sum(1 for a in atms if str(a.get("s")).upper() == "OK")
        total = len(atms)
        parts: list = [make_health_panel(h)]
        if last:
            eid = last.get("epic_id", "?")
            parts.insert(0, Panel(Text.from_markup(f"[bold]{eid}[/]\n{make_progress_bar(ok, total)}"), title="Last EPIC"))
            if atms:
                parts.append(make_atm_table(atms[-12:]))
        return Panel(Group(*parts), title="osnova watch", expand=False)

    try:
        with Live(render(), console=console, refresh_per_second=1 / max(interval, 0.5), screen=True) as live:
            while True:
                time.sleep(interval)
                live.update(render())
    except KeyboardInterrupt:
        pass
