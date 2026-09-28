/**
 * КОДЫ ОШИБОК ИСПОЛНЕНИЯ — вторая половина личности ошибки (первая — каталог
 * видов компилятора, `src/compiler/diagnosticCatalogue.ts`).
 *
 * **Зачем.** Отказ VM сегодня — это текст и позиция в байткоде:
 * `InterpreterError { message; pc?; op? }` (`src/runtime/vm/interpreter.ts`).
 * Машине не за что зацепиться: `Division by zero` и `Remainder by zero`
 * различаются только строкой, а по строке нельзя ни считать частоты, ни
 * запретить переиспользование смысла. Замер 2026-09-28: у компилятора
 * структурированные ошибки есть (вид + файл), у VM — нет вовсе.
 *
 * **Что здесь есть.** Таблица «причина → код» с признаком `internal`. Разделение
 * принципиальное: ошибка программы (деление на ноль, лимит шагов) и **дефект
 * самой VM** (`Stack underflow`, `Unknown op`, регистр вне диапазона) — разные
 * события. Вторые получают один общий код `OSN-RT-900`, потому что их ценность
 * именно в том, что они сигнал о дефекте интерпретатора, а не о программе.
 *
 * **Правила те же, что у каталога видов:** пространство `OSN-RT-NNN`, код
 * выдаётся один раз и не переиспользуется; для нового вида причины берётся
 * следующий свободный номер. Диапазон `900+` зарезервирован под внутренние.
 *
 * **Контракт для потребителей** (кто читает коды):
 * - `InterpreterError` и `RegInterpreterError` несут `code?: RuntimeErrorCode`;
 * - `formatVmRuntimeError` (`src/runtime/vm.ts`) добавляет `код=OSN-RT-NNN`
 *   к тексту, когда код есть, — строка остаётся читаемой человеком;
 * - запись об отказе для отчёта/журнала собирает
 *   {@link import("./goldenApps").vmErrorRecordOf}: `message` (дословно, как было),
 *   `code` — код ошибки, а если кода нет, то `OSN-RT-000` ({@link RUNTIME_CODES.unnamedRefusal}),
 *   плюс `op`/`pc`, когда они есть. Читать код из записи —
 *   {@link runtimeErrorCodeOf}, а не разбором текста;
 * - журнал (`src/trace/**`) пишет код отдельным полем, а не выковыривает из текста.
 *
 * **Где живёт код у чужого класса ошибки.** Не всякий отказ исполнения — наш
 * класс: лимит времени бросает `TimeoutError` (`src/runtime/runtimeRecovery.ts`),
 * у которого уже занято поле `code` (`TIMEOUT_ERROR`), и менять его нельзя — на
 * это значение опирается восстановление (`TimeoutRetryStrategy`). Поэтому код
 * кладётся в `metadata.runtimeCode`, а читается **всегда** через
 * {@link runtimeErrorCodeOf}: одна функция на оба источника (поле `code`, поле
 * `metadata.runtimeCode`). Разбирать код по тексту сообщения запрещено — текст
 * остаётся человеческим и в любой момент может измениться.
 */

/** Таблица причин отказа исполнения. */
export const RUNTIME_CODES = {
  /**
   * ОТКАЗ, КОД КОТОРОГО НЕ НАЗВАН. Не причина, а **маркер разрыва канала**:
   * запись об отказе собрана, а код до неё не доехал (или отказ пришёл не из VM).
   * Нужен, чтобы «код не назван» было видно ЧИСЛОМ, а не пустым полем: пустое
   * поле не отличить от «поле забыли», а `OSN-RT-000` считается и красится.
   */
  unnamedRefusal: "OSN-RT-000",
  maxSteps: "OSN-RT-001",
  divisionByZero: "OSN-RT-002",
  remainderByZero: "OSN-RT-003",
  unknownInvoke: "OSN-RT-004",
  unhandledThrow: "OSN-RT-005",
  timeout: "OSN-RT-006",
  entryNotFound: "OSN-RT-007",
  concurrentExecute: "OSN-RT-008",
  internalInvariant: "OSN-RT-900",
} as const;

export type RuntimeErrorCode = (typeof RUNTIME_CODES)[keyof typeof RUNTIME_CODES];

