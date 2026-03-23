#!/usr/bin/env tsx
import * as fs from 'fs';
import * as path from 'path';
import type { PipelineStatus } from '../src/pipeline/types';

type CompatStatus = 'ok' | 'error';

interface PipelineCompletedLogEvent {
  ts: string;
  component: 'osiris_pipeline';
  event: 'pipeline_completed';
  status: CompatStatus;
  pipelineStatus: PipelineStatus;
  duration_ms?: number | null;
}

interface MetricsArgs {
  file: string;
  days?: number;
  from?: string;
  to?: string;
  json: boolean;
}

interface StatusCounts {
  success: number;
  partial: number;
  repair_exhausted: number;
  error: number;
}

interface MetricsReport {
  period: {
    file: string;
    from: string | null;
    to: string | null;
    days: number | null;
  };
  totalRuns: number;
  byStatus: StatusCounts;
  rates: StatusCounts;
  daily: Array<{ date: string } & StatusCounts>;
  duration: {
    count: number;
    min: number | null;
    avg: number | null;
    max: number | null;
  };
}

const EMPTY_COUNTS: StatusCounts = {
  success: 0,
  partial: 0,
  repair_exhausted: 0,
  error: 0,
};

function printHelp(): void {
  console.log(`Usage: npx tsx scripts/pipeline-metrics.ts [options]

Options:
  --file <path>           Log file path (default: ./osiris.out.log)
  --days <N>              Last N days (relative to now)
  --from <YYYY-MM-DD>     Start date (inclusive)
  --to <YYYY-MM-DD>       End date (inclusive)
  --json                  Print JSON report
  --help                  Show help
`);
}

export function parseArgs(argv: string[]): MetricsArgs {
  const args: MetricsArgs = {
    file: './osiris.out.log',
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--file' && argv[i + 1]) args.file = argv[++i]!;
    else if (arg === '--days' && argv[i + 1]) args.days = Number(argv[++i]!);
    else if (arg === '--from' && argv[i + 1]) args.from = argv[++i]!;
    else if (arg === '--to' && argv[i + 1]) args.to = argv[++i]!;
    else if (arg === '--json') args.json = true;
  }
  return args;
}

function toDateStartIso(date: string): string {
  return `${date}T00:00:00.000Z`;
}

function toDateEndIso(date: string): string {
  return `${date}T23:59:59.999Z`;
}

function matchesPeriod(ts: string, args: MetricsArgs): boolean {
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return false;

  if (typeof args.days === 'number' && Number.isFinite(args.days) && args.days >= 0) {
    const now = Date.now();
    const fromMs = now - args.days * 24 * 60 * 60 * 1000;
    if (ms < fromMs || ms > now) return false;
  }
  if (args.from) {
    const fromMs = Date.parse(toDateStartIso(args.from));
    if (Number.isFinite(fromMs) && ms < fromMs) return false;
  }
  if (args.to) {
    const toMs = Date.parse(toDateEndIso(args.to));
    if (Number.isFinite(toMs) && ms > toMs) return false;
  }
  return true;
}

export function parsePipelineEvents(lines: string[], args: MetricsArgs): PipelineCompletedLogEvent[] {
  const events: PipelineCompletedLogEvent[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;

    try {
      const obj = JSON.parse(trimmed) as Partial<PipelineCompletedLogEvent>;
      if (obj.component !== 'osiris_pipeline' || obj.event !== 'pipeline_completed') continue;
      if (!obj.ts || typeof obj.ts !== 'string' || !matchesPeriod(obj.ts, args)) continue;
      if (obj.status !== 'ok' && obj.status !== 'error') continue;
      if (
        obj.pipelineStatus !== 'success'
        && obj.pipelineStatus !== 'partial'
        && obj.pipelineStatus !== 'repair_exhausted'
        && obj.pipelineStatus !== 'error'
      ) {
        continue;
      }
      events.push(obj as PipelineCompletedLogEvent);
    } catch {
      // ignore invalid JSON or unrelated log lines
    }
  }
  return events;
}

