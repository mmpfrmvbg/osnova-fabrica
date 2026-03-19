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
  console.error('  osnova new-app --task "описание"     Генерация + сохранение + регистрация');
  console.error('  osnova compile file.osnova [-o out]  Компиляция .osnova → .osvbc');
  console.error('  osnova run --manifest path           Запуск приложения по манифесту');
  console.error('  osnova schedule file.osvbc.json      VLIW-планирование (линейный код)');
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

  if (result.status === 'failure' || !result.source) {
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
