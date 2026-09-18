// ============================================================
// src/scripts/traceFailureReport.ts
//
// Отчёт по реальным трейсам: где именно падают прогоны и чем это лечится.
//
// Два предупреждения о методе, оба важны:
//
// 1. Корпус разделён на ФИКСТУРЫ и РЕАЛЬНЫЕ задачи. Без этого разделения数字
//    вводят в заблуждение: подавляющая часть трейсов — повторяющиеся
//    тестовые задачи, и все «error» и «partial» сидят именно в них.
//
// 2. Трейс почти не хранит диагностику (semanticErrors заполнены в 43 записях
//    из 4598), поэтому исходники из трейсов ПЕРЕКОМПИЛИРУЮТСЯ текущим
//    компилятором. Это «что сказал бы компилятор сегодня», а не «что он сказал
//    тогда»: дрейф версии компилятора возможен.
//
// Только чтение: файлы в runs/ не изменяются.
//
// Запуск: npx tsx src/scripts/traceFailureReport.ts
// ============================================================
import * as fs from 'fs';
import * as path from 'path';
import { compileSource } from '../compiler/compiler';
import { BLOCKING_SEMANTIC_KINDS } from '../compiler/semanticKinds';
import { assertNoEscapedFixtures, splitFixtures, taskCounts } from '../lib/fixtureTasks';

const TRACES = path.resolve('runs', 'traces.jsonl');
const REPAIR_FAILURES = path.resolve('runs', 'repair-failures.jsonl');
const LOOP_TRACES = path.resolve('runs', 'loop-traces.jsonl');

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

interface TraceRec {
  runId: string;
  timestamp?: string;
  status: string;
  task?: string;
  repairAttempts?: number;
  source?: { filename: string; source: string };
  goldenReport?: { passed?: boolean; executed?: boolean; qualityScore?: number; vmErrors?: unknown[] };
}

const BLOCKING = new Set<string>(BLOCKING_SEMANTIC_KINDS);

function bump(m: Record<string, number>, k: string): void {
  m[k] = (m[k] ?? 0) + 1;
}

