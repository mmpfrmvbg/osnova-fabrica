# Dataset v1 — Baseline Report
Date: 2026-03-18
Model: qwen-coder-plus

## Метрики
- Total runs: 50
- Success: 48 (96%)
- Partial: 0
- repair_exhausted: 1 (2%)
- Failure: 1 (2%)
- Avg repair attempts: 0.2

## Известные баги (не промпты)
- G1 low confidence на простых задачах (IntakeAgent порог)
- VM crash на задачах с % (кратные числа)

## Статус
Датасет готов к fine-tuning pipeline.
Трейсы: runs/traces.jsonl
