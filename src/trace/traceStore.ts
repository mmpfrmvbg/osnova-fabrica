// ============================================================
// src/trace/traceStore.ts — Запись трейсов в JSONL
// Путь: OSNOVA_TRACE_DB (default: ./runs/traces.jsonl)
// ============================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import { z } from 'zod';
import type { TraceEntry } from './types';
import type {
  OsnovaIntent,
  OsnovaSpec,
  OsnovaSource,
  BuildReport,
  GoldenReport,
  PipelineStatus,
} from '../pipeline/types';
import type { ShadowHit } from '../pipeline/shadowMode';

const LexerErrorSchema = z.object({
  line: z.number(),
  column: z.number(),
  message: z.string(),
});

const ParserErrorSchema = z
  .object({
    line: z.number(),
    column: z.number(),
    message: z.string(),
    node: z.string().optional(),
  })
  .passthrough();

const CompilerErrorSchema = z
  .object({
    message: z.string(),
    node: z.string().optional(),
  })
  .passthrough();

const SemanticErrorKindSchema = z.enum([
  'undeclared_var',
  'syscall_argc',
  'chained_compare',
  'unknown_syscall',
  'unknown_procedure',
  'redeclare_var',
  'keyword_param',
  'invented_syntax',
  'sentinel_pattern',
  'break_outside_loop',
  'continue_outside_loop',
]);

const SemanticErrorSchema = z
  .object({
    message: z.string(),
    kind: SemanticErrorKindSchema,
    line: z.number().optional(),
  })
  .passthrough();

const VmErrorSchema = z
  .object({
    message: z.string(),
    opcode: z.string().optional(),
    stack: z.unknown().optional(),
  })
  .passthrough();

const AppTypeSchema = z.enum(['утилита', 'хранилище', 'ui_приложение', 'актор', 'смешанный']);

const OsnovaIntentSchema = z
  .object({
    intentId: z.string(),
    description: z.string(),
    features: z.array(z.string()),
    appType: AppTypeSchema,
    constraints: z.record(z.string(), z.unknown()),
    confidence: z.number().min(0).max(1),
  })
  .passthrough();

const OsnovaModuleSchema = z.object({
  name: z.string(),
  description: z.string(),
  isMain: z.boolean(),
});

const OsnovaTypeSchema = z.object({
  name: z.string(),
  fields: z.record(z.string(), z.string()),
});

const ProcedureSignatureSchema = z.object({
  name: z.string(),
  params: z.record(z.string(), z.string()),
  returnType: z.string(),
});

const OsnovaSpecSchema = z
  .object({
    specId: z.string(),
    modules: z.array(OsnovaModuleSchema),
    mainModule: z.string(),
    types: z.array(OsnovaTypeSchema),
    procedures: z.array(ProcedureSignatureSchema),
    syscalls: z.array(z.string()),
    conventions: z.record(z.string(), z.unknown()),
  })
  .passthrough();

const OsnovaSourceSchema = z.object({
  filename: z.string(),
  source: z.string(),
  tokensUsed: z.number().optional(),
});

const BuildReportSchema = z
  .object({
    success: z.boolean(),
    lexerErrors: z.array(LexerErrorSchema),
    parserErrors: z.array(ParserErrorSchema),
    compilerErrors: z.array(CompilerErrorSchema),
    semanticErrors: z.array(SemanticErrorSchema).optional(),
    semanticErrorCount: z.number().int().min(0).optional(),
    bytecode: z.unknown().nullable(),
    compilerSuccess: z.boolean(),
    durationMs: z.number(),
  })
  .passthrough();

const GoldenReportSchema = z
  .object({
    executed: z.boolean(),
    passed: z.boolean(),
    qualityScore: z.number().min(0).max(1),
    vmErrors: z.array(VmErrorSchema),
    outputDiff: z.string().nullable(),
    durationMs: z.number(),
  })
  .passthrough();

const ShadowHitSchema = z.object({
  rfc: z.enum(['RFC-002', 'RFC-003']),
  count: z.number(),
  correct: z.boolean(),
});

export const TraceEntrySchema = z.object({
  runId: z.string().uuid(),
  timestamp: z.string().datetime({ offset: true }),
  status: z.enum(['success', 'partial', 'repair_exhausted', 'error']),
  task: z.string().min(1),
  modelId: z.string().optional(),
  intent: OsnovaIntentSchema.optional(),
  spec: OsnovaSpecSchema.optional(),
  source: OsnovaSourceSchema.optional(),
  buildReport: BuildReportSchema.optional(),
  goldenReport: GoldenReportSchema.optional(),
  repairAttempts: z.number().int().min(0),
  semanticErrorCount: z.number().int().min(0).optional(),
  lastErrorKind: z.string().optional(),
  shadow_hits: z.array(ShadowHitSchema).optional(),
});

export type TraceEntryParsed = z.infer<typeof TraceEntrySchema>;

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
  semanticErrorCount?: number;
  lastErrorKind?: string;
  shadow_hits?: ShadowHit[];
}): Promise<void> {
  const entry: TraceEntry = {
    ...data,
    timestamp: new Date().toISOString(),
  };

  const r = TraceEntrySchema.safeParse(entry);
  if (!r.success) {
    console.warn('[traceStore] невалидная запись:', r.error.issues);
    return;
  }

  const tracePath = getTracePath();
  const dir = path.dirname(tracePath);

  try {
    await fs.access(dir);
  } catch {
    await fs.mkdir(dir, { recursive: true });
  }

  await fs.appendFile(tracePath, JSON.stringify(entry) + '\n', 'utf-8');
}
