// ============================================================
// src/trace/types.ts — Формат трейса прогона
// Источник правды: trace-format-v0.1.md
// Используется для дообучения LLM: training-llm-from-traces-v0.1.md
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
  readonly intent?: OsnovaIntent;
  readonly spec?: OsnovaSpec;
  readonly source?: OsnovaSource;
  readonly buildReport?: BuildReport;
  readonly goldenReport?: GoldenReport;
  readonly repairAttempts: number;
}
