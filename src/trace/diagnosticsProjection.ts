/**
 * ДИАГНОСТИКА ПРОГОНА КАК ЗАПИСЬ ЖУРНАЛА — одна чистая проекция на все пути.
 *
 * **Повод (замер 2026-09-28).** В живом `runs/traces.jsonl` (7153 строки)
 * `buildReport.semanticErrors` заполнены в **43** записях, поля `diagnostics` не
 * было ни в одной, а события VM не попадали в журнал вовсе: `GoldenReport.vmErrors`
 * журнал хранит, но причины отказа исполнения не имеют машинной личности. По
 * журналу нельзя было ответить на вопрос «какие отказы у нас бывают и сколько их» —
 * только «сколько семантических ошибок» и «kind последней».
 *
 * **Что здесь есть.** Перенос уже существующей диагностики в записи
 * `DiagnosticRecord` (код + фаза + уровень) и ничего больше:
 * - `semanticErrors` → код из каталога видов (`diagnosticCodeOf`), уровень по
 *   признаку `blocking` — блокирующий вид это ошибка, неблокирующий совет;
 * - `lexerErrors` / `parserErrors` / `compilerErrors` → коды фаз
 *   (`PHASE_CODES`), зеркала `[semantic] …` пропускаются ровно как в
 *   `src/compiler/compileDiagnostics.ts` (иначе одна ошибка считалась бы дважды);
 * - `vmErrors` → фаза `исполнение`, код `OSN-RT-*` **из поля записи** (читается
 *   тем же `runtimeErrorCodeOf`, что и в VM) — `vmErrorRecordOf`
 *   (`src/runtime/goldenApps.ts`) проставляет его с 2026-09-28; запись без кода
 *   получает `OSN-RT-000` («код не назван», `internal: true` в таблице VM).
 *
 * **Измеренный разрыв, закрытый 2026-09-28.** Коды исполнения до журнала не
 * доходили: `vmErrors` собирались из одного `e.message`, и код терялся — замер
 * живого журнала дал 51 отказ исполнения, **все** без кода. Проверка после правки
 * T2 (`.tmp/osnova-rt-code-path.ts`): `goldenReport.vmErrors` =
 * `[{message:"Integer division by zero", code:"OSN-RT-002", op:"idiv", pc:6}]`,
 * проекция даёт `OSN-RT-002`. Числа, записанные до правки, код не несут нигде и
 * задним числом не восстанавливаются — это и есть 51 × `OSN-RT-000` в замере.
 *
 * **Проекция, а не копия.** Подробности (`ParserError.node`, `VMError.stack`,
 * текст исходника) остаются во вложенных отчётах записи: `diagnostics` — это
 * **исчисляемый** слой. Сознательно не переносятся и не порождаются:
 * - текст исходника и переменные окружения — журнал не канал утечки;
 * - «не сошлось с эталоном» (`qualityScore`, `outputDiff`) — это не ошибка с
 *   кодом, и выдумывать ей код нельзя: причину несёт сам отчёт.
 *
 * **Отказ без диагностики — тоже событие.** Если сборка провалилась, а ни одна
 * фаза причины не назвала, пишется `OSN-CG-002` (`INTERNAL_CODES`): по каталогу
 * такая запись означает дефект компилятора, а не ошибку программы. Если исполнение
 * отказало, а код не назван (запись старше контракта либо путь VM без кода) —
 * `OSN-RT-000` (`RUNTIME_CODES.unnamedRefusal`, `internal: true`). Оба кода видны
 * в сводке не как «рядовой отказ»: `OSN-RT-000` — внутренний код таблицы VM, и
 * отчёт помечает такие коды отдельно; код вне каталога попадает в `unknownCodes`.
 * Ни один из них не растворяется среди известных причин.
 *
 * **Коды, которых нет в каталоге, не отбрасываются.** Код выдаётся один раз и не
 * переиспользуется: запись, написанная более новым кодом, обязана читаться
 * старым — поэтому схема проверяет **форму** кода (`OSN-<ФАЗА>-<НОМЕР>`), а
 * расхождение с каталогом делает явным сводка. Это решение закреплено тестом
 * (`diagnosticsProjection.test.ts`), как и негативный контроль: мусор в поле
 * `code` записью не становится.
 */

