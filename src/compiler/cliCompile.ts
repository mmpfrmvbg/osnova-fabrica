/**
 * Логика CLI компилятора (`osnova-compile`), отделённая от точки входа.
 *
 * Зачем отдельный модуль: `src/compiler/cli.ts` завершается `process.exit(main())`
 * на импорте, поэтому проверить флаги оракулом можно было только запуском
 * подпроцесса. Здесь — чистая функция `runCompileCli(argv, io)`: флаги, вывод,
 * код возврата; `cli.ts` остаётся тремя строками.
 *
 * Флаг `--warn-deprecated` (Стадия 2 плана v2) включает предупреждения об
 * устаревшем закрывающем `конец`. Предупреждение **информационное**: код
 * возврата не меняется, файл байткода пишется как обычно.
 *
 * Флаг `--diagnostics=json` включает машинный вывод: одна JSONL-строка на запись
 * (`./compileDiagnostics`), **только** на stdout, без человеческих строк. Правила
 * канала закреплены здесь, потому что точек входа у команды три
 * (`./cli.ts`, `src/cli.ts`, `src/cli/index.ts`) и они уже расходились один раз:
 *  * JSONL — всегда stdout, человеческие строки — всегда stderr;
 *  * код возврата не зависит от формата;
 *  * формат не поддержан — **названный** отказ (иначе опечатка в флаге молча
 *    давала бы человеческий вывод тому, кто просил машинный).
 */

import * as fs from "fs";
import * as path from "path";
import { compileSource } from ".";
import {
  formatCompileDiagnosticJson,
  reportCompileDiagnostics,
  type DiagnosticsFormat,
  type DiagnosticsSink,
} from "./compileDiagnostics";
import { PHASE_CODES, CLI_CODES } from "./diagnosticCatalogue";
import type { ParseWarning } from "./parser";

/** Куда CLI пишет. Инъекция — ради оракула, а не ради гибкости. */
export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

const DEFAULT_IO: CliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

/** Единственное место, где предупреждение превращается в строку вывода. */
export function formatDeprecatedWarning(w: ParseWarning): string {
  return `[устаревшее] строка ${w.line}:${w.column}: ${w.message}`;
}

/**
 * То же предупреждение в машинном виде. Фаза — `парсер`: предупреждение родил
 * разбор, и кода вида у него нет (каталог кодирует **виды ошибок**, а не
 * предупреждения); уровень несёт `severity`.
 */
export function formatDeprecatedWarningJson(w: ParseWarning): string {
  return formatCompileDiagnosticJson({
    code: PHASE_CODES.парсер,
    phase: "парсер",
    severity: "предупреждение",
    message: w.message,
    line: w.line,
    column: w.column,
  });
}

/**
 * Разобрать `--diagnostics=<формат>` из argv.
 *
 * `null` — форма флага не поддержана. Это не придирка: молчаливое умолчание на
 * `--diagnostics=xml` напечатало бы человеку человеческие строки, а инструменту —
 * ничего разбираемого, и оба решили бы, что диагностик нет.
 */
export function parseDiagnosticsFormat(argv: readonly string[]): DiagnosticsFormat | null {
  let format: DiagnosticsFormat = "human";
  for (const arg of argv) {
    if (arg === "--diagnostics" || arg === "--diagnostics=") return null;
    if (!arg.startsWith("--diagnostics=")) continue;
    const value = arg.slice("--diagnostics=".length);
    if (value !== "json" && value !== "human") return null;
    format = value;
  }
  return format;
}

/**
 * Стоки для выбранного формата. Машинный поток — только stdout: инструмент
 * читает его целиком, и одна человеческая строка в нём ломает разбор.
 */
export function diagnosticsSink(io: CliIo, format: DiagnosticsFormat): DiagnosticsSink {
  return format === "json"
    ? { error: io.out, warning: io.out }
    : { error: io.err, warning: io.err };
}

/**
 * Предупреждения разбора в выбранном формате. Вынесено сюда, чтобы три точки
 * входа не обзавелись тремя копиями правила (ровно так разошлась команда `compile`).
 */
export function reportParseWarnings(
  warnings: readonly ParseWarning[],
  io: CliIo,
  format: DiagnosticsFormat,
): void {
  for (const w of warnings) {
    if (format === "json") io.out(formatDeprecatedWarningJson(w));
    else io.err(formatDeprecatedWarning(w));
  }
}

/** Отказ команды **до** компиляции: причину назвала строка аргументов. */
export type CliRefusalKind = keyof typeof CLI_CODES;

