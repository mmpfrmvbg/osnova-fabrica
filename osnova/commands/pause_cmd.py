"""osnova pause / resume."""
from __future__ import annotations

import typer

from osnova.engine import ForgeEngine
from osnova.render import console

engine = ForgeEngine()


def pause():
    """Пауза forge (forge-state.json)."""
    r = engine.pause_forge()
    if r == "already_paused":
        console.print("[yellow]Уже на паузе[/]")
        return
    if r == "paused":
        console.print("[yellow]Пауза включена[/]")
        return
    raise typer.Exit(1)


def resume():
    """Снять паузу."""
    r = engine.resume_forge()
    if r == "already_running":
        console.print("[green]Не на паузе[/]")
        return
    if r == "resumed":
        console.print("[green]Пауза снята[/]")
        return
    raise typer.Exit(1)
