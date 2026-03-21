# scripts/health_now.py
import json, pprint
from pathlib import Path
from collections import Counter

path = Path("runs/traces.jsonl")
traces = [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]

window = traces[-500:]
total = len(window)

success   = [t for t in window if t.get("status") == "success"]
exhausted = [t for t in window if t.get("status") == "repair_exhausted"]

sem_errors = [e for t in window for e in (t.get("semanticErrors") or [])]
sem_in_ok  = [t for t in success if t.get("semanticErrors")]

repair_attempts = [t.get("repairAttempts", 0) for t in success]
mean_repair = sum(repair_attempts) / len(repair_attempts) if repair_attempts else 0

top_sem = Counter(e.get("kind") for e in sem_errors).most_common(5)

# Исправленная формула I-4: всегда в [0, 1]
health = (
    (len(success) / total) * 0.40
    + (1 - len(exhausted) / total) * 0.35
    + (1 - (len(sem_in_ok) / len(success) if success else 0)) * 0.25
)
health = max(0.0, min(1.0, health))

print(f"\n=== OSNOVA HEALTH (last {total} traces) ===")
print(f"  success rate:        {len(success)/total:.1%}  ({len(success)}/{total})")
print(f"  repair_exhausted:    {len(exhausted)/total:.1%}  ({len(exhausted)})")
print(f"  semantic in success: {len(sem_in_ok)}  ← КРИТИЧНО если > 0")
print(f"  mean repair attempts:{mean_repair:.2f}")
print(f"  health_score:        {health:.2f}")

# Статусы всех трейсов
statuses = Counter(t.get("status") for t in window)
print(f"\n  статусы:")
for status, n in statuses.most_common():
    print(f"    {status}: {n}")

# Топ semantic kinds
print(f"\n  top semantic kinds:")
for kind, n in top_sem:
    print(f"    {kind}: {n}")

# Структура последнего трейса
print(f"\n  структура последнего трейса (ключи):")
pprint.pprint(list(traces[-1].keys()))

# Вскрыть partial
partials = [t for t in window if t.get("status") == "partial"]
print(f"\n  анализ partial ({len(partials)}):")

# Посмотреть структуру buildReport у partial
sample = partials[-1]
print(f"  buildReport keys: {list((sample.get('buildReport') or {}).keys())}")
print(f"  goldenReport keys: {list((sample.get('goldenReport') or {}).keys())}")

# Есть ли у partial repairAttempts?
repair_in_partial = Counter(t.get("repairAttempts", 0) for t in partials)
print(f"  repairAttempts в partial: {dict(repair_in_partial)}")

# Добавь в конец health_now.py

print(f"\n  детали partial:")

# Compile success у partial?
compile_ok = [t for t in partials if (t.get("buildReport") or {}).get("compilerSuccess")]
print(f"  compilerSuccess=true:  {len(compile_ok)}/{len(partials)}")

# Semantic errors у partial?
sem_in_partial = [t for t in partials if (t.get("buildReport") or {}).get("semanticErrors")]
print(f"  с semanticErrors:      {len(sem_in_partial)}")

# Golden качество у partial
scores = [(t.get("goldenReport") or {}).get("qualityScore") for t in partials]
scores = [s for s in scores if s is not None]
if scores:
    print(f"  qualityScore: min={min(scores):.2f}  avg={sum(scores)/len(scores):.2f}  max={max(scores):.2f}")

# VM errors у partial?
vm_errors = [t for t in partials if (t.get("goldenReport") or {}).get("vmErrors")]
print(f"  с vmErrors:            {len(vm_errors)}")

# outputDiff — есть расхождение?
with_diff = [t for t in partials if (t.get("goldenReport") or {}).get("outputDiff")]
print(f"  с outputDiff:          {len(with_diff)}")

# Один пример partial для понимания
g = partials[-1].get("goldenReport") or {}
print(f"\n  пример goldenReport:")
pprint.pprint(g)



# Посмотреть несколько реальных задач с partial
for t in partials[:3]:
    print(t.get("task", "")[:80])
    print(f"  outputDiff: {(t.get('goldenReport') or {}).get('outputDiff')}")
    print()








# Посмотреть реальные invoke в partial трейсе
import json
partials = [t for t in window if t.get("status") == "partial"]
p = partials[0]
print("spec.syscalls:", p.get("spec", {}).get("syscalls", []))
print("outputDiff:", p.get("goldenReport", {}).get("outputDiff"))



# Добавь в скрипт
partials = [t for t in window if t.get("status") == "partial"]
print("\n  примеры задач из partial:")
for t in partials[:5]:
    print(f"  task: {str(t.get('task', ''))[:100]}")
    print(f"  runId: {t.get('runId', '')[:40]}")
    print()

exhausted = [t for t in window if t.get("status") == "repair_exhausted"]
print(f"\n  примеры repair_exhausted ({len(exhausted)}):")
for t in exhausted[:5]:
    print(f"  task: {str(t.get('task',''))[:80]}")
    b = t.get("buildReport") or {}
    print(f"  compilerErrors: {b.get('compilerErrors', [])[:2]}")
    print(f"  semanticErrors: {b.get('semanticErrors', [])[:2]}")
    print()