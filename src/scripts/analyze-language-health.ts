#!/usr/bin/env tsx
// ============================================================
// src/scripts/analyze-language-health.ts
// Анализ health-метрик пайплайна по traces.jsonl
// Ключевая метрика: semantic_errors_in_success (стоп-сигнал = > 0)
// ============================================================

import * as fs from 'fs';
import * as path from 'path';

interface TraceRecord {
  runId?: string;
  status?: string;
  task?: string;
  modelId?: string;
  repairAttempts?: number;
  timestamp?: string;
  buildReport?: {
    success?: boolean;
    semanticErrors?: Array<{ kind?: string; message?: string }>;
    lexerErrors?: unknown[];
    parserErrors?: unknown[];
    compilerErrors?: unknown[];
  };
  goldenReport?: {
    qualityScore?: number;
    passed?: boolean;
  };
  source?: { source?: string };
  forbiddenPatterns?: string[]; // паттерны из repair-лога если есть
}

function loadTraces(tracePath: string): TraceRecord[] {
  if (!fs.existsSync(tracePath)) return [];
  return fs
    .readFileSync(tracePath, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as TraceRecord];
      } catch {
        return [];
      }
    });
}

export function computeHealthMetrics(
  traces: TraceRecord[],
  options: { lastN?: number; lastHours24?: boolean } = {},
): {
  total: number;
  byStatus: Record<string, number>;
  semantic_errors_in_success: number;
  avg_quality_score: number;
  avg_repair_attempts: number;
  build_success_rate: number;
  // S-1: топ паттерны обходных решений
  top_workaround_patterns: Array<{ pattern: string; count: number }>;
  // T-8: teachability score
  teachability_score: number; // доля задач решённых с первой попытки (repairAttempts=0) среди success
  // S-7: поддержка window-режима передаётся снаружи через параметр, не внутри метрики
} {
  let windowedTraces = traces;
  if (options.lastHours24) {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    windowedTraces = traces.filter((t) => {
      const ts = t.timestamp ? new Date(t.timestamp).getTime() : 0;
      return ts >= cutoff;
    });
  } else if (options.lastN && options.lastN > 0) {
    windowedTraces = traces.slice(-options.lastN);
  }

  const byStatus: Record<string, number> = {};
  let semanticErrorsInSuccess = 0;
  let qualitySum = 0;
  let qualityCount = 0;
  let repairSum = 0;
  let buildSuccessCount = 0;

  for (const t of windowedTraces) {
    const status = t.status ?? 'unknown';
    byStatus[status] = (byStatus[status] ?? 0) + 1;

    // Стоп-сигнал: success + семантические ошибки одновременно
    if (status === 'success' && (t.buildReport?.semanticErrors?.length ?? 0) > 0) {
      semanticErrorsInSuccess++;
    }

    if (typeof t.goldenReport?.qualityScore === 'number') {
      qualitySum += t.goldenReport.qualityScore;
      qualityCount++;
    }

    repairSum += t.repairAttempts ?? 0;

    if (t.buildReport?.success === true) buildSuccessCount++;
  }

  // S-1: top_workaround_patterns
  // Паттерны обходных решений которые ищем в source:
  // - catchVar: переменная-флаг для имитации try/catch (if err != null)
  // - sentinel: использование пусто/null как сигнального значения вместо ошибки
  // - flag_loop: флаговые циклы (пусть найдено = ложь ... найдено = истина)
  const workaroundCounts: Record<string, number> = {
    catchVar: 0,
    sentinel: 0,
    flag_loop: 0,
  };
  for (const t of windowedTraces) {
    const src = (t as TraceRecord).source?.source ?? '';
    // catchVar: объявление переменной с именем содержащим "ошибк" или "err" вне попробовать
    // (\w не покрывает кириллицу — используем \S и явные классы)
    if (/пусть\s+\S*(ошибк|err|error)\S*\s*=/i.test(src) && !/попробовать/.test(src)) {
      workaroundCounts.catchVar++;
    }
    // sentinel: сравнение с пусто в условии (x == пусто или x != пусто)
    if (/[!=]=\s*пусто/.test(src)) {
      workaroundCounts.sentinel++;
    }
    // flag_loop: флаговый цикл — объявление булевого флага + пока + присваивание флага в теле
    if (/пусть\s+\S+\s*=\s*(ложь|истина)/.test(src) && /пока/.test(src)) {
      workaroundCounts.flag_loop++;
    }
  }
  const top_workaround_patterns = Object.entries(workaroundCounts)
    .map(([pattern, count]) => ({ pattern, count }))
    .sort((a, b) => b.count - a.count);

  // T-8: teachability_score
  const successTraces = windowedTraces.filter((t) => t.status === 'success');
  const firstAttemptSuccess = successTraces.filter((t) => (t.repairAttempts ?? 0) === 0).length;
  const teachability_score =
    successTraces.length > 0 ? firstAttemptSuccess / successTraces.length : 0;

  return {
    total: windowedTraces.length,
    byStatus,
    semantic_errors_in_success: semanticErrorsInSuccess,
    avg_quality_score: qualityCount > 0 ? qualitySum / qualityCount : 0,
    avg_repair_attempts: windowedTraces.length > 0 ? repairSum / windowedTraces.length : 0,
    build_success_rate: windowedTraces.length > 0 ? buildSuccessCount / windowedTraces.length : 0,
    top_workaround_patterns,
    teachability_score,
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const tracePath = path.resolve(
    args.includes('--input') ? (args[args.indexOf('--input') + 1] ?? 'runs/traces.jsonl') : 'runs/traces.jsonl',
  );

  const traces = loadTraces(tracePath);

  if (traces.length === 0) {
    if (jsonMode) {
      console.log(JSON.stringify({ total: 0, semantic_errors_in_success: 0 }));
    } else {
      console.log('traces.jsonl пуст или не найден — метрик нет.');
    }
    process.exit(0);
  }

  const m = computeHealthMetrics(traces);

  if (jsonMode) {
    console.log(JSON.stringify(m, null, 2));
    // Выход 1 если стоп-сигнал
    if (m.semantic_errors_in_success > 0) process.exit(1);
    return;
  }

  console.log('\n═══ LANGUAGE HEALTH REPORT ═══');
  console.log(`Трейсов всего:              ${m.total}`);
  console.log('');
  console.log('По статусу:');
  for (const [s, n] of Object.entries(m.byStatus)) {
    const pct = ((n / m.total) * 100).toFixed(1);
    console.log(`  ${s.padEnd(20)} ${n} (${pct}%)`);
  }
  console.log('');
  console.log(`Avg quality score:          ${m.avg_quality_score.toFixed(3)}`);
  console.log(`Avg repair attempts:        ${m.avg_repair_attempts.toFixed(2)}`);
  console.log(`Build success rate:         ${(m.build_success_rate * 100).toFixed(1)}%`);
  console.log('');
  console.log('Teachability (решено с 1-й попытки):');
  console.log(`  teachability_score:       ${(m.teachability_score * 100).toFixed(1)}%`);
  console.log('');
  console.log('Top workaround patterns:');
  for (const wp of m.top_workaround_patterns) {
    console.log(`  ${wp.pattern.padEnd(20)} ${wp.count}`);
  }

  // Стоп-сигнал
  const stopSignal = m.semantic_errors_in_success > 0;
  const icon = stopSignal ? '🚨 СТОП-СИГНАЛ' : '✅ OK';
  console.log('');
  console.log(`semantic_errors_in_success: ${m.semantic_errors_in_success}  ${icon}`);

  if (stopSignal) {
    console.log('');
    console.log('ВНИМАНИЕ: есть трейсы status=success с semantic errors в buildReport.');
    console.log('Это нарушение конституции roadmap. Доложить PM.');
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
