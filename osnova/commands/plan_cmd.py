"""osnova plan — atomize(epic, dry_run=True) stub."""
from __future__ import annotations

import json
from typing import Annotated

import typer
import yaml

from osnova.engine import ForgeEngine
from osnova.render import console, make_atm_table

engine = ForgeEngine()


def plan(
    goal: Annotated[str, typer.Argument()],
    executor: Annotated[str, typer.Option(help="executor hint")] = "auto",
    json_out: Annotated[bool, typer.Option("--json", "-j")] = False,
):
    """Быстрый план (без вызова Qwen atomizer): упрощённые ATM."""
    p = engine.plan_from_goal(goal, executor=executor)
    if p.get("error"):
        console.print(f"[red]{p['error']}[/]")
        raise typer.Exit(1)
    if json_out:
        typer.echo(json.dumps(p, ensure_ascii=False, indent=2, default=str))
        return
    atms = p.get("atms") or []
    console.print(f"\n[cyan]Plan[/] [dim](dry atomize — не полная декомпозиция LLM)[/]\n")
    if atms:
        console.print(make_atm_table(atms, title=f"{len(atms)} ATM"))
    else:
        console.print(yaml.safe_dump(p, allow_unicode=True))