/**
 * Причина отказа одной строкой. Одна на все три точки входа: человеческие строки
 * у них разные (у `src/cli/index.ts` — семь строк подсказки), а машинная запись
 * обязана быть одинаковой, иначе канал разъедется вместе с точками входа. Путь
 * едет полем `file`, а не текстом — по той же причине.
 */
const CLI_REFUSAL_MESSAGE: Record<CliRefusalKind, string> = {
  inputMissing: "не указан входной файл",
  inputNotFound: "файл не найден",
};

/**
 * Фаза записи об отказе команды — `вызов` (одно имя на всех: канон §12.4).
 * Коды при этом остаются ASCII (`OSN-CLI-*`), как и все коды каталога.
 */
const CLI_REFUSAL_PHASE = "вызов" as const;

/** Одна JSONL-запись отказа до компиляции; код — из каталога (`CLI_CODES`). */
export function formatCliRefusalJson(kind: CliRefusalKind, file?: string): string {
  return formatCompileDiagnosticJson({
    code: CLI_CODES[kind],
    phase: CLI_REFUSAL_PHASE,
    severity: "ошибка",
    message: CLI_REFUSAL_MESSAGE[kind],
    ...(file !== undefined ? { file } : {}),
  });
}

/**
 * Напечатать отказ **до** компиляции.
 *
 * Человеческий режим вызывает `human` — ровно тот вывод, что был до правки (его
 * формат заморожен, и у каждой точки входа он свой). Машинный печатает одну
 * запись с кодом каталога: пустой stdout на код 1 неотличим от «диагностик нет»,
 * и инструмент не узнал бы, что входного файла нет вовсе.
 */
export function reportCliRefusal(
  kind: CliRefusalKind,
  format: DiagnosticsFormat,
  io: CliIo,
  human: () => void,
  file?: string,
): void {
  if (format === "json") io.out(formatCliRefusalJson(kind, file));
  else human();
}

export function runCompileCli(argv: string[], io: CliIo = DEFAULT_IO): number {
  const format = parseDiagnosticsFormat(argv);
  if (format === null) {
    io.err(`Формат диагностики не поддержан. Допустимо: --diagnostics=json (или --diagnostics=human).`);
    return 1;
  }
  let input: string | null = null;
  let output: string | null = null;
  let warnDeprecated = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "-o" || argv[i] === "--output") {
      output = argv[++i] ?? null;
    } else if (argv[i] === "--warn-deprecated") {
      warnDeprecated = true;
    } else if (!argv[i]!.startsWith("-")) {
      input = argv[i]!;
    }
  }
  if (!input) {
    // Отказ до компиляции: в машинном режиме — запись `OSN-CLI-001`, а не пустой
    // stdout, по которому инструмент не отличил бы отказ от «диагностик нет».
    reportCliRefusal("inputMissing", format, io, () =>
      io.err(
        "Использование: osnova-compile input.osnova [-o output.osvbc.json] [--warn-deprecated] [--diagnostics=json]",
      ),
    );
    return 1;
  }
  const inputPath = path.resolve(input);
  if (!fs.existsSync(inputPath)) {
    reportCliRefusal(
      "inputNotFound",
      format,
      io,
      () => io.err(`Файл не найден: ${inputPath}`),
      inputPath,
    );
    return 1;
  }
  const source = fs.readFileSync(inputPath, "utf-8");
  const result = compileSource(source, {
    baseDir: path.dirname(inputPath),
    filename: path.basename(inputPath),
    warnDeprecated,
  });
  // Вывод один на все точки входа — `./compileDiagnostics`. Здесь раньше жила
  // четвёртая копия сборки строк, и она уходила от остальных: семантическая
  // ошибка печаталась зеркалом `[semantic] …` без вида и файла.
  reportCompileDiagnostics(result, diagnosticsSink(io, format), { source, format });
  // Предупреждения печатаются ДО проверки модуля: даже при отказе сборки
  // полезно видеть, что причина — не только устаревшая форма. В JSON-режиме они
  // уходят тем же машинным потоком: JSONL остаётся машинным только тогда, когда
  // в нём нет человеческих строк.
  reportParseWarnings(result.warnings, io, format);
  if (!result.module) {
    return 1;
  }
  const json = JSON.stringify(result.module, null, 2);
  const outPath = output ?? inputPath.replace(/\.osnova$/i, ".osvbc.json");
  fs.writeFileSync(path.resolve(outPath), json, "utf-8");
  // В JSON-режиме stdout несёт только JSONL: «Скомпилировано: …» — человеческая
  // строка, и в машинном потоке ей места нет (успех виден по коду 0 и файлу).
  if (format !== "json") io.out(`Скомпилировано: ${outPath}`);
  return 0;
}
