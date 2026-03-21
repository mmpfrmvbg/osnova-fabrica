#!/usr/bin/env python3
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from llm_usage_report import aggregate, build_report

def test_aggregate_empty():
    assert aggregate([]) == {}

def test_aggregate_tokens():
    records = [
        {"role": "OsnovaCodegen", "tokenUsage": {"prompt": 100, "completion": 50, "total": 150}},
        {"role": "OsnovaCodegen", "tokenUsage": {"prompt": 50,  "completion": 30, "total": 80}},
        {"role": "RepairEngineer","tokenUsage": {"prompt": 200, "completion": 100,"total": 300}},
    ]
    agg = aggregate(records)
    assert agg["OsnovaCodegen"]["count"] == 2
    assert agg["OsnovaCodegen"]["tokens_total"] == 230
    assert agg["RepairEngineer"]["tokens_total"] == 300

def test_aggregate_fallback_field():
    records = [{"agent": "IntakeAgent", "tokens": "120"}]
    agg = aggregate(records)
    assert "IntakeAgent" in agg
    assert agg["IntakeAgent"]["tokens_total"] == 120

def test_build_report_info():
    agg = {"OsnovaCodegen": {"count":1,"tokens_prompt":50,"tokens_completion":50,"tokens_total":100}}
    _, severity = build_report(agg, "2026-03-21")
    assert severity == "INFO"

def test_build_report_warn_total():
    agg = {"OsnovaCodegen": {"count":1,"tokens_prompt":0,"tokens_completion":0,"tokens_total":850}}
    _, severity = build_report(agg, "2026-03-21")
    assert severity == "WARN"

def test_build_report_crit_total():
    agg = {"OsnovaCodegen": {"count":1,"tokens_prompt":0,"tokens_completion":0,"tokens_total":1000}}
    _, severity = build_report(agg, "2026-03-21")
    assert severity == "CRIT"

def test_build_report_role_over_budget():
    agg = {"OsnovaCodegen": {"count":2,"tokens_prompt":0,"tokens_completion":0,"tokens_total":500}}
    text, severity = build_report(agg, "2026-03-21")
    assert severity in ("WARN", "CRIT")
    assert "OVER" in text or "⚠️" in text

if __name__ == "__main__":
    tests = [
        test_aggregate_empty, test_aggregate_tokens,
        test_aggregate_fallback_field, test_build_report_info,
        test_build_report_warn_total, test_build_report_crit_total,
        test_build_report_role_over_budget,
    ]
    failed = 0
    for t in tests:
        try:
            t(); print(f"  OK {t.__name__}")
        except AssertionError as e:
            print(f"  FAIL {t.__name__}: {e}"); failed += 1
    print(f"\n{len(tests)-failed}/{len(tests)} passed")
    sys.exit(failed)
