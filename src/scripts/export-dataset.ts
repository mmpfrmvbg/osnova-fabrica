#!/usr/bin/env ts-node
// ============================================================
// src/scripts/export-dataset.ts — Export traces to HuggingFace SFT format
// Reads traces.jsonl, filters success records, outputs dataset-v1.jsonl
// ============================================================

import * as fs from 'fs';
import * as path from 'path';

interface TraceRecord {
  runId?: string;
  status?: string;
  task?: string;
  spec?: {
    mainModule?: string;
    procedures?: Array<{ name?: string }>;
    syscalls?: string[];
  };
  source?: { source?: string };
  buildReport?: { compilerSuccess?: boolean };
  goldenReport?: { qualityScore?: number };
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

  let passedFilter = 0;
  let skippedNotSuccess = 0;
  const examples: Array<{ input_text: string; target_text: string }> = [];
  let totalTargetLen = 0;

  for (const line of lines) {
    let rec: TraceRecord;
    try {
      rec = JSON.parse(line) as TraceRecord;
    } catch {
      continue;
    }

    if (rec.status !== 'success') {
      skippedNotSuccess++;
      continue;
    }

    const src = rec.source?.source?.trim();
    if (!src || src.length === 0) {
      continue;
    }

    const compilerOk = rec.buildReport?.compilerSuccess === true;
    if (!compilerOk) {
      continue;
    }

    const quality = rec.goldenReport?.qualityScore ?? 0;
    if (quality < minQuality) {
      continue;
    }

    passedFilter++;
    const input_text = buildInputText(rec);
    const target_text = src;
    examples.push({ input_text, target_text });
    totalTargetLen += target_text.length;
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

  const avgTargetLen = examples.length > 0 ? Math.round(totalTargetLen / examples.length) : 0;

  console.log(`Прочитано записей:      ${lines.length}`);
  console.log(`Прошло фильтр:          ${passedFilter}`);
  console.log(`Пропущено (не success): ${skippedNotSuccess}`);
  console.log(`Записано в dataset:     ${examples.length}`);
  console.log(`Средняя длина target:   ${avgTargetLen} символов`);
  console.log(`Файл: ${outputPath}`);
}

main();
