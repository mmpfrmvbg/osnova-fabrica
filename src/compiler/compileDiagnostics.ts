/**
 * Единственное место, где знание компилятора превращается в строки для человека
 * и в записи для машин.
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
 * (`lexerErrors`, `parserErrors`, `semanticErrors`, `compilerErrors`) и **два**
 * формата одной и той же записи: строка для человека (`formatCompileDiagnostic`)
 * и строка JSONL для инструментов (`formatCompileDiagnosticJson`). Формат
 * человека не менялся ни на символ: на него опираются существующие тесты и
 * привычка. `compilerErrors` содержит **зеркала** семантических ошибок с
 * префиксом `[semantic] ` (`compiler.ts`, `semanticAsCompiler`) — они
 * пропускаются, иначе одна ошибка печаталась бы дважды: структурная запись
 * (с `kind`, файлом и строкой) и её зеркало без них.
 *
 * **Коды берутся из каталога, а не заводятся здесь.** `./diagnosticCatalogue` —
 * источник правды: `diagnosticCodeOf(kind)` для семантики, `PHASE_CODES` для фаз,
 * у которых видов нет, `INTERNAL_CODES.refusalWithoutDiagnostics` для
 * записи-признака, `CLI_CODES` для отказов команды. Вид, которого в каталоге нет,
 * кода **не получает** — у него нет вида в каталоге, — и тогда стоит **маркер**
 * `UNCATALOGUED_CODES.kindNotCatalogued` (`OSN-SEM-000`): это названный дефект
 * каталога, а не код вида. Замер проверяющего 2026-09-28: здесь на такой вид
 * отдавалась пустая строка, а `src/trace/diagnosticsProjection.ts` держал свой
 * литерал `OSN-SEM-000` — два ответа на один вопрос, и пустая строка к тому же не
 * проходит проверку формы `OSN-…`, то есть запись потерялась бы молча. Теперь
 * маркер один и берётся из каталога; литерал здесь был бы тем же дрейфом.
 * Подставить «похожий» код вида — по-прежнему ложь в журнале, и сторож
 * (`./compileDiagnostics.test.ts`, проверка «вид вне каталога») краснеет и на
 * пустой строке, и на чужом коде.
 *
 * **Отказ не имеет права молчать.** Если модуля нет, а причин не названо ни
 * одной фазой, рождается запись-признак дефекта компилятора с кодом
 * `OSN-CG-002` — и рождается она в `collectCompileDiagnostics`, а не в печати.
 * Так её видят **все** потребители: и строки для человека, и JSONL, и журнал
 * прогонов, который о печати ничего не знает. Сторож — `./compileDiagnostics.test.ts`,
 * в том числе на сам молчащий путь (`src/cli.ts`), негативный контроль — рабочая
 * программа молчит в обоих форматах.
 *
 * **Машинный вывод.** `--diagnostics=json` (см. `./cliCompile.ts`) печатает
 * JSONL: одна запись — одна строка, порядок ключей стабилен
 * (`code, phase, severity, kind?, message, file?, line?, column?`). Машинный
 * поток не смешивается с человеческим: строки для человека уходят в stderr,
 * JSONL — в stdout, и в JSON-режиме человеческих строк не печатается вовсе.
 *
 * **Отказ до компиляции — тоже запись.** «Входной файл не указан» и «файл не
 * найден» — отказы команды, а не фаз: их записи несут фазу `вызов` и коды
 * каталога `OSN-CLI-001`/`OSN-CLI-002` (`CLI_CODES`, `./cliCompile.ts`). Без них
 * машинный канал повторял бы исходный дефект на новой стороне: пустой stdout и
 * код 1, по которым инструмент не отличает «диагностик нет» от «файла нет».
 */

