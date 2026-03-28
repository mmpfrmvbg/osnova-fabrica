"""osnova ask."""
from __future__ import annotations

from typing import Annotated, Optional

import typer

from osnova.engine import ForgeEngine
from osnova.render import console

engine = ForgeEngine()


def ask(
    question: Annotated[str, typer.Argument(help="Вопрос")],
    files: Annotated[Optional[str], typer.Option("--files", "-f")] = None,
):
    """Вопрос к Qwen CLI с контекстом state/history."""
    extra = [x.strip() for x in files.split(",")] if files else []
    with console.status("Qwen…"):
        ans = engine.ask_qwen(question, context_files=extra)
    console.print(ans)
