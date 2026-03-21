// src/tools/health-metrics-extended.ts
// Расширение computeHealthMetrics: RFC rates + shadow rates.
// Не импортируется компилятором, только health-pipeline.

import * as fs from 'fs';
import * as path from 'path';
import { computeHealthMetrics, loadTraces } from '../scripts/analyze-language-health';

export { computeHealthMetrics, loadTraces };

// ── Типы ──────────────────────────────────────────────────

interface ShadowAggregate {
  rfc: string;
  totalTraces: number;
  correctTraces: number;
  correctRate: number;
  readyForPhaseB: boolean;
}

interface ShadowReport {
  ts: string;
  total_traces: number;
  aggregates: ShadowAggregate[];
}

export interface ExtendedHealthMetrics extends ReturnType<typeof computeHealthMetrics> {
  sentinel_rate: number | null;
  invented_syntax_rate: number | null;
  shadow_rfc002_correct_rate: number | null;
  shadow_rfc003_correct_rate: number | null;
}

// ── Чтение shadow-report.jsonl ─────────────────────────────
// Файл содержит одну или несколько строк JSON.
// Берём последнюю (самую свежую).

function loadShadowReport(shadowPath = path.resolve('runs', 'shadow-report.jsonl')): ShadowReport | null {
  if (!fs.existsSync(shadowPath)) return null;
  const lines = fs
    .readFileSync(shadowPath, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;
  try {
    return JSON.parse(lines[lines.length - 1]!) as ShadowReport;
  } catch {
    return null;
  }
}

// ── Главная функция ────────────────────────────────────────

export function computeExtendedHealthMetrics(
  tracesPath = path.resolve('runs', 'traces.jsonl'),
  shadowPath = path.resolve('runs', 'shadow-report.jsonl'),
  since?: Date,
): ExtendedHealthMetrics {
  const traces = loadTraces(tracesPath);
  const base = computeHealthMetrics(traces, since);

  // sentinel_rate = трейсы с sentinel workaround среди success
  const sentinelCount =
    base.top_workaround_patterns.find((p) => p.pattern === 'sentinel')?.count ?? 0;
  const successCount = base.byStatus['success'] ?? 0;
  const sentinel_rate = successCount > 0 ? sentinelCount / successCount : null;

  const allTraces = loadTraces(tracesPath);
  const windowedTraces = since
    ? allTraces.filter(
        (t) => Boolean(t.timestamp) && new Date(t.timestamp as string) >= since,
      )
    : allTraces;
  const inventedCount = windowedTraces.filter(
    (t) =>
      Array.isArray((t as { forbiddenPatterns?: string[] }).forbiddenPatterns) &&
      ((t as { forbiddenPatterns?: string[] }).forbiddenPatterns?.length ?? 0) > 0,
  ).length;
  const invented_syntax_rate = base.total > 0 ? inventedCount / base.total : null;

  const shadow = loadShadowReport(shadowPath);
  let shadow_rfc002_correct_rate: number | null = null;
  let shadow_rfc003_correct_rate: number | null = null;
  if (shadow) {
    const r002 = shadow.aggregates.find((a) => a.rfc === 'RFC-002');
    const r003 = shadow.aggregates.find((a) => a.rfc === 'RFC-003');
    if (r002) shadow_rfc002_correct_rate = r002.correctRate;
    if (r003) shadow_rfc003_correct_rate = r003.correctRate;
  }

  return {
    ...base,
    sentinel_rate,
    invented_syntax_rate,
    shadow_rfc002_correct_rate,
    shadow_rfc003_correct_rate,
  };
}

// ── CLI (для npm run analyze-health-extended) ──────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  let since: Date | undefined;
  if (args.includes('--since')) {
    const i = args.indexOf('--since');
    const raw = args[i + 1];
    if (raw) {
      const d = new Date(raw);
      if (!Number.isNaN(d.getTime())) since = d;
    }
  }

  const metrics = computeExtendedHealthMetrics(
    path.resolve('runs', 'traces.jsonl'),
    path.resolve('runs', 'shadow-report.jsonl'),
    since,
  );

  if (jsonMode) {
    const payload = since ? { ...metrics, since: since.toISOString() } : metrics;
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(JSON.stringify(metrics, null, 2));
  }
}
