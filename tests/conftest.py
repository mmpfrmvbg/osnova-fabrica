"""Pytest fixtures for OSNOVA CLI tests."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


@pytest.fixture
def tmp_osnova(tmp_path: Path) -> Path:
    """Минимальная структура .osnova/ для monkeypatch OSNOVA_DIR."""
    osnova_dir = tmp_path / ".osnova"
    osnova_dir.mkdir()
    (osnova_dir / "history").mkdir()
    (osnova_dir / "epics").mkdir()
    (osnova_dir / "meta").mkdir()

    state = {
        "v": 5,
        "sessionstats": {
            "passrate": 0.85,
            "epicsreceived": 3,
            "atomsdone": 17,
            "atomsblocked": 3,
        },
        "brainsource": "test",
        "heart": {"restartstoday": 0},
        "ci": {"openblockerissues": 0},
        "blockers": [],
    }
    (osnova_dir / "state.yaml").write_text(
        yaml.dump(state, allow_unicode=True),
        encoding="utf-8",
    )

    history = {
        "epic": "EPK-T-1",
        "goal": "goal line for log",
        "summary": {"started_at": "2026-03-28T15:00:00"},
        "results": [
            {"id": "ATM-1", "s": "OK", "elapsed": 10},
            {"id": "ATM-2", "s": "BLK", "err": "fail", "elapsed": 5},
        ],
    }
    (osnova_dir / "history" / "260328-150000.yaml").write_text(
        yaml.dump(history, allow_unicode=True),
        encoding="utf-8",
    )

    (osnova_dir / "meta" / "retrospective-latest.yaml").write_text(
        yaml.dump({"epic_id": "EPK-T-1"}, allow_unicode=True),
        encoding="utf-8",
    )

    return tmp_path
