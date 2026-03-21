#!/usr/bin/env tsx
// ============================================================
// src/scripts/beta-gate.ts — Beta-Gate checker
// Проверяет все пороги перед выпуском beta.
// Exit 0 = ✅ BETA-GATE PASSED, Exit 1 = ❌ BETA-GATE FAILED
// ============================================================

import * as path from 'path';
import { computeExtendedHealthMetrics } from '../tools/health-metrics-extended';

interface GateCheck {
  metric: string;
  value: number | null;
  threshold: number;
  mode: '>=' | '<=';
  mustBeZero?: boolean;
}

function fmt(v: number | null): string {
  if (v === null) return 'N/A';
  return (v * 100).toFixed(1) + '%';
}

function fmtRaw(v: number | null): string {
  if (v === null) return 'N/A';
  return String(v);
}

function check(c: GateCheck): boolean {
  if (c.value === null) return false;
  if (c.mustBeZero) return c.value === 0;
  if (c.mode === '>=') return c.value >= c.threshold;
  if (c.mode === '<=') return c.value <= c.threshold;
  return false;
}

function main(): void {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');

  const metrics = computeExtendedHealthMetrics(
    path.resolve('runs', 'traces.jsonl'),
    path.resolve('runs', 'shadow-report.jsonl'),
  );

  const checks: GateCheck[] = [
    {
      metric: 'teachability_score',
      value: metrics.teachability_score,
      threshold: 0.8,
      mode: '>=',
    },
    {
      metric: 'build_success_rate',
      value: metrics.build_success_rate,
      threshold: 0.9,
      mode: '>=',
    },
    {
      metric: 'sentinel_rate',
      value: metrics.sentinel_rate,
      threshold: 0.1,
      mode: '<=',
    },
    {
      metric: 'invented_syntax_rate',
      value: metrics.invented_syntax_rate,
      threshold: 0.01,
      mode: '<=',
    },
    {
      metric: 'semantic_errors_in_success',
      value: metrics.semantic_errors_in_success,
      threshold: 0,
      mode: '<=',
      mustBeZero: true,
    },
    {
      metric: 'shadow_rfc002_correct_rate',
      value: metrics.shadow_rfc002_correct_rate,
      threshold: 0.8,
      mode: '>=',
    },
    {
      metric: 'shadow_rfc003_correct_rate',
      value: metrics.shadow_rfc003_correct_rate,
      threshold: 0.95,
      mode: '>=',
    },
  ];

  const results = checks.map((c) => ({
    ...c,
    passed: check(c),
  }));

  if (jsonMode) {
    console.log(JSON.stringify({ results, passed: results.every((r) => r.passed) }, null, 2));
    process.exit(results.every((r) => r.passed) ? 0 : 1);
    return;
  }

  const COL_METRIC = 36;
  const COL_VALUE = 10;
  const COL_THRESHOLD = 10;

  console.log('\n╔══ BETA-GATE ═══════════════════════════════════════════╗');
  console.log(
    '║ ' +
      'Метрика'.padEnd(COL_METRIC) +
      'Значение'.padEnd(COL_VALUE) +
      'Порог'.padEnd(COL_THRESHOLD) +
      ' ║',
  );
  console.log('╠' + '═'.repeat(62) + '╣');

  for (const r of results) {
    const icon = r.passed ? '🟢' : '🔴';
    const isCount = r.mustBeZero === true;
    const valueStr = isCount ? fmtRaw(r.value) : fmt(r.value);
    const thresholdStr = isCount
      ? '= 0'
      : (r.mode === '>=' ? '>= ' : '<= ') + fmt(r.threshold);
    console.log(
      '║ ' +
        (icon + ' ' + r.metric).padEnd(COL_METRIC + 2) +
        valueStr.padEnd(COL_VALUE) +
        thresholdStr.padEnd(COL_THRESHOLD) +
        ' ║',
    );
  }

  console.log('╚' + '═'.repeat(62) + '╝');
  console.log('');

  const allPassed = results.every((r) => r.passed);
  if (allPassed) {
    console.log('✅ BETA-GATE PASSED');
    process.exit(0);
  } else {
    const failed = results.filter((r) => !r.passed).map((r) => r.metric);
    console.log(`❌ BETA-GATE FAILED: ${failed.join(', ')}`);
    process.exit(1);
  }
}

main();
