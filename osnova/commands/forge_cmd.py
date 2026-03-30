"""osnova forge — запуск/остановка основного цикла forge (python -m forge.forge)."""
from __future__ import annotations

import urllib.error
from typing import Annotated

import typer
import yaml

from osnova.engine import ForgeEngine
from osnova.paths import ensure_forge_imports
from osnova.render import console

engine = ForgeEngine()

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


@app.command("tray")
def forge_tray():
    """Трей Windows: forge в фоне, иконка по статусу, лог / пауза / выход."""
    from osnova.commands.tray_cmd import run_forge_tray

    run_forge_tray()


@app.command("close-blockers")
def forge_close_blockers(
    issues: Annotated[
        str,
        typer.Option(
            "--issues",
            help="Номера GitHub issues через запятую (например 76,77,78)",
        ),
    ],
    dry_run: Annotated[
        bool,
        typer.Option("--dry-run", help="Только план: без записи файлов и без GitHub API"),
    ] = False,
):
    """Записать зеркало закрытых blocker-issues в ``.github/issues/`` и при наличии GH_TOKEN закрыть issues в GitHub."""
    from osnova import config

    ensure_forge_imports()
    from forge.common import env_paths, gh_request, now_iso

    repo_root = config.project_dir()
    issues_dir = repo_root / ".github" / "issues"
    raw = [p.strip() for p in (issues or "").split(",") if p.strip()]
    if not raw:
        console.print("[red]Пустой --issues[/]")
        raise typer.Exit(1)
    try:
        nums = [int(x) for x in raw]
    except ValueError:
        console.print("[red]--issues должен содержать целые номера через запятую[/]")
        raise typer.Exit(1)

    paths = env_paths()
    gh_repo = paths["GHREPO"]
    token = (paths.get("GH_TOKEN") or "").strip()

    if dry_run:
        for n in nums:
            console.print(
                f"[dim]dry-run:[/] записать [bold]{issues_dir / (str(n) + '.yaml')}[/] (state: closed)"
            )
            if token:
                console.print(
                    f"[dim]dry-run:[/] PATCH api.github.com/repos/{gh_repo}/issues/{n} state=closed"
                )
            else:
                console.print("[yellow]dry-run:[/] GH_TOKEN не задан — шаг GitHub API будет пропущен")
        return

    issues_dir.mkdir(parents=True, exist_ok=True)
    ts = now_iso()
    for n in nums:
        rec = {
            "issue": n,
            "state": "closed",
            "updated": ts,
            "source": "forge-close-blockers",
        }
        out = issues_dir / f"{n}.yaml"
        out.write_text(yaml.safe_dump(rec, allow_unicode=True, sort_keys=False), encoding="utf-8")
        console.print(f"[green]recorded[/] {out.relative_to(repo_root)}")
        if not token:
            console.print(f"[yellow]GH_TOKEN не задан[/] — GitHub #{n} не трогали")
            continue
        try:
            gh_request("PATCH", f"/repos/{gh_repo}/issues/{n}", {"state": "closed"})
            console.print(f"[green]GitHub[/] issue #{n} закрыт")
        except urllib.error.HTTPError as exc:
            console.print(f"[yellow]GitHub #{n}[/] HTTP {exc.code} — локальный файл всё равно записан")

