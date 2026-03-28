"""osnova run."""
from __future__ import annotations

from typing import Annotated

import typer

from osnova.engine import ForgeEngine
from osnova.render import console

engine = ForgeEngine()


def run(
    goal: Annotated[str, typer.Argument(help="Цель EPIC")],
    auto: Annotated[bool, typer.Option("--auto", "-y")] = False,
    executor: Annotated[str, typer.Option(help="cursor|qwen|auto")] = "auto",
    dry_run: Annotated[bool, typer.Option("--dry-run", help="Пропуск реального исполнения")] = False,
):
    """Полный EPIC через forge.run_epic_from_dict."""
    if not auto and not dry_run:
        typer.confirm("Запустить EPIC?", abort=True)

    with console.status("[bold]Forge…[/]"):
        r = engine.run_from_goal(
            goal, auto=True, executor=executor, dry_run=dry_run, on_update=None
        )

    if r.get("error"):
        console.print(f"[red]{r['error']}[/]")
        raise typer.Exit(1)
    console.print(
        f"\n[bold]Готово:[/] {r.get('ok_count', 0)}/{r.get('total', 0)} OK  "
        f"[dim]{r.get('epic_id', '')}  {r.get('elapsed_s', '?')}s[/]"
    )
