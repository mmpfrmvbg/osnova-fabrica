/**
 * Оракул единого вывода об отказе (`./compileDiagnostics`).
 *
 * **Повод.** Одна команда `compile` жила в трёх реализациях, и они разошлись:
 * `src/cli.ts` (из него собран установленный `osnova`) на семантической ошибке
 * выходил кодом 1 с **нулём строк** вывода — отказ без причины, который канон
 * называет худшим видом отказа. Замер до правки: `compileSource` знает на такой
 * программе 2 семантические ошибки с `kind` и файлом + отказ кодогена, а
 * пользователь не видел ничего. Пробы замера — `.tmp/err-channel-probe.ts`,
 * `.tmp/err-log-probe*.osnova`.
 *
 * **Что здесь держится.** Не текст сообщений, а канал: (1) структурная запись
 * семантической ошибки доходит до строки вместе с `kind` и файлом; (2) зеркало
 * `[semantic] …` из `compilerErrors` не печатается второй раз; (3) отказ без
 * диагностики называет себя, а не молчит; (4) рабочая программа молчит —
 * негативный контроль, без которого «печатать всегда» прошло бы оракул.
 *
 * Проверка 3-й части запускает подпроцессом именно `src/cli.ts` — тот путь,
 * который молчал: у него своя реализация команды, и оракул ловит их разъезд.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { compileSource, type CompileResult } from "./compiler";
import {
  collectCompileDiagnostics,
  formatCompileDiagnostic,
  reportCompileDiagnostics,
} from "./compileDiagnostics";

const ROOT = path.resolve(__dirname, "..", "..");

/** Необъявленная переменная: `undeclared_var` (блокирующий вид) + отказ кодогена. */
const BROKEN = [
  "модуль ПробаДиагностики",
  "",
  "процедура главная()",
  "  вернуть сумма_без_объявления",
  "конец",
  "",
  "конец",
  "",
].join("\n");

/** Та же программа без ошибки — негативный контроль. */
const GOOD = [
  "модуль ПробаДиагностики",
  "",
  "процедура главная()",
  "  пусть сумма = 2 + 2",
  "  вернуть сумма",
  "конец",
  "",
  "конец",
  "",
].join("\n");

const compile = (source: string, filename: string): CompileResult =>
  compileSource(source, { filename });

describe("единый вывод об отказе: что компилятор знает, то человек и видит", () => {
  it("семантическая ошибка доходит строкой с видом и файлом", () => {
    const result = compile(BROKEN, "проба.osnova");
    const records = collectCompileDiagnostics(result);
    const semantic = records.filter((d) => d.phase === "семантика");

    expect(semantic, "семантических записей").toHaveLength(1);
    expect(semantic[0]!.kind, "вид ошибки").toBe("undeclared_var");
    expect(semantic[0]!.file, "файл ошибки").toBe("проба.osnova");
    expect(semantic[0]!.severity, "блокирующий вид — отказ, а не совет").toBe("ошибка");
    const line = formatCompileDiagnostic(semantic[0]!);
    expect(line).toContain("[семантика]");
    expect(line, "место ошибки названо файлом").toContain("проба.osnova");
    expect(line).toContain("undeclared_var");
  });

  it("зеркало `[semantic] …` из compilerErrors не печатается второй раз", () => {
    const result = compile(BROKEN, "проба.osnova");
    const lines = renderToStrings(result);

    expect(lines.filter((l) => l.includes("[semantic] ")), "зеркал в выводе").toHaveLength(0);
    expect(
      lines.filter((l) => l.includes("используется без объявления")),
      "сообщение названо один раз",
    ).toHaveLength(1);
  });

  it("отказ кодогена тоже назван — иначе причина осталась бы за кадром", () => {
    const result = compile(BROKEN, "проба.osnova");
    const lines = renderToStrings(result);

    expect(result.module, "модуля нет").toBeNull();
    expect(lines.some((l) => l.startsWith("[сборка]"))).toBe(true);
  });

  it("рабочая программа молчит — негативный контроль", () => {
    const result = compile(GOOD, "проба.osnova");

    expect(result.module, "модуль собран").not.toBeNull();
    expect(collectCompileDiagnostics(result), "записей об отказе").toHaveLength(0);
    expect(renderToStrings(result), "строк вывода").toHaveLength(0);
  });

  it("отказ БЕЗ диагностики называет себя, а не молчит", () => {
    const empty: CompileResult = {
      module: null,
      compilerSuccess: false,
      lexerErrors: [],
      parserErrors: [],
      compilerErrors: [],
      semanticErrors: [],
      warnings: [],
      durationMs: 0,
    };
    const lines = renderToStrings(empty);

    expect(lines, "строк вывода").toHaveLength(1);
    expect(lines[0]).toContain("без диагностики");
  });

  it("собранный модуль без диагностики не получает строки-признака", () => {
    const good = compile(GOOD, "проба.osnova");
    const printed = reportCompileDiagnostics(good, { error: () => {} });

    expect(printed, "напечатанных записей").toBe(0);
  });
});

describe("установленный `osnova` (src/cli.ts compile) больше не молчит", () => {
  it("семантическая ошибка: код 1 и причина в stderr", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-diag-"));
    const file = path.join(dir, "проба.osnova");
    fs.writeFileSync(file, BROKEN, "utf-8");

    const r = spawnSync(`npx tsx src/cli.ts compile ${JSON.stringify(file)}`, {
      shell: true,
      cwd: ROOT,
      encoding: "utf-8",
    });

    expect(r.status, "код возврата").toBe(1);
    // До правки здесь было ровно ноль строк: оракул краснеет на откате.
    expect(r.stderr.trim(), "причина в stderr").not.toBe("");
    expect(r.stderr).toContain("undeclared_var");
  });

  it("рабочая программа: код 0 и ни одной строки диагностики", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-diag-ok-"));
    const file = path.join(dir, "проба.osnova");
    fs.writeFileSync(file, GOOD, "utf-8");

    const r = spawnSync(`npx tsx src/cli.ts compile ${JSON.stringify(file)}`, {
      shell: true,
      cwd: ROOT,
      encoding: "utf-8",
    });

    expect(r.status, "код возврата").toBe(0);
    expect(r.stderr.trim(), "диагностик нет").toBe("");
    expect(r.stdout).toContain("Скомпилировано");
  });
});

/** Вывод в массив строк: тот же путь, что у CLI, но без процессов. */
function renderToStrings(result: CompileResult, source?: string): string[] {
  const lines: string[] = [];
  reportCompileDiagnostics(
    result,
    { error: (l) => lines.push(l), warning: (l) => lines.push(l) },
    source !== undefined ? { source } : {},
  );
  return lines;
}
