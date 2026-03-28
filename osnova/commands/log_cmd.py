"""osnova log."""
from __future__ import annotations

import json
from typing import Annotated, Optional

import typer

from osnova.engine import ForgeEngine
from osnova.render import console, make_atm_table, make_progress_bar

engine = ForgeEngine()


def log(
    limit: Annotated[int, typer.Option("--limit", "-n", help="Сколько прогонов")] = 5,
    blk_only: Annotated[bool, typer.Option("--blk", help="Только BLK")] = False,
    epic_id: Annotated[Optional[str], typer.Option("--epic", "-e", help="Фильтр EPIC")] = None,
    json_out: Annotated[bool, typer.Option("--json", "-j")] = False,
):
    """История прогонов (normalized history)."""
    rows = engine.get_history(limit=limit)
    if not rows:
        console.print("[yellow]История пуста[/]")
        return
    if json_out:
        typer.echo(json.dumps(rows, ensure_ascii=False, indent=2, default=str))
        return

    for item in rows:
        eid = str(item.get("epic_id") or "?")
        if epic_id and epic_id not in eid:
            continue
        atms = list(item.get("atms") or [])
        if blk_only:
            atms = [a for a in atms if str(a.get("s")).upper() == "BLK"]
            if not atms:
                continue
        ok = sum(1 for a in atms if str(a.get("s")).upper() == "OK")
        total = len(item.get("atms") or [])
        goal = str(item.get("goal") or "").strip()
        console.print(f"\n[bold cyan]{eid}[/]  [dim]{item.get('started_at', '')[:19]}[/]")
        if goal:
            console.print(f"[dim]{goal[:120]}{'…' if len(goal) > 120 else ''}[/]")
        console.print(make_progress_bar(ok, total if total else len(atms)))
        if atms:
            console.print(make_atm_table(atms))
        for a in atms:
            if str(a.get("s")).upper() == "BLK":
                console.print(f"  [red]{a.get('id')}:[/] {str(a.get('blk_reason'))[:200]}")
    console.print()
