/**
 * ОТЧЁТ ПО ДИАГНОСТИКЕ ЖИВОГО ЖУРНАЛА — «стал ли журнал читаемым».
 *
 * **Повод.** Дыра измерялась однажды руками: `semanticErrors` в 43 записях из
 * 4605 (`docs/trace-failure-report.md:17`), события VM не попадали в журнал вовсе.
 * Чтобы это перестало быть анекдотом, нужен воспроизводимый замер одной командой.
 *
 * **Что делает.** Читает `runs/traces.jsonl` (или `OSNOVA_TRACE_DB`) **только на
 * чтение** и печатает:
 * - сколько строк всего, сколько не разобралось (битый JSON / отклонено схемой) с
 *   причинами отказа — отчёт не падает на битой строке;
 * - сколько записей несут диагностику **полем** (`diagnostics`, новые записи) и
 *   сколько — **проекцией** из `buildReport`/`goldenReport` (записи, написанные
 *   до появления поля: их диагностика уже была в журнале, но лежала неисчисляемой);
 * - топ кодов с долями, разбивку по фазам, коды вне каталога
 *   (`unknownDiagnosticCodes`) и число записей вообще без диагностики.
 *
 * **Чего отчёт не делает.** Не пишет в журнал ни строки, не печатает текст
 * исходника, задачи и значений переменных окружения — только коды, фазы и числа.
 * У записей, отклонённых схемой, диагностика не считается, но потеря называется
 * числом (`rejectedProjectedDiagnostics`), а не умалчивается.
 *
 * Запуск: `npx tsx src/scripts/diagnosticsJournalReport.ts [путь к журналу]`
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { TraceEntrySchema, traceIssueReason } from '../trace/traceStore';
import {
  projectEntryDiagnostics,
  summarizeDiagnostics,
  type BuildReportLike,
  type DiagnosticSummary,
  type GoldenReportLike,
} from '../trace/diagnosticsProjection';
import type { DiagnosticRecord } from '../trace/types';
import { runtimeCodeInfo } from '../runtime/runtimeCodes';

/** Сколько записей в топе кодов и топе причин отказа. */
const TOP = 5;

/** Причина отказа схемы и сколько раз она встретилась. */
export interface RejectionReason {
  reason: string;
  count: number;
}

/** Замер журнала. Все числа — из файла, ничего не выдумано. */
export interface JournalSummary {
  /** Непустых строк в журнале. */
  lines: number;
  /** Строк, которые не являются JSON. */
  jsonBroken: number;
  /** Строк-JSON, отклонённых схемой записи (`TraceEntrySchema`). */
  schemaRejected: number;
  /** Строк, разобранных схемой. */
  parsed: number;
  /** Причины отказов схемы, по убыванию частоты. */
  rejectionReasons: RejectionReason[];
  /** Разобранные записи, в которых поле `diagnostics` есть (в том числе пустое). */
  withField: number;
  /** Из них — с непустым списком: такие записи диагностику несут полем. */
  withFieldNonEmpty: number;
  /** Разобранные записи без поля, у которых диагностика восстановлена проекцией. */
  projected: number;
  /** Разобранные записи без диагностики вообще. */
  withoutDiagnostics: number;
  /** Сводка по всем диагностикам разобранных записей (поле + проекция). */
  diagnostics: DiagnosticSummary;
  /** Диагностик пришло полем. */
  fromField: number;
  /** Диагностик восстановлено проекцией из отчётов. */
  fromProjection: number;
  /** Сколько диагностик дала бы проекция у записей, отклонённых схемой, — названная потеря. */
  rejectedProjectedDiagnostics: number;
  /** Записей с диагностикой по статусам (успех/частичный/…) — «где живут отказы». */
  diagnosticsByStatus: Array<{ status: string; records: number; diagnostics: number }>;
}

/** Путь журнала: аргумент → `OSNOVA_TRACE_DB` → `./runs/traces.jsonl` (как у записи). */
export function resolveJournalPath(arg?: string): string {
  if (arg !== undefined && arg !== '') return path.resolve(arg);
  const db = process.env.OSNOVA_TRACE_DB ?? './runs/traces.jsonl';
  return path.resolve(db);
}

/**
 * Замер по тексту журнала. Чистая функция: файл читает `main`, а не она, —
 * поэтому тест подставляет свой журнал и не зависит от живого.
 */
