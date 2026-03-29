"""Human-readable log formatting (reason display)."""

from __future__ import annotations

from unittest.mock import patch

import forge.humanlog as humanlog


def test_review_fail_reason_short_unchanged() -> None:
    msg = humanlog._format_message(
        "review_fail",
        reason="short",
        atm_id="ATM-1",
        elapsed_s=5,
    )
    assert "short" in msg
    assert "…" not in msg or len("short") <= 200


def test_review_fail_reason_long_truncated_and_debug() -> None:
    long_reason = "x" * 250
    with patch.object(humanlog, "LOG_DBG") as mock_log:
        msg = humanlog._format_message(
            "review_fail",
            reason=long_reason,
            atm_id="ATM-1",
            elapsed_s=3,
        )
    assert "…" in msg
    assert "x" * 200 in msg
    assert long_reason not in msg
    mock_log.debug.assert_called_once()
    call = mock_log.debug.call_args[0]
    assert "ATM-1" in call
    assert long_reason in str(call)


def test_atm_blk_reason_long() -> None:
    long_reason = "e" * 220
    with patch.object(humanlog, "LOG_DBG") as mock_log:
        msg = humanlog._format_message("atm_blk", atm_id="ATM-2", reason=long_reason)
    assert "…" in msg
    mock_log.debug.assert_called_once()
