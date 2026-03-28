"""OSNOVA CLI entrypoint."""
from __future__ import annotations

import typer
from typing import Annotated

from osnova.commands.ask_cmd import ask
from osnova.commands.do_cmd import do
from osnova.commands.epic_cmd import app as epic_app
from osnova.commands.fix_cmd import fix
from osnova.commands.health_cmd import health
from osnova.commands.log_cmd import log
from osnova.commands.pause_cmd import pause, resume
from osnova.commands.plan_cmd import plan
from osnova.commands.quota_cmd import quota
from osnova.commands.retro_cmd import retro
from osnova.commands.run_cmd import run
from osnova.commands.status_cmd import status
from osnova.commands.watch_cmd import watch

app = typer.Typer(
    name="osnova",
    help="OSNOVA Forge CLI",
    no_args_is_help=True,
    rich_markup_mode="rich",
    pretty_exceptions_show_locals=False,
    pretty_exceptions_short=True,
)

app.command("status")(status)
app.command("watch")(watch)
app.command("health")(health)
app.command("log")(log)
app.command("retro")(retro)
app.command("quota")(quota)
app.command("run")(run)
app.command("do")(do)
app.command("plan")(plan)
app.command("fix")(fix)
app.command("ask")(ask)
app.command("pause")(pause)
app.command("resume")(resume)
app.add_typer(epic_app, name="epic")


@app.callback(invoke_without_command=True)
def main(
    ctx: typer.Context,
    version: Annotated[bool, typer.Option("--version", "-v")] = False,
):
    if version:
        from osnova import __version__

        typer.echo(f"osnova {__version__}")
        raise typer.Exit()
    if ctx.invoked_subcommand is None:
        typer.echo(ctx.get_help())


if __name__ == "__main__":
    app()
