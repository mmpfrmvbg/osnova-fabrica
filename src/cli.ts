#!/usr/bin/env ts-node
// ============================================================
// src/cli.ts — Единая точка входа osnova-fabrica
// Субкоманды: --task, compile, run, schedule
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { runPipeline } from './pipeline/orchestrator';
import { validateEnv } from './env';
import { compileSource } from './compiler/compiler';
import { printParseError } from './compiler/parser';
import { run as runRuntime } from './runtime/run';

const args = process.argv.slice(2);

function printUsage(): void {
  console.error('Использование:');
  console.error('  osnova --task "описание задачи"     Генерация через LLM');
  console.error('  osnova compile file.osnova [-o out]  Компиляция .osnova → .osvbc');
  console.error('  osnova run --manifest path           Запуск приложения по манифесту');
  console.error('  osnova schedule file.osvbc.json      VLIW-планирование (линейный код)');
}

async function runTaskMode(task: string): Promise<void> {
  await validateEnv();
  console.log(`\n[osnova-fabrica] Задача: ${task}\n`);
  const result = await runPipeline(task);
  console.log('\n─── Результат ───');
  console.log('Статус:         ', result.status);
  console.log('Файл:           ', result.source?.filename ?? '—');
  console.log('Repair попыток: ', result.repairAttempts);
  console.log('Время:          ', result.totalDurationMs, 'ms');
  if (result.status === 'success') {
    console.log('Golden:          passed');
  } else if (result.status === 'partial') {
    console.log(`Quality score:   ${result.goldenReport?.qualityScore?.toFixed(2)}`);
  } else if (result.error) {
    console.error('Ошибка:         ', result.error);
  }
  if (result.buildReport) {
    const br = result.buildReport;
    if (br.lexerErrors?.length) {
      console.error('\n─── Lexer errors ───');
      for (const e of br.lexerErrors) {
        console.error(`  ${e.line}:${e.column} ${e.message}`);
      }
    }
    if (br.parserErrors?.length) {
      console.error('\n─── Parser errors ───');
      for (const e of br.parserErrors) {
        console.error(`  ${e.message ?? JSON.stringify(e)}`);
      }
    }
    if (br.compilerErrors?.length) {
      console.error('\n─── Compiler errors ───');
      for (const e of br.compilerErrors) {
        console.error(`  ${(e as { message?: string }).message ?? JSON.stringify(e)}`);
      }
    }
  }
  if (result.status === 'repair_exhausted' && result.source) {
    console.log('\n─── Последний сгенерированный код ───');
    console.log(result.source.source);
  } else if (result.source) {
    console.log('\n─── Сгенерированный .osnova ───');
    console.log(result.source.source);
  }
  process.exit(result.status === 'failure' ? 1 : 0);
}

function runCompileMode(cliArgs: string[]): number {
  let input: string | null = null;
  let output: string | null = null;
  for (let i = 0; i < cliArgs.length; i++) {
    if (cliArgs[i] === '-o' || cliArgs[i] === '--output') {
      output = cliArgs[++i] ?? null;
    } else if (!cliArgs[i].startsWith('-')) {
      input = cliArgs[i];
    }
  }
  if (!input) {
    console.error('Использование: osnova compile input.osnova [-o output.osvbc.json]');
    return 1;
  }
  const inputPath = path.resolve(input);
  if (!fs.existsSync(inputPath)) {
    console.error('Файл не найден:', inputPath);
    return 1;
  }
  const source = fs.readFileSync(inputPath, 'utf-8');
  const result = compileSource(source);
  if (result.lexerErrors.length > 0) {
    for (const e of result.lexerErrors) {
      console.error(`Лексер ${e.line}:${e.column}: ${e.message}`);
    }
  }
  if (result.parserErrors.length > 0) {
    for (const e of result.parserErrors) printParseError(e, source);
  }
  if (!result.module) return 1;
  const json = JSON.stringify(result.module, null, 2);
  const outPath = output ?? inputPath.replace(/\.osnova$/i, '.osvbc.json');
  fs.writeFileSync(path.resolve(outPath), json, 'utf-8');
  console.log('Скомпилировано:', outPath);
  return 0;
}

async function runScheduleMode(cliArgs: string[]): Promise<number> {
  const { runScheduleCli } = await import('./vliw/cli');
  return runScheduleCli(cliArgs);
}

async function main(): Promise<number> {
  const sub = args[0];
  const taskIdx = args.indexOf('--task');

  // --task "..." (можно без субкоманды)
  if (taskIdx >= 0 && args[taskIdx + 1]) {
    await runTaskMode(args[taskIdx + 1]!);
    return 0;
  }

  if (sub === 'compile') {
    return runCompileMode(args.slice(1));
  }

  if (sub === 'run') {
    return await runRuntime(args.slice(1));
  }

  if (sub === 'schedule') {
    return await runScheduleMode(args.slice(1));
  }

  if (!sub || sub.startsWith('-')) {
    console.error('Укажите субкоманду или --task "описание"');
    printUsage();
    return 1;
  }

  console.error(`Неизвестная субкоманда: ${sub}`);
  printUsage();
  return 1;
}

main()
  .catch(err => {
    console.error('[fatal]', err);
    process.exit(1);
  })
  .then(code => process.exit(code ?? 0));