import {
  CLI_CODES,
  DIAGNOSTIC_KINDS,
  INTERNAL_CODES,
  PHASE_CODES,
  UNCATALOGUED_CODES,
  diagnosticCodeOf,
  isBlockingKind,
} from '../compiler/diagnosticCatalogue';
import { RUNTIME_CODES, RUNTIME_CODE_TABLE, runtimeErrorCodeOf } from '../runtime/runtimeCodes';
import type { DiagnosticPhase, DiagnosticRecord } from './types';

/**
 * Вход проекции — **структурный**, а не `BuildReport`/`GoldenReport` из
 * `src/pipeline/types.ts`. Причина: тот же замер читает журнал, разобранный
 * схемой (`TraceEntryParsed`), и её типы не совпадают с объявленными один в один
 * (zod выводит `kind: string`, объявление — союз видов). Приводить типы на
 * границе значило бы прятать дрейф; здесь проекция просит ровно те поля, которые
 * читает, и объявленные типы пайплайна подходят под неё без приведения.
 */
export interface BuildReportLike {
  readonly success?: boolean;
  readonly compilerSuccess?: boolean;
  readonly lexerErrors?: readonly {
    readonly message: string;
    readonly line?: number;
    readonly column?: number;
  }[];
  readonly parserErrors?: readonly {
    readonly message: string;
    readonly line?: number;
    readonly column?: number;
  }[];
  readonly semanticErrors?: readonly {
    readonly message: string;
    readonly kind: string;
    readonly line?: number;
    readonly file?: string;
  }[];
  readonly compilerErrors?: readonly {
    readonly message: string;
    readonly kind?: string;
    readonly file?: string;
    readonly line?: number;
    readonly column?: number;
  }[];
}

export interface GoldenReportLike {
  readonly executed?: boolean;
  readonly vmErrors?: readonly { readonly message: string; readonly code?: unknown }[];
}

/**
 * Код семантической ошибки, вида которой нет в каталоге. Живёт **в каталоге**
 * (`UNCATALOGUED_CODES.kindNotCatalogued`): до 2026-09-28 это был литерал здесь, а
 * `src/compiler/compileDiagnostics.ts` отвечал на тот же вопрос пустой строкой —
 * два модуля по-разному. Пустая строка к тому же не проходит проверку формы, и
 * запись терялась бы молча. `000` читается как «номер не присвоен»; появление
 * такого кода означает дрейф каталога от компилятора, и сводка называет его вслух
 * (`unknownCodes` — пока каталог его не объявил; после объявления он в каталоге).
 */
export const UNCATALOGUED_KIND_CODE: string = UNCATALOGUED_CODES.kindNotCatalogued;

/**
 * Код отказа исполнения, который код не назвал. Живёт **в таблице VM**
 * (`RUNTIME_CODES.unnamedRefusal`, `internal: true`) — там же, где все остальные
 * коды: два имени одного кода разъехались бы молча. Смысл кода по таблице:
 * «отказ исполнения, код которого не назван — разрыв канала, а не свойство
 * программы».
 *
 * Замер живого журнала 2026-09-28 (до правки golden-пути): 51 отказ исполнения,
 * **все** без кода; в 54 записях с непустыми `vmErrors` код не назван нигде —
 * ни полем, ни текстом. Именно поэтому маркер обязан быть исчисляемым.
 */
export const UNCODED_RUNTIME_CODE: string = RUNTIME_CODES.unnamedRefusal;

/** Сообщение «сборка провалилась, причин нет» — тот же смысл, что печатает CLI. */
const REFUSAL_WITHOUT_DIAGNOSTICS_MESSAGE =
  'отказ без диагностики: ни одна фаза не назвала причину — это дефект компилятора, а не программы';

/** Сообщение «исполнение не состоялось, причина не названа». */
const RUNTIME_WITHOUT_CAUSE_MESSAGE = 'исполнение не состоялось, причина не названа';

/** Форма кода: `OSN-SEM-001`, `OSN-CG-002`, `OSN-RT-900`. Пространство имён — ASCII. */
const CODE_SHAPE = /^OSN-[A-Z]{2,4}-\d{3}$/;

/** Проверка формы кода (не принадлежности каталогу — её делает `isKnownDiagnosticCode`). */
export function isDiagnosticCodeShape(value: unknown): value is string {
  return typeof value === 'string' && CODE_SHAPE.test(value);
}

