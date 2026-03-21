#!/usr/bin/env python3
# scripts/llm_usage_report.py
# Читает logs/llm-usage/YYYY-MM-DD.jsonl, агрегирует по role,
# отправляет отчёт в Telegram.
# Запуск: python scripts/llm_usage_report.py [--no-telegram] [--date YYYY-MM-DD]

import json, os, sys, argparse
from pathlib import Path
from datetime import date
from collections import defaultdict

BUDGET_PER_ROLE: dict[str, int] = {
    "OsnovaCodegen":  400,
    "RepairEngineer": 200,
    "IntakeAgent":    100,
    "GateChecker":    100,
    "default":        150,
}
TOTAL_WARN = 800
TOTAL_CRIT = 950

def load_log(log_path: Path) -> list[dict]:
    if not log_path.exists():
        return []
    records = []
    for line in log_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return records

def aggregate(records: list[dict]) -> dict[str, dict]:
    agg: dict[str, dict] = defaultdict(lambda: {
        "count": 0,
        "tokens_prompt": 0,
        "tokens_completion": 0,
        "tokens_total": 0,
    })
    for r in records:
        role = r.get("role") or r.get("agent") or "unknown"
        agg[role]["count"] += 1
        tu = r.get("tokenUsage") or r.get("tokensUsed")
        if isinstance(tu, dict) and len(tu) > 0:
            agg[role]["tokens_prompt"]     += tu.get("prompt", 0) or 0
            agg[role]["tokens_completion"] += tu.get("completion", 0) or 0
            agg[role]["tokens_total"]      += tu.get("total", 0) or 0
        else:
            agg[role]["tokens_total"] += int(r.get("tokens", 0) or 0)
    return dict(agg)

def build_report(agg: dict[str, dict], target_date: str) -> tuple[str, str]:
    total_tokens = sum(v["tokens_total"] for v in agg.values())
    lines = [f"📊 LLM Usage Report — {target_date}", f"Всего токенов: {total_tokens}", ""]
    severity = "INFO"
    role_warns = []

    for role, stats in sorted(agg.items()):
        budget = BUDGET_PER_ROLE.get(role, BUDGET_PER_ROLE["default"])
        pct = (stats["tokens_total"] / budget * 100) if budget > 0 else 0
        flag = ""
        if pct > 100:
            flag = " ⚠️ OVER"
            if severity != "CRIT":
                severity = "WARN"
            role_warns.append(f"{role}: {stats['tokens_total']} > budget {budget}")
        lines.append(
            f"  {role}: {stats['count']} calls, "
            f"{stats['tokens_total']} tok ({pct:.0f}% budget){flag}"
        )

    lines.append("")
    if total_tokens > TOTAL_CRIT:
        severity = "CRIT"
        lines.append(f"🚨 CRIT: total {total_tokens} > {TOTAL_CRIT}")
    elif total_tokens > TOTAL_WARN:
        if severity != "CRIT":
            severity = "WARN"
        lines.append(f"⚠️  WARN: total {total_tokens} > {TOTAL_WARN}")
    else:
        lines.append(f"✅ INFO: total {total_tokens} — норма")

    if role_warns:
        lines.append("")
        lines.append("Превышения бюджета по ролям:")
        for w in role_warns:
            lines.append(f"  • {w}")

    return "\n".join(lines), severity

def send_telegram(text: str, severity: str) -> None:
    token   = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID", "")
    if not token or not chat_id:
        print("[telegram] TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID не заданы — пропускаю")
        return
    import urllib.request
    if severity == "CRIT":
        admin = os.environ.get("TELEGRAM_ADMIN", "")
        if admin:
            text = f"{text}\n\n🔴 {admin} требуется внимание"
    payload = json.dumps({
        "chat_id": chat_id, "text": text,
        "parse_mode": "HTML",
        "disable_notification": (severity == "INFO"),
    }).encode("utf-8")
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read().decode())
            if not result.get("ok"):
                print(f"[telegram] ошибка: {result}")
            else:
                print("[telegram] отправлено ✓")
    except Exception as e:
        print(f"[telegram] исключение: {e}")

def main() -> None:
    parser = argparse.ArgumentParser(description="LLM Usage Report")
    parser.add_argument("--no-telegram", action="store_true")
    parser.add_argument("--date", default=None)
    args = parser.parse_args()
    target_date = args.date or date.today().strftime("%Y-%m-%d")
    log_path = Path("logs") / "llm-usage" / f"{target_date}.jsonl"
    print(f"[usage-report] Читаю: {log_path}")
    records = load_log(log_path)
    print(f"[usage-report] Записей: {len(records)}")
    if not records:
        print("[usage-report] Лог пуст — нечего отправлять")
        sys.exit(0)
    agg = aggregate(records)
    report_text, severity = build_report(agg, target_date)
    print(""); print(report_text)
    print(f"\n[severity] {severity}")
    if not args.no_telegram:
        send_telegram(report_text, severity)
    else:
        print("[telegram] пропущено (--no-telegram)")

if __name__ == "__main__":
    main()
