"""osnova do."""
from __future__ import annotations

from typing import Annotated, Optional

import typer
import yaml

from osnova.engine import ForgeEngine
from osnova.render import console

engine = ForgeEngine()


def do(
    goal: Annotated[str, typer.Argument(help="Одна задача")],
    scope: Annotated[Optional[str], typer.Option("--scope", "-s")] = None,
    done: Annotated[Optional[str], typer.Option("--done", "-d")] = None,
    executor: Annotated[str, typer.Option(help="cursor|qwen|auto")] = "auto",
    dry_run: Annotated[bool, typer.Option("--dry-run", help="Показать ATM без выполнения")] = False,
):
    """Один ATM без atomizer (прямой вызов run_single_atm)."""
    scope_list = [s.strip() for s in scope.split(",")] if scope else []
    r = engine.do_single(
        goal,
        scope=scope_list,
        done_cmd=done,
        executor=executor,
        dry_run=dry_run,
    )
    if r and r.get("dry_run"):
        console.print("[dim]Dry-run — ATM:[/]\n")
        console.print(yaml.safe_dump(r.get("atm"), allow_unicode=True, sort_keys=False))
        return
    if not r:
        raise typer.Exit(1)
    s = str(r.get("s", "?")).upper()
    icon = "OK" if s == "OK" else "BLK"
    console.print(f"\n[{icon}] {r.get('id')}  executor={r.get('executor')}")
    if s == "BLK":
        console.print(f"[red]{r.get('err') or r.get('blk_reason')}[/]")
