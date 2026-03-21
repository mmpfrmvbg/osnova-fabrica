#!/usr/bin/env tsx
// src/scripts/patch-legacy-traces.ts
// Разовый патч: пометить трейсы с status=success + blocking semantic errors
// как legacy_gate_bug=true.
// Запускать ОДИН РАЗ локально: npm run patch-legacy-traces
// или: tsx src/scripts/patch-legacy-traces.ts

import * as fs from 'fs';
import * as path from 'path';
import { BLOCKING_SEMANTIC_KINDS } from '../compiler/semanticKinds';

const TRACE_PATH = path.resolve('runs', 'traces.jsonl');

function main(): void {
  if (!fs.existsSync(TRACE_PATH)) {
    console.log('traces.jsonl не найден — нечего патчить.');
    process.exit(0);
  }

  const lines = fs
    .readFileSync(TRACE_PATH, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0);

  const BLOCKING_KINDS = new Set<string>(BLOCKING_SEMANTIC_KINDS);
  let patchedCount = 0;
  let alreadyMarked = 0;

  const patched = lines.map((line) => {
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return line;
    }

    if (rec['legacy_gate_bug'] === true) {
      alreadyMarked++;
      return JSON.stringify(rec);
    }

    if (rec['status'] !== 'success') return JSON.stringify(rec);

    const buildReport = rec['buildReport'] as
      | { semanticErrors?: Array<{ kind?: string }> }
      | undefined;
    const semErrors = buildReport?.semanticErrors ?? [];
    const hasBlocking = semErrors.some((e) => e.kind && BLOCKING_KINDS.has(e.kind));

    if (hasBlocking) {
      rec['legacy_gate_bug'] = true;
      patchedCount++;
    }

    return JSON.stringify(rec);
  });

  fs.writeFileSync(TRACE_PATH, patched.join('\n') + '\n', 'utf-8');

  console.log(`Всего строк:       ${lines.length}`);
  console.log(`Уже помечено:      ${alreadyMarked}`);
  console.log(`Помечено сейчас:   ${patchedCount}`);
  console.log(`Ожидалось ~37.     ${patchedCount === 37 ? '✅' : '⚠️ проверь'}`);
  console.log('Готово: runs/traces.jsonl обновлён.');
}

if (require.main === module) {
  main();
}
