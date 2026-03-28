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
    full: Annotated[
        bool,
        typer.Option(
            "--full",
            help="Реальный atomizer (Qwen), расход бюджета",
        ),
    ] = False,
    yes: Annotated[bool, typer.Option("--yes", "-y", help="С --full: без подтверждения")] = False,
    json_out: Annotated[bool, typer.Option("--json", "-j")] = False,
):
    """План ATM: по умолчанию заглушка без LLM; --full вызывает Qwen atomizer."""
    if full:
        console.print(
            "[yellow]Внимание: --full вызывает Qwen atomizer (реальный расход бюджета).[/]"
        )
        if not yes:
            console.print(
                "[yellow]Это вызовет Qwen atomizer и потратит квоту. Продолжить? [y/N][/] ",
                end="",
            )
            answer = input().strip().lower()
            if answer not in ("y", "yes"):
                raise typer.Abort()
    elif not json_out:
        console.print(
            "[yellow]Dry-run: план без LLM (заглушка). "
            "Для реальной декомпозиции: osnova plan ... --full[/][/]"
        )

    p = engine.plan_from_goal(goal, executor=executor, full=full)
    if p.get("error"):
        console.print(f"[red]{p['error']}[/]")
        raise typer.Exit(1)
    if json_out:
        typer.echo(json.dumps(p, ensure_ascii=False, indent=2, default=str))
        return
    atms = p.get("atms") or []
    mode = "[green]full (Qwen)[/]" if p.get("full") else "[dim]stub (dry_run)[/]"
    console.print(f"\n[cyan]Plan[/] {mode}\n")
    if atms:
        console.print(make_atm_table(atms, title=f"{len(atms)} ATM"))
    else:
        console.print(yaml.safe_dump(p, allow_unicode=True))