import type { CompileResult } from "./compiler";
import { printParseError } from "./parser";
import {
  diagnosticCodeOf,
  isBlockingKind,
  INTERNAL_CODES,
  PHASE_CODES,
  UNCATALOGUED_CODES,
  type DiagnosticPhase,
  type DiagnosticSeverity,
} from "./diagnosticCatalogue";

/**
 * Словарь фаз и уровней — **из каталога**, а не свой.
 *
 * Своё объединение здесь уже было, и это ровно тот класс дрейфа, ради которого
 * каталог заведён: замер T1 2026-09-28 — у этого модуля был свой союз из пяти
 * фаз, у каталога из шести (с `исполнение`), и расхождение было невидимым.
 * Реэкспорт оставлен, чтобы у модуля не менялась поверхность для читателей.
 *
 * Фаза `вызов` (отказы команды до компиляции) объявлена в каталоге и внесена в
 * канон §12.4: русское имя фазы — как у остальных, код `OSN-CLI-*` остаётся
 * ASCII, как и все коды.
 */
export type { DiagnosticPhase, DiagnosticSeverity };

/** Формат записи: строка для человека или одна строка JSONL для инструментов. */
export type DiagnosticsFormat = "human" | "json";

/**
 * Одна запись об отказе: то, что человек обязан увидеть, и то, что можно посчитать.
 */
