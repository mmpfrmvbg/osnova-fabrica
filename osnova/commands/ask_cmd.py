"""osnova ask."""
from __future__ import annotations

from typing import Annotated, Optional

import typer

from osnova.engine import ForgeEngine
from osnova.render import console

engine = ForgeEngine()


def ask(
    question: Annotated[Optional[str], typer.Argument(help="Вопрос")] = None,
    files: Annotated[Optional[str], typer.Option("--files", "-f")] = None,
    interactive: Annotated[
        bool,
        typer.Option(
            "--interactive",
            "-i",
            help="Ввести вопрос в интерактивном prompt (нужен пакет osnova-cli[interactive])",
        ),
    ] = False,
):
    """Вопрос к Qwen с контекстом state/history (forge: qwen_headless_argv + qwenbudget)."""
    q = question
    if interactive:
        try:
            from prompt_toolkit import prompt as pt_prompt
        except ImportError:
            console.print(
                "[red]Нужен пакет prompt_toolkit:[/] "
                "[dim]pip install 'osnova-cli[interactive]'[/]"
            )
            raise typer.Exit(1)
        entered = pt_prompt("Вопрос > ").strip()
        if not entered:
            raise typer.Abort()
        q = entered
    if not q:
        console.print(
            "[yellow]Укажите вопрос аргументом или используйте [bold]--interactive[/][/]"
        )
        raise typer.Exit(1)

    extra = [x.strip() for x in files.split(",")] if files else []
    with console.status("Qwen…"):
        ans = engine.ask_qwen(q, context_files=extra)
    console.print(ans)
