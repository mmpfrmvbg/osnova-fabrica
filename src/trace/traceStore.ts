// ============================================================
// src/trace/traceStore.ts — Запись трейсов в JSONL
// Путь: OSNOVA_TRACE_DB (default: ./runs/traces.jsonl)
// ============================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import { z } from 'zod';
import type { DiagnosticRecord, TraceEntry } from './types';
import type {
  OsnovaIntent,
  OsnovaSpec,
  OsnovaSource,
  BuildReport,
  GoldenReport,
  PipelineTracePersistedStatus,
} from '../pipeline/types';
import type { ShadowHit } from '../pipeline/shadowMode';
import { DIAGNOSTIC_KINDS } from '../compiler/diagnosticCatalogue';
import type { DiagnosticPhase, DiagnosticSeverity } from '../compiler/diagnosticCatalogue';
import { isDiagnosticCodeShape } from './diagnosticsProjection';

/**
 * Перечни фаз и уровней. Написаны здесь, но **сверены каталогом** аннотацией
 * типа: переименование фазы в `src/compiler/diagnosticCatalogue.ts` сломает
 * сборку здесь, а не разъедется молча (`diagnosticsProjection.test.ts`).
 *
 * `вызов` — отказ **до** компиляции (коды `CLI_CODES`, `OSN-CLI-001/002`). Без
 * него запись с этой фазой отклонялась бы схемой молча — ровно тот класс дефекта,
 * что и «схема уже каталога» (K2, 2026-09-28).
 */
const DIAGNOSTIC_PHASES: readonly [DiagnosticPhase, ...DiagnosticPhase[]] = [
  'лексер',
  'парсер',
  'семантика',
  'сборка',
  'вызов',
  'исполнение',
];
const DIAGNOSTIC_SEVERITIES: readonly [DiagnosticSeverity, ...DiagnosticSeverity[]] = [
  'ошибка',
  'предупреждение',
];


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

/**
 * Виды семантических ошибок для схемы журнала — **все виды каталога (15)**, а не
 * только отнесённые к блокирующим и неблокирующим спискам (9).
 *
 * **Повод (замер проверяющего 2026-09-28).** Здесь стоял `z.enum` из
 * `ALL_SEMANTIC_KINDS` — 9 видов. Запись, в `buildReport.semanticErrors` которой
 * был любой из шести «неотнесённых» видов (`arg_count_mismatch`,
 * `chained_compare`, `keyword_param`, `sentinel_pattern`, `unknown_module`,
 * `export_collision`), не проходила `safeParse`, `saveTrace` писал
 * `console.warn` и **возвращался молча** — прогон исчезал из журнала целиком, без
 * кода возврата и без счётчика. Проверяющий измерил: `sentinel_pattern`,
 * `unknown_module`, `arg_count_mismatch` оставляли число строк журнала неизменным
 * (1 → 1).
 *
 * Перечень берётся **из каталога**, а не копируется: каталог — источник правды о
 * видах (`src/compiler/diagnosticCatalogue.ts`), и «отнесённость к спискам» —
 * вопрос маршрутизации пайплайна, а не права вида попасть в журнал. Списки
 * блокирующих/неблокирующих при этом не трогаются: поведение `DiagnosticAgent` и
 * `RepairEngineer` этой правкой не меняется.
 */
const CATALOGUE_SEMANTIC_KINDS = DIAGNOSTIC_KINDS.map((k) => k.kind) as [string, ...string[]];
const SemanticErrorKindSchema = z.enum(CATALOGUE_SEMANTIC_KINDS);

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

/**
 * Диагностика прогона (код + фаза + уровень) — см. `DiagnosticRecord` в
 * `./types.ts` и проекцию в `./diagnosticsProjection.ts`.
 *
 * **Решение про коды вне каталога (явное, закреплено тестом).** Схема проверяет
 * **форму** кода (`OSN-<ФАЗА>-<НОМЕР>`), а не принадлежность каталогу:
 * - мусор в `code` (`«семантика»`, `OSN-SEM-1`) записью не становится — схема
 *   отклоняет, `saveTrace` предупреждает и не пишет;
 * - код правильной формы, которого нет в каталоге, **принимается и помечается**:
 *   коды выдаются один раз и не переиспользуются, поэтому запись, написанная
 *   более новым кодом, обязана читаться старым. Молча «известным» такой код не
 *   считается — `summarizeDiagnostics` называет его в `unknownCodes`.
 */
const DiagnosticRecordSchema = z
  .object({
    code: z
      .string()
      .refine(isDiagnosticCodeShape, { message: 'код должен иметь форму OSN-<ФАЗА>-<НОМЕР>' }),
    phase: z.enum(DIAGNOSTIC_PHASES),
    severity: z.enum(DIAGNOSTIC_SEVERITIES),
    message: z.string().min(1),
    kind: z.string().optional(),
    file: z.string().optional(),
    line: z.number().int().optional(),
    column: z.number().int().optional(),
  })
  .passthrough();

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
  /** Опциональное поле: записи без него (весь журнал до 2026-09-28) читаются как раньше. */
  diagnostics: z.array(DiagnosticRecordSchema).optional(),
  shadow_hits: z.array(ShadowHitSchema).optional(),
});

export type TraceEntryParsed = z.infer<typeof TraceEntrySchema>;

function getTracePath(): string {
  const db = process.env.OSNOVA_TRACE_DB ?? './runs/traces.jsonl';
  return path.resolve(db);
}

/**
 * Почему запись не прошла схему — одной строкой: путь поля и сообщение. Тот же
 * формат читает отчёт по журналу (`src/scripts/diagnosticsJournalReport.ts`),
 * поэтому причина отказа у записи и у замера выглядит одинаково.
 */
export function traceIssueReason(
  issues: readonly { path: PropertyKey[]; message: string }[],
): string {
  const first = issues[0];
  if (first === undefined) return 'неизвестная причина';
  const where = first.path.map(String).join('.');
  return where === '' ? first.message : `${where}: ${first.message}`;
}

/** Итог записи в журнал: сохранено или нет и почему. Отказ не имеет права молчать. */
export interface SaveTraceResult {
  saved: boolean;
  /** Причина отказа — заполнена только при `saved: false`. */
  reason?: string;
}

export async function saveTrace(data: {
  runId: string;
  status: PipelineTracePersistedStatus;
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
  /** Диагностика прогона: собирается `projectEntryDiagnostics` (`./diagnosticsProjection`). */
  diagnostics?: DiagnosticRecord[];
  shadow_hits?: ShadowHit[];
}): Promise<SaveTraceResult> {
  const entry: TraceEntry = {
    ...data,
    timestamp: new Date().toISOString(),
  };

  const r = TraceEntrySchema.safeParse(entry);
  if (!r.success) {
    const reason = traceIssueReason(r.error.issues);
    // Два канала, потому что адресаты разные: человек читает лог, машина —
    // возвращённый результат. Молчащая потеря записи недопустима так же, как
    // молчащий отказ компилятора.
    console.warn('[traceStore] невалидная запись:', reason, r.error.issues);
    return { saved: false, reason };
  }

  const tracePath = getTracePath();
  const dir = path.dirname(tracePath);

  try {
    await fs.access(dir);
  } catch {
    await fs.mkdir(dir, { recursive: true });
  }

  // Ошибка ввода-вывода остаётся исключением: её нельзя выдать за «невалидную
  // запись», и вызывающий обязан увидеть её как сбой, а не как отказ схемы.
  await fs.appendFile(tracePath, JSON.stringify(entry) + '\n', 'utf-8');
  return { saved: true };
}