export function summarizeJournal(text: string): JournalSummary {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const reasons = new Map<string, number>();
  const all: DiagnosticRecord[] = [];
  const byStatus = new Map<string, { records: number; diagnostics: number }>();

  let jsonBroken = 0;
  let schemaRejected = 0;
  let parsed = 0;
  let withField = 0;
  let withFieldNonEmpty = 0;
  let projected = 0;
  let withoutDiagnostics = 0;
  let fromField = 0;
  let fromProjection = 0;
  let rejectedProjectedDiagnostics = 0;

  for (const line of lines) {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      jsonBroken += 1;
      continue;
    }

    const r = TraceEntrySchema.safeParse(raw);
    if (!r.success) {
      schemaRejected += 1;
      const reason = traceIssueReason(r.error.issues);
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      // Запись журналу не поддаётся, но потеря называется: сколько диагностики
      // лежало бы в ней, если бы схема её приняла.
      const rawObj = raw as {
        buildReport?: BuildReportLike;
        goldenReport?: GoldenReportLike;
      };
      rejectedProjectedDiagnostics += projectEntryDiagnostics({
        buildReport: rawObj.buildReport,
        goldenReport: rawObj.goldenReport,
      }).length;
      continue;
    }

    parsed += 1;
    const entry = r.data;
    const field = Array.isArray(entry.diagnostics) ? entry.diagnostics : [];
    const useField = field.length > 0;
    const records: DiagnosticRecord[] = useField
      ? field
      : projectEntryDiagnostics({
          buildReport: entry.buildReport,
          goldenReport: entry.goldenReport,
        });

    if (Array.isArray(entry.diagnostics)) {
      withField += 1;
      if (useField) withFieldNonEmpty += 1;
    }

    if (useField) {
      fromField += records.length;
    } else if (records.length > 0) {
      projected += 1;
      fromProjection += records.length;
    } else {
      withoutDiagnostics += 1;
    }

    const status = String(entry.status);
    const slot = byStatus.get(status) ?? { records: 0, diagnostics: 0 };
    slot.records += 1;
    slot.diagnostics += records.length;
    byStatus.set(status, slot);

    all.push(...records);
  }

  return {
    lines: lines.length,
    jsonBroken,
    schemaRejected,
    parsed,
    rejectionReasons: [...reasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    withField,
    withFieldNonEmpty,
    projected,
    withoutDiagnostics,
    diagnostics: summarizeDiagnostics(all),
    fromField,
    fromProjection,
    rejectedProjectedDiagnostics,
    diagnosticsByStatus: [...byStatus.entries()]
      .map(([status, v]) => ({ status, ...v }))
      .sort((a, b) => b.records - a.records || a.status.localeCompare(b.status)),
  };
}

const share = (part: number, whole: number): string =>
  whole === 0 ? '0.0 %' : `${((part / whole) * 100).toFixed(1)} %`;

/** Текст отчёта. Без текста исходника, без задачи, без переменных окружения. */
export function formatJournalSummary(s: JournalSummary, journalPath: string): string {
  const out: string[] = [];
  out.push(`[diagnostics-journal] ${journalPath}`);
  out.push(
    `строк: ${s.lines} | битый JSON: ${s.jsonBroken} | отклонено схемой: ${s.schemaRejected} | разобрано: ${s.parsed}`,
  );

  if (s.rejectionReasons.length > 0) {
    out.push(`причины отказа схемы (топ-${TOP}):`);
    for (const r of s.rejectionReasons.slice(0, TOP)) {
      out.push(`  ${String(r.count).padStart(5)}  ${r.reason}`);
    }
    if (s.rejectedProjectedDiagnostics > 0) {
      out.push(
        `  в отклонённых записях лежало бы ещё диагностик: ${s.rejectedProjectedDiagnostics}`,
      );
    }
  }

  out.push(
    `записи: поле diagnostics есть: ${s.withField} (непустых ${s.withFieldNonEmpty}) | проекция из отчётов: ${s.projected} | без диагностики: ${s.withoutDiagnostics} (${share(s.withoutDiagnostics, s.parsed)})`,
  );
  const d = s.diagnostics;
  out.push(
    `диагностик: ${d.total} (ошибок ${d.errors}, предупреждений ${d.warnings}) | полем ${s.fromField} | проекцией ${s.fromProjection}`,
  );

  if (d.byPhase.length > 0) {
    out.push(
      `фазы: ${d.byPhase.map((p) => `${p.phase} ${p.count} (${share(p.count, d.total)})`).join(' | ')}`,
    );
  }

  if (d.byCode.length === 0) {
    out.push('кодов нет: ни одна разобранная запись не назвала причину');
  } else {
    out.push(`топ-${TOP} кодов:`);
    d.byCode.slice(0, TOP).forEach((c, i) => {
      // Метка не косметика: «вне каталога» — код новее каталога либо дефект,
      // «внутренний» — сигнал о дефекте VM или о разрыве канала (OSN-RT-000).
      const mark = !c.known
        ? '  [вне каталога]'
        : runtimeCodeInfo(c.code)?.internal === true
          ? '  [внутренний: дефект VM или разрыв канала]'
          : '';
      out.push(
        `  ${i + 1}. ${c.code.padEnd(12)} ${String(c.count).padStart(5)}  ${share(c.count, d.total).padStart(7)}  ${c.phases.join(', ')}${mark}`,
      );
    });
    if (d.unknownCodes.length > 0) {
      out.push(`коды вне каталога: ${d.unknownCodes.join(', ')}`);
    }
  }

  if (s.diagnosticsByStatus.length > 0) {
    out.push('по статусам записи/диагностики:');
    for (const st of s.diagnosticsByStatus) {
      out.push(`  ${st.status.padEnd(18)} ${String(st.records).padStart(5)} / ${st.diagnostics}`);
    }
  }

  return out.join('\n');
}

function main(): void {
  const journalPath = resolveJournalPath(process.argv[2]);
  if (!fs.existsSync(journalPath)) {
    console.error(`[diagnostics-journal] нет журнала: ${journalPath}`);
    process.exit(1);
  }
  // Только чтение: журнал живой, в него дописывают прогоны других сессий.
  const text = fs.readFileSync(journalPath, 'utf8');
  console.log(formatJournalSummary(summarizeJournal(text), journalPath));
}

if (require.main === module) {
  main();
}
