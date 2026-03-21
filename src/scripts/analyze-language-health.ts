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

export function computeHealthMetrics(traces: TraceRecord[]): {
  total: number;
  byStatus: Record<string, number>;
  semantic_errors_in_success: number;
  avg_quality_score: number;
  avg_repair_attempts: number;
  build_success_rate: number;
} {
  const byStatus: Record<string, number> = {};
  let semanticErrorsInSuccess = 0;
  let qualitySum = 0;
  let qualityCount = 0;
  let repairSum = 0;
  let buildSuccessCount = 0;

  for (const t of traces) {
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

  return {
    total: traces.length,
    byStatus,
    semantic_errors_in_success: semanticErrorsInSuccess,
    avg_quality_score: qualityCount > 0 ? qualitySum / qualityCount : 0,
    avg_repair_attempts: traces.length > 0 ? repairSum / traces.length : 0,
    build_success_rate: traces.length > 0 ? buildSuccessCount / traces.length : 0,
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

  // Стоп-сигнал
  const stopSignal = m.semantic_errors_in_success > 0;
  const icon = stopSignal ? '🚨 СТОП-СИГНАЛ' : '✅ OK';
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
