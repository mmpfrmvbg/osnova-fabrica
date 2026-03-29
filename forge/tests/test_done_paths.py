"""Tests for forge.done_paths.check_done_cmd_paths."""

from __future__ import annotations

from pathlib import Path

from forge.done_paths import check_done_cmd_paths


def test_existing_file_no_missing(tmp_path: Path) -> None:
    f = tmp_path / "foo.test.ts"
    f.write_text("x", encoding="utf-8")
    result = check_done_cmd_paths(f"npx vitest run {f.name}", tmp_path)
    assert result == []


def test_missing_file_detected(tmp_path: Path) -> None:
    result = check_done_cmd_paths("npx vitest run tsconfig.test.ts", tmp_path)
    assert "tsconfig.test.ts" in result


def test_no_file_args(tmp_path: Path) -> None:
    result = check_done_cmd_paths("npm run ci", tmp_path)
    assert result == []


def test_multiple_args_some_missing(tmp_path: Path) -> None:
    existing = tmp_path / "exists.test.ts"
    existing.write_text("x", encoding="utf-8")
    result = check_done_cmd_paths(
        f"npx vitest run {existing.name} missing.test.ts",
        tmp_path,
    )
    assert "missing.test.ts" in result
    assert existing.name not in result


def test_absolute_path_missing(tmp_path: Path) -> None:
    p = tmp_path / "abs_missing.ts"
    result = check_done_cmd_paths(f"npx vitest run {p}", tmp_path)
    assert str(p) in result
