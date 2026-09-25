#!/usr/bin/env node
/**
 * Основа CLI: compile + run
 * Использование:
 *   tsx src/cli/index.ts compile <input.osnova> [-o <output.osvbc.json>]
 *   tsx src/cli/index.ts run <input.osvbc.json>
 */
import * as fs from "fs";
import * as path from "path";
import { compileSource } from "../compiler/compiler";
import { formatDeprecatedWarning } from "../compiler/cliCompile";
import { VM, createDefaultInvokeHandler, formatOsnovaValue, type InvokeHandler, type StackValue } from "../runtime/vm/interpreter";
import { isKnownInvoke } from "../runtime/vm/invokeRegistry";
import type { OsVbcModule } from "../runtime/vm/bytecode";
import { runParity } from "../oracle/parity";
import { regModuleOf } from "../vliw/regOracle";
import { compareReorders, formatComparison } from "../vliw/reorderEquivalence";

function usage(): void {
  console.error("Использование:");
  console.error("  osnova compile <файл.osnova> [-o <файл.osvbc.json>] [--warn-deprecated]");
  console.error("  osnova run <файл.osnova>            скомпилировать и сразу запустить");
  console.error("  osnova run <файл.osvbc.json>        запустить готовый байткод");
  console.error("  osnova parity <файл.osnova>         сверка стековой и регистровой VM");
  console.error("  osnova schedule <файл.osvbc.json>   планирование линейного кода в пакеты VLIW");
  console.error("  osnova reorder <файл.osnova>        оракул перестановки: линейный код против переставленного");
  process.exit(1);
}

/**
 * Прочитать программу из файла: исходник компилируется, байткод разбирается.
 *
 * Исходник (`.osnova`) компилируется **в память**: одной командой `run` можно
 * запустить программу, не оставляя рядом `.osvbc.json`. Ошибки компиляции
 * печатаются теми же строками, что у `compile`.
 */
