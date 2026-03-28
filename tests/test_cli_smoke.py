"""Smoke tests for Typer entrypoint."""
from __future__ import annotations

from typer.testing import CliRunner

from osnova import __version__
from osnova.cli import app


def test_cli_version():
    r = CliRunner().invoke(app, ["--version"])
    assert r.exit_code == 0
    assert __version__ in (r.stdout or "")


def test_cli_help():
    r = CliRunner().invoke(app, ["--help"])
    assert r.exit_code == 0
    assert "install-completion" in (r.stdout or "") or "completion" in (r.stdout or "").lower()


def test_forge_help():
    r = CliRunner().invoke(app, ["forge", "--help"])
    assert r.exit_code == 0
    assert "start" in (r.stdout or "") and "stop" in (r.stdout or "")
