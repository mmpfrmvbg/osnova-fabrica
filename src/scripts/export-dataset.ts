#!/usr/bin/env ts-node
// ============================================================
// src/scripts/export-dataset.ts — Export traces to HuggingFace SFT format
// Reads traces.jsonl, filters success records, outputs dataset-v1.jsonl
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'node:url';

/** Запись из traces.jsonl. Поля соответствуют TraceEntry (src/trace/types.ts). */
export interface TraceRecord {
  runId?: string;
  status?: string;
  task?: string;
  spec?: {
    mainModule?: string;
    procedures?: Array<{ name?: string }>;
    syscalls?: string[];
  };
  source?: { source?: string };
  /** success = compilerSuccess && нет ошибок лексера/парсера. Для дообучения — только success. */
  buildReport?: { success?: boolean; compilerSuccess?: boolean };
  goldenReport?: { qualityScore?: number };
}

export interface DatasetExample {
  input_text: string;
  target_text: string;
}

/**
 * Чистая функция: фильтрует и преобразует записи в обучающие примеры.
 * Без IO — тестируема без файловой системы.
 * Фильтр: status=success, buildReport.success=true (без ошибок лексера/парсера), source.source не пустой.
 */
export function filterAndTransform(
  records: TraceRecord[],
  minQuality = 0,
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
    examples.push({
      input_text: buildInputText(rec),
      target_text: src,
    });
  }
  return examples;
}

function parseArgs(): { input: string; output: string; minQuality: number } {
  const args = process.argv.slice(2);
  let input = 'runs/traces.jsonl';
  let output = 'runs/dataset-v1.jsonl';
  let minQuality = 0;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1]) {
      input = args[++i]!;
    } else if (args[i] === '--output' && args[i + 1]) {
      output = args[++i]!;
    } else if (args[i] === '--min-quality' && args[i + 1]) {
      minQuality = parseFloat(args[++i]!) || 0;
    }
  }

  return { input, output, minQuality };
}

function buildInputText(record: TraceRecord): string {
  const task = record.task ?? '(нет задачи)';
  const spec = record.spec ?? {};
  const mainModule = spec.mainModule ?? '?';
  const procedures = (spec.procedures ?? []).map((p) => p.name ?? '?').join(', ') || '(нет)';
  const syscalls = (spec.syscalls ?? []).join(', ') || '(нет)';

  return [
    'Сгенерируй код на языке Основа для следующей задачи.',
    '',
    `Задача: ${task}`,
    '',
    'Спецификация:',
    `- Главный модуль: ${mainModule}`,
    `- Процедуры: ${procedures}`,
    `- Syscalls: ${syscalls}`,
    '',
    'Верни ТОЛЬКО код модуля, без объяснений.',
  ].join('\n');
}

function main(): void {
  const { input, output, minQuality } = parseArgs();
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

  const examples = filterAndTransform(records, minQuality);
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
  console.log(`Записано в dataset:     ${examples.length}`);
  console.log(`Средняя длина target:   ${avgTargetLen} символов`);
  console.log(`Файл: ${outputPath}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
