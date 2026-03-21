#!/usr/bin/env npx tsx
// ============================================================
// src/tools/dataset-stats.ts — статистика по JSONL export-dataset-v2
// ============================================================

import * as fs from 'fs';
import * as path from 'path';

export interface DatasetV2Row {
  prompt: string;
  completion: string;
  meta: {
    traceId: string;
    category: string;
    healthScore: number;
    repairAttempts: number;
  };
}

export function loadDataset(filePath: string): DatasetV2Row[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  const out: DatasetV2Row[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as DatasetV2Row);
    } catch {
      /* skip invalid JSON */
    }
  }
  return out;
}

export interface DatasetStats {
  total: number;
  by_category: Record<string, number>;
  avg_health_score: number;
  avg_repair_attempts: number;
  min_health_score: number;
  max_health_score: number;
  warnings: string[];
}

export function computeStats(records: DatasetV2Row[]): DatasetStats {
  const total = records.length;
  const by_category: Record<string, number> = {};
  let sumHealth = 0;
  let sumRepairs = 0;
  let minH = Number.POSITIVE_INFINITY;
  let maxH = Number.NEGATIVE_INFINITY;

  for (const r of records) {
    const cat = r.meta?.category ?? 'unknown';
    by_category[cat] = (by_category[cat] ?? 0) + 1;
    const h = r.meta?.healthScore ?? 0;
    const rep = r.meta?.repairAttempts ?? 0;
    sumHealth += h;
    sumRepairs += rep;
    if (h < minH) minH = h;
    if (h > maxH) maxH = h;
  }

  const avg_health_score = total > 0 ? sumHealth / total : 0;
  const avg_repair_attempts = total > 0 ? sumRepairs / total : 0;
  const min_health_score = total > 0 && Number.isFinite(minH) ? minH : 0;
  const max_health_score = total > 0 && Number.isFinite(maxH) ? maxH : 0;

  const warnings: string[] = [];
  if (total < 200) {
    warnings.push(`⚠️  total записей ${total} < 200 — датасет мал для fine-tune`);
  }

  if (total > 0) {
    for (const [cat, count] of Object.entries(by_category)) {
      const pct = (count / total) * 100;
      if (pct < 10) {
        warnings.push(`⚠️  категория '${cat}' = ${pct.toFixed(1)}% < 10% — недопредставлена`);
      }
    }
  }

  return {
    total,
    by_category,
    avg_health_score,
    avg_repair_attempts,
    min_health_score,
    max_health_score,
    warnings,
  };
}

export function printStats(stats: DatasetStats): void {
  console.log('═══ Dataset stats (export-dataset-v2) ═══');
  console.log(`Всего записей:     ${stats.total}`);
  console.log(`Средний health:    ${stats.avg_health_score.toFixed(4)}`);
  console.log(`Средний repairs:   ${stats.avg_repair_attempts.toFixed(4)}`);
  console.log(`Min health:        ${stats.min_health_score.toFixed(4)}`);
  console.log(`Max health:        ${stats.max_health_score.toFixed(4)}`);
  console.log('По категориям:');
  for (const [k, v] of Object.entries(stats.by_category).sort((a, b) => b[1] - a[1])) {
    const pct = stats.total > 0 ? ((v / stats.total) * 100).toFixed(1) : '0.0';
    console.log(`  ${k}: ${v} (${pct}%)`);
  }
  if (stats.warnings.length > 0) {
    console.log('');
    for (const w of stats.warnings) {
      console.log(w);
    }
  }
}

function parseArgs(): { input: string } {
  const args = process.argv.slice(2);
  let input = 'runs/dataset-v2.jsonl';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1]) {
      input = args[++i]!;
    }
  }
  return { input: path.resolve(input) };
}

function main(): void {
  const { input } = parseArgs();
  if (!fs.existsSync(input)) {
    console.log(`[dataset-stats] файл не найден: ${input}`);
    process.exit(0);
  }

  const records = loadDataset(input);
  const stats = computeStats(records);
  printStats(stats);

  if (stats.warnings.length > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

if (require.main === module) {
  main();
}
