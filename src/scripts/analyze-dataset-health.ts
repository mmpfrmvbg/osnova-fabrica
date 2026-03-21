#!/usr/bin/env tsx
// ============================================================
// src/scripts/analyze-dataset-health.ts — T-5
// Анализ баланса few-shot по категориям в датасете трейсов.
// Предупреждение если категория < 10% от общего числа success-трейсов.
// ============================================================

import * as fs from 'fs';
import * as path from 'path';

interface TraceRecord {
  status?: string;
  category?: string;
  task?: string;
  repairAttempts?: number;
  goldenReport?: { qualityScore?: number };
}

export interface CategoryStats {
  category: string;
  count: number;
  pct: number;
  underrepresented: boolean; // true если pct < MIN_PCT
}

export interface DatasetHealthReport {
  total_success: number;
  categories: CategoryStats[];
  underrepresented: CategoryStats[];
  warnings: string[];
}

const MIN_PCT = 10; // порог недопредставленности

/**
 * Определить категорию из поля category трейса или по task (heuristic).
 */
export function inferCategory(record: TraceRecord): string {
  if (record.category) return record.category;
  const task = (record.task ?? '').toLowerCase();
  if (/массив|список|перебор/.test(task)) return 'arrays';
  if (/строк|текст/.test(task)) return 'strings';
  if (/хранилищ|сохран|записать/.test(task)) return 'storage';
  if (/ошибк|попробовать|catch/.test(task)) return 'errors';
  if (/объект|структур|запись/.test(task)) return 'objects';
  if (/файл/.test(task)) return 'files';
  if (/сеть|запрос|http/.test(task)) return 'network';
  if (/процедур|функц|вызов/.test(task)) return 'procedures';
  return 'generic';
}

export function analyzeDatasetHealth(traces: TraceRecord[]): DatasetHealthReport {
  const successTraces = traces.filter(t => t.status === 'success');
  const total = successTraces.length;
  if (total === 0) {
    return { total_success: 0, categories: [], underrepresented: [], warnings: ['Нет success-трейсов'] };
  }

  const counts: Record<string, number> = {};
  for (const t of successTraces) {
    const cat = inferCategory(t);
    counts[cat] = (counts[cat] ?? 0) + 1;
  }

  const categories: CategoryStats[] = Object.entries(counts)
    .map(([category, count]) => ({
      category,
      count,
      pct: (count / total) * 100,
      underrepresented: (count / total) * 100 < MIN_PCT,
    }))
    .sort((a, b) => b.count - a.count);

  const underrepresented = categories.filter(c => c.underrepresented);
  const warnings: string[] = underrepresented.map(
    c => `⚠️  Категория "${c.category}" недопредставлена: ${c.count} трейсов (${c.pct.toFixed(1)}% < ${MIN_PCT}%)`,
  );

  return { total_success: total, categories, underrepresented, warnings };
}

function main(): void {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const tracePath = path.resolve(
    args.includes('--input')
      ? (args[args.indexOf('--input') + 1] ?? 'runs/traces.jsonl')
      : 'runs/traces.jsonl',
  );

  if (!fs.existsSync(tracePath)) {
    console.log('traces.jsonl не найден');
    process.exit(0);
  }

  const lines = fs.readFileSync(tracePath, 'utf-8').split('\n').filter(l => l.trim());
  const traces = lines.flatMap(l => {
    try {
      return [JSON.parse(l) as TraceRecord];
    } catch {
      return [];
    }
  });
  const report = analyzeDatasetHealth(traces);

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('\n═══ DATASET HEALTH REPORT ═══');
  console.log(`Success трейсов: ${report.total_success}`);
  console.log('');
  console.log('Распределение по категориям:');
  for (const c of report.categories) {
    const flag = c.underrepresented ? ' ⚠️' : '';
    console.log(`  ${c.category.padEnd(16)} ${c.count.toString().padStart(5)} (${c.pct.toFixed(1)}%)${flag}`);
  }
  if (report.warnings.length > 0) {
    console.log('');
    console.log('Предупреждения:');
    for (const w of report.warnings) console.log(' ', w);
  } else {
    console.log('');
    console.log('✅ Все категории в норме (>= 10%)');
  }
}

const isMain =
  typeof process !== 'undefined' &&
  Boolean(process.argv[1]?.replace(/\\/g, '/').includes('analyze-dataset-health'));
if (isMain) main();
