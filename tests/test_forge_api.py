"""Smoke: forge exposes run_epic_from_dict and run_single_atm."""
from __future__ import annotations

import pytest


@pytest.mark.skip(reason="requires full forge deps and env")
def test_import_run_helpers():
    from forge.forge import run_epic_from_dict, run_single_atm

    assert callable(run_epic_from_dict)
    assert callable(run_single_atm)


def test_forge_module_defines_functions():
    import importlib.util
    from pathlib import Path

    p = Path(__file__).resolve().parents[1] / "forge" / "forge.py"
    src = p.read_text(encoding="utf-8")
    assert "def run_epic_from_dict" in src
    assert "def run_single_atm" in src
    assert "def _execute_atom_with_retries" in src
