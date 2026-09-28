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
 * (5) Машинный вывод: у записи есть код из каталога, JSONL парсится построчно,
 * (6) вид вне каталога получает **маркер** `OSN-SEM-000` из каталога — не пустую
 * строку (её не пропустила бы проверка формы `OSN-…`) и не «похожий» код вида;
 * проверка краснеет на любом из трёх ответов; (7) `--diagnostics=json` отдаёт
 * инструменту только JSONL, а человеческий формат остаётся прежним; (8) отказы
 * ДО компиляции («не указан входной файл», «файл не найден») выходят записью с
 * кодом каталога в фазе `вызов` — одинаковой у всех трёх точек входа.
 *
 * Проверка 3-й части запускает подпроцессом именно `src/cli.ts` — тот путь,
 * который молчал: у него своя реализация команды, и оракул ловит их разъезд.
 * По той же причине флаг `--diagnostics=json` проверяется подпроцессом на двух
 * точках входа: `src/compiler/cli.ts` и `src/cli.ts` (установленный `osnova`).
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { compileSource, type CompileResult } from "./compiler";
import type { SemanticError } from "./semantic";
import {
  diagnosticCodeOf,
  CLI_CODES,
  INTERNAL_CODES,
  PHASE_CODES,
  UNCATALOGUED_CODES,
} from "./diagnosticCatalogue";
import {
  collectCompileDiagnostics,
  formatCompileDiagnostic,
  formatCompileDiagnosticJson,
  reportCompileDiagnostics,
} from "./compileDiagnostics";
import { parseDiagnosticsFormat, runCompileCli } from "./cliCompile";

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

/** То же, но машинным форматом: JSONL, одна запись — одна строка. */
function renderJson(result: CompileResult, source?: string): string[] {
  const lines: string[] = [];
  reportCompileDiagnostics(
    result,
    { error: (l) => lines.push(l), warning: (l) => lines.push(l) },
    { ...(source !== undefined ? { source } : {}), format: "json" },
  );
  return lines;
}

/** Программа с ошибкой разбора: у неё свой путь печати (строка исходника + указатель). */
const SYNTAX = [
  "модуль ПробаДиагностики",
  "",
  "процедура главная(",
  "  вернуть 1",
  "конец",
  "",
  "конец",
  "",
].join("\n");

/** Отказ без единой причины: так выглядит дефект компилятора. */
const SILENT: CompileResult = {
  module: null,
  compilerSuccess: false,
  lexerErrors: [],
  parserErrors: [],
  compilerErrors: [],
  semanticErrors: [],
  warnings: [],
  durationMs: 0,
};

