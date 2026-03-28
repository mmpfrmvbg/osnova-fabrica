"""osnova epic list/show/kill."""
from __future__ import annotations

import json
from typing import Annotated

import typer
import yaml

from osnova.engine import ForgeEngine
from osnova.render import console, make_epic_table

engine = ForgeEngine()

app = typer.Typer(help="EPIC manifests")


@app.command("list")
def epic_list(
    n: Annotated[int, typer.Option("--limit", "-n", help="limit")] = 20,
    json_out: Annotated[bool, typer.Option("--json", "-j")] = False,
):
    rows = engine.list_epics(limit=n)
    if json_out:
        typer.echo(json.dumps(rows, ensure_ascii=False, indent=2, default=str))
        return
    if not rows:
        console.print("[yellow]Нет EPIC yaml[/]")
        return
    console.print(make_epic_table(rows))
    console.print()


@app.command("show")
def epic_show(
    epic_id: Annotated[str, typer.Argument(help="ID или фрагмент")],
):
    for e in engine.list_epics(limit=100):
        if epic_id in str(e.get("id", "")):
            console.print(yaml.safe_dump(e, allow_unicode=True, sort_keys=False))
            return
    console.print(f"[red]Не найдено: {epic_id}[/]")
    raise typer.Exit(1)


@app.command("kill")
def epic_kill(
    yes: Annotated[bool, typer.Option("--yes", "-y", help="Без подтверждения")] = False,
):
    """SIGTERM smith_pid из forge-state."""
    fs = engine.get_forge_state()
    pid = fs.get("smith_pid")
    if not pid:
        console.print("[yellow]smith_pid отсутствует[/]")
        raise typer.Exit(0)
    if not yes:
        typer.confirm(f"Отправить SIGTERM PID {pid}?", abort=True)
    if engine.kill_current_epic():
        console.print("[yellow]SIGTERM отправлен[/]")
    else:
        raise typer.Exit(1)