export interface CompileDiagnostic {
  /**
   * Стабильный машинный код из каталога: `OSN-SEM-002`, `OSN-LEX-001`,
   * `OSN-CG-002`, `OSN-CLI-001`. У вида, которого в каталоге нет, кода быть не
   * может — тогда стоит маркер `UNCATALOGUED_CODES.kindNotCatalogued`
   * (`OSN-SEM-000`): это названный дефект каталога, а не код вида.
   */
  code: string;
  phase: DiagnosticPhase;
  severity: DiagnosticSeverity;
  message: string;
  /** Вид ошибки (`SemanticError.kind`) — только у семантических записей. */
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

/** Настройки печати. `format` выбирает запись, `source` — подробный вывод парсера. */
export interface DiagnosticsReportOptions {
  source?: string;
  /** По умолчанию `human`: поведение без флага не меняется. */
  format?: DiagnosticsFormat;
}

/**
 * Код для семантического вида. Каталог — единственный источник: вида нет в
 * каталоге — стоит маркер дефекта каталога (`UNCATALOGUED_CODES.kindNotCatalogued`),
 * а не «похожий» код и не пустая строка: пустая не проходит проверку формы
 * `OSN-…`, и запись потерялась бы молча — ровно тогда, когда её начнёт читать
 * журнал (`src/trace/diagnosticsProjection.ts`, замер проверяющего 2026-09-28).
 */
const semanticCodeOf = (kind: string | undefined): string =>
  diagnosticCodeOf(kind) ?? UNCATALOGUED_CODES.kindNotCatalogued;

/**
 * Запись-признак: отказ есть, причины нет. Это дефект компилятора, и он обязан
 * быть назван, а не проглочен — поэтому запись рождается в сборщике, а не в
 * момент печати.
 */
const refusalWithoutDiagnostics = (): CompileDiagnostic => ({
  code: INTERNAL_CODES.refusalWithoutDiagnostics,
  phase: "сборка",
  severity: "ошибка",
  message:
    "отказ без диагностики: ни одна фаза не назвала причину — это дефект компилятора, а не программы",
});

/**
 * Зеркало семантической ошибки в `compilerErrors` — то же сообщение с префиксом
 * `[semantic] ` и **без** `kind`/`file`/`line` (`compiler.ts`). Печатать его
 * нельзя: структурная запись уже напечатана.
 */
const isSemanticMirror = (message: string): boolean => message.startsWith("[semantic] ");

/**
 * Собрать записи об отказе из результата компиляции. Чистая функция: никуда не
 * пишет — только переносит поля и берёт коды из каталога.
 *
 * Последняя запись — не перенос, а вывод: если модуля нет и **ни одна** фаза не
 * назвала причину, добавляется запись-признак `OSN-CG-002`. Она здесь, а не в
 * печати, чтобы молчащий отказ был виден и тому, кто считает, а не только тому,
 * кто печатает.
 */
export function collectCompileDiagnostics(result: CompileResult): CompileDiagnostic[] {
  const records: CompileDiagnostic[] = [];

  for (const e of result.lexerErrors) {
    records.push({
      code: PHASE_CODES.лексер,
      phase: "лексер",
      severity: "ошибка",
      message: e.message,
      line: e.line,
      column: e.column,
    });
  }

  for (const e of result.parserErrors) {
    records.push({
      code: PHASE_CODES.парсер,
      phase: "парсер",
      severity: "ошибка",
      message: e.message,
      line: e.line,
      column: e.column,
    });
  }

  for (const e of result.semanticErrors) {
    records.push({
      code: semanticCodeOf(e.kind),
      phase: "семантика",
      // Блокирующий вид — ошибка, неблокирующий — совет: `compilerSuccess`
      // остаётся истинным у неблокирующих (canon §13.10), и путать их нельзя.
      // Признак блокировки — из каталога (`isBlockingKind`), а не из местного
      // перечня: местный перечень и был одной из трёх разошедшихся копий.
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
      code: PHASE_CODES.сборка,
      phase: "сборка",
      severity: "ошибка",
      message: e.message,
      ...(e.file != null ? { file: e.file } : {}),
      ...(e.line != null ? { line: e.line } : {}),
      ...(e.column != null ? { column: e.column } : {}),
    });
  }

  if (records.length === 0 && result.module == null) {
    records.push(refusalWithoutDiagnostics());
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
 * Единственный формат машинной строки: одна запись — одна строка JSONL.
 *
 * Порядок ключей стабилен (`code, phase, severity, kind?, message, file?,
 * line?, column?`) — не ради красоты: журналы прошлых прогонов сравниваются
 * глазами и `diff`-ом, а необязательные поля **отсутствуют**, а не приходят
 * `null`-ом. `JSON.stringify` сохраняет порядок вставки для строковых ключей.
 */
export function formatCompileDiagnosticJson(d: CompileDiagnostic): string {
  const record: Record<string, string | number> = {
    code: d.code,
    phase: d.phase,
    severity: d.severity,
  };
  if (d.kind != null) record.kind = d.kind;
  record.message = d.message;
  if (d.file != null) record.file = d.file;
  if (d.line != null) record.line = d.line;
  if (d.column != null) record.column = d.column;
  return JSON.stringify(record);
}

/**
 * Напечатать всё, что компилятор знает об отказе, и вернуть число записей.
 *
 * Ошибки парсера печатаются `printParseError` (строка исходника + указатель),
 * когда исходник передан: это самый полезный вывод из существующих, и терять
 * его ради единообразия нельзя. В JSON-режиме подробный вывод не печатается —
 * он человеческий, а поток машинный; запись парсера уходит обычной JSONL-строкой.
 *
 * Уровень в JSON-режиме несёт поле `severity`, но стоки сохраняются: вызывающий
 * сам решает, что stdout, а что stderr (`./cliCompile.ts`, `diagnosticsSink`).
 */
export function reportCompileDiagnostics(
  result: CompileResult,
  sink: DiagnosticsSink,
  options: DiagnosticsReportOptions = {},
): number {
  const format = options.format ?? "human";
  const warn = sink.warning ?? sink.error;
  const emit = (d: CompileDiagnostic): void => {
    const line =
      format === "json" ? formatCompileDiagnosticJson(d) : formatCompileDiagnostic(d);
    if (d.severity === "предупреждение") warn(line);
    else sink.error(line);
  };

  let printed = 0;
  for (const d of collectCompileDiagnostics(result)) {
    if (format === "human" && d.phase === "парсер" && options.source != null) {
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

  return printed;
}