/** Все коды, известные каталогам: виды, коды фаз, внутренние, CLI и коды исполнения. */
export function knownDiagnosticCodes(): ReadonlySet<string> {
  const codes = new Set<string>();
  for (const kind of DIAGNOSTIC_KINDS) codes.add(kind.code);
  for (const code of Object.values(PHASE_CODES)) codes.add(code);
  for (const code of Object.values(INTERNAL_CODES)) codes.add(code);
  // Маркеры и коды отказа ДО компиляции (`вызов`) — такой же каталог, как виды:
  // без них отчёт объявил бы «вне каталога» законные коды CLI.
  for (const code of Object.values(UNCATALOGUED_CODES)) codes.add(code);
  for (const code of Object.values(CLI_CODES)) codes.add(code);
  for (const rt of RUNTIME_CODE_TABLE) codes.add(rt.code);
  return codes;
}

const KNOWN_CODES = knownDiagnosticCodes();

/** Известен ли код каталогу. `false` — код либо новее каталога, либо это дефект. */
export function isKnownDiagnosticCode(code: string): boolean {
  return KNOWN_CODES.has(code);
}

/**
 * Поле `code` записи VM. Читается **тем же способом, что и в VM**
 * (`runtimeErrorCodeOf`: поле `code`, затем `metadata.runtimeCode`, сверка с
 * таблицей) — свой разбор поля означал бы второе правило чтения кода.
 */
function runtimeCodeFromField(error: unknown): string | undefined {
  return runtimeErrorCodeOf(error);
}

/**
 * Код отказа исполнения: **только поле записи**, иначе маркер «код не назван».
 *
 * Разбирать код из текста сообщения запрещено (`src/runtime/runtimeCodes.ts`:
 * текст остаётся человеческим и может измениться), и замер это подтверждает:
 * в живом журнале (7160 строк, 2026-09-28) **ни одна** запись не несёт
 * `код=OSN-RT…` в тексте. Угадывание кода из строки не помогло бы ни одной
 * записи, зато замаскировало бы разрыв канала, ради видимости которого маркер и
 * заведён.
 */
