"""osnova do."""
from __future__ import annotations

from typing import Annotated, Optional

import typer

from osnova.engine import ForgeEngine
from osnova.render import console

engine = ForgeEngine()


def do(
    goal: Annotated[str, typer.Argument(help="Одна задача")],
    scope: Annotated[Optional[str], typer.Option("--scope", "-s")] = None,
    done: Annotated[Optional[str], typer.Option("--done", "-d")] = None,
    executor: Annotated[str, typer.Option(help="cursor|qwen|auto")] = "auto",
):
    """Один ATM без atomizer."""
    scope_list = [s.strip() for s in scope.split(",")] if scope else []
    done_cmd = done or "npx tsc -p tsconfig.typecheck.json --noEmit"
    r = engine.run_single(goal, scope_list, done_cmd, executor)
    s = str(r.get("s", "?")).upper()
    icon = "OK" if s == "OK" else "BLK"
    console.print(f"\n[{icon}] {r.get('id')}  executor={r.get('executor')}")
    if s == "BLK":
        console.print(f"[red]{r.get('err') or r.get('blk_reason')}[/]")
