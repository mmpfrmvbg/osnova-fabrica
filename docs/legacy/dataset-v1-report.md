# Dataset v1 — Baseline Report
Date: 2026-03-18
Model: qwen-coder-plus

## Baseline v3 (финальный)
Date: 2026-03-18
Batch: runs/batch-v3-summary.json

### Метрики
- Total runs: 50
- Success: 48 (96%)
- Partial: 0
- repair_exhausted: 2 (4%)
- Failure: 0
- Avg repair attempts: 0.3

### Известные нестабильности (не системные баги)
- «сумма чётных» и «кратные 3» иногда падают из-за нестабильности LLM
- При ручном запуске — success; при batch — недетерминированы
- Ожидается исправление после fine-tuning

### Статус
Датасет закрыт. Готов к fine-tuning pipeline.
Суммарно накоплено: ~150+ трейсов (runs/traces.jsonl)
