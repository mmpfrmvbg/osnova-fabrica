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
import { VM, type InvokeHandler, type StackValue } from "../runtime/vm/interpreter";
import type { OsVbcModule } from "../runtime/vm/bytecode";

function usage(): void {
  console.error("Использование:");
  console.error("  osnova compile <файл.osnova> [-o <файл.osvbc.json>]");
  console.error("  osnova run <файл.osvbc.json>");
  process.exit(1);
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

  const source = fs.readFileSync(inputFile, "utf-8");
  const result = compileSource(source, { baseDir: path.dirname(path.resolve(inputFile)) });

  if (!result.compilerSuccess || !result.module) {
    for (const e of result.lexerErrors)
      console.error(`[лексер] строка ${e.line}: ${e.message}`);
    for (const e of result.parserErrors)
      console.error(`[парсер] строка ${e.line}: ${e.message}`);
    for (const e of result.compilerErrors)
      console.error(`[компилятор] ${e.message}`);
    process.exit(1);
  }

  if (result.compilerErrors.length > 0) {
    for (const e of result.compilerErrors)
      console.warn(`[предупреждение] ${e.message}`);
  }

  fs.writeFileSync(outputFile, JSON.stringify(result.module, null, 2), "utf-8");
  console.log(`Скомпилировано: ${inputFile} → ${outputFile}`);
}

async function cmdRun(args: string[]): Promise<void> {
  const inputFile = args.find((a) => !a.startsWith("-"));
  if (!inputFile) { console.error("Ошибка: не указан файл байткода"); usage(); }

  const raw = fs.readFileSync(inputFile!, "utf-8");
  let module: OsVbcModule;
  try {
    module = JSON.parse(raw) as OsVbcModule;
  } catch {
    console.error(`Ошибка: не удалось разобрать файл байткода: ${inputFile}`);
    process.exit(1);
  }

  const invoke: InvokeHandler = (name, args) => {
    if (name === "система.лог.вывести") {
      console.log(...args);
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
  if (result !== null && result !== undefined) console.log(result);
}

async function main(): Promise<void> {
  const [,, cmd, ...rest] = process.argv;
  switch (cmd) {
    case "compile": cmdCompile(rest); break;
    case "run":     await cmdRun(rest); break;
    default:        usage();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
