#!/usr/bin/env ts-node
// ============================================================
// src/cli.ts — Единая точка входа osnova-fabrica
// Субкоманды: --task, compile, run, schedule
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { runPipeline } from './pipeline/orchestrator';
import { runLoop } from './pipeline/loop';
import { selfImprove } from './self-improve/core';
import {
  createLlmPatchGen,
  createFilePatchPort,
  createCommandGate,
  assertCleanWorkingTree,
} from './self-improve/adapters';
import { resident } from './resident/core';
import { createLlmPlanner, createResidentExecutor } from './resident/adapters';
import { validateEnv } from './env';
import { compileSource } from './compiler/compiler';
import { printParseError } from './compiler/parser';
import { run as runRuntime } from './runtime/run';
import { runParity } from './oracle/parity';

const args = process.argv.slice(2);

/**
 * Загружает корневой `.env` в process.env (если переменная ещё не задана).
 * Без зависимости dotenv: простой разбор KEY=VALUE с учётом '#'-комментариев.
 */
function loadDotEnv(): void {
  const envPath = path.resolve('.env');
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const commentIdx = value.indexOf(' #');
    if (commentIdx >= 0) value = value.slice(0, commentIdx).trim();
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function printUsage(): void {
  console.error('Использование:');
  console.error('  osnova --task "описание задачи"     Генерация через LLM');
  console.error('  osnova loop "цель"                Автономная петля до зелёного golden');
  console.error('  osnova improve "цель" [--max N] [--scope п1,п2]   Самоулучшение ядра (патчи компилятора/VM)');
  console.error('  osnova resident "старт" [--rounds N]  Автономный резидент (сам ставит цели)');
  console.error('  osnova new-app --task "описание"     Генерация + сохранение + регистрация');
  console.error('  osnova compile file.osnova [-o out]  Компиляция .osnova → .osvbc');
  console.error('  osnova run --manifest path           Запуск приложения по манифесту');
  console.error('  osnova schedule file.osvbc.json      VLIW-планирование (линейный код)');
  console.error('  osnova parity file.osnova            Оракул: стековая VM vs регистровая (сверка трасс)');
  console.error('  osnova list [--dir <path>]       Список приложений из реестра');
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
  process.exit(result.status === 'error' ? 1 : 0);
}

async function runLoopMode(goal: string): Promise<void> {
  await validateEnv();
  console.log(`\n[osnova loop] Цель: ${goal}\n`);
  const result = await runLoop(goal);

  console.log('\n─── Результат петли ───');
  console.log('Статус:          ', result.status);
  console.log('Итераций:        ', result.iterations.length);
  console.log('Время:           ', result.totalDurationMs, 'ms');
  if (result.lastErrorKind) console.log('Последняя ошибка:', result.lastErrorKind);
  if (result.error) console.error('Ошибка:          ', result.error);

  console.log('\n─── Итерации ───');
  for (const it of result.iterations) {
    const q = it.goldenReport ? ` q=${it.goldenReport.qualityScore.toFixed(2)}` : '';
    console.log(
      `  #${it.iteration} ${it.phase.padEnd(8)} ${it.status.padEnd(8)}` +
      (it.errorKind ? ' ' + it.errorKind : '') + q + ` (${it.durationMs}ms)`,
    );
  }

  if (result.source) {
    console.log('\n─── Итоговый .osnova ───');
    console.log(result.source.source);
  }
  process.exit(result.status === 'error' ? 1 : 0);
}

async function runImproveMode(goal: string, args: string[]): Promise<void> {
  const maxIdx = args.indexOf('--max');
  const maxIterations = maxIdx >= 0 ? Number(args[maxIdx + 1]) || 4 : 4;

  const scopeIdx = args.indexOf('--scope');
  const allowedPaths = scopeIdx >= 0
    ? args[scopeIdx + 1].split(',').map(s => s.trim()).filter(Boolean)
    : ['src/compiler', 'src/runtime/vm'];
  const forbiddenPaths = ['.qwen', 'forge', 'Fabrika2.0', 'apps', 'dist', 'node_modules'];

  await validateEnv();
  console.log(`\n[osnova improve] Цель: ${goal}\n`);

  try {
    await assertCleanWorkingTree(allowedPaths);

    const ports = {
      gen: createLlmPatchGen(),
      patch: createFilePatchPort(),
      gate: createCommandGate(['npx vitest run src/compiler src/runtime/vm']),
    };

    const result = await selfImprove(
      goal,
      { allowedPaths, forbiddenPaths, maxIterations },
      ports,
    );

    console.log('\n─── Результат самоулучшения ───');
    console.log('Статус:   ', result.status);
    console.log('Итераций: ', result.iterations.length);
    console.log('Время:    ', result.totalDurationMs, 'ms');
    if (result.error) console.error('Ошибка:   ', result.error);

    console.log('\n─── Итерации ───');
    for (const it of result.iterations) {
      console.log(
        `  #${it.iteration} ${it.status.padEnd(8)}${it.errorKind ? ' ' + it.errorKind : ''} (${it.durationMs}ms)`,
      );
    }

    if (result.edits) {
      console.log('\n─── Принятые правки ───');
      for (const [p, c] of Object.entries(result.edits)) {
        console.log(`\n=== ${p} ===\n${c}`);
      }
    }

    process.exit(result.status === 'error' ? 1 : 0);
  } catch (err) {
    console.error('Ошибка:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function runResidentMode(startGoal: string, args: string[]): Promise<void> {
  const roundsIdx = args.indexOf('--rounds');
  const maxRounds = roundsIdx >= 0 ? Number(args[roundsIdx + 1]) || 5 : 5;

  await validateEnv();
  console.log(`\n[osnova resident] Старт: ${startGoal}\n`);

  const result = await resident(
    startGoal,
    { maxRounds },
    { plan: createLlmPlanner(), exec: createResidentExecutor() },
  );

  console.log('\n─── Результат резидента ───');
  console.log('Статус:   ', result.status);
  console.log('Раундов:  ', result.rounds.length);
  console.log('Время:    ', result.totalDurationMs, 'ms');
  if (result.error) console.error('Ошибка:   ', result.error);

  console.log('\n─── Раунды ───');
  for (const r of result.rounds) {
    console.log(
      `  #${r.round} ${r.mode.padEnd(8)} ${r.status.padEnd(10)} ${r.goal.slice(0, 60)} (${r.durationMs}ms)`,
    );
  }

  process.exit(result.status === 'error' ? 1 : 0);
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

/**
 * `osnova parity file.osnova` — дифференциальный оракул бэкендов.
 *
 * Компилирует один исходник дважды (стековый и регистровый байткод), исполняет
 * обе VM с одинаковым хостом и сверяет трассы вызовов и итоговое значение.
 * Код возврата: 0 — совпало, 1 — расхождение, 2 — программа вне среза
 * регистрового бэкенда (ещё не поддержано, это не расхождение), 3 — обе VM не
 * завершились за лимит шагов: сравнивать нечего, и это не «совпало».
 */
async function runParityMode(cliArgs: string[]): Promise<number> {
  const input = cliArgs.find((a) => !a.startsWith('-'));
  if (!input) {
    console.error('Использование: osnova parity input.osnova [--entry имя]');
    return 1;
  }
  const inputPath = path.resolve(input);
  if (!fs.existsSync(inputPath)) {
    console.error('Файл не найден:', inputPath);
    return 1;
  }
  const entryIdx = cliArgs.indexOf('--entry');
  const entryProcedure = entryIdx >= 0 ? cliArgs[entryIdx + 1] : undefined;

  const source = fs.readFileSync(inputPath, 'utf-8');
  const result = await runParity(source, { entryProcedure });
  if ('skipped' in result) {
    console.log(`[skip] ${path.basename(inputPath)}: ${result.reason}`);
    return 2;
  }
  console.log(`[${result.ok ? 'OK' : 'FAIL'}] ${path.basename(inputPath)}`);
  console.log('  статус:         ', result.status);
  console.log('  стековая VM:    ', JSON.stringify(result.stackValue));
  console.log('  регистровая VM: ', JSON.stringify(result.regValue));
  console.log('  шагов трассы:   ', result.stackTrace.length);
  console.log('  сверка:         ', result.message);
  if (result.status === 'both_hit_step_limit') {
    console.error('  обе VM не завершились за лимит шагов — сравнивать нечего');
    return 3;
  }
  if (!result.ok) {
    console.error(`  первое расхождение на шаге ${result.divergenceIndex}`);
    return 1;
  }
  return 0;
}

async function listApps(cliArgs: string[]): Promise<number> {
  let dir = path.resolve('src/runtime');
  for (let i = 0; i < cliArgs.length; i++) {
    if (cliArgs[i] === '--dir' && cliArgs[i + 1]) {
      dir = path.resolve(cliArgs[++i]!);
      break;
    }
  }
  const registryPath = path.join(dir, 'registry.json');
  if (!fs.existsSync(registryPath)) {
    console.error('Реестр не найден:', registryPath);
    return 1;
  }
  const raw = fs.readFileSync(registryPath, 'utf-8');
  const registry = JSON.parse(raw) as {
    entries: Array<{
      kind: string;
      id: string;
      name: string;
      version: string;
      category: string;
      uiKind: string;
    }>;
  };
  console.log('\n─── Приложения ОС-НОВА ───\n');
  const apps = registry.entries.filter(e => e.kind === 'app');
  const services = registry.entries.filter(e => e.kind === 'service');
  if (apps.length) {
    console.log('Приложения:');
    for (const a of apps) {
      console.log(`  [${a.id}]  ${a.name}  v${a.version}  (${a.category}, ui: ${a.uiKind})`);
    }
  }
  if (services.length) {
    console.log('\nСервисы:');
    for (const s of services) {
      console.log(`  [${s.id}]  ${s.name}  v${s.version}`);
    }
  }
  console.log(`\nВсего: ${registry.entries.length} (${apps.length} app, ${services.length} service)\n`);
  return 0;
}

async function runNewApp(cliArgs: string[]): Promise<void> {
  // Парсим --task "..." из cliArgs
  const taskIdx = cliArgs.indexOf('--task');
  const task = taskIdx >= 0 ? cliArgs[taskIdx + 1] : cliArgs[0];
  if (!task) {
    console.error('Использование: osnova new-app --task "описание задачи"');
    console.error('         или:  osnova new-app "описание задачи"');
    process.exit(1);
  }

  await validateEnv();
  console.log(`\n[osnova new-app] Задача: ${task}\n`);

  const result = await runPipeline(task);

  console.log('\n─── Результат генерации ───');
  console.log('Статус:         ', result.status);
  console.log('Repair попыток: ', result.repairAttempts);
  console.log('Время:          ', result.totalDurationMs, 'ms');

  if (result.status === 'error' || !result.source) {
    console.error('Генерация не удалась — приложение не сохранено.');
    if (result.error) console.error('Ошибка:', result.error);
    process.exit(1);
  }

  const translitMap: Record<string, string> = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i',
    й: 'j', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
    у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
    э: 'e', ю: 'yu', я: 'ya',
  };

  // Генерируем appId из задачи: берём первые слова, транслитерируем
  const appId = 'osnova.' + task
    .toLowerCase()
    .replace(/[^a-zа-яё0-9\s]/gi, '')
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .join('_')
    .replace(/[а-яё]/gi, c => translitMap[c.toLowerCase()] ?? c);

  const appsDir = path.resolve('src/runtime/apps');
  const appDir = path.join(appsDir, appId);
  fs.mkdirSync(appDir, { recursive: true });

  // Сохраняем .osnova
  const osnovaPath = path.join(appDir, result.source.filename);
  fs.writeFileSync(osnovaPath, result.source.source, 'utf-8');
  console.log('Сохранён .osnova: ', osnovaPath);

  // Сохраняем bytecode если есть
  if (result.buildReport?.bytecode) {
    const bcPath = path.join(appDir, result.source.filename.replace(/\.osnova$/i, '.osvbc.json'));
    fs.writeFileSync(bcPath, JSON.stringify(result.buildReport.bytecode, null, 2), 'utf-8');
    console.log('Сохранён bytecode:', bcPath);
  }

  // Создаём минимальный osapp.yaml
  const manifestPath = path.join(appDir, 'osapp.yaml');
  const manifest = [
    `id: "${appId}"`,
    `name: "${task.slice(0, 40)}"`,
    `version: "0.1.0"`,
    `kind: app`,
    `entry: "${result.source.filename}"`,
    `uiKind: window`,
    `category: generated`,
    `generatedAt: "${new Date().toISOString()}"`,
    `task: "${task.replace(/"/g, '\\"')}"`,
    `status: "${result.status}"`,
  ].join('\n');
  fs.writeFileSync(manifestPath, manifest, 'utf-8');
  console.log('Создан манифест: ', manifestPath);

  // Обновляем registry.json
  const registryPath = path.resolve('src/runtime/registry.json');
  let registry: { entries: Array<Record<string, unknown>> } = { entries: [] };
  if (fs.existsSync(registryPath)) {
    registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
  }
  const exists = registry.entries.some(e => e.id === appId);
  if (!exists) {
    registry.entries.push({
      kind: 'app',
      id: appId,
      name: task.slice(0, 40),
      version: '0.1.0',
      category: 'generated',
      uiKind: 'window',
      manifestPath: path.relative('src/runtime', manifestPath).replace(/\\/g, '/'),
      packagePath: path.relative('src/runtime', appDir).replace(/\\/g, '/'),
      generatedAt: new Date().toISOString(),
      status: result.status,
    });
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf-8');
    console.log(`Зарегистрировано в registry.json: ${appId}`);
  } else {
    console.log(`Уже в реестре: ${appId} (не обновлялось)`);
  }

  console.log('\n✅ Приложение готово:', appDir);
  console.log('   osnova list — чтобы увидеть в реестре\n');
}

async function main(): Promise<number> {
  loadDotEnv();
  const sub = args[0];
  const taskIdx = args.indexOf('--task');

  // --task "..." (можно без субкоманды)
  if (taskIdx >= 0 && args[taskIdx + 1]) {
    await runTaskMode(args[taskIdx + 1]!);
    return 0;
  }

  if (sub === 'loop') {
    const goal = args[1];
    if (!goal) {
      console.error('Использование: osnova loop "цель"');
      process.exit(1);
    }
    await runLoopMode(goal);
    return 0;
  }

  if (sub === 'improve') {
    const goal = args[1];
    if (!goal) {
      console.error('Использование: osnova improve "цель" [--max N] [--scope п1,п2]');
      process.exit(1);
    }
    await runImproveMode(goal, args.slice(2));
    return 0;
  }

  if (sub === 'resident') {
    const startGoal = args[1];
    if (!startGoal) {
      console.error('Использование: osnova resident "старт" [--rounds N]');
      process.exit(1);
    }
    await runResidentMode(startGoal, args.slice(2));
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

  if (sub === 'parity') {
    return await runParityMode(args.slice(1));
  }

  if (sub === 'list') {
    return await listApps(args.slice(1));
  }

  if (sub === 'new-app') {
    await runNewApp(args.slice(1));
    return 0;
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
