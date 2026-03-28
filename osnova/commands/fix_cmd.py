"""osnova fix."""
from __future__ import annotations

from typing import Annotated

import typer
import yaml

from osnova.done_cmd import resolve_done_cmd
from osnova.engine import ForgeEngine
from osnova.render import console

engine = ForgeEngine()

_FIX_ATM_HELP = (
    "Нужен полный id, например [cyan]ATM-EPK-260328-015-008[/]. "
    "Короткие фрагменты вроде [dim]ATM-008[/] не поддерживаются — "
    "они совпадают с разными EPIC."
)


def _find_atm_exact_in_history(
    hist: list[dict], atm_id: str
) -> tuple[dict | None, str | None]:
    aid = atm_id.strip()
    if not aid:
        return None, None
    matches: list[tuple[dict, str | None]] = []
    for h in hist:
        eid = str(h.get("epic_id") or "").strip() or None
        for a in h.get("atms") or []:
            if str(a.get("id", "")) == aid:
                matches.append((a, eid))
    if not matches:
        return None, None
    return matches[0]


def fix(
    atm_id: Annotated[str, typer.Argument(help="Полный ATM id, например ATM-EPK-...-NNN")],
    message: Annotated[str, typer.Option("--message", "-m")] = "manual fix",
    executor: Annotated[str, typer.Option("--executor", "-e", help="cursor|qwen|auto")] = "cursor",
    dry_run: Annotated[bool, typer.Option("--dry-run", help="Показать goal/done без запуска")] = False,
):
    """Повторный прогон ATM через run_single_atm (re-run and fix)."""
    hist = engine.get_history(limit=20)
    target, epic_id_for = _find_atm_exact_in_history(hist, atm_id)
    if not target:
        console.print(f"[red]ATM не найден:[/] {atm_id!r}\n{_FIX_ATM_HELP}")
        raise typer.Exit(1)

    state = engine.get_state()
    done_cmd = resolve_done_cmd(
        target,
        state,
        epic_id=epic_id_for,
        repo_root=engine.repo_root,
    )
    resolved_id = str(target.get("id") or atm_id.strip())
    goal = f"re-run and fix: {resolved_id} — {message}"

    if dry_run:
        preview = {
            "id": resolved_id,
            "goal": goal,
            "scope": [],
            "done": done_cmd,
            "executor": executor,
        }
        console.print("[dim]Dry-run — будет запущено:[/]\n")
        console.print(yaml.safe_dump(preview, allow_unicode=True, sort_keys=False))
        return

    console.print(f"[bold]Fix[/] {resolved_id}\n[dim]done:[/] {done_cmd}\n")
    r = engine.run_single(goal, [], done_cmd, executor)
    s = str(r.get("s", "?")).upper()
    if s == "OK":
        console.print("[green]OK[/]")
    else:
        console.print(f"[red]BLK[/] {r.get('err') or r.get('blk_reason') or r}")
