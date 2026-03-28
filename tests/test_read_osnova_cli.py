"""read_osnova_md и read-only CLI с временным проектом."""
from __future__ import annotations

from pathlib import Path

import pytest
from typer.testing import CliRunner

from osnova.cli import app


def test_read_osnova_md_parses_sections(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr("osnova.config.project_dir", lambda: tmp_path)
    (tmp_path / "OSNOVA.md").write_text(
        "# OSNOVA\n\n## Stack\n\n- language: TypeScript\n- runtime: Node.js 20\n\n"
        "## Notouch\n\n- .github/\n\n## Brain\n\n- cycle_minutes: 36\n",
        encoding="utf-8",
    )
    from osnova.state_reader import read_osnova_md

    cfg = read_osnova_md()
    assert cfg.get("stack", {}).get("language") == "TypeScript"
    assert ".github/" in cfg.get("notouch", [])
    assert cfg.get("brain", {}).get("cycle_minutes") == "36"


def test_status_json_uses_tmp_state(monkeypatch: pytest.MonkeyPatch, tmp_osnova: Path) -> None:
    monkeypatch.setattr("osnova.config.project_dir", lambda: tmp_osnova)
    r = CliRunner().invoke(app, ["status", "--json"])
    assert r.exit_code == 0
    assert "EPK-T-1" in (r.stdout or "") or "sessionstats" in (r.stdout or "")


def test_log_json_uses_tmp_history(monkeypatch: pytest.MonkeyPatch, tmp_osnova: Path) -> None:
    monkeypatch.setattr("osnova.config.project_dir", lambda: tmp_osnova)
    r = CliRunner().invoke(app, ["log", "--json", "-n", "2"])
    assert r.exit_code == 0
    assert "EPK-T-1" in (r.stdout or "")


def test_health_smoke_with_patched_pulse(
    monkeypatch: pytest.MonkeyPatch, tmp_osnova: Path
) -> None:
    monkeypatch.setattr("osnova.config.project_dir", lambda: tmp_osnova)
    monkeypatch.setattr("osnova.engine.read_heartbeat_age", lambda: 30.0)
    monkeypatch.setattr(
        "osnova.engine.read_forge_state",
        lambda: {"paused": False},
    )
    monkeypatch.setattr(
        "osnova.engine.ForgeEngine.get_degradation_status",
        lambda self: {"qwen": True, "cursor": True, "healthy": True},
    )
    r = CliRunner().invoke(app, ["health", "--json"])
    assert r.exit_code == 0
    out = r.stdout or ""
    assert "forge" in out.lower() or '"forge"' in out
