/**
 * Оракул печати значений: логическое печатается СЛОВОМ, а не `true`/`false`.
 *
 * Повод. Голое `система.лог.вывести(10 > 3)` выводило `true`, а склейка через `+`
 * давала `истина` — одно и то же значение выглядело по-разному в зависимости от
 * способа печати (найдено при написании учебника, 2026-09-23). Теперь вид значения
 * решается в одном месте (`formatOsnovaValue`) и используется всеми путями вывода:
 * общим обработчиком, раннером приложений, CLI и обеими VM.
 *
 * Проверяются оба пути: библиотечный (компиляция + VM со значениями `console.log`)
 * и настоящий CLI — чтобы расхождение не вернулось в одной из точек печати.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { compileSource } from "../compiler/compiler";
import { VM, createDefaultInvokeHandler, formatOsnovaValue } from "./vm/interpreter";

const ROOT = path.resolve(__dirname, "..", "..");

async function printed(body: string): Promise<string[]> {
  const source = `модуль печать\n\nпроцедура главная()\n${body}\nконец_процедуры\n\nконец_модуля\n`;
  const out: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    out.push(args.map(String).join(" "));
  });
  try {
    const r = compileSource(source);
    expect(r.lexerErrors).toEqual([]);
    expect(r.parserErrors).toEqual([]);
    expect(r.semanticErrors, "пример без семантических ошибок").toEqual([]);
    const vm = new VM(r.module!, { invoke: createDefaultInvokeHandler() });
    await vm.runProcedure(vm.findProcedureIndex("главная"), []);
  } finally {
    spy.mockRestore();
  }
  return out;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("печать значений: логическое — словом", () => {
  it("голое логическое печатается как истина/ложь", async () => {
    expect(await printed("  система.лог.вывести(10 > 3)")).toEqual(["истина"]);
    expect(await printed("  система.лог.вывести(1 > 3)")).toEqual(["ложь"]);
  });

  it("в склейке через `+` — тоже истина/ложь", async () => {
    expect(await printed('  система.лог.вывести("итог: " + (10 > 3))')).toEqual(["итог: истина"]);
    expect(await printed('  система.лог.вывести("итог: " + (1 > 3))')).toEqual(["итог: ложь"]);
  });

  it("`система.строка.объединить` даёт тот же вид, что `+`", async () => {
    expect(await printed('  система.лог.вывести(система.строка.объединить("флаг: ", 10 > 3))')).toEqual([
      "флаг: истина",
    ]);
    expect(await printed('  система.лог.вывести(система.строка.объединить("флаг: ", 1 > 3))')).toEqual([
      "флаг: ложь",
    ]);
  });

  it("`пусто` печатается словом пусто", async () => {
    expect(await printed("  система.лог.вывести(пусто)")).toEqual(["пусто"]);
  });

  it("числа и строки печатаются как есть (ничего не сломалось)", async () => {
    expect(await printed("  система.лог.вывести(5)")).toEqual(["5"]);
    expect(await printed('  система.лог.вывести("текст")')).toEqual(["текст"]);
    expect(await printed('  система.лог.вывести("массив: " + [1, 2])')).toEqual(["массив: [1,2]"]);
  });

  it("formatOsnovaValue — единственное место, где решается вид значения", () => {
    expect(formatOsnovaValue(true)).toBe("истина");
    expect(formatOsnovaValue(false)).toBe("ложь");
    expect(formatOsnovaValue(null)).toBe("пусто");
    expect(formatOsnovaValue(0)).toBe("0");
    expect(formatOsnovaValue("")).toBe("");
  });
});

describe("печать значений: self-host runner показывает то же", () => {
  it("`src/self-host/run.ts` печатает истина/ложь, а не true/false", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-selfhost-"));
    const sourceFile = path.join(dir, "флаг.osnova");
    const bytecodeFile = path.join(dir, "флаг.osvbc.json");
    fs.writeFileSync(
      sourceFile,
      [
        "модуль флаг",
        "",
        "процедура главная(): Логический",
        "  вернуть 10 > 3",
        "конец_процедуры",
        "",
        "конец_модуля",
        "",
      ].join("\n"),
      "utf-8",
    );

    const compile = spawnSync(
      `npx tsx src/cli/index.ts compile ${JSON.stringify(sourceFile)} -o ${JSON.stringify(bytecodeFile)}`,
      { shell: true, cwd: ROOT, encoding: "utf-8" },
    );
    expect(compile.status, `compile: ${compile.stderr ?? ""}`).toBe(0);

    const run = spawnSync(`npx tsx src/self-host/run.ts ${JSON.stringify(bytecodeFile)}`, {
      shell: true,
      cwd: ROOT,
      encoding: "utf-8",
    });
    expect(run.status, `run: ${run.stderr ?? ""}`).toBe(0);
    expect((run.stdout ?? "").trim()).toBe("истина");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("печать значений: CLI показывает то же", () => {
  it("`compile` + `run` печатают истина/ложь, а не true/false", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-print-"));
    const sourceFile = path.join(dir, "флаги.osnova");
    const bytecodeFile = path.join(dir, "флаги.osvbc.json");
    fs.writeFileSync(
      sourceFile,
      [
        "модуль флаги",
        "",
        "процедура главная(): Логический",
        "  система.лог.вывести(10 > 3)",
        "  система.лог.вывести(1 > 3)",
        '  система.лог.вывести("склейка: " + (2 > 1))',
        "  вернуть 3 > 4",
        "конец_процедуры",
        "",
        "конец_модуля",
        "",
      ].join("\n"),
      "utf-8",
    );

    const compile = spawnSync(
      `npx tsx src/cli/index.ts compile ${JSON.stringify(sourceFile)} -o ${JSON.stringify(bytecodeFile)}`,
      { shell: true, cwd: ROOT, encoding: "utf-8" },
    );
    expect(compile.status, `compile: ${compile.stderr ?? ""}`).toBe(0);
    const run = spawnSync(`npx tsx src/cli/index.ts run ${JSON.stringify(bytecodeFile)}`, {
      shell: true,
      cwd: ROOT,
      encoding: "utf-8",
    });
    expect(run.status, `run: ${run.stderr ?? ""}`).toBe(0);
    expect((run.stdout ?? "").trim().split("\n")).toEqual([
      "истина",
      "ложь",
      "склейка: истина",
      "ложь",
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
