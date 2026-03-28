"""Unit tests for render helpers and health-shaped panels."""
from __future__ import annotations

from osnova.render import (
    atm_status_icon,
    make_atm_table,
    make_epic_table,
    make_health_panel,
    make_progress_bar,
)


def test_atm_status_icons():
    assert atm_status_icon("OK") == "✅"
    assert atm_status_icon("BLK") == "❌"


def test_make_progress_bar():
    assert make_progress_bar(0, 0) == "—"
    assert "5/10" in make_progress_bar(5, 10)
    assert "█" in make_progress_bar(3, 10)


def test_make_atm_table_rows():
    t = make_atm_table(
        [
            {"id": "A1", "s": "OK", "goal": "g", "elapsed_s": 1, "executor": "qwen"},
        ]
    )
    assert t.row_count == 1


def test_make_epic_table_zone_stat():
    t = make_epic_table(
        [
            {
                "id": "EPK-1",
                "priority": "P2",
                "zone": "lang",
                "status": "OPEN",
                "goal": "x",
            }
        ]
    )
    assert t.row_count == 1


def test_make_health_panel_includes_heart_brain():
    from io import StringIO

    from rich.console import Console

    panel = make_health_panel(
        {
            "forge": {
                "status": "ALIVE",
                "detail": "ok",
                "systemd": "active",
                "paused": False,
                "restarts_today": 0,
            },
            "heart": {"systemd": "inactive", "restarts_today": 1},
            "brain": {"source": "idle", "last_epic_at": None},
            "executors": {"qwen": True, "cursor": True, "healthy": True},
            "stats": {
                "passrate": 0.8,
                "epics_today": 1,
                "atms_ok": 2,
                "atms_blk": 0,
            },
            "ci": {"openblockerissues": 0},
            "blockers": [],
        }
    )
    buf = StringIO()
    Console(file=buf, width=120, force_terminal=True).print(panel)
    s = buf.getvalue()
    assert "Heart:" in s
    assert "Brain:" in s
    assert "Forge:" in s
