// ============================================================
// src/trace/types.ts — Формат трейса прогона (traces-v1)
// Источник истины — этот файл и src/pipeline/types.ts
// Документация: docs/traces-v1.md (должна синхронизироваться с кодом)
// Запись: src/trace/traceStore.ts | Чтение: src/scripts/export-dataset.ts
// ============================================================

import type {
  OsnovaIntent,
  OsnovaSpec,
  OsnovaSource,
  BuildReport,
  GoldenReport,
  PipelineStatus,
} from '../pipeline/types';

export interface TraceEntry {
  readonly runId: string;
  readonly timestamp: string;   // ISO 8601
  readonly status: PipelineStatus;
  readonly task: string;        // исходный текстовый запрос
  readonly modelId?: string;    // OSNOVA_MODEL, для анализа качества по провайдерам
  readonly intent?: OsnovaIntent;
  readonly spec?: OsnovaSpec;
  readonly source?: OsnovaSource;
  readonly buildReport?: BuildReport;
  readonly goldenReport?: GoldenReport;
  readonly repairAttempts: number;
}
