#!/usr/bin/env ts-node
// ============================================================
// src/scripts/export-dataset.ts — Export traces to HuggingFace SFT format
// Reads traces.jsonl, filters success records, outputs dataset-v1.jsonl
// ============================================================

import * as fs from 'fs';
import * as path from 'path';

/** Запись из traces.jsonl. Поля соответствуют TraceEntry (src/trace/types.ts). */
export interface TraceRecord {
  runId?: string;
  status?: string;
  task?: string;
  modelId?: string;
  repairAttempts?: number;
  spec?: {
    mainModule?: string;
    procedures?: Array<{ name?: string }>;
    syscalls?: string[];
  };
  source?: { source?: string };
  /** success = compilerSuccess && нет ошибок лексера/парсера. Для дообучения — только success. */
  buildReport?: {
    success?: boolean;
    compilerSuccess?: boolean;
    semanticErrors?: Array<{ kind?: string; message?: string }>;
  };
  goldenReport?: { qualityScore?: number };
  intent?: {
    description?: string;
    appType?: string;
    features?: string[];
  };
}

export interface DatasetExample {
  input_text: string;
  target_text: string;
  meta?: {
    runId?: string;
    traceId?: string; // алиас runId для SFT-пайплайна
    status?: string;
    repairAttempts?: number;
    qualityScore?: number;
    modelId?: string;
    semanticErrorCount?: number; // кол-во семантических ошибок в buildReport
    category?: string; // категория из intent (appType или первый feature)
  };
}

/**
 * Определяет категорию задачи из intent.
 * Приоритет: appType → первый feature → 'unknown'
 */
function deriveCategory(rec: TraceRecord): string {
  if (rec.intent?.appType) return rec.intent.appType;
  const firstFeature = rec.intent?.features?.[0];
  if (firstFeature) return firstFeature;
  return 'unknown';
}

/**
 * Чистая функция: фильтрует и преобразует записи в обучающие примеры.
 * Без IO — тестируема без файловой системы.
 * Фильтр: status=success, buildReport.success=true (без ошибок лексера/парсера), source.source не пустой.
 */
export function filterAndTransform(
  records: TraceRecord[],
  minQuality = 0,
  minRepairs = -1,
): DatasetExample[] {
  const examples: DatasetExample[] = [];
  for (const rec of records) {
    if (rec.status !== 'success') continue;
    const src = rec.source?.source?.trim();
    if (!src || src.length === 0) continue;
    // success = полная успешность билда (compilerSuccess + нет lexer/parser errors)
    if (rec.buildReport?.success !== true) continue;
    const quality = rec.goldenReport?.qualityScore ?? 0;
    if (quality < minQuality) continue;
    if (minRepairs >= 0 && (rec.repairAttempts ?? 0) < minRepairs) continue;
    examples.push({
      input_text: buildInputText(rec),
      target_text: src,
      meta: {
        runId: rec.runId,
        traceId: rec.runId,
        status: rec.status,
        repairAttempts: rec.repairAttempts,
        qualityScore: rec.goldenReport?.qualityScore,
        modelId: rec.modelId,
        semanticErrorCount: rec.buildReport?.semanticErrors?.length ?? 0,
        category: deriveCategory(rec),
      },
    });
  }
  return examples;
}

function parseArgs(): { input: string; output: string; minQuality: number; minRepairs: number } {
  const args = process.argv.slice(2);
  let input = 'runs/traces.jsonl';
  let output = 'runs/dataset-v1.jsonl';
  let minQuality = 0;
  let minRepairs = -1;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1]) {
      input = args[++i]!;
    } else if (args[i] === '--output' && args[i + 1]) {
      output = args[++i]!;
    } else if (args[i] === '--min-quality' && args[i + 1]) {
      minQuality = parseFloat(args[++i]!) || 0;
    } else if (args[i] === '--min-repairs' && args[i + 1]) {
      minRepairs = parseInt(args[++i]!, 10);
    }
  }

  return { input, output, minQuality, minRepairs };
}

function buildInputText(record: TraceRecord): string {
  const task = record.task ?? '(нет задачи)';
  const spec = record.spec ?? {};
  const intent = record.intent;
  const mainModule = spec.mainModule ?? '?';
  const procedures = (spec.procedures ?? []).map((p) => p.name ?? '?').join(', ') || '(нет)';
  const syscalls = (spec.syscalls ?? []).join(', ') || '(нет)';

  const lines = [
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

function main(): void {
  const { input, output, minQuality, minRepairs } = parseArgs();
  const inputPath = path.resolve(input);
  const outputPath = path.resolve(output);

  const content = fs.readFileSync(inputPath, 'utf-8');
  const lines = content.split('\n').filter((line) => line.trim().length > 0);

  const records: TraceRecord[] = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line) as TraceRecord);
    } catch {
      /* skip invalid JSON */
    }
  }

  const examples = filterAndTransform(records, minQuality, minRepairs);
  const skippedNotSuccess = records.filter((r) => r.status !== 'success').length;
  const totalTargetLen = examples.reduce((s, ex) => s + ex.target_text.length, 0);
  const avgTargetLen = examples.length > 0 ? Math.round(totalTargetLen / examples.length) : 0;

  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const outStream = fs.createWriteStream(outputPath, { encoding: 'utf-8' });
  for (const ex of examples) {
    outStream.write(JSON.stringify(ex) + '\n');
  }
  outStream.end();

  console.log(`Прочитано записей:      ${records.length}`);
  console.log(`Прошло фильтр:          ${examples.length}`);
  console.log(`Пропущено (не success): ${skippedNotSuccess}`);
  console.log(`Мин. repair-попыток:     ${minRepairs >= 0 ? minRepairs : 'нет фильтра'}`);
  console.log(`Записано в dataset:     ${examples.length}`);
  console.log(`Средняя длина target:   ${avgTargetLen} символов`);
  console.log(`Файл: ${outputPath}`);
}

if (require.main === module) {
  main();
}