/** Запустить точку входа подпроцессом: потоки порознь, вместе с кодом возврата. */
function runEntry(entry: string, args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync(
    `npx tsx ${entry} ${args.map((a) => JSON.stringify(a)).join(" ")}`,
    { shell: true, cwd: ROOT, encoding: "utf-8" },
  );
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** Файл во временном каталоге: подпроцессу нужен путь, а не исходник в памяти. */
function writeTemp(source: string, prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const file = path.join(dir, "проба.osnova");
  fs.writeFileSync(file, source, "utf-8");
  return file;
}

/** Непустые строки вывода: хвостовой перевод строки — не запись. */
const linesOf = (out: string): string[] => out.split(/\r?\n/).filter((l) => l !== "");

describe("машинная личность записи: код из каталога и JSONL", () => {
  it("у семантической записи код каталога, а не выдуманный здесь", () => {
    const semantic = collectCompileDiagnostics(compile(BROKEN, "проба.osnova")).find(
      (d) => d.phase === "семантика",
    )!;

    expect(diagnosticCodeOf("undeclared_var"), "вид есть в каталоге").toBeDefined();
    expect(semantic.code, "код — ровно тот, что даёт каталог").toBe(
      diagnosticCodeOf("undeclared_var"),
    );
    expect(semantic.code, "код не пуст").not.toBe("");
    expect(semantic.code, "форма кода").toMatch(/^OSN-SEM-\d{3}$/);
  });

  it("JSONL парсится, несёт код, фазу, уровень и файл; порядок ключей стабилен", () => {
    const semantic = collectCompileDiagnostics(compile(BROKEN, "проба.osnova")).find(
      (d) => d.phase === "семантика",
    )!;
    const line = formatCompileDiagnosticJson(semantic);

    expect(line.includes("\n"), "одна запись — одна строка").toBe(false);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(Object.keys(parsed), "порядок ключей записи").toEqual([
      "code",
      "phase",
      "severity",
      "kind",
      "message",
      "file",
    ]);
    expect(parsed.code).toBe(semantic.code);
    expect(parsed.phase, "фаза").toBe("семантика");
    expect(parsed.severity, "уровень").toBe("ошибка");
    expect(parsed.kind).toBe("undeclared_var");
    expect(parsed.message).toBe(semantic.message);
    expect(parsed.file, "файл на месте").toBe("проба.osnova");
  });

  it("две записи об отказе — две строки JSONL, у каждой код фазы", () => {
    const lines = renderJson(compile(BROKEN, "проба.osnova"), BROKEN);

    expect(lines, "семантика + отказ сборки").toHaveLength(2);
    const codes = lines.map((l) => (JSON.parse(l) as { code: string }).code);
    expect(codes).toEqual([diagnosticCodeOf("undeclared_var"), PHASE_CODES.сборка]);
    expect(
      codes.every((c) => /^OSN-[A-Z]{2,3}-\d{3}$/.test(c)),
      "у каждой записи машинный код",
    ).toBe(true);
  });

  it("ошибка разбора в JSON-режиме — одна строка, без строки исходника", () => {
    const result = compile(SYNTAX, "проба.osnova");
    const human = renderToStrings(result, SYNTAX);
    const json = renderJson(result, SYNTAX);

    expect(result.parserErrors, "проба осмысленна: ошибка разбора").toHaveLength(1);
    expect(human.join("\n"), "человеку — строка исходника и указатель").toContain("^");
    expect(json, "машине — одна запись").toHaveLength(1);
    const parsed = JSON.parse(json[0]!) as { code: string; phase: string; line?: number };
    expect(parsed.code).toBe(PHASE_CODES.парсер);
    expect(parsed.phase).toBe("парсер");
    expect(parsed.line, "место названо номером").toBe(4);
  });

  it("человеческий формат не изменился: строка собирается по прежнему правилу", () => {
    const semantic = collectCompileDiagnostics(compile(BROKEN, "проба.osnova")).find(
      (d) => d.phase === "семантика",
    )!;
    const line = formatCompileDiagnostic(semantic);

    // Формат заморожен: `[фаза] файл: вид: сообщение`. Машинная запись — не он.
    expect(line).toBe(`[семантика] проба.osnova: undeclared_var: ${semantic.message}`);
    expect(line.startsWith("{"), "человеку не отдаётся JSON").toBe(false);
  });

  it("рабочая программа молчит в обоих форматах — негативный контроль", () => {
    const good = compile(GOOD, "проба.osnova");

    expect(good.module, "модуль собран").not.toBeNull();
    expect(renderToStrings(good), "человеческих строк").toHaveLength(0);
    expect(renderJson(good), "машинных строк").toHaveLength(0);
    expect(renderJson(good, GOOD), "и с исходником — ни строки").toHaveLength(0);
  });

  it("отказ БЕЗ диагностики несёт OSN-CG-002 — и в записи, и в JSONL", () => {
    const records = collectCompileDiagnostics(SILENT);

    // Запись-признак рождается в сборщике, а не в печати: её обязан видеть и
    // журнал прогонов, который ничего не печатает.
    expect(records, "запись-признак").toHaveLength(1);
    expect(records[0]!.code).toBe(INTERNAL_CODES.refusalWithoutDiagnostics);
    expect(records[0]!.code).toBe("OSN-CG-002");

    const json = renderJson(SILENT);
    expect(json, "молчащего отказа в JSON-режиме нет").toHaveLength(1);
    expect((JSON.parse(json[0]!) as { code: string }).code).toBe("OSN-CG-002");
  });

  it("вид вне каталога получает МАРКЕР дефекта каталога, а не пусто и не чужой код", () => {
    // Проба на расхождение компилятора и каталога: `SemanticError.kind` —
    // закрытый союз, и вид «вне каталога» выражается только приведением. Это
    // и есть предмет проверки: что случится, когда союз обгонит каталог.
    const drifted: CompileResult = {
      ...SILENT,
      semanticErrors: [
        {
          kind: "вид_вне_каталога",
          message: "вид, которого в каталоге нет",
          file: "проба.osnova",
        } as unknown as SemanticError,
      ],
    };

    expect(diagnosticCodeOf("вид_вне_каталога"), "проба осмысленна: вида нет").toBeUndefined();

    const records = collectCompileDiagnostics(drifted);
    expect(records, "запись одна: отказ назван, признак не добавляется").toHaveLength(1);
    expect(records[0]!.code, "маркер каталога, а не литерал здесь").toBe(
      UNCATALOGUED_CODES.kindNotCatalogued,
    );
    expect(records[0]!.code, "код отличим от кода любого вида").toBe("OSN-SEM-000");
    expect(records[0]!.code, "код проходит проверку формы — иначе запись потерялась бы").toMatch(
      /^OSN-[A-Z]{2,3}-\d{3}$/,
    );
    // Три «почти правильных» ответа, каждый из которых эта проверка отсекает:
    expect(records[0]!.code, "не пустая строка").not.toBe("");
    expect(records[0]!.code, "не код соседнего вида").not.toBe(diagnosticCodeOf("undeclared_var"));
    expect(records[0]!.severity, "неизвестный вид не блокирует — как и до каталога").toBe(
      "предупреждение",
    );
    expect(formatCompileDiagnosticJson(records[0]!)).toContain('"code":"OSN-SEM-000"');
  });
});

describe("CLI: --diagnostics=json — машинный канал", () => {
  it("разбор флага: умолчание — human, чужое значение — названный отказ", () => {
    expect(parseDiagnosticsFormat([]), "без флага поведение не меняется").toBe("human");
    expect(parseDiagnosticsFormat(["--warn-deprecated"])).toBe("human");
    expect(parseDiagnosticsFormat(["--diagnostics=json"])).toBe("json");
    expect(parseDiagnosticsFormat(["--diagnostics=human"])).toBe("human");
    expect(parseDiagnosticsFormat(["--diagnostics=xml"]), "опечатка не молчит").toBeNull();
    expect(parseDiagnosticsFormat(["--diagnostics"])).toBeNull();
  });

  it("неверный формат: код 1 и причина названа, файл не читается", () => {
    const err: string[] = [];
    const code = runCompileCli(["--diagnostics=xml", "нет-такого-файла.osnova"], {
      out: () => {},
      err: (l) => err.push(l),
    });

    expect(code, "код возврата").toBe(1);
    expect(err.join("\n"), "названо, что поддержано").toContain("--diagnostics=json");
  });

  it("битый файл: код 1, stdout — только JSONL, stderr пуст", () => {
    const file = writeTemp(BROKEN, "osnova-diag-json-");
    const r = runEntry("src/compiler/cli.ts", [file, "--diagnostics=json"]);

    expect(r.code, "код возврата не зависит от формата").toBe(1);
    const lines = linesOf(r.out);
    expect(lines, "две записи — две строки").toHaveLength(2);
    expect(lines.map((l) => (JSON.parse(l) as { code: string }).code)).toEqual([
      diagnosticCodeOf("undeclared_var"),
      PHASE_CODES.сборка,
    ]);
    expect(r.err, "человеческих строк в JSON-режиме нет").toBe("");
  });

  it("рабочая программа: код 0 и ни строки ни в одном потоке", () => {
    const file = writeTemp(GOOD, "osnova-diag-json-ok-");
    const r = runEntry("src/compiler/cli.ts", [file, "--diagnostics=json"]);

    expect(r.code).toBe(0);
    expect(r.out, "stdout в JSON-режиме несёт только JSONL").toBe("");
    expect(r.err).toBe("");
  });

  it("предупреждения разбора в JSON-режиме не смешиваются с машинным потоком", () => {
    const file = writeTemp(
      ["модуль t", "процедура главная()", "  вернуть 0", "конец", "конец"].join("\n"),
      "osnova-diag-json-dep-",
    );
    const out: string[] = [];
    const err: string[] = [];
    const code = runCompileCli([file, "--warn-deprecated", "--diagnostics=json"], {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });

    expect(code, "предупреждение — не ошибка: код возврата не меняется").toBe(0);
    expect(err, "человеческих строк в JSON-режиме нет").toEqual([]);
    const parsed = out.map((l) => JSON.parse(l) as { code: string; phase: string; severity: string });
    expect(parsed, "два legacy-закрытия — две записи").toHaveLength(2);
    expect(
      parsed.every((r) => r.code === PHASE_CODES.парсер && r.severity === "предупреждение"),
      "предупреждение идёт той же формой записи, что и отказ",
    ).toBe(true);
  });

  it("установленный `osnova` (src/cli.ts compile) понимает тот же флаг", () => {
    const broken = writeTemp(BROKEN, "osnova-diag-json-cli-");
    const r = runEntry("src/cli.ts", ["compile", broken, "--diagnostics=json"]);

    expect(r.code).toBe(1);
    expect(linesOf(r.out), "две записи — две строки").toHaveLength(2);
    expect(r.err).toBe("");
  });

  it("установленный `osnova`: рабочая программа в JSON-режиме молчит", () => {
    const good = writeTemp(GOOD, "osnova-diag-json-cli-ok-");
    const r = runEntry("src/cli.ts", ["compile", good, "--diagnostics=json"]);

    expect(r.code).toBe(0);
    expect(r.out, "«Скомпилировано:» — человеческая строка, в машинном потоке ей места нет").toBe(
      "",
    );
    expect(r.err).toBe("");
  });
});

describe("отказ ДО компиляции: в машинном канале он тоже запись", () => {
  it("файла нет: одна запись OSN-CLI-002 с путём, человеческих строк нет", () => {
    const missing = path.join(os.tmpdir(), "osnova-нет-такого-файла.osnova");
    const out: string[] = [];
    const err: string[] = [];
    const code = runCompileCli([missing, "--diagnostics=json"], {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });

    expect(code, "код возврата").toBe(1);
    expect(err, "человеческих строк в машинном режиме нет").toEqual([]);
    expect(out, "ровно одна запись").toHaveLength(1);
    const parsed = JSON.parse(out[0]!) as Record<string, unknown>;
    expect(Object.keys(parsed), "порядок ключей записи").toEqual([
      "code",
      "phase",
      "severity",
      "message",
      "file",
    ]);
    expect(parsed.code, "код из каталога").toBe(CLI_CODES.inputNotFound);
    expect(parsed.phase, "фаза названа: ни одна фаза компилятора не работала").toBe("вызов");
    expect(parsed.severity).toBe("ошибка");
    expect(parsed.file, "путь едет полем, а не текстом").toBe(path.resolve(missing));
  });

  it("входного файла нет: одна запись OSN-CLI-001, поля file нет", () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = runCompileCli(["--diagnostics=json"], {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });

    expect(code).toBe(1);
    expect(err).toEqual([]);
    expect(out).toHaveLength(1);
    const parsed = JSON.parse(out[0]!) as Record<string, unknown>;
    expect(parsed.code).toBe(CLI_CODES.inputMissing);
    expect(parsed.phase).toBe("вызов");
    expect("file" in parsed, "пути нет — и поля нет, а не null").toBe(false);
  });

  it("человеческий режим тех же отказов не изменился, stdout пуст — негативный контроль", () => {
    const missing = path.join(os.tmpdir(), "osnova-нет-такого-файла.osnova");
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) };

    expect(runCompileCli([missing], io), "файла нет: код").toBe(1);
    expect(out, "человеку stdout не засоряется").toEqual([]);
    expect(err, "прежняя строка — ровно она").toEqual([`Файл не найден: ${path.resolve(missing)}`]);

    out.length = 0;
    err.length = 0;
    expect(runCompileCli([], io), "входного файла нет: код").toBe(1);
    expect(out).toEqual([]);
    expect(err, "прежняя подсказка").toHaveLength(1);
    expect(err[0]).toContain("Использование: osnova-compile");
  });

  it("три точки входа дают ОДНУ И ТУ ЖЕ запись, а не три похожие", () => {
    const missing = path.join(os.tmpdir(), "osnova-нет-такого-файла.osnova");
    const entries: Array<[string, string[]]> = [
      ["src/compiler/cli.ts", [missing, "--diagnostics=json"]],
      ["src/cli.ts", ["compile", missing, "--diagnostics=json"]],
      ["src/cli/index.ts", ["compile", missing, "--diagnostics=json"]],
    ];
    const lines: string[] = [];
    for (const [entry, argv] of entries) {
      const r = runEntry(entry, argv);
      expect(r.code, `${entry}: код возврата`).toBe(1);
      expect(r.err, `${entry}: человеческих строк нет`).toBe("");
      const entryLines = linesOf(r.out);
      expect(entryLines, `${entry}: ровно одна запись`).toHaveLength(1);
      expect((JSON.parse(entryLines[0]!) as { code: string }).code).toBe(CLI_CODES.inputNotFound);
      lines.push(entryLines[0]!);
    }

    expect(new Set(lines).size, "канал один: записи совпали побайтово").toBe(1);
  });

  it("человеческий режим: файла нет — прежняя строка, stdout пуст", () => {
    const missing = path.join(os.tmpdir(), "osnova-нет-такого-файла.osnova");
    const r = runEntry("src/compiler/cli.ts", [missing]);

    expect(r.code).toBe(1);
    expect(r.out, "человеческое уходит в stderr, и только оно").toBe("");
    expect(r.err.trim()).toBe(`Файл не найден: ${path.resolve(missing)}`);
  });

  it("`-o` вместе с `--diagnostics=json`: байткод записан, stdout пуст", () => {
    const file = writeTemp(GOOD, "osnova-diag-json-out-");
    const artifact = `${file}.osvbc.json`;
    const r = runEntry("src/compiler/cli.ts", [file, "-o", artifact, "--diagnostics=json"]);

    expect(r.code, "успешная сборка").toBe(0);
    expect(r.out, "машинный поток пуст: диагностик нет").toBe("");
    expect(r.err).toBe("");
    expect(fs.existsSync(artifact), "артефакт записан").toBe(true);
    const module = JSON.parse(fs.readFileSync(artifact, "utf-8")) as { procedures?: unknown[] };
    expect(Array.isArray(module.procedures), "это модуль, а не пустой файл").toBe(true);
  });
});
