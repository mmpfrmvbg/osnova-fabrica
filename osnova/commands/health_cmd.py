"""osnova health."""
from __future__ import annotations

import json

import typer

from osnova.engine import ForgeEngine
from osnova.render import console, make_health_panel

engine = ForgeEngine()


def health(json_out: bool = typer.Option(False, "--json", "-j")):
    """Сводка: heartbeat, forge-state, executors, sessionstats."""
    h = engine.get_health()
    if json_out:
        typer.echo(json.dumps(h, ensure_ascii=False, indent=2, default=str))
        return
    console.print()
    console.print(make_health_panel(h))
    console.print()
