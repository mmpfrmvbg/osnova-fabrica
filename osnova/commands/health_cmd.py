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

    forge = h.get("forge") if isinstance(h.get("forge"), dict) else {}
    fs = str(forge.get("status") or "")
    if fs in ("DEAD", "STALE"):
        console.print(
            f"[bold red]Forge {fs}[/] — проверь пульс и службу: "
            "[dim]systemctl status osnova-forge[/] (Linux) или запуск forge."
        )
    ex = h.get("executors") if isinstance(h.get("executors"), dict) else {}
    if ex.get("healthy") is False:
        console.print(
            "[bold red]Executors недоступны[/] — проверь Qwen и Cursor (degradation / ключи)."
        )
    if forge.get("paused"):
        console.print("[yellow]Forge на паузе.[/] Снять: [dim]osnova resume[/]")
