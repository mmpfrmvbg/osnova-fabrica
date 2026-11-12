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
 * **8**: `break_outside_loop` и `continue_outside_loop` перешли в блокирующие,
 * потому что программа с ними **не собирается** (`BuildReport.success = false`,
 * `compilerSuccess = false`, модуля нет — замер `.tmp/diag-break.osnova`,
 * `.tmp/diag-continue.osnova`). Состояние обязано совпадать с судьбой сборки:
 * иначе отказ печатался «советом» и не уходил в repair-цикл.
 *
 * **Неблокирующий список не расширен — и это решение, а не забывчивость**
 * (задача T12). Три живых вида, стоявшие с долгом (`arg_count_mismatch`,
 * `sentinel_pattern`, `unknown_module`), получили названное состояние
 * `"неблокирующий-вне-списка"`: они живы и сборку проходят, но потребителям не
 * отданы. Цена расширения измерена и названа (`.tmp/diag-consumers-probe.ts`):
 * отдать их — значит родить `DiagnosticAgent` **+3** записи (видимых видов 9 → 12
 * из 15, молча отброшенных 6 → 3) и положить `RepairEngineer` **+3** вида в промпт
 * ремонта (9 → 12). Это поведение замороженного пайплайна, поэтому решение о нём —
 * владельца: расширение отклонено, а числа отказа закреплены здесь, чтобы оно не
 * стало тихим.
 *
 * Мёртвые виды (`state: "недостижимый"`, три штуки) не входят ни в один список:
 * маршрутизировать нечего — исходный текст их не порождает.
 */

/** Запись каталога блокирует сборку — вид идёт в блокирующий список. */
function isBlockingEntry(entry: DiagnosticKindInfo): entry is BlockingEntry {
  return entry.state === 'блокирующий';
}

/** Запись отнесена к неблокирующим: вид жив, сборку проходит и отдан потребителям. */
function isNonBlockingEntry(entry: DiagnosticKindInfo): entry is NonBlockingEntry {
  return entry.state === 'неблокирующий';
}

/**
 * Вид, блокирующий сборку: `BuildReport.success = false` и маршрут в repair-цикл.
 * Множество выведено из каталога — 8 видов.
 */
export type BlockingSemanticKind = BlockingDiagnosticKind;

/**
 * Вид-диагностика: попадает в отчёты, но сборку не останавливает. Множество
 * выведено из каталога — 1 вид. Не путать с состоянием
 * `"неблокирующий-вне-списка"` (три вида): те тоже не блокируют, но потребителям
 * не отданы — расширение этого списка отклонено владельцем, цена названа выше.
 */
export type NonBlockingSemanticKind = NonBlockingDiagnosticKind;

/**
 * ЛЮБОЙ вид семантической ошибки, какой бывает в языке, — все 15 каталога. Это
 * тип поля `SemanticError.kind` (`semantic.ts`).
 *
 * Не путать с `ALL_SEMANTIC_KINDS` ниже: там 12 — то, что **отнесено** к спискам.
 * Мёртвые виды каталога (`state: "недостижимый"`) входят сюда, но ни в один
 * список — нет: порождать их нечему.
 */
export type SemanticKind = DiagnosticKind;

/**
 * Blocking semantic error kinds.
 * При наличии хотя бы одного — pipeline маршрутизирует в repair-цикл.
 * Новый блокирующий вид помечается `state: 'блокирующий'` в каталоге, а не здесь.
 */
export const BLOCKING_SEMANTIC_KINDS: readonly BlockingSemanticKind[] = DIAGNOSTIC_KINDS
  .filter(isBlockingEntry)
  .map((entry) => entry.kind);

/**
 * Non-blocking semantic diagnostics.
 * Не запускают repair-цикл, но должны попадать в отчеты.
 *
 * Порядок — каталожный (порядок выдачи кодов). Перечень менялся один раз за
 * 2026-09-28, и перемена названа: `break_outside_loop` и
 * `continue_outside_loop` ушли в блокирующий список (сборка не проходит), поэтому
 * список сузился до одного вида. Три живых вида, стоявших с долгом, в список НЕ
 * вошли — расширение отклонено владельцем (T12), цена названа в шапке файла.
 * На поведение порядок не влияет — все потребители строят из списка `Set` или
 * спрашивают `includes`, — но перемену сторож называет вслух, чтобы она не была
 * тихой.
 */
export const NON_BLOCKING_SEMANTIC_KINDS: readonly NonBlockingSemanticKind[] = DIAGNOSTIC_KINDS
  .filter(isNonBlockingEntry)
  .map((entry) => entry.kind);

/**
 * Списки потребителей: blocking + non-blocking, без дублей. **Девять из
 * пятнадцати** (2026-09-28, задача T12 — число не сдвинулось): шесть видов стоят
 * вне списков, но теперь у каждого названное состояние — три мёртвых
 * (`"недостижимый"`) и три живых, потребителям не отданных
 * (`"неблокирующий-вне-списка"`). Безымянного состояния «не отнесён ни к одному»
 * больше нет. Имя сохранено ради импортёров, а полный перечень видов — каталог.
 */
export const ALL_SEMANTIC_KINDS: readonly (BlockingSemanticKind | NonBlockingSemanticKind)[] = [
  ...BLOCKING_SEMANTIC_KINDS,
  ...NON_BLOCKING_SEMANTIC_KINDS,
];
