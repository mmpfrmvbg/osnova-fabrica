/**
 * CLI: osnova schedule input.osvbc.json [-o output.osvbc.json]
 * Гонит линейный .osvbc через планировщик Этапа 1, выдаёт .osvbc v2 с пакетами.
 * Ограничение: один процедура, код полностью линейный (без ветвлений и без готовых пакетов), в конце ret.
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { OsVbcModule, RawInstruction, CodeElement } from "../runtime/vm/bytecode";
import { isOsVbcModule, isVliwPacket } from "../runtime/vm/bytecode";
import { buildDependencyGraph } from "./dependencyGraph";
import { scheduleLinearBlock, packetsToCodeElements } from "./scheduler";

function isLinearInstruction(el: CodeElement): el is RawInstruction {
  return typeof el === "object" && el !== null && "op" in el && !isVliwPacket(el);
}

function isLinearCode(code: CodeElement[]): code is RawInstruction[] {
  if (code.length === 0) return false;
  if (!code.every(isLinearInstruction)) return false;
  const last = code[code.length - 1] as RawInstruction;
  return last.op === "ret";
}

export async function runScheduleCli(cliArgs: string[]): Promise<number> {
  const outIdx = cliArgs.indexOf("-o");
  const outputPath = outIdx >= 0 ? cliArgs[outIdx + 1] : null;
  const inputPath = cliArgs.filter((a, i) => a !== "-o" && (i === 0 || cliArgs[i - 1] !== "-o"))[0];

  if (!inputPath) {
    console.error("Использование: osnova-schedule input.osvbc.json [-o output.osvbc.json]");
    return 1;
  }

  let raw: string;
  try {
    raw = await fs.readFile(path.resolve(inputPath), "utf-8");
  } catch (e) {
    console.error("Не удалось прочитать файл:", inputPath, (e as Error).message);
    return 1;
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.error("Невалидный JSON:", (e as Error).message);
    return 1;
  }

  if (!isOsVbcModule(data)) {
    console.error("Файл не является OsVbcModule (version, moduleName, constants, procedures, code).");
    return 1;
  }

  const module = data as OsVbcModule;
  if (module.procedures.length !== 1) {
    console.error("Поддерживается только модуль с одной процедурой. Сейчас:", module.procedures.length);
    return 1;
  }

  if (!isLinearCode(module.code)) {
    console.error(
      "Код должен быть линейным (только инструкции, без packet) и заканчиваться на ret.",
    );
    return 1;
  }

  const linear = module.code as RawInstruction[];
  const block = linear.slice(0, -1);
  const ret = linear[linear.length - 1]!;
  const proc = module.procedures[0]!;

  const graph = buildDependencyGraph(block, { argc: proc.argc });
  const packets = scheduleLinearBlock(block, graph);
  const scheduled = packetsToCodeElements(packets);
  const newCode: CodeElement[] = [...scheduled, ret];

  const outModule: OsVbcModule = {
    version: 2,
    moduleName: module.moduleName,
    constants: module.constants,
    procedures: module.procedures.map((p) => ({ ...p })),
    code: newCode,
    vliwSlots: 4,
  };

  const outJson = JSON.stringify(outModule, null, 2);

  if (outputPath) {
    await fs.writeFile(path.resolve(outputPath), outJson, "utf-8");
    console.error("Записано:", outputPath);
  } else {
    process.stdout.write(outJson);
  }

  return 0;
}

function main(): void {
  runScheduleCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

if (require.main === module) {
  main();
}
