"""Classify ATM failures: transient (infra) vs permanent (semantic / hard failure)."""

from __future__ import annotations

from typing import Any

# Executor / infra — substring match on combined error text (lowercase)
TRANSIENT_SUBSTRINGS = (
    "fatalturnlimitederror",
    "quota exceeded",
    "timeout",
    "connection refused",
    "rate limit",
    "network error",
    "econnreset",
    "etimedout",
    "temporarily unavailable",
    "503",
    "429",
)


def classify_blk(
    *,
    exec_report_ok: bool,
    review_passed: bool | None,
    report: dict[str, Any],
) -> str:
    """
    Returns 'transient' or 'permanent'.

    Review failure when executor produced OK report — always permanent (semantic).
    Executor failure — classify by error text; default permanent.
    """
    if exec_report_ok and review_passed is False:
        return "permanent"
    err_parts: list[str] = []
    if report.get("err"):
        err_parts.append(str(report["err"]))
    rev = report.get("review")
    if isinstance(rev, dict) and rev.get("reason"):
        err_parts.append(str(rev["reason"]))
    elif rev:
        err_parts.append(str(rev))
    blob = " ".join(err_parts).lower()
    if not exec_report_ok or not blob.strip():
        if any(p in blob for p in TRANSIENT_SUBSTRINGS):
            return "transient"
    return "permanent"
