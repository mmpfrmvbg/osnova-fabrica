"""osnova fix."""
from __future__ import annotations

import subprocess
from typing import Annotated

import typer

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
    """Только точное совпадение id ATM (избегаем ложных совпадений по подстроке)."""
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
    # history уже от новых к старым — берём первое вхождение (самый свежий прогон)
    return matches[0]


def fix(
    atm_id: Annotated[str, typer.Argument(help="Полный ATM id, например ATM-EPK-...-NNN")],
    message: Annotated[str, typer.Option("--message", "-m")] = "manual fix",
):
    """Найти ATM в history, воспроизвести done, правка вручную, re-verify, commit."""
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
    console.print(f"[bold]Fix[/] {resolved_id}\n[dim]done:[/] {done_cmd}\n")
    if done_cmd:
        subprocess.run(done_cmd, shell=True, cwd=str(engine.repo_root))
    console.print("\n[yellow]Исправь код, Enter для re-verify…[/]")
    input()
    r = subprocess.run(done_cmd, shell=True, cwd=str(engine.repo_root), capture_output=True, text=True)
    if r.returncode == 0:
        subprocess.run(
            ["git", "add", "-A"],
            cwd=str(engine.repo_root),
            check=False,
        )
        subprocess.run(
            ["git", "commit", "-m", f"fix({resolved_id}): {message}"],
            cwd=str(engine.repo_root),
            check=False,
        )
        console.print("[green]OK[/]")
    else:
        console.print(f"[red]FAIL[/]\n{r.stderr or r.stdout}")
