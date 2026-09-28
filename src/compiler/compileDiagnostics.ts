/**
 * Единственное место, где знание компилятора превращается в строки для человека.
 *
 * **Повод.** Одна команда `compile` жила в трёх реализациях — `./cliCompile.ts`,
 * `src/cli/index.ts` и `src/cli.ts` — и они разошлись. `src/cli.ts` (из него
 * собран установленный `osnova`, `dist/cli.js`) печатал лексер и парсер, а
 * `compilerErrors` не печатал **вовсе**: на семантической ошибке выходил кодом 1
 * с нулём строк вывода. Замер 2026-09-28: `compileSource` на такой программе
 * знает 2 семантические ошибки (`kind` + файл), 3 `compilerErrors` и 3 записи
 * `logs`, а пользователь не видел ни строки — то есть отказ был, а причины не
 * было. Канон называет это худшим видом отказа
 * (`docs/language-changelog-v2.md`: «Отказ без диагностики — худший вид отказа»).
 *
 * **Что здесь есть.** Сборка записей из того, что компилятор уже вернул
 * (`lexerErrors`, `parserErrors`, `semanticErrors`, `compilerErrors`) и один
 * формат строки. `compilerErrors` содержит **зеркала** семантических ошибок с
 * префиксом `[semantic] ` (`compiler.ts`, `semanticAsCompiler`) — они
 * пропускаются, иначе одна ошибка печаталась бы дважды: структурная запись
 * (с `kind`, файлом и строкой) и её зеркало без них.
 *
 * **Коды ошибок здесь нет намеренно.** `kind` — это то, что уже есть и уже
 * различает виды; числовой каталог кодов — отдельный шаг, и подменять его
 * строкой нельзя (иначе появится второй список видов рядом с тремя нынешними:
 * `semantic.ts` — 15, `semanticKinds.ts` — 9, канон — 11).
 *
 * **Отказ не имеет права молчать.** Если модуля нет, а причин не названо ни
 * одной фазой, печатается строка-признак дефекта компилятора, а не пустота.
 * Сторож — `./compileDiagnostics.test.ts`, в том числе на сам молчащий путь
 * (`src/cli.ts`), негативный контроль — рабочая программа молчит.
 */

import type { CompileResult } from "./compiler";
import { printParseError } from "./parser";
import { BLOCKING_SEMANTIC_KINDS } from "./semanticKinds";

/** Фаза, которая назвала причину. Русские имена — как в выводе CLI. */
export type DiagnosticPhase = "лексер" | "парсер" | "семантика" | "сборка";

export type DiagnosticSeverity = "ошибка" | "предупреждение";

/** Одна запись об отказе: то, что человек обязан увидеть, и то, что можно посчитать. */
export interface CompileDiagnostic {
  phase: DiagnosticPhase;
  severity: DiagnosticSeverity;
  message: string;
  /** Вид ошибки (`SemanticError.kind`). Числовых кодов у компилятора пока нет. */
  kind?: string;
  /** Файл исходника: свои процедуры — входной, встроенные — тот, откуда пришли. */
  file?: string;
  line?: number;
  column?: number;
}

/** Куда печатать. Два стока, потому что «ошибка» и «совет» — разные вещи. */
export interface DiagnosticsSink {
  error: (line: string) => void;
  warning?: (line: string) => void;
}

/** Вид из каталога блокирующих (`src/compiler/semanticKinds.ts`) — значит отказ, а не совет. */
const isBlockingKind = (kind: string | undefined): boolean =>
  kind !== undefined && (BLOCKING_SEMANTIC_KINDS as readonly string[]).includes(kind);

/**
 * Зеркало семантической ошибки в `compilerErrors` — то же сообщение с префиксом
 * `[semantic] ` и **без** `kind`/`file`/`line` (`compiler.ts`). Печатать его
 * нельзя: структурная запись уже напечатана.
 */
const isSemanticMirror = (message: string): boolean => message.startsWith("[semantic] ");

/**
 * Собрать записи об отказе из результата компиляции. Чистая функция: никуда не
 * пишет, ничего не решает про вид значения — только переносит поля.
 */
export function collectCompileDiagnostics(result: CompileResult): CompileDiagnostic[] {
  const records: CompileDiagnostic[] = [];

  for (const e of result.lexerErrors) {
    records.push({
      phase: "лексер",
      severity: "ошибка",
      message: e.message,
      line: e.line,
      column: e.column,
    });
  }

  for (const e of result.parserErrors) {
    records.push({
      phase: "парсер",
      severity: "ошибка",
      message: e.message,
      line: e.line,
      column: e.column,
    });
  }

  for (const e of result.semanticErrors) {
    records.push({
      phase: "семантика",
      // Блокирующий вид — ошибка, неблокирующий — совет: `compilerSuccess`
      // остаётся истинным у неблокирующих (canon §13.10), и путать их нельзя.
      severity: isBlockingKind(e.kind) ? "ошибка" : "предупреждение",
      message: e.message,
      kind: e.kind,
      ...(e.file != null ? { file: e.file } : {}),
      ...(e.line != null ? { line: e.line } : {}),
    });
  }

  for (const e of result.compilerErrors) {
    if (isSemanticMirror(e.message)) continue;
    records.push({
      phase: "сборка",
      severity: "ошибка",
      message: e.message,
      ...(e.file != null ? { file: e.file } : {}),
      ...(e.line != null ? { line: e.line } : {}),
      ...(e.column != null ? { column: e.column } : {}),
    });
  }

  return records;
}

/** Единственный формат строки. Место (`файл:строка:колонка`) — как в `formatErrorLoc`. */
export function formatCompileDiagnostic(d: CompileDiagnostic): string {
  const where =
    d.file != null
      ? `${d.file}${d.line != null ? `:${d.line}${d.column != null ? `:${d.column}` : ""}` : ""}`
      : d.line != null
        ? `строка ${d.line}${d.column != null ? `:${d.column}` : ""}`
        : "";
  const kind = d.kind != null ? `${d.kind}: ` : "";
  return `[${d.phase}] ${where !== "" ? `${where}: ` : ""}${kind}${d.message}`;
}

/**
 * Напечатать всё, что компилятор знает об отказе, и вернуть число записей.
 *
 * Ошибки парсера печатаются `printParseError` (строка исходника + указатель),
 * когда исходник передан: это самый полезный вывод из существующих, и терять
 * его ради единообразия нельзя. Остальные фазы — одной строкой.
 */
export function reportCompileDiagnostics(
  result: CompileResult,
  sink: DiagnosticsSink,
  options: { source?: string } = {},
): number {
  const warn = sink.warning ?? sink.error;
  const emit = (d: CompileDiagnostic): void => {
    if (d.severity === "предупреждение") warn(formatCompileDiagnostic(d));
    else sink.error(formatCompileDiagnostic(d));
  };

  let printed = 0;
  for (const d of collectCompileDiagnostics(result)) {
    if (d.phase === "парсер" && options.source != null) {
      const parseError = result.parserErrors.find(
        (e) => e.message === d.message && e.line === d.line && e.column === d.column,
      );
      if (parseError !== undefined) {
        printParseError(parseError, options.source, sink.error);
        printed += 1;
        continue;
      }
    }
    emit(d);
    printed += 1;
  }

  // Отказ без причины запрещён: пустой вывод на код возврата 1 — дефект
  // компилятора, и он обязан быть назван, а не проглочен.
  if (printed === 0 && result.module == null) {
    sink.error(
      "[сборка] отказ без диагностики: ни одна фаза не назвала причину — это дефект компилятора, а не программы",
    );
    printed += 1;
  }

  return printed;
}
