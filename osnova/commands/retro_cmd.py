"""osnova retro."""
from __future__ import annotations

import typer
from rich.panel import Panel

from osnova.engine import ForgeEngine
from osnova.render import console

engine = ForgeEngine()


def retro():
    """Ретроспектива: meta + последний history."""
    meta = engine.get_retrospective()
    hist = engine.get_history(limit=1)
    last = hist[0] if hist else None

    if not meta and not last:
        console.print("[yellow]Нет данных[/]")
        raise typer.Exit(0)

    le = meta.get("lastepic") if isinstance(meta.get("lastepic"), dict) else {}
    epic_id = le.get("id") or (last.get("epic_id") if last else "?")
    body = f"[bold]{epic_id}[/]\n"
    if le:
        body += f"ATM: {le.get('atomspass', '?')}/{le.get('atomstotal', '?')} OK\n"
    if last:
        atms = last.get("atms") or []
        body += f"Последний history: {len(atms)} ATM\n"

    console.print(Panel(body, title="[cyan]Retro[/]", expand=False))

    recs = meta.get("recommendations") if isinstance(meta.get("recommendations"), list) else []
    if recs:
        console.print("\n[bold]Рекомендации:[/]")
        for r in recs:
            console.print(f"  • {r}")
    console.print()
