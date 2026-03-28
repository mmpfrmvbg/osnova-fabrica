"""osnova pause / resume."""
from __future__ import annotations

import typer

from osnova.engine import ForgeEngine
from osnova.render import console

engine = ForgeEngine()


def pause():
    """Пауза forge (forge-state.json)."""
    if engine.get_forge_state().get("paused"):
        console.print("[yellow]Уже на паузе[/]")
        return
    if engine.pause_forge():
        console.print("[yellow]Пауза включена[/]")
    else:
        raise typer.Exit(1)


def resume():
    """Снять паузу."""
    if not engine.get_forge_state().get("paused"):
        console.print("[green]Не на паузе[/]")
        return
    if engine.resume_forge():
        console.print("[green]Пауза снята[/]")
    else:
        raise typer.Exit(1)
