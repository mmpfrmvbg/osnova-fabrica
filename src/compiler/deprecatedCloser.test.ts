/**
 * Стадия 2 плана v2: предупреждение об устаревшем закрывающем слове `конец`.
 *
 * Канон v2.3.2 — закрывающее слово называет свой блок (`конец_процедуры`,
 * `конец_модуля`, `конец_если`, …). Одиночный `конец` принимается как
 * контекстный (БЛОК 1 v2), но это **legacy**, и Стадия 2 обязана его показывать.
 *
 * Три требования владельца, которые здесь закреплены:
 *  1. по умолчанию предупреждение **выключено** (корпус не мигрирован и не
 *     должен получать шум при каждом прогоне);
 *  2. `--warn-deprecated` его **включает**;
 *  3. предупреждение **информационное**: сборка успешна, байткод есть, код
 *     возврата — 0. Это не ошибка.
 *
 * Отдельно проверяется, что предупреждение НЕ срабатывает на `конец` как имени:
 * после БЛОК 1 v2 `конец` — контекстный токен, и `пусть конец = 5` / `вернуть
 * конец` законны. Предупреждать на них значило бы ругаться на верный код.
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compileSource } from "./compiler";
import { runCompileCli } from "./cliCompile";
import { deprecatedClosingsOf, reportDeprecatedEnds } from "../scripts/deprecatedEnds";

/** Минимальная программа, закрытая legacy-словами. */
const LEGACY = ["модуль t", "процедура главная()", "  вернуть 0", "конец", "конец"].join("\n");

/** Та же программа, закрытая каноническими словами. */
const CANON = ["модуль t", "процедура главная()", "  вернуть 0", "конец_процедуры", "конец_модуля"].join("\n");

const tmpFiles: string[] = [];

afterEach(() => {
  while (tmpFiles.length > 0) {
    const f = tmpFiles.pop()!;
    try {
      fs.unlinkSync(f);
    } catch {
      /* файла уже нет — не ошибка замера */
    }
  }
});

function writeTmp(source: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-deprecated-"));
  const file = path.join(dir, "т.osnova");
  fs.writeFileSync(file, source, "utf-8");
  tmpFiles.push(file);
  return file;
}

function captureCli(argv: string[]): { code: number; out: string; err: string } {
  let out = "";
  let err = "";
  const code = runCompileCli(argv, {
    out: (s) => {
      out += s + "\n";
    },
    err: (s) => {
      err += s + "\n";
    },
  });
  return { code, out, err };
}

describe("компилятор: предупреждение об устаревшем `конец` (Стадия 2)", () => {
  it("по умолчанию предупреждений НЕТ", () => {
    const r = compileSource(LEGACY, { filename: "т.osnova" });
    expect(r.warnings).toEqual([]);
  });

  it("с `warnDeprecated` предупреждение называет блок и каноническое слово", () => {
    const r = compileSource(LEGACY, { filename: "т.osnova", warnDeprecated: true });
    expect(r.warnings).toHaveLength(2);

    const proc = r.warnings.find((w) => w.block === "процедура");
    expect(proc, "предупреждение о закрытии процедуры").toBeDefined();
    expect(proc!.canonical).toBe("конец_процедуры");
    expect(proc!.line, "строка 4 — первое legacy-закрытие").toBe(4);
    expect(proc!.message).toContain("конец_процедуры");

    const mod = r.warnings.find((w) => w.block === "модуль");
    expect(mod, "предупреждение о закрытии модуля").toBeDefined();
    expect(mod!.canonical).toBe("конец_модуля");
    expect(mod!.line, "строка 5 — второе legacy-закрытие").toBe(5);
  });

  it("предупреждение информационное: сборка успешна, байткод есть", () => {
    const r = compileSource(LEGACY, { filename: "т.osnova", warnDeprecated: true });
    expect(r.parserErrors).toEqual([]);
    expect(r.lexerErrors).toEqual([]);
    expect(r.compilerSuccess).toBe(true);
    expect(r.module, "модуль собран — предупреждение ничего не сломало").not.toBeNull();
  });

  it("каноническое `конец_процедуры`/`конец_модуля` не предупреждает", () => {
    const r = compileSource(CANON, { filename: "т.osnova", warnDeprecated: true });
    expect(r.warnings).toEqual([]);
  });

  it("`конец` как ИМЯ не предупреждает (контекстный токен, не закрытие)", () => {
    const src = [
      "модуль t",
      "процедура главная()",
      "  пусть конец = 5",
      "  вернуть конец",
      "конец_процедуры",
      "конец_модуля",
    ].join("\n");
    const r = compileSource(src, { filename: "т.osnova", warnDeprecated: true });
    expect(r.parserErrors).toEqual([]);
    expect(r.warnings, "`конец` в позиции имени — не устаревшее закрытие").toEqual([]);
  });
});

describe("CLI компилятора: --warn-deprecated", () => {
  it("без флага не печатает предупреждений", () => {
    const file = writeTmp(LEGACY);
    const r = captureCli([file, "-o", file + ".json"]);
    expect(r.code, "код возврата — 0: предупреждение не ошибка").toBe(0);
    expect(r.err).not.toContain("устаревшее");
    fs.rmSync(file + ".json", { force: true });
  });

  it("с флагом печатает предупреждение и не меняет код возврата", () => {
    const file = writeTmp(LEGACY);
    const r = captureCli([file, "--warn-deprecated", "-o", file + ".json"]);
    expect(r.code).toBe(0);
    expect(r.err).toContain("устаревшее");
    expect(r.err).toContain("конец_процедуры");
    expect(r.err).toContain("конец_модуля");
    fs.rmSync(file + ".json", { force: true });
  });
});

describe("отчёт по устаревшим закрытиям (информационный шаг CI)", () => {
  it("считает legacy-закрытия по файлам и не путает их с каноном", () => {
    const rows = deprecatedClosingsOf([
      { file: "legacy.osnova", text: LEGACY },
      { file: "canon.osnova", text: CANON },
    ]);
    expect(rows.map((r) => r.file)).toEqual(["legacy.osnova", "canon.osnova"]);
    expect(rows[0]!.count).toBe(2);
    expect(rows[1]!.count, "канон — не долг").toBe(0);
  });

  it("у файла с `конец`-именем долг нулевой", () => {
    const src = ["модуль t", "процедура f()", "  пусть конец = 1", "  вернуть конец", "конец_процедуры", "конец_модуля"].join("\n");
    const rows = deprecatedClosingsOf([{ file: "имя.osnova", text: src }]);
    expect(rows[0]!.count).toBe(0);
  });

  it("шаг CI на реальном корпусе: код 0 и число долга названо", () => {
    // Корпус НЕ мигрирован (требование владельца), поэтому долг > 0 — это норма.
    // Проверяется не число, а работоспособность шага и инвариант «по умолчанию молчит».
    let out = "";
    let err = "";
    const code = reportDeprecatedEnds({
      out: (s) => {
        out += s + "\n";
      },
      err: (s) => {
        err += s + "\n";
      },
    });
    expect(err, "ошибок шага нет").toBe("");
    expect(code).toBe(0);
    expect(out).toMatch(/итого: \d+ закрытий 'конец' в \d+ файлах корпуса/);
    expect(out).toContain("по умолчанию предупреждение выключено");
  });
});