function readProgram(inputFile: string): OsVbcModule {
  const full = path.resolve(inputFile);
  if (!fs.existsSync(full)) {
    console.error(`Файл не найден: ${full}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(full, "utf-8");

  if (/\.osnova$/i.test(inputFile)) {
    const result = compileSource(raw, {
      baseDir: path.dirname(full),
      filename: path.basename(full),
    });
    if (!result.compilerSuccess || !result.module) {
      for (const e of result.lexerErrors) console.error(`[лексер] строка ${e.line}: ${e.message}`);
      for (const e of result.parserErrors) console.error(`[парсер] строка ${e.line}: ${e.message}`);
      for (const e of result.compilerErrors) console.error(`[компилятор] ${e.message}`);
      process.exit(1);
    }
    for (const e of result.compilerErrors) console.warn(`[предупреждение] ${e.message}`);
    return result.module;
  }

  try {
    return JSON.parse(raw) as OsVbcModule;
  } catch {
    console.error(`Ошибка: не удалось разобрать файл байткода: ${inputFile}`);
    process.exit(1);
  }
}

function cmdCompile(args: string[]): void {
  const inputIdx = args.findIndex((a) => !a.startsWith("-"));
  if (inputIdx === -1) { console.error("Ошибка: не указан входной файл"); usage(); }
  const inputFile = args[inputIdx]!;

  const outFlagIdx = args.indexOf("-o");
  const outputFile =
    outFlagIdx !== -1 && args[outFlagIdx + 1]
      ? args[outFlagIdx + 1]!
      : inputFile.replace(/\.osnova$/i, ".osvbc.json");

  // Стадия 2 плана v2: предупреждение об устаревшем закрывающем `конец`
  // выключено по умолчанию, включается явным флагом.
  const warnDeprecated = args.includes("--warn-deprecated");

  const source = fs.readFileSync(inputFile, "utf-8");
  // Имя файла передаётся ЯВНО: под каноном «файл = модуль» без него модуль
  // получает имя `вход` (умолчание из parser.ts), и артефакт расходится с тем,
  // что даёт компиляторный CLI и сторож `src/runtime/artifactDrift.test.ts`.
  // Ровно этот дефект был в `src/cli.ts` и `src/compiler/compile-fixtures.ts`.
  const result = compileSource(source, {
    baseDir: path.dirname(path.resolve(inputFile)),
    filename: path.basename(inputFile),
    warnDeprecated,
  });

  if (!result.compilerSuccess || !result.module) {
    for (const e of result.lexerErrors)
      console.error(`[лексер] строка ${e.line}: ${e.message}`);
    for (const e of result.parserErrors)
      console.error(`[парсер] строка ${e.line}: ${e.message}`);
    for (const e of result.compilerErrors)
      console.error(`[компилятор] ${e.message}`);
    for (const w of result.warnings) console.warn(formatDeprecatedWarning(w));
    process.exit(1);
  }

  if (result.compilerErrors.length > 0) {
    for (const e of result.compilerErrors)
      console.warn(`[предупреждение] ${e.message}`);
  }

  for (const w of result.warnings) console.warn(formatDeprecatedWarning(w));

  fs.writeFileSync(outputFile, JSON.stringify(result.module, null, 2), "utf-8");
  console.log(`Скомпилировано: ${inputFile} → ${outputFile}`);
}

async function cmdRun(args: string[]): Promise<void> {
  const inputIdx = args.findIndex((a) => !a.startsWith("-"));
  if (inputIdx === -1) { console.error("Ошибка: не указан файл программы"); usage(); }
  const inputFile = args[inputIdx]!;

  const module = readProgram(inputFile);

  // Общий обработчик — источник истины для вызовов языка (строки, математика,
  // объекты, JSON, итератор для `для`). Раньше здесь были только `лог` и массивы,
  // и любой другой известный вызов молча возвращал `null`: `для_каждого` не делал
  // ни одной итерации, `система.строка.*` давали пусто. Свои случаи раннера
  // (`лог`, массивы) остаются выше, остальное берётся из общего обработчика.
  const base = createDefaultInvokeHandler();
  const invoke: InvokeHandler = (name, args) => {
    if (name === "система.лог.вывести") {
      console.log(formatOsnovaValue(args[0]));
      return null;
    }
    if (name === "система.массив.создать") return [] as StackValue[];
    if (name === "система.массив.добавить") {
      const arr = args[0] as StackValue[];
      if (Array.isArray(arr)) arr.push(args[1] as StackValue);
      return null;
    }
    if (name === "система.массив.длина")
      return Array.isArray(args[0]) ? (args[0] as StackValue[]).length : 0;
    if (name === "система.массив.получить") {
      const v = (args[0] as StackValue[])[args[1] as number];
      return v === undefined ? null : (v as StackValue);
    }
    if (name === "система.массив.установить") {
      const arr = args[0] as StackValue[];
      const idx = Number(args[1]) | 0;
      if (Array.isArray(arr) && idx >= 0 && idx < arr.length) arr[idx] = args[2] as StackValue;
      return null;
    }
    if (isKnownInvoke(name)) return base(name, args);
    console.warn(`[VM] неизвестный syscall: ${name}`);
    return null;
  };

  const vm = new VM(module, { invoke, maxSteps: 1_000_000 });
  const mainIdx = (() => {
    try { return vm.findProcedureIndex("главная"); } catch { /* */ }
    try { return vm.findProcedureIndex("старт"); } catch { /* */ }
    try { return vm.findProcedureIndex("main"); } catch { /* */ }
    return 0;
  })();

  const result = await vm.runProcedure(mainIdx, []);
  if (result !== null && result !== undefined) console.log(formatOsnovaValue(result));
}

/**
 * `osnova parity файл.osnova` — сверка двух бэкендов.
 *
 * Компилирует один исходник дважды (стековый и регистровый байткод), исполняет
 * обе VM с одинаковым хостом и сверяет трассы вызовов и итоговое значение.
 * Код возврата: 0 — совпало, 1 — расхождение, 2 — программа вне среза
 * регистрового бэкенда, 3 — обе VM не завершились за лимит шагов.
 */
async function cmdParity(args: string[]): Promise<void> {
  const input = args.find((a) => !a.startsWith("-"));
  if (!input) {
    console.error("Использование: osnova parity файл.osnova [--entry имя]");
    process.exit(1);
  }
  const inputPath = path.resolve(input);
  if (!fs.existsSync(inputPath)) {
    console.error("Файл не найден:", inputPath);
    process.exit(1);
  }
  const entryIdx = args.indexOf("--entry");
  const entryProcedure = entryIdx >= 0 ? args[entryIdx + 1] : undefined;

  const source = fs.readFileSync(inputPath, "utf-8");
  const result = await runParity(source, { entryProcedure });
  if ("skipped" in result) {
    console.log(`[skip] ${path.basename(inputPath)}: ${result.reason}`);
    process.exit(2);
  }
  console.log(`[${result.ok ? "OK" : "FAIL"}] ${path.basename(inputPath)}`);
  console.log("  статус:         ", result.status);
  console.log("  стековая VM:    ", JSON.stringify(result.stackValue));
  console.log("  регистровая VM: ", JSON.stringify(result.regValue));
  console.log("  шагов трассы:   ", result.stackTrace.length);
  console.log("  сверка:         ", result.message);
  if (result.status === "both_hit_step_limit") {
    console.error("  обе VM не завершились за лимит шагов — сравнивать нечего");
    process.exit(3);
  }
  if (!result.ok) {
    console.error(`  первое расхождение на шаге ${result.divergenceIndex}`);
    process.exit(1);
  }
}

/** `osnova schedule файл.osvbc.json` — планирование линейного кода в пакеты VLIW. */
async function cmdSchedule(args: string[]): Promise<void> {
  const { runScheduleCli } = await import("../vliw/cli");
  process.exit(await runScheduleCli(args));
}

/**
 * `osnova reorder файл.osnova` — оракул перестановки независимых операций:
 * линейный регистровый код против переставленного на одной RegVM, плюс счётчики e2k.
 */
async function cmdReorder(args: string[]): Promise<void> {
  const input = args.find((a) => !a.startsWith("-"));
  if (!input) {
    console.error("Использование: osnova reorder файл.osnova [--memory l1|l2|l3|mem] [--entry имя] [--steps N]");
    process.exit(1);
  }
  const inputPath = path.resolve(input);
  if (!fs.existsSync(inputPath)) {
    console.error("Файл не найден:", inputPath);
    process.exit(1);
  }

  const argOf = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const memoryRaw = argOf("--memory") ?? "l1";
  const allowed = ["l1", "l2", "l3", "mem"] as const;
  if (!(allowed as readonly string[]).includes(memoryRaw)) {
    console.error(`Неизвестный уровень памяти: ${memoryRaw}. Допустимо: ${allowed.join(", ")}`);
    process.exit(1);
  }
  const memoryLevel = memoryRaw as (typeof allowed)[number];
  const entryProcedure = argOf("--entry");
  const stepsRaw = argOf("--steps");
  const maxSteps = stepsRaw !== undefined ? Number(stepsRaw) : undefined;
  if (maxSteps !== undefined && (!Number.isFinite(maxSteps) || maxSteps <= 0)) {
    console.error("--steps должен быть положительным числом");
    process.exit(1);
  }

  const source = fs.readFileSync(inputPath, "utf-8");
  const built = regModuleOf(source);
  if (!built) {
    console.error(`[FAIL] ${path.basename(inputPath)}: исходник не компилируется`);
    process.exit(2);
  }

  const cmp = await compareReorders(built.module, {
    memoryLevel,
    ...(entryProcedure !== undefined ? { entryProcedure } : {}),
    ...(maxSteps !== undefined ? { maxSteps } : {}),
  });
  console.log(formatComparison(path.basename(inputPath), cmp, memoryLevel));
  if (!cmp.equivalence.ok) {
    console.error(`  расхождение: ${cmp.equivalence.message}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const [,, cmd, ...rest] = process.argv;
  switch (cmd) {
    case "compile": cmdCompile(rest); break;
    case "run":     await cmdRun(rest); break;
    case "parity":  await cmdParity(rest); break;
    case "schedule": await cmdSchedule(rest); break;
    case "reorder": await cmdReorder(rest); break;
    default:        usage();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
