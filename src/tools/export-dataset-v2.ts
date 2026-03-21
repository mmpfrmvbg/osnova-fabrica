#!/usr/bin/env npx tsx
// ============================================================
// src/tools/export-dataset-v2.ts — Export traces → dataset v2 (quality filters)
// Формат: { prompt, completion, meta: { traceId, category, healthScore, repairAttempts } }
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import type { DatasetExample, TraceRecord } from '../scripts/export-dataset';

/** Поле `completion` в v2 соответствует `target_text` в DatasetExample (v1). */
export type DatasetV2CompletionField = DatasetExample['target_text'];

/** Поля трейса в JSONL (timestamp есть в TraceEntry, не в TraceRecord). */
type TraceRecordRead = TraceRecord & { timestamp?: string };

export interface DatasetV2Example {
  prompt: string;
  completion: string;
  meta: {
    traceId: string;
    category: string;
    healthScore: number;
    repairAttempts: number;
  };
}

export interface FilterV2Opts {
  minHealthScore?: number;
  maxRepairs?: number;
  since?: Date;
}

/** Дублирует логику deriveCategory из export-dataset.ts (там не экспортируется). */
function deriveCategory(rec: TraceRecord): string {
  if (rec.intent?.appType) return rec.intent.appType;
  const firstFeature = rec.intent?.features?.[0];
  if (firstFeature) return firstFeature;
  return 'unknown';
}

/** Образец buildInputText из v1 + префикс v2. */
function buildPromptV2(rec: TraceRecord): string {
  const task = rec.task ?? '(нет задачи)';
  const spec = rec.spec ?? {};
  const intent = rec.intent;
  const mainModule = spec.mainModule ?? '?';
  const procedures = (spec.procedures ?? []).map((p) => p.name ?? '?').join(', ') || '(нет)';
  const syscalls = (spec.syscalls ?? []).join(', ') || '(нет)';

  const lines = [
    '### Задача v2',
    '',
    'Сгенерируй код на языке Основа для следующей задачи.',
    '',
    `Задача: ${task}`,
  ];

  if (intent) {
    if (intent.description && intent.description !== task) {
      lines.push(`Описание: ${intent.description}`);
    }
    if (intent.appType) {
      lines.push(`Тип приложения: ${intent.appType}`);
    }
    if (intent.features && intent.features.length > 0) {
      lines.push(`Возможности: ${intent.features.join(', ')}`);
    }
  }

  lines.push(
    '',
    'Спецификация:',
    `- Главный модуль: ${mainModule}`,
    `- Процедуры: ${procedures}`,
    `- Syscalls: ${syscalls}`,
    '',
    'Верни ТОЛЬКО код модуля, без объяснений.',
  );

  return lines.join('\n');
}

function passesPreHealth(rec: TraceRecordRead, opts: FilterV2Opts): boolean {
  if (rec.status !== 'success') return false;
  if (rec.buildReport?.success !== true) return false;
  const src = rec.source?.source?.trim();
  if (!src || src.length === 0) return false;
  const maxRep = opts.maxRepairs ?? -1;
  if (maxRep >= 0 && (rec.repairAttempts ?? 0) > maxRep) return false;
  if (opts.since) {
    const t = rec.timestamp;
    if (!t) return false;
    if (new Date(t) < opts.since) return false;
  }
  return true;
}

export function filterV2(records: TraceRecordRead[], opts: FilterV2Opts = {}): DatasetV2Example[] {
  const minHealth = opts.minHealthScore ?? 0.75;
  const out: DatasetV2Example[] = [];

  for (const rec of records) {
    if (!passesPreHealth(rec, opts)) continue;
    const healthScore = rec.goldenReport?.qualityScore ?? 0;
    if (healthScore < minHealth) continue;

    const src = rec.source!.source!.trim();
    out.push({
      prompt: buildPromptV2(rec),
      completion: src,
      meta: {
        traceId: rec.runId ?? '',
        category: deriveCategory(rec),
        healthScore,
        repairAttempts: rec.repairAttempts ?? 0,
      },
    });
  }

  return out;
}

function parseArgs(): {
  input: string;
  output: string;
  minHealth: number;
  maxRepairs: number;
  since?: Date;
  help: boolean;
} {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    return {
      input: '',
      output: '',
      minHealth: 0.75,
      maxRepairs: -1,
      help: true,
    };
  }

  let input = 'runs/traces.jsonl';
  let output = 'runs/dataset-v2.jsonl';
  let minHealth = 0.75;
  let maxRepairs = -1;
  let since: Date | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1]) {
      input = args[++i]!;
    } else if (args[i] === '--output' && args[i + 1]) {
      output = args[++i]!;
    } else if (args[i] === '--min-health' && args[i + 1]) {
      minHealth = Number.parseFloat(args[++i]!) || 0.75;
    } else if (args[i] === '--max-repairs' && args[i + 1]) {
      maxRepairs = Number.parseInt(args[++i]!, 10);
      if (!Number.isFinite(maxRepairs)) maxRepairs = -1;
    } else if (args[i] === '--since' && args[i + 1]) {
      const d = new Date(args[++i]!);
      if (!Number.isNaN(d.getTime())) since = d;
    }
  }

  return { input, output, minHealth, maxRepairs, since, help: false };
}

function printUsage(): void {
  console.log(`usage: export-dataset-v2 [--input PATH] [--output PATH]
       [--min-health N] [--max-repairs N] [--since ISO_DATE]
  defaults: input=runs/traces.jsonl output=runs/dataset-v2.jsonl min-health=0.75 max-repairs=-1`);
}

function main(): void {
  const parsed = parseArgs();
  if (parsed.help) {
    printUsage();
    return;
  }

  const { input, output, minHealth, maxRepairs, since } = parsed;
  const inputPath = path.resolve(input);
  const outputPath = path.resolve(output);

  const content = fs.readFileSync(inputPath, 'utf-8');
  const lines = content.split('\n').filter((line) => line.trim().length > 0);

  const records: TraceRecordRead[] = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line) as TraceRecordRead);
    } catch {
      /* skip invalid JSON */
    }
  }

  const opts: FilterV2Opts = {
    minHealthScore: minHealth,
    maxRepairs,
    since,
  };

  const minH = minHealth;
  const skippedNotSuccess = records.filter((r) => r.status !== 'success').length;
  const skippedHealth = records.filter((r) => {
    if (!passesPreHealth(r, opts)) return false;
    return (r.goldenReport?.qualityScore ?? 0) < minH;
  }).length;

  const examples = filterV2(records, opts);

  const byCategory: Record<string, number> = {};
  for (const ex of examples) {
    const c = ex.meta.category;
    byCategory[c] = (byCategory[c] ?? 0) + 1;
  }

  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const outStream = fs.createWriteStream(outputPath, { encoding: 'utf-8' });
  for (const ex of examples) {
    outStream.write(JSON.stringify(ex) + '\n');
  }
  outStream.end();

  console.log(`Прочитано: ${records.length}`);
  console.log(`Прошло фильтр: ${examples.length}`);
  console.log(`Пропущено (не success): ${skippedNotSuccess}`);
  console.log(`Пропущено (healthScore < ${minH}): ${skippedHealth}`);
  console.log(`По категориям: ${JSON.stringify(byCategory)}`);
  console.log(`Записано в: ${outputPath}`);
}

if (require.main === module) {
  main();
}
