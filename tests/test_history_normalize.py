"""Tests for history normalization (no forge import required)."""
from __future__ import annotations

from osnova.state_reader import normalize_history_entry


def test_normalize_maps_results_to_atms():
    raw = {
        "epic": "EPK-1",
        "createdat": "2026-01-01T00:00:00",
        "summary": {"status": "OK"},
        "results": [
            {"id": "ATM-1", "s": "OK", "elapsed": 10},
            {"id": "ATM-2", "s": "BLK", "err": "fail", "elapsed": 5},
        ],
    }
    n = normalize_history_entry(raw)
    assert n["epic_id"] == "EPK-1"
    assert len(n["atms"]) == 2
    assert n["atms"][0]["elapsed_s"] == 10
    assert n["atms"][1]["blk_reason"] == "fail"


def test_normalize_empty_results():
    n = normalize_history_entry({"epic": "X", "results": []})
    assert n["atms"] == []
