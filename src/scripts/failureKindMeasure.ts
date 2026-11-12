// ============================================================
// src/scripts/failureKindMeasure.ts
//
// Замер классификатора отказов ДО и ПОСЛЕ правки.
//
// «Было» — прежнее поведение: причина искалась только в BuildReport
// (`classifyBuildFailure` воспроизводит его точно, включая 'unknown').
// «Стало» — `classifyFailure` с goldenReport.
//
// Зачем не по файлу repair-failures.jsonl: из 695 его записей с traces.jsonl
// связаны только 19 — у остальных 676 соответствующих трейсов в файле нет,
// и переклассифицировать их нечем. Поэтому A/B считается на популяции, которая
// эти записи порождает: трейсы со статусом repair_exhausted.
//
// runs/*.jsonl — ТОЛЬКО ЧТЕНИЕ.
//
// Запуск: npx tsx src/scripts/failureKindMeasure.ts
// ============================================================
import * as fs from 'fs';
import * as path from 'path';
import { classifyBuildFailure, classifyFailure } from '../pipeline/failureKind';
import type { BuildReport, GoldenReport } from '../pipeline/types';
import { assertNoEscapedFixtures, splitFixtures, taskCounts } from '../lib/fixtureTasks';

const TRACES = path.resolve('runs', 'traces.jsonl');
const REPAIR_FAILURES = path.resolve('runs', 'repair-failures.jsonl');

interface TraceRec {
  runId: string;
  status: string;
  task?: string;
  buildReport?: BuildReport;
  goldenReport?: GoldenReport;
  lastErrorKind?: string;
}

function readJsonl<T>(p: string): T[] {
  if (!fs.existsSync(p)) return [];
  const out: T[] = [];
  for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* битая строка */
    }
  }
  return out;
}

function tally(values: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return m;
}

function main() {
  const traces = readJsonl<TraceRec>(TRACES);

  // Сторож фильтра фикстур — на всём корпусе.
  assertNoEscapedFixtures(taskCounts(traces.map((t) => t.task ?? '')));

  const failed = traces.filter((t) => t.status === 'repair_exhausted');
  const { real, fixtures } = splitFixtures(failed, (t) => t.task ?? '');

  const before = real.map((t) => classifyBuildFailure(t.buildReport));
  const after = real.map((t) => classifyFailure(t.buildReport, t.goldenReport));

  const unknownBefore = before.filter((k) => k === 'unknown').length;
  const unknownAfter = after.filter((k) => k === 'unknown').length;

  // Файл repair-failures: сколько записей вообще поддаётся переклассификации.
  const rf = readJsonl<{ traceId: string; last_error_kind?: string }>(REPAIR_FAILURES);
  const ids = new Set(traces.map((t) => t.runId));
  const linked = rf.filter((r) => ids.has(r.traceId));
  const unknownStored = rf.filter((r) => (r.last_error_kind ?? 'unknown') === 'unknown').length;

  const md: string[] = [];
  md.push('# Замер классификатора отказов');
  md.push('');
  md.push(`Трейсов: ${traces.length}. Со статусом \`repair_exhausted\`: ${failed.length} (реальных ${real.length}, фикстур ${fixtures.length}).`);
  md.push('');
  md.push('## A/B на реальных отказах');
  md.push('');
  md.push(`| | unknown | доля от ${real.length} |`);
  md.push('|---|---:|---:|');
  md.push(`| было (только BuildReport) | ${unknownBefore} | ${((100 * unknownBefore) / (real.length || 1)).toFixed(1)} % |`);
  md.push(`| стало (+ goldenReport) | **${unknownAfter}** | ${((100 * unknownAfter) / (real.length || 1)).toFixed(1)} % |`);
  md.push('');
  md.push('### Распределение причин после правки');
  md.push('');
  md.push('| kind | раз |');
  md.push('|---|---:|');
  for (const [k, v] of [...tally(after)].sort((a, b) => b[1] - a[1])) {
    md.push(`| \`${k}\` | ${v} |`);
  }
  md.push('');
  md.push('### Распределение причин до правки');
  md.push('');
  md.push('| kind | раз |');
  md.push('|---|---:|');
  for (const [k, v] of [...tally(before)].sort((a, b) => b[1] - a[1])) {
    md.push(`| \`${k}\` | ${v} |`);
  }
  md.push('');
  md.push('## Файл `runs/repair-failures.jsonl`');
  md.push('');
  md.push(`Записей: ${rf.length}. Из них \`unknown\`: ${unknownStored}.`);
  md.push(`Связано с traces.jsonl по traceId: **${linked.length}** из ${rf.length}.`);
  if (linked.length > 0) {
    const linkedBefore = linked.map((r) => (r.last_error_kind ?? 'unknown') === 'unknown').length;
    md.push('');
    md.push('| на связанных записях | unknown |');
    md.push('|---|---:|');
    md.push(`| как записано в файле | ${linkedBefore} |`);
    md.push(
      `| по новому классификатору | ${linked.filter((r) => { const t = traces.find((x) => x.runId === r.traceId); return classifyFailure(t?.buildReport, t?.goldenReport) === 'unknown'; }).length} |`,
    );
  }
  md.push('');
  md.push(`> Остальные ${rf.length - linked.length} записей переклассифицировать нечем: их трейсов в traces.jsonl нет. Файл только для чтения и не переписывается.`);

  const out = md.join('\n');
  fs.mkdirSync(path.resolve('.tmp'), { recursive: true });
  fs.writeFileSync(path.resolve('.tmp', 'failure-kind-measure.md'), out, 'utf-8');
  process.stdout.write('\n' + out + '\n');
}

main();
