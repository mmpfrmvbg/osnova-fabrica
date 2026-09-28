// ============================================================
// src/compiler/semanticKinds.ts
// Списки видов семантических ошибок — ВЫВЕДЕНЫ из единого каталога.
// Источник правды: src/compiler/diagnosticCatalogue.ts
// Имена и значения сохранены: их импортируют ~15 файлов, включая
// замороженный пайплайн (src/pipeline/**) и src/agents/**.
// Совместимость импортов: реэкспорт в src/pipeline/semanticKinds.ts.
// ============================================================

import {
  DIAGNOSTIC_KINDS,
  type BlockingDiagnosticKind,
  type DiagnosticKind,
  type DiagnosticKindInfo,
  type NonBlockingDiagnosticKind,
  type BlockingEntry,
  type NonBlockingEntry,
} from './diagnosticCatalogue';

/**
 * **Зачем списки переехали в каталог (2026-09-28).** Виды ошибок жили тремя
 * несогласованными перечнями: здесь было 6 блокирующих + 3 неблокирующих,
 * `semantic.ts` порождал 15, канон перечислял 11. Шесть видов —
 * `arg_count_mismatch`, `chained_compare`, `keyword_param`, `sentinel_pattern`,
 * `unknown_module`, `export_collision` — не входили **ни в один**, то есть были
 * невидимы для каждого, кто спрашивает «блокирует ли это сборку»
 * (`compiler.ts` — `BuildReport.success`, `gateChecker.ts` — шлюз G2,
 * `orchestrator.ts`). Теперь оба списка выводятся из каталога, а расхождение с
 * ним ловит `diagnosticCatalogue.test.ts`.
 *
 * **Значения сдвинулись один раз, и по замеру (2026-09-28).** Блокирующих стало
 * **8**, неблокирующих — **1**: `break_outside_loop` и `continue_outside_loop`
 * перешли в блокирующие, потому что программа с ними **не собирается**
 * (`BuildReport.success = false`, `compilerSuccess = false`, модуля нет — замер
 * `.tmp/diag-break.osnova`, `.tmp/diag-continue.osnova`). Признак обязан
 * совпадать с судьбой сборки: иначе отказ печатался «советом» и не уходил в
 * repair-цикл. Сдвиг меняет поведение `DiagnosticAgent` (вид — ошибка, а не
 * совет) и маршрутизацию в repair; это и было целью правки, а не её побочным
 * эффектом. Виды с долгом каталога (`debt`) по-прежнему не попадают ни в один
 * список, потому что отнесены не были.
 */

/** Запись каталога блокирует сборку — вид идёт в блокирующий список. */
function isBlockingEntry(entry: DiagnosticKindInfo): entry is BlockingEntry {
  return entry.blocking;
}

/** Запись отнесена к неблокирующим: не блокирует **и** долга за ней нет. */
function isNonBlockingEntry(entry: DiagnosticKindInfo): entry is NonBlockingEntry {
  return !entry.blocking && entry.debt === undefined;
}

/**
 * Вид, блокирующий сборку: `BuildReport.success = false` и маршрут в repair-цикл.
 * Множество выведено из каталога — 8 видов.
 */
export type BlockingSemanticKind = BlockingDiagnosticKind;

/**
 * Вид-диагностика: попадает в отчёты, но сборку не останавливает. Множество
 * выведено из каталога — 1 вид.
 */
export type NonBlockingSemanticKind = NonBlockingDiagnosticKind;

/**
 * ЛЮБОЙ вид семантической ошибки, какой бывает в языке, — все 15 каталога. Это
 * тип поля `SemanticError.kind` (`semantic.ts`).
 *
 * Не путать с `ALL_SEMANTIC_KINDS` ниже: там 9 — то, что **отнесено** к спискам.
 * Виды с долгом каталога входят сюда (компилятор их порождает), но ни в один
 * список — нет.
 */
export type SemanticKind = DiagnosticKind;

/**
 * Blocking semantic error kinds.
 * При наличии хотя бы одного — pipeline маршрутизирует в repair-цикл.
 * Новый блокирующий вид помечается `blocking: true` в каталоге, а не здесь.
 */
export const BLOCKING_SEMANTIC_KINDS: readonly BlockingSemanticKind[] = DIAGNOSTIC_KINDS
  .filter(isBlockingEntry)
  .map((entry) => entry.kind);

/**
 * Non-blocking semantic diagnostics.
 * Не запускают repair-цикл, но должны попадать в отчеты.
 *
 * Порядок — каталожный (порядок выдачи кодов). Прежний рукописный перечень был
 * (`break_outside_loop`, `continue_outside_loop`, `keyword_as_identifier`); с
 * 2026-09-28 первые два ушли в блокирующий список по замеру судьбы сборки,
 * поэтому список сузился до одного вида. На поведение порядок не влияет — все
 * потребители строят из списка `Set` или спрашивают `includes`, — но перемену
 * сторож называет вслух, чтобы она не была тихой.
 */
export const NON_BLOCKING_SEMANTIC_KINDS: readonly NonBlockingSemanticKind[] = DIAGNOSTIC_KINDS
  .filter(isNonBlockingEntry)
  .map((entry) => entry.kind);

/**
 * Списки потребителей: blocking + non-blocking, без дублей. **Девять из
 * пятнадцати** (2026-09-28): шесть видов с долгом не отнесены ни к одной
 * половине, поэтому здесь их нет. Имя сохранено ради импортёров, а полный
 * перечень видов — каталог.
 */
export const ALL_SEMANTIC_KINDS: readonly (BlockingSemanticKind | NonBlockingSemanticKind)[] = [
  ...BLOCKING_SEMANTIC_KINDS,
  ...NON_BLOCKING_SEMANTIC_KINDS,
];