function main() {
  const traces = readJsonl<TraceRec>(TRACES);

  // Фильтр фикстур — из общего модуля (список-данные + сторож), чтобы замер
  // языка нигде не считался по «посчитай сумму от 1 до 10».
  // История: локальная эвристика `/^тест\b/i` не срабатывала из-за ASCII-only
  // `\b` в JavaScript и раздула «реальные partial» с 6 до 117.
  assertNoEscapedFixtures(taskCounts(traces.map((t) => t.task ?? '')));
  const { fixtures, real } = splitFixtures(traces, (t) => t.task ?? '');
  const realUnique = new Set(real.map((t) => t.task)).size;

  const stAll: Record<string, number> = {};
  const stFix: Record<string, number> = {};
  const stReal: Record<string, number> = {};
  for (const t of traces) bump(stAll, t.status);
  for (const t of fixtures) bump(stFix, t.status);
  for (const t of real) bump(stReal, t.status);

  const realWithSource = real.filter((t) => t.source?.source);

  const crossTab: Record<string, Record<string, number>> = {};
  const kindsReal: Record<string, number> = {};
  const parserMsgs: Record<string, number> = {};
  const parserMsgLines: Record<string, string[]> = {};
  const lexerMsgs: Record<string, number> = {};
  const names: Record<string, number> = {};
  const inventedExamples: { task: string; kind: string; line: string; message: string }[] = [];
  const parserExamples: { task: string; msg: string; line: string }[] = [];
  let done = 0;

  for (const t of realWithSource) {
    const srcText = t.source!.source;
    const r = compileSource(srcText, { filename: t.source!.filename });
    const kinds = r.semanticErrors.map((e) => e.kind);
    const blocking = kinds.filter((k) => BLOCKING.has(k));
    let cls: string;
    if (r.lexerErrors.length > 0) cls = 'лексер';
    else if (r.parserErrors.length > 0) cls = 'парсер';
    else if (blocking.length > 0) cls = 'семантика: блокирующая';
    else if (r.compilerErrors.length > 0) cls = 'кодоген';
    else if (kinds.length > 0) cls = 'семантика: неблокирующая';
    else cls = 'собирается';

    crossTab[t.status] = crossTab[t.status] ?? {};
    bump(crossTab[t.status]!, cls);

    for (const e of r.parserErrors) {
      bump(parserMsgs, e.message.slice(0, 90));
      const line = e.line != null ? (srcText.split('\n')[e.line - 1] ?? '').trim() : '';
      const bucket = parserMsgLines[e.message] ?? (parserMsgLines[e.message] = []);
      if (bucket.length < 3 && line.length > 0 && !bucket.includes(line)) bucket.push(line.slice(0, 110));
      if (parserExamples.length < 8) {
        parserExamples.push({ task: (t.task ?? '').slice(0, 60), msg: e.message.slice(0, 90), line: line.slice(0, 80) });
      }
    }
    for (const e of r.lexerErrors) bump(lexerMsgs, e.message.slice(0, 90));

    for (const e of r.semanticErrors) {
      bump(kindsReal, e.kind);
      const m1 = /объявление '([^']+)'/.exec(e.message);
      if (m1) bump(names, `redeclare_var: ${m1[1]}`);
      const m2 = /Идентификатор '([^']+)'/.exec(e.message);
      if (m2) bump(names, `зарезервировано: ${m2[1]}`);
      if (e.kind === 'unknown_syscall') {
        const m3 = /'([^']*система\.[^']*)'/.exec(e.message);
        if (m3) bump(names, `unknown_syscall: ${m3[1]}`);
      }
      if (inventedExamples.length < 12 && (e.kind === 'invented_syntax' || e.kind === 'unknown_syscall')) {
        const lines = srcText.split('\n');
        let line = e.line != null ? (lines[e.line - 1] ?? '').trim() : '';
        if (line.length === 0) {
          const q = /'([^']+)'/.exec(e.message)?.[1];
          if (q) line = lines.find((l) => l.includes(q))?.trim() ?? '';
        }
        if (line.length > 0) {
          inventedExamples.push({
            task: (t.task ?? '').slice(0, 60),
            kind: e.kind,
            line: line.slice(0, 95),
            message: e.message.slice(0, 100),
          });
        }
      }
    }
    if (++done % 200 === 0) process.stderr.write(`[отчёт] ${done}/${realWithSource.length}\n`);
  }

  const rf = readJsonl<{ last_error_kind?: string }>(REPAIR_FAILURES);
  const rfKinds: Record<string, number> = {};
  for (const r of rf) bump(rfKinds, r.last_error_kind ?? '(нет)');

  const lt = readJsonl<{ errorKind?: string | null }>(LOOP_TRACES);
  const ltKinds: Record<string, number> = {};
  for (const r of lt) if (r.errorKind) bump(ltKinds, r.errorKind);

  const pct = (x: number, y: number) => `${((100 * x) / (y || 1)).toFixed(1)} %`;
  const table = (
    md: string[],
    head: [string, string],
    rows: [string, number][],
    total: number,
  ) => {
    md.push(`| ${head[0]} | ${head[1]} | доля |`);
    md.push('|---|---:|---:|');
    for (const [k, v] of rows) md.push(`| ${k} | ${v} | ${pct(v, total)} |`);
  };

  const md: string[] = [];
  md.push('# Отчёт по реальным трейсам');
  md.push('');
  md.push(`Трейсов всего: **${traces.length}**. Из них фикстуры: **${fixtures.length}** (${pct(fixtures.length, traces.length)}), реальные задачи: **${real.length}** (${pct(real.length, traces.length)}). Уникальных реальных задач: **${realUnique}**.`);
  md.push('');
  md.push('> **Фикстура** — задача, повторяющаяся десятками раз (`посчитай сумму от 1 до 10` — 2419 раз, `задача` — 737, `тест repair-цикла` — 216, `__test__partial__mock__` — 150). Такие прогоны проверяют пайплайн, а не язык.');
  md.push('');
  md.push('## 1. Статусы: фикстуры против реальных');
  md.push('');
  md.push('| статус | все | фикстуры | реальные |');
  md.push('|---|---:|---:|---:|');
  for (const k of Object.keys(stAll).sort((a, b) => stAll[b]! - stAll[a]!)) {
    md.push(`| ${k} | ${stAll[k]} | ${stFix[k] ?? 0} | ${stReal[k] ?? 0} |`);
  }
  md.push('');
  md.push('## 2. Перекомпиляция реальных исходников текущим компилятором');
  md.push('');
  md.push(`Исходников реальных задач: ${realWithSource.length}`);
  md.push('');
  md.push('| статус трейса | класс при перекомпиляции | прогонов |');
  md.push('|---|---|---:|');
  for (const [st, row] of Object.entries(crossTab)) {
    for (const [cls, n] of Object.entries(row).sort((a, b) => b[1] - a[1])) {
      md.push(`| ${st} | ${cls} | ${n} |`);
    }
  }
  md.push('');
  md.push('## 3. Виды семантических ошибок на реальных задачах');
  md.push('');
  if (Object.keys(kindsReal).length === 0) md.push('_нет_');
  else table(md, ['kind', 'раз'], Object.entries(kindsReal).sort((a, b) => b[1] - a[1]), realWithSource.length);
  md.push('');
  md.push('## 4. Ошибки парсера на реальных задачах (главный отказ сборки)');
  md.push('');
  if (Object.keys(parserMsgs).length === 0) md.push('_нет_');
  else table(md, ['сообщение', 'раз'], Object.entries(parserMsgs).sort((a, b) => b[1] - a[1]).slice(0, 15), realWithSource.length);
  md.push('');
  md.push('### Примеры');
  md.push('');
  md.push('| задача | сообщение | строка |');
  md.push('|---|---|---|');
  for (const p of parserExamples) {
    md.push(`| ${p.task} | ${p.msg.replace(/\|/g, '\\|')} | \`${p.line.replace(/\|/g, '\\|')}\` |`);
  }
  md.push('');
  md.push('### Что именно написала модель (по главным сообщениям)');
  md.push('');
  for (const [msg, n] of Object.entries(parserMsgs).sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    md.push(`**${msg}** — ${n} раз:`);
    md.push('');
    for (const l of parserMsgLines[msg] ?? []) md.push(`- \`${l.replace(/\|/g, '\\|')}\``);
    md.push('');
  }
  md.push('');
  md.push('## 5. Словарь выдумок на реальных задачах');
  md.push('');
  if (Object.keys(names).length === 0) md.push('_нет_');
  else table(md, ['имя', 'раз'], Object.entries(names).sort((a, b) => b[1] - a[1]).slice(0, 30), realWithSource.length);
  md.push('');
  md.push('### Выдумка и реальная строка кода');
  md.push('');
  md.push('| задача | kind | строка | диагностика |');
  md.push('|---|---|---|---|');
  for (const e of inventedExamples) {
    md.push(`| ${e.task} | ${e.kind} | \`${e.line.replace(/\|/g, '\\|')}\` | ${e.message.replace(/\|/g, '\\|')} |`);
  }
  md.push('');
  md.push('## 6. `repair-failures.jsonl` — чем классифицируется отказ');
  md.push('');
  md.push(`Записей: ${rf.length}`);
  md.push('');
  table(md, ['last_error_kind', 'раз'], Object.entries(rfKinds).sort((a, b) => b[1] - a[1]), rf.length);
  md.push('');
  md.push('## 7. `loop-traces.jsonl` — errorKind');
  md.push('');
  md.push(`Записей: ${lt.length}`);
  md.push('');
  if (Object.keys(ltKinds).length === 0) md.push('_errorKind не заполнен_');
  else table(md, ['errorKind', 'раз'], Object.entries(ltKinds).sort((a, b) => b[1] - a[1]), lt.length);

  const out = md.join('\n');
  fs.mkdirSync(path.resolve('.tmp'), { recursive: true });
  fs.writeFileSync(path.resolve('.tmp', 'trace-failure-report.md'), out, 'utf-8');
  process.stdout.write('\n' + out + '\n');
  process.stderr.write('[отчёт] записано: .tmp/trace-failure-report.md\n');
}

main();