/** Описание кода: причина и признак «это дефект VM, а не программы». */
export interface RuntimeCodeInfo {
  code: RuntimeErrorCode;
  /** Что случилось — словами, для канона и для подсказки. */
  cause: string;
  /** `true` — сигнал о дефекте интерпретатора; `false` — отказ программы или предела. */
  internal: boolean;
  /**
   * `true` — код ставится **не точкой броска**, а сборкой записи об отказе
   * ({@link import("./goldenApps").vmErrorRecordOf}): он отмечает не причину, а
   * разрыв канала. Сторож (`src/runtime/runtimeCodes.test.ts`) держит обе
   * стороны: такой код обязан появляться в записи и **не имеет права**
   * появляться в точке броска — иначе «код не назван» перестанет отличаться
   * от «код есть».
   */
  fromRecord?: boolean;
}

/** Исчерпывающий перечень: тест `src/runtime/runtimeCodes.test.ts` держит его полноту. */
export const RUNTIME_CODE_TABLE: readonly RuntimeCodeInfo[] = [
  {
    code: RUNTIME_CODES.unnamedRefusal,
    cause: "отказ исполнения, код которого не назван — разрыв канала, а не свойство программы",
    internal: true,
    fromRecord: true,
  },
  { code: RUNTIME_CODES.maxSteps, cause: "превышен лимит шагов исполнения", internal: false },
  { code: RUNTIME_CODES.divisionByZero, cause: "деление на ноль (вещественное и целочисленное)", internal: false },
  { code: RUNTIME_CODES.remainderByZero, cause: "остаток по нулю", internal: false },
  { code: RUNTIME_CODES.unknownInvoke, cause: "вызов системного вызова, которого нет в реестре", internal: false },
  { code: RUNTIME_CODES.unhandledThrow, cause: "необработанное исключение языка (`выбросить` вне `попробовать`)", internal: false },
  { code: RUNTIME_CODES.timeout, cause: "превышен лимит времени исполнения", internal: false },
  { code: RUNTIME_CODES.entryNotFound, cause: "точка входа не найдена: нет `главная`/`main` и первой процедуры", internal: false },
  { code: RUNTIME_CODES.concurrentExecute, cause: "повторный вход в исполняющую VM (гонка)", internal: true },
  { code: RUNTIME_CODES.internalInvariant, cause: "нарушен внутренний инвариант интерпретатора — это дефект VM", internal: true },
];

const CODE_SET: ReadonlySet<string> = new Set(RUNTIME_CODE_TABLE.map((r) => r.code));

/** Проверка, что строка — известный код исполнения (для чтения чужих журналов). */
export function isRuntimeErrorCode(value: unknown): value is RuntimeErrorCode {
  return typeof value === "string" && CODE_SET.has(value);
}

/** Описание кода; `undefined` — код не из этого пространства. */
export function runtimeCodeInfo(code: string | undefined): RuntimeCodeInfo | undefined {
  return code === undefined ? undefined : RUNTIME_CODE_TABLE.find((r) => r.code === code);
}

/**
 * Код исполнения у пойманной ошибки — **единственный** способ его прочитать.
 *
 * Два источника, в порядке старшинства:
 * 1. собственное поле `code` — так его несут {@link import("./vm/interpreter").InterpreterError},
 *    {@link import("./vm/reginterpreter").RegInterpreterError} и вообще любой класс,
 *    у которого поле свободно;
 * 2. `metadata.runtimeCode` — для классов, у которых `code` уже занят чужим
 *    значением (`TimeoutError`: `TIMEOUT_ERROR`).
 *
 * Чужое значение в `code` (например `ENOENT` у ошибок файловой системы) кодом
 * исполнения не считается: сверка идёт по таблице {@link RUNTIME_CODE_TABLE}.
 */
export function runtimeErrorCodeOf(err: unknown): RuntimeErrorCode | undefined {
  if (err === null || typeof err !== "object") return undefined;
  const own = (err as { code?: unknown }).code;
  if (isRuntimeErrorCode(own)) return own;
  const metadata = (err as { metadata?: unknown }).metadata;
  if (metadata === null || typeof metadata !== "object") return undefined;
  const fromMetadata = (metadata as { runtimeCode?: unknown }).runtimeCode;
  return isRuntimeErrorCode(fromMetadata) ? fromMetadata : undefined;
}