export function runtimeCodeOf(error: unknown): string {
  return runtimeCodeFromField(error) ?? UNCODED_RUNTIME_CODE;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Записи из отчёта сборки. `undefined` — сборки не было: пустой список, а не
 * выдуманная причина.
 */
export function diagnosticsFromBuildReport(report: BuildReportLike | undefined): DiagnosticRecord[] {
  if (report === undefined) return [];
  const records: DiagnosticRecord[] = [];

  for (const e of report.lexerErrors ?? []) {
    records.push({
      code: PHASE_CODES.лексер,
      phase: 'лексер',
      severity: 'ошибка',
      message: e.message,
      ...(optionalNumber(e.line) !== undefined ? { line: e.line } : {}),
      ...(optionalNumber(e.column) !== undefined ? { column: e.column } : {}),
    });
  }

  for (const e of report.parserErrors ?? []) {
    records.push({
      code: PHASE_CODES.парсер,
      phase: 'парсер',
      severity: 'ошибка',
      message: e.message,
      ...(optionalNumber(e.line) !== undefined ? { line: e.line } : {}),
      ...(optionalNumber(e.column) !== undefined ? { column: e.column } : {}),
    });
  }

  for (const e of report.semanticErrors ?? []) {
    const code = diagnosticCodeOf(e.kind) ?? UNCATALOGUED_KIND_CODE;
    records.push({
      code,
      phase: 'семантика',
      // Блокирующий вид — ошибка, неблокирующий — совет: `compilerSuccess`
      // остаётся истинным у неблокирующих (канон §13.10).
      severity: isBlockingKind(e.kind) ? 'ошибка' : 'предупреждение',
      message: e.message,
      kind: e.kind,
      ...(optionalString(e.file) !== undefined ? { file: e.file as string } : {}),
      ...(optionalNumber(e.line) !== undefined ? { line: e.line } : {}),
    });
  }

  for (const e of report.compilerErrors ?? []) {
    // Зеркало семантической ошибки: то же сообщение с префиксом `[semantic] `
    // и без вида/файла. Структурная запись уже посчитана выше.
    if (e.message.startsWith('[semantic] ')) continue;
    const extra = e as { file?: unknown; line?: unknown; column?: unknown };
    records.push({
      code: PHASE_CODES.сборка,
      phase: 'сборка',
      severity: 'ошибка',
      message: e.message,
      ...(optionalString(e.kind) !== undefined ? { kind: e.kind } : {}),
      ...(optionalString(extra.file) !== undefined ? { file: extra.file as string } : {}),
      ...(optionalNumber(extra.line) !== undefined ? { line: extra.line as number } : {}),
      ...(optionalNumber(extra.column) !== undefined ? { column: extra.column as number } : {}),
    });
  }

  // Отказ без причины обязан быть назван: молчание компилятора — событие журнала,
  // и у него есть собственный код (`INTERNAL_CODES.refusalWithoutDiagnostics`).
  const refused = report.success === false || report.compilerSuccess === false;
  if (refused && records.length === 0) {
    records.push({
      code: INTERNAL_CODES.refusalWithoutDiagnostics,
      phase: 'сборка',
      severity: 'ошибка',
      message: REFUSAL_WITHOUT_DIAGNOSTICS_MESSAGE,
    });
  }

  return records;
}

/**
 * Записи из отчёта исполнения: по одной на отказ VM, плюс признак «не состоялось,
 * причина не названа». Успешный прогон (в том числе не сошедшийся с эталоном)
 * диагностик не порождает: у «не сошлось» кода нет, его несут `qualityScore` и
 * `outputDiff`.
 */
export function diagnosticsFromGoldenReport(golden: GoldenReportLike | undefined): DiagnosticRecord[] {
  if (golden === undefined) return [];
  const records: DiagnosticRecord[] = [];

  for (const e of golden.vmErrors ?? []) {
    records.push({
      code: runtimeCodeOf(e),
      phase: 'исполнение',
      severity: 'ошибка',
      message: e.message,
    });
  }

  if (golden.executed === false && records.length === 0) {
    records.push({
      code: UNCODED_RUNTIME_CODE,
      phase: 'исполнение',
      severity: 'ошибка',
      message: RUNTIME_WITHOUT_CAUSE_MESSAGE,
    });
  }

  return records;
}

/** Проекция всей записи журнала: сборка + исполнение, в порядке фаз. */
export function projectEntryDiagnostics(input: {
  buildReport?: BuildReportLike | undefined;
  goldenReport?: GoldenReportLike | undefined;
}): DiagnosticRecord[] {
  return [
    ...diagnosticsFromBuildReport(input.buildReport),
    ...diagnosticsFromGoldenReport(input.goldenReport),
  ];
}

/** Сколько раз встретился код и на каких фазах. */
export interface DiagnosticCodeCount {
  code: string;
  count: number;
  phases: DiagnosticPhase[];
  /** Известен ли код каталогу (`knownDiagnosticCodes`). */
  known: boolean;
}

/** Итог по набору записей: по кодам, по фазам, плюс коды вне каталога. */
export interface DiagnosticSummary {
  total: number;
  errors: number;
  warnings: number;
  byCode: DiagnosticCodeCount[];
  byPhase: Array<{ phase: DiagnosticPhase; count: number }>;
  /** Коды правильной формы, которых нет в каталоге: их не считаем «известными» молча. */
  unknownCodes: string[];
}

/** Сводка по записям. Чистая: порядок кодов — по убыванию частоты, затем по коду. */
export function summarizeDiagnostics(records: readonly DiagnosticRecord[]): DiagnosticSummary {
  const byCode = new Map<string, { count: number; phases: Set<DiagnosticPhase> }>();
  const byPhase = new Map<DiagnosticPhase, number>();
  let errors = 0;
  let warnings = 0;

  for (const r of records) {
    const entry = byCode.get(r.code) ?? { count: 0, phases: new Set<DiagnosticPhase>() };
    entry.count += 1;
    entry.phases.add(r.phase);
    byCode.set(r.code, entry);
    byPhase.set(r.phase, (byPhase.get(r.phase) ?? 0) + 1);
    if (r.severity === 'предупреждение') warnings += 1;
    else errors += 1;
  }

  const codes: DiagnosticCodeCount[] = [...byCode.entries()]
    .map(([code, v]) => ({
      code,
      count: v.count,
      phases: [...v.phases],
      known: isKnownDiagnosticCode(code),
    }))
    .sort((a, b) => (b.count - a.count) || a.code.localeCompare(b.code));

  return {
    total: records.length,
    errors,
    warnings,
    byCode: codes,
    byPhase: [...byPhase.entries()]
      .map(([phase, count]) => ({ phase, count }))
      .sort((a, b) => (b.count - a.count) || a.phase.localeCompare(b.phase)),
    unknownCodes: codes.filter((c) => !c.known).map((c) => c.code),
  };
}
