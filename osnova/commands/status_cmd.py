"""osnova status."""
from __future__ import annotations

import json

import typer

from osnova.engine import ForgeEngine
from osnova.render import console, make_atm_table, make_passrate_line, make_progress_bar

engine = ForgeEngine()


def status(json_out: bool = typer.Option(False, "--json", "-j", help="JSON output")):
    """Текущий EPIC, ATM из последнего history, passrate."""
    state = engine.get_state()
    history = engine.get_history(limit=1)
    sess = state.get("sessionstats") if isinstance(state.get("sessionstats"), dict) else {}
    version = state.get("v", "?")

    if json_out:
        typer.echo(
            json.dumps(
                {
                    "version": version,
                    "sessionstats": sess,
                    "last_history": history[0] if history else None,
                },
                ensure_ascii=False,
                indent=2,
                default=str,
            )
        )
        return

    console.print(f"\n[bold cyan]OSNOVA Forge[/]  [dim]v{version}[/]\n")

    cur = state.get("currentepic")
    last = history[0] if history else None
    epic_id = "?"
    goal = ""
    atms: list = []
    if isinstance(cur, dict) and cur.get("id"):
        epic_id = str(cur.get("id"))
        goal = str(cur.get("goal", ""))[:60]
        if last and str(last.get("epic_id")) == epic_id:
            atms = last.get("atms") or []
    elif last:
        epic_id = str(last.get("epic_id") or "?")
        goal = str(last.get("goal", ""))[:60]
        atms = last.get("atms") or []

    if not atms and not cur and not last:
        console.print("[yellow]Нет данных EPIC/history[/]")
        return

    console.print(f"[bold]EPIC[/] [cyan]{epic_id}[/]  {goal}")
    ok = sum(1 for a in atms if str(a.get("s")).upper() == "OK")
    blk = sum(1 for a in atms if str(a.get("s")).upper() == "BLK")
    total = len(atms)
    console.print(make_progress_bar(ok, total))
    console.print(
        f"  [green]OK {ok}[/]   [red]BLK {blk}[/]   pending {total - ok - blk}\n"
    )
    if atms:
        console.print(make_atm_table(atms))

    quota = engine.get_quota_info()
    ex = state.get("executors") if isinstance(state.get("executors"), dict) else {}
    qwen_ok = quota.get("qwen_available", True)
    cursor_ok = (ex.get("cursor") or {}).get("available", True)
    console.print(
        f"\nQwen {quota.get('qwen_used', '?')}/{quota.get('qwen_limit', '?')}  "
        f"·  cursor: {'OK' if cursor_ok else 'DOWN'}\n"
    )

    pr = float(sess.get("passrate") or 0)
    console.print(make_passrate_line(pr))
    console.print()
