// ============================================================
// src/trace/traceStore.ts — Запись трейсов в JSONL
// Путь: OSNOVA_TRACE_DB (default: ./runs/traces.jsonl)
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import type { TraceEntry } from './types';
import type {
  OsnovaIntent,
  OsnovaSpec,
  OsnovaSource,
  BuildReport,
  GoldenReport,
  PipelineStatus,
} from '../pipeline/types';

function getTracePath(): string {
  const db = process.env.OSNOVA_TRACE_DB ?? './runs/traces.jsonl';
  return path.resolve(db);
}

export async function saveTrace(data: {
  runId: string;
  status: PipelineStatus;
  task: string;
  intent?: OsnovaIntent;
  spec?: OsnovaSpec;
  source?: OsnovaSource;
  buildReport?: BuildReport;
  goldenReport?: GoldenReport;
  repairAttempts: number;
}): Promise<void> {
  const entry: TraceEntry = {
    ...data,
    timestamp: new Date().toISOString(),
  };

  const tracePath = getTracePath();
  const dir = path.dirname(tracePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.appendFileSync(tracePath, JSON.stringify(entry) + '\n', 'utf-8');
}
