"""osnova fix."""
from __future__ import annotations

import subprocess
from typing import Annotated

import typer

from osnova.done_cmd import get_done_cmd
from osnova.engine import ForgeEngine
from osnova.render import console

engine = ForgeEngine()


def fix(
    atm_id: Annotated[str, typer.Argument(help="ATM id")],
    message: Annotated[str, typer.Option("--message", "-m")] = "manual fix",
):
    """Найти ATM в history, воспроизвести done, правка вручную, re-verify, commit."""
    hist = engine.get_history(limit=20)
    target = None
    for h in hist:
        for a in h.get("atms") or []:
            if str(a.get("id", "")) == atm_id or atm_id in str(a.get("id", "")):
                target = a
                break
        if target:
            break
    if not target:
        console.print(f"[red]ATM не найден: {atm_id}[/]")
        raise typer.Exit(1)

    state = engine.get_state()
    done_cmd = get_done_cmd(target, state)

    console.print(f"[bold]Fix[/] {atm_id}\n[dim]done:[/] {done_cmd}\n")
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
            ["git", "commit", "-m", f"fix({atm_id}): {message}"],
            cwd=str(engine.repo_root),
            check=False,
        )
        console.print("[green]OK[/]")
    else:
        console.print(f"[red]FAIL[/]\n{r.stderr or r.stdout}")
