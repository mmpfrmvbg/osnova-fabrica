// ============================================================
// src/pipeline/failureKind.ts — классификация причины отказа прогона
//
// Зачем отдельный модуль: `last_error_kind` в трейсах и в
// `runs/repair-failures.jsonl` был бесполезен — 683 записи из 693 давали
// `unknown`. Причина: `extractLastErrorKind` смотрел только на `BuildReport`.
// Когда сборка проходила, а прогон падал на исполнении (golden), классификатор
// не имел входных данных и честно возвращал `unknown`. По замеру
// (`docs/trace-failure-report.md`) это 42 % реальных отказов.
//
// Модуль — ЧИСТАЯ функция без побочных эффектов: он только НАЗЫВАЕТ причину.
// Он ничего не меняет ни в парсере, ни в лексере, ни в промптах.
//
// Возвращаемый тип — `string`, а не литеральный союз: для семантических ошибок
// возвращается их собственный kind (`redeclare_var`, `unknown_syscall`, …),
// который ведётся в `semanticKinds.ts` и здесь не дублируется.
// ============================================================

import type { BuildReport, GoldenReport } from './types';
import { BLOCKING_SEMANTIC_KINDS } from '../compiler/semanticKinds';

const BLOCKING = new Set<string>(BLOCKING_SEMANTIC_KINDS);

/**
 * Подвиды отказа ПАРСЕРА, которые различает классификатор.
 *
 * Это самая частая причина отказа сборки (см. `docs/trace-failure-report.md`):
 * 52 × `=` вместо `==`, 49 × ранний/лишний `конец`, 20 × `:=`,
 * 8 × `конец` как имя параметра.
 *
 * Различение сделано ПО ТЕКСТУ сообщения парсера — сам парсер не тронут.
 */
export const PARSER_FAILURE_KINDS = [
  'parser_eq_in_condition',
  'parser_missing_module_end',
  'parser_colon_assign',
  'parser_keyword_as_name',
  'parser_error',
] as const;

export type ParserFailureKind = (typeof PARSER_FAILURE_KINDS)[number];

/** Причины отказа ИСПОЛНЕНИЯ (фаза golden) — те, что раньше гасились в `unknown`. */
export const EXECUTION_FAILURE_KINDS = ['vm_error', 'golden_diff', 'golden_fail'] as const;

export type ExecutionFailureKind = (typeof EXECUTION_FAILURE_KINDS)[number];

/**
 * Разбирает сообщение парсера в подвид.
 *
 * Берётся ПЕРВОЕ сообщение: ошибки парсера каскадны, и первое обычно и есть
 * корневая причина, а последующие — её следствия.
 *
 * Сопоставление идёт подстроками намеренно: это наблюдаемость, а не логика
 * компилятора. Если формулировка в парсере изменится, подвид деградирует до
 * `parser_error` — но не сломается и не соврёт.
 */
export function classifyParserMessage(message: string): ParserFailureKind {
  if (/получено:\s*=$/.test(message)) return 'parser_eq_in_condition';
  if (message.includes("Ожидается 'модуль'")) return 'parser_missing_module_end';
  if (message.includes('Ожидается начало следующего модуля')) return 'parser_missing_module_end';
  if (message.includes('Ожидается имя типа')) return 'parser_colon_assign';
  // Без \b: в JavaScript \b ASCII-only и после кириллицы не срабатывает.
  // Это уже третья встреча класса за сессию — см. docs/trace-failure-report.md §7.
  if (/получено:\s*конец/.test(message)) return 'parser_keyword_as_name';
  return 'parser_error';
}

/**
 * Причина отказа СБОРКИ. Порядок приоритета сохранён таким же, как был в
 * `extractLastErrorKind`: blocking semantic → compiler → parser → lexer →
 * non-blocking semantic → unknown.
 */
export function classifyBuildFailure(report: BuildReport | undefined): string {
  if (!report) return 'unknown';

  const blocking = (report.semanticErrors ?? []).filter((e) => BLOCKING.has(e.kind));
  if (blocking.length > 0) return blocking[blocking.length - 1]!.kind;

  if ((report.compilerErrors ?? []).length > 0) {
    const last = report.compilerErrors![report.compilerErrors!.length - 1]!;
    return (last as { kind?: string }).kind ?? 'compiler_error';
  }

  if ((report.parserErrors ?? []).length > 0) {
    return classifyParserMessage(report.parserErrors![0]!.message);
  }

  if ((report.lexerErrors ?? []).length > 0) return 'lexer_error';

  if ((report.semanticErrors ?? []).length > 0) {
    return report.semanticErrors![report.semanticErrors!.length - 1]!.kind ?? 'semantic_warning';
  }

  return 'unknown';
}

/** Причина отказа ИСПОЛНЕНИЯ (фаза golden). */
export function classifyGoldenFailure(golden: GoldenReport | undefined): ExecutionFailureKind | 'unknown' {
  if (!golden) return 'unknown';
  if ((golden.vmErrors ?? []).length > 0) return 'vm_error';
  if (golden.outputDiff) return 'golden_diff';
  if (!golden.passed) return 'golden_fail';
  return 'unknown';
}

/**
 * Причина отказа прогона целиком.
 *
 * Сначала сборка: если она не прошла — причина там. Если сборка чистая, а
 * golden провален — причина на исполнении. Это и есть случай, который раньше
 * давал `unknown`.
 */
export function classifyFailure(
  report: BuildReport | undefined,
  golden?: GoldenReport,
): string {
  const build = classifyBuildFailure(report);
  if (build !== 'unknown') return build;
  return classifyGoldenFailure(golden);
}
