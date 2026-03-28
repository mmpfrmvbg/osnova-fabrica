"""osnova forge — запуск/остановка основного цикла forge (python -m forge.forge)."""
from __future__ import annotations

from typing import Annotated

import typer

from osnova.engine import ForgeEngine
from osnova.render import console

engine = ForgeEngine()


@app.command("tray")
def forge_tray():
    """Трей Windows: forge в фоне, иконка по статусу, лог / пауза / выход."""
    from osnova.commands.tray_cmd import run_forge_tray

    run_forge_tray()

app = typer.Typer(help="Управление демоном forge (цикл while True)")


@app.command("start")
def forge_start(
    detach: Annotated[
        bool,
        typer.Option(
            "--detach",
            "-d",
            help="Фон: лог в forge.log в корне репозитория (на Windows — без нового окна)",
        ),
    ] = False,
):
    """Запустить forge. На Windows без --detach открывается новая консоль; с --detach — тихий фон + forge.log."""
    pid, err = engine.start_forge_daemon(detach=detach)
    if pid is None:
        console.print(f"[red]Не удалось запустить forge:[/] {err}")
        raise typer.Exit(1)
    if err:
        console.print(f"[yellow]{err}[/]")
    console.print(f"[green]Forge запущен[/]  PID [bold]{pid}[/]  (записан в forge-state как forge_loop_pid)")
    if detach:
        console.print(f"[dim]Лог: {engine.repo_root / 'forge.log'}[/]")
    else:
        console.print("[dim]Лог в этой консоли или в открывшемся окне (Windows).[/]")


@app.command("stop")
def forge_stop():
    """Остановить PID: forge_loop_pid, иначе smith_pid (fallback если forge не через CLI)."""
    ok, msg = engine.stop_forge_daemon()
    if not ok:
        console.print(f"[yellow]{msg}[/]")
        raise typer.Exit(1)
    if msg:
        console.print(f"[dim]{msg}[/]")
    console.print("[green]Остановка forge отправлена.[/]")


@app.command("status")
def forge_status():
    """Кратко: forge_loop_pid и smith_pid из forge-state; подробности — osnova health."""
    fs = engine.get_forge_state()
    loop_pid = fs.get("forge_loop_pid")
    smith_pid = fs.get("smith_pid")
    paused = fs.get("paused")
    console.print(
        f"forge_loop_pid: [bold]{loop_pid if loop_pid is not None else '—'}[/]  "
        f"smith_pid: [bold]{smith_pid if smith_pid is not None else '—'}[/]  "
        f"paused: {paused}"
    )
    if not loop_pid and not smith_pid:
        console.print(
            "[dim]Оба PID пусты — forge не через CLI или процесс не писал state.[/]"
        )
    console.print("[dim]Полный статус: osnova health[/]")

