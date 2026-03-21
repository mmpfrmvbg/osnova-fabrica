---
# PM Handoff — ОС-НОВА Session State

**Дата:** 2026-03-21  
**Сессия:** языковой агент + PM  
**Репозиторий:** mmpfrmvbg/osnova-fabrica (приватный)

---

## Схема работы

Языковой агент работает через Cursor самостоятельно.  
Формат цикла:
1. PM присылает задание в промпте
2. Агент выполняет, пишет текстовый доклад
3. PM читает доклад, принимает решения, даёт следующий промпт

Агент НЕ спрашивает что делать — работает до конца задания,  
затем ждёт промпт PM.

---

## Статус роадмапа на 2026-03-21

### Завершено в этой сессии

| Задача | SHA | Статус |
|--------|-----|--------|
| T-2: repair-target per blocking kind | 0b551c9 | ✅ |
| T-5: few-shot balance by category | cdd2c6b | ✅ |
| T-6: repair-failures.jsonl | b798126 | ✅ |
| T-2 connect repairTarget → repair prompt | fbc1bbe | ✅ |
| Dataset few-shot (storage/strings/procedures/errors) | 4539a16 | ✅ |
| Shadow Mode RFC-002 tracker | fa6933e | ✅ |
| Shadow Mode RFC-003 tracker (empty) | 4ac6dee | ✅ |
| Shadow wire-up в orchestrator | 7160778 | ✅ |
| aggregate-shadow script | aa70798 | ✅ |
| Fix trace schema (shadow_hits) | 452ac2c | ✅ |
| RFC-003 Phase B: invented_syntax blocking | — | ✅ |
| RFC-002 Phase B: sentinel_pattern non-blocking | — | ✅ |
| docs: RFC-002/003 Phase B accepted in compiler | — | ✅ |

### Метрики (2026-03-21, 978 трейсов total)

| Метрика | Значение | Цель |
|---------|----------|------|
| success rate | 65.3% | ≥ 70% |
| repair_exhausted rate | 8.6% | ≤ 10% ✅ |
| build success | 94.0% | ≥ 90% ✅ |
| quality avg | 0.838 | ≥ 0.82 ✅ |
| teachability | 86.4% (total) | ≥ 85% ✅ |
| sentinel rate | 10.8% | < 5% (Phase B ждёт) |
| invented_syntax rate | 0.2% | < 1% ✅ |
| RFC-002 shadow correctRate | 87.7% | ≥ 80% ✅ |
| RFC-003 shadow correctRate | 99.8% | ≥ 80% ✅ |
| semantic_errors_in_success | 37 (total) / 0 (since 2026-03-21) | = 0 |

### Beta-gate (--since 2026-03-21)

passed: **false** — нет success-трейсов в узком окне.  
Нужен batch-run с реальным LLM для накопления трейсов.  
Blockers записаны в runs/decisions.jsonl.

---

## Открытые вопросы (требуют решения PM)

1. **sentinel_pattern blocking/non-blocking** — сейчас non-blocking.  
   Вариант B: обновить golden-тесты, сделать blocking.  
   Вариант C: оставить только в shadowMode.

2. **batch-run с реальным LLM** — готов (`npm run batch-run`).  
   Нужен OSNOVA_MODEL + API key. Запускать по команде PM.

3. **Beta-gate повторный прогон** — после batch-run:  
   `npm run analyze-language-health -- --since 2026-03-21`

4. **RFC-002 Phase B sentinel rate** — 10.8% сейчас.  
   Phase B детектор добавлен, но в промпты не дополнительно  
   усилен — repair через invented_syntax blocking уже работает.

---

## Ключевые файлы

| Файл | Назначение |
|------|-----------|
| src/pipeline/shadowMode.ts | Shadow tracker RFC-002/003 |
| src/pipeline/orchestrator.ts | Основной пайплайн |
| src/compiler/semantic.ts | Семантические проверки |
| src/compiler/semanticKinds.ts | BLOCKING_SEMANTIC_KINDS |
| src/pipeline-llm/buildOsnovaPrompt.ts | Промпты codegen + repair |
| src/pipeline-llm/repairTarget.ts | T-2 repair инструкции |
| src/scripts/aggregate-shadow.ts | Shadow rate агрегат |
| src/scripts/analyze-language-health.ts | Метрики языка |
| src/scripts/batch-run.ts | Batch прогон трейсов |
| runs/decisions.jsonl | История решений PM |
| runs/repair-failures.jsonl | Repair exhausted лог |

---

## Формат задания агенту

```
Файлы: <какие файлы трогать>
Не трогать: <что не трогать>

Задача: <что сделать>

Коммит:
git add <файлы> && git commit -m "<тип>(<scope>): <описание>" && git push
```

Типы коммитов: feat, fix, docs, test, chore, refactor
---
