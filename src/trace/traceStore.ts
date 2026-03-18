// ============================================================
// src/trace/traceStore.ts — Запись трейсов в JSONL
// Путь: OSNOVA_TRACE_DB (default: ./runs/traces.jsonl)
// ============================================================

import * as fs from 'fs/promises';
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
  modelId?: string;
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

  try {
    await fs.access(dir);
  } catch {
    await fs.mkdir(dir, { recursive: true });
  }

  await fs.appendFile(tracePath, JSON.stringify(entry) + '\n', 'utf-8');
}