export function aggregatePipelineMetrics(events: PipelineCompletedLogEvent[], args: MetricsArgs): MetricsReport {
  const byStatus: StatusCounts = { ...EMPTY_COUNTS };
  const dailyMap = new Map<string, StatusCounts>();
  const durations: number[] = [];

  for (const e of events) {
    byStatus[e.pipelineStatus] += 1;
    const day = e.ts.slice(0, 10);
    if (!dailyMap.has(day)) dailyMap.set(day, { ...EMPTY_COUNTS });
    dailyMap.get(day)![e.pipelineStatus] += 1;
    if (typeof e.duration_ms === 'number' && Number.isFinite(e.duration_ms) && e.duration_ms >= 0) {
      durations.push(e.duration_ms);
    }
  }

  const totalRuns = events.length;
  const toRate = (value: number): number => (totalRuns > 0 ? Number((value / totalRuns).toFixed(4)) : 0);
  const rates: StatusCounts = {
    success: toRate(byStatus.success),
    partial: toRate(byStatus.partial),
    repair_exhausted: toRate(byStatus.repair_exhausted),
    error: toRate(byStatus.error),
  };

  const daily = [...dailyMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, counts]) => ({ date, ...counts }));

  const duration =
    durations.length > 0
      ? {
        count: durations.length,
        min: Math.min(...durations),
        avg: Number((durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(2)),
        max: Math.max(...durations),
      }
      : { count: 0, min: null, avg: null, max: null };

  return {
    period: {
      file: args.file,
      from: args.from ?? null,
      to: args.to ?? null,
      days: typeof args.days === 'number' ? args.days : null,
    },
    totalRuns,
    byStatus,
    rates,
    daily,
    duration,
  };
}

function printTextReport(report: MetricsReport): void {
  console.log('=== Pipeline Metrics (local) ===');
  console.log(`file: ${report.period.file}`);
  if (report.period.days !== null) console.log(`period: last ${report.period.days} day(s)`);
  if (report.period.from || report.period.to) {
    console.log(`range: ${report.period.from ?? '-'} .. ${report.period.to ?? '-'}`);
  }
  console.log(`total runs: ${report.totalRuns}`);
  console.log('');
  console.log('status              count   rate');
  console.log('------------------  ------  ------');
  const rows: Array<[PipelineStatus, number, number]> = [
    ['success', report.byStatus.success, report.rates.success],
    ['partial', report.byStatus.partial, report.rates.partial],
    ['repair_exhausted', report.byStatus.repair_exhausted, report.rates.repair_exhausted],
    ['error', report.byStatus.error, report.rates.error],
  ];
  for (const [name, count, rate] of rows) {
    console.log(`${name.padEnd(18)}  ${String(count).padStart(6)}  ${(rate * 100).toFixed(2)}%`);
  }
  console.log('');
  console.log('daily breakdown');
  console.log('date         success  partial  repair_exhausted  error');
  console.log('----------   -------  -------  ----------------  -----');
  for (const d of report.daily) {
    console.log(
      `${d.date}   ${String(d.success).padStart(7)}  ${String(d.partial).padStart(7)}  ${String(
        d.repair_exhausted,
      ).padStart(16)}  ${String(d.error).padStart(5)}`,
    );
  }
  console.log('');
  if (report.duration.count > 0) {
    console.log(
      `duration_ms: count=${report.duration.count} min=${report.duration.min} avg=${report.duration.avg} max=${report.duration.max}`,
    );
  } else {
    console.log('duration_ms: no data');
  }
}

export function runPipelineMetrics(lines: string[], args: MetricsArgs): MetricsReport {
  const events = parsePipelineEvents(lines, args);
  return aggregatePipelineMetrics(events, args);
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  const args = parseArgs(argv);
  const filePath = path.resolve(args.file);
  if (!fs.existsSync(filePath)) {
    console.error(`[pipeline-metrics] log file not found: ${filePath}`);
    process.exit(1);
  }

  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  const report = runPipelineMetrics(lines, { ...args, file: filePath });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  printTextReport(report);
}

if (require.main === module) {
  main();
}
