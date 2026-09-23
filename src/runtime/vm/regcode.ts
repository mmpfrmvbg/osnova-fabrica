/**
 * Регистровый байткод Основа (RegBC, `.osvreg.json`) — формат **рядом** со стековым
 * байткодом v0.1 из {@link import("./bytecode")}. Стековый формат не меняется: два
 * артефакта живут параллельно, стековая VM остаётся эталоном (канон проекта:
 * оракул на каждый слой).
 *
 * ## Зачем
 *
 * В стековой машине единственный последовательный разделяемый ресурс — вершина
 * стека: «положи a», «положи b», «сложи» трогают её каждую инструкцию, поэтому две
 * независимые вычислительные цепочки сериализуются. В регистровой форме значения
 * лежат в пронумерованных ячейках (`add d, a, b`), и зависимость видна по номерам:
 * инструкция `d` зависит ровно от `a` и `b`. Это представление, на котором
 * переупорядочивание и ILP возможны по построению, а не вопреки.
 *
 * ## Форма
 *
 * - Три адреса: `d` (назначение), `a`, `b`. Один-к-одному на слоты I0/I1/M/B
 *   из `src/vliw/e2kModel.ts`; больше трёх операндов язык не требует.
 * - `d === undefined` — операция с эффектом (или её результат не наблюдается):
 *   порядок таких операций значим.
 * - Каждая инструкция адресуется абсолютным индексом в `code` (своя таблица
 *   процедур с `codeOffset`), поэтому патчинг меток — обычная запись числа.
 * - Пул констант (`constants` + `k`) — **тот же контракт**, что в стековом формате.
 *
 * ## Локальные переменные — по-прежнему регистры
 *
 * `local.get` / `local.set` в этом формате исчезают: переменная занимает
 * фиксированный vreg (`localToVreg`), а временные значения выражений получают
 * свободные vreg'и выше `localsCount`. Отдельного «окна локалов» нет — есть
 * регистровый файл процедуры на `vregs` ячеек.
 *
 * ## Граница с VLIW
 *
 * Поле `deps` (если появится) — hint для планировщика; интерпретатор его
 * игнорирует. Планировщик на этот формат **не переводится** в этом срезе
 * (см. `docs/register-ir-migration.md`, шаг 3): сначала полный паритет трасс.
 */

/**
 * Имя регистрового IR — НАШЕ РЕШЕНИЕ (не из документа).
 *
 * Строка-маркер в поле `ir` модуля: отличает регистровый формат от стекового
 * при чтении файла. Значение выбрано проектом; внешнего стандарта на него нет.
 */
export const REGCODE_IR = "osnova-reg";

/**
 * Версия регистрового формата — НАШЕ РЕШЕНИЕ (не из документа).
 *
 * Как и `BYTECODE_VERSION`, назначается проектом при изменении структуры. В
 * отличие от стекового формата, у которого есть `docs/bytecode-v1.md`,
 * документированной спецификации у `.osvreg` нет — единственный источник это
 * код. Помечено, чтобы не выглядело как ссылка на несуществующий документ.
 */
export const REGCODE_VERSION = 1;

export type RegConstType = "i32" | "f64" | "str" | "bool" | "null";

/**
 * Опкоды регистровой формы.
 * ПРАВИЛО: новый опкод добавляется только после реализации `case` в
 * `src/runtime/vm/reginterpreter.ts` — иначе `Unknown op` в рантайме.
 */
export type RegOp =
  /** `d = constants[k]` */
  | "const"
  /** `d = true` */
  | "const.true"
  /** `d = false` */
  | "const.false"
  /** `d = null` */
  | "const.null"
  /** `d = a` (копия значения; нужна там, где две ветки обязаны сойтись в одном регистре) */
  | "move"
  | "add"
  | "sub"
  | "mul"
  | "div"
  /** Целочисленное деление с отсечением к нулю (БЛОК 2: оператор `div`). */
  | "idiv"
  | "rem"
  | "eq"
  | "ne"
  | "lt"
  | "le"
  | "gt"
  | "ge"
  /** Логическое «и»/«или» без короткого замыкания (truthy-семантика стековой VM). */
  | "and"
  | "or"
  /** `d = !a` */
  | "not"
  /** `d = invoke(name, args)`; `argc` — сколько регистров читать из `args` */
  | "invoke"
  /** `d = call(fi, args)`; `argc` — сколько регистров читать из `args` */
  | "call"
  /** Безусловный переход на абсолютный индекс */
  | "jmp"
  /** Переход, если `cond` truthy */
  | "jmp_if"
  /** Переход, если `cond` falsy */
  | "jmp_if_not"
  /** Начало защищённого блока: адрес обработчика и регистр для пойманного значения */
  | "try_begin"
  /** Нормальное завершение защищённого блока (снять обработчик) */
  | "try_end"
  /** Выбросить исключение: значение в регистре, обработчик — из `try_begin` */
  | "throw"
  /** Возврат значения из `v` (нет `v` — процедура завершилась без значения) */
  | "ret"
  /** `d = {}` (объект без прототипа, как `obj.new` в стековой VM) */
  | "obj.new"
  /** `d = a[key]` */
  | "obj.get"
  /** `a[key] = b`; значение — сама `a` (как `obj.set` в стековой VM: объект остаётся на вершине) */
  | "obj.set";

/** Константа типа (совпадает с {@link import("./bytecode").ConstType}). */
export interface RegInstructionConst {
  op: "const";
  d: number;
  type: RegConstType;
  k: number;
}

/** Копия регистр→регистр. */
export interface RegInstructionMove {
  op: "move";
  d: number;
  a: number;
}

/** Бинарная операция: `d = a ∘ b`. */
export interface RegInstructionBinary {
  op:
    | "add"
    | "sub"
    | "mul"
    | "div"
    | "idiv"
    | "rem"
    | "eq"
    | "ne"
    | "lt"
    | "le"
    | "gt"
    | "ge"
    | "and"
    | "or";
  d: number;
  a: number;
  b: number;
}

/** Унарная операция: `d = f(a)`. */
export interface RegInstructionUnary {
  op: "not";
  d: number;
  a: number;
}

/** Константы-литералы без пула. */
export interface RegInstructionLiteral {
  op: "const.true" | "const.false" | "const.null" | "obj.new";
  d: number;
}

/** Системный вызов (или хост-вызов): результат в `d`, если он нужен. */
export interface RegInstructionInvoke {
  op: "invoke";
  d?: number;
  name: string;
  args: number[];
  argc: number;
}

/** Вызов процедуры модуля: результат в `d`, если он нужен. */
export interface RegInstructionCall {
  op: "call";
  d?: number;
  fi: number;
  args: number[];
  argc: number;
}

/** Ветвления: `cond` для условных переходов. */
export interface RegInstructionJump {
  op: "jmp" | "jmp_if" | "jmp_if_not";
  off: number;
  cond?: number;
}

/**
 * Начало защищённого блока: обработчик живёт по адресу `off`, а пойманное
 * значение интерпретатор кладёт прямо в `catchReg` (регистр переменной
 * `иначе_попытка`). Так `throw` не нужен ни стек, ни зарезервированный регистр:
 * адресат значения известен из самого блока. Парная инструкция — `try_end`.
 */
export interface RegInstructionTryBegin {
  op: "try_begin";
  off: number;
  catchReg: number;
}

/** Конец защищённого блока (нормальное завершение): снять обработчик. */
export interface RegInstructionTryEnd {
  op: "try_end";
}

/** Выбросить исключение: значение из регистра `a`. */
export interface RegInstructionThrow {
  op: "throw";
  a?: number;
}

/** Возврат: `v` отсутствует — процедура завершается без значения. */
export interface RegInstructionRet {
  op: "ret";
  v?: number;
}

/** Доступ к полю/ключу: `d = a[key]` или `a[key] = b`. */
export interface RegInstructionField {
  op: "obj.get" | "obj.set";
  d?: number;
  a: number;
  key: number;
  b?: number;
}

export type RegInstruction =
  | RegInstructionConst
  | RegInstructionMove
  | RegInstructionBinary
  | RegInstructionUnary
  | RegInstructionLiteral
  | RegInstructionInvoke
  | RegInstructionCall
  | RegInstructionJump
  | RegInstructionTryBegin
  | RegInstructionTryEnd
  | RegInstructionThrow
  | RegInstructionRet
  | RegInstructionField;

/**
 * Описание процедуры в регистровой форме.
 *
 * `localToVreg` — отладочная карта «имя переменной → vreg»: код работает и без
 * неё, но она делает артефакт читаемым и позволяет тестам утверждать раскладку.
 */
export interface RegProcedure {
  name: string;
  /** Абсолютный индекс первой инструкции процедуры в {@link RegModule.code}. */
  codeOffset: number;
  /** Число параметров: `localToVreg[param]` — vreg'и `0..argc-1`. */
  argc: number;
  /** Сколько всего ячеек нужно процедуре (переменные + временные). */
  vregs: number;
  /** Отладочная карта «имя → vreg». */
  localToVreg: Record<string, number>;
  returnsValue?: boolean;
  /** Процедура объявлена как `чистый` (без побочных эффектов). */
  pure?: boolean;
}

/**
 * Элемент регистрового кода: обычная инструкция или VLIW-пакет.
 *
 * `slots` исполняются последовательно — slot[0], slot[1], …: планировщик
 * гарантирует, что инструкции одного пакета независимы (нет чтения и записи
 * одного регистра внутри пакета), поэтому порядок слотов внутри пакета
 * наблюдаемого эффекта не имеет. Переходы (`jmp*`, `ret`) всегда занимают
 * отдельный пакет целиком — пакет после передачи управления не исполняется.
 *
 * `deps` — hint для планировщика/отладки (пары индексов инструкций); VM
 * игнорирует, как и в стековом `VliwPacket`.
 */
export interface RegPacket {
  packet: true;
  slots: RegInstruction[];
  deps?: [number, number][];
}

/** Элемент кода: линейная инструкция или пакет. */
export type RegCodeElement = RegInstruction | RegPacket;

/** Пакет ли это (зеркало `isVliwPacket` для регистрового формата). */
export function isRegPacket(el: RegCodeElement): el is RegPacket {
  return (
    typeof el === "object" &&
    el !== null &&
    "packet" in el &&
    (el as RegPacket).packet === true &&
    Array.isArray((el as RegPacket).slots)
  );
}

export interface RegModule {
  ir: typeof REGCODE_IR;
  version: number;
  moduleName: string;
  /** Тот же пул и те же индексы, что в стековом `.osvbc`. */
  constants: unknown[];
  procedures: RegProcedure[];
  /**
   * Линейный код: инструкции процедур друг за другом, адресация абсолютная.
   * Может быть смесью инструкций и VLIW-пакетов (`vliwSlots` выставлен).
   */
  code: RegCodeElement[];
  /** Максимум слотов в пакете (если код упакован). */
  vliwSlots?: number;
  /**
   * Разметка границ атомов (Фаза 4, шаг 1): какой участок кода какому атому принадлежит.
   *
   * Флаги `optimizable` живут в каталоге атомов (`src/compiler/atomRegions.ts`), а здесь
   * лежит их **разрешение на конкретный код**: без этого планировщику не с чем сопоставить
   * флаг — он планирует программу как единый код.
   *
   * Поле **необязательное и аддитивное**: компилятор по умолчанию его не пишет, читатель,
   * не знающий поля, его игнорирует. Поэтому `REGCODE_VERSION` не поднимается и
   * закоммиченные артефакты не меняются (`npm run artifacts:check`).
   */
  atoms?: RegAtomRegion[];
}

/** Участок кода, отнесённый к атому. Границы — абсолютные индексы `code`, `[start, end)`. */
export interface RegAtomRegion {
  /** Идентификатор атома из каталога 27 атомов (`A1`…`E4`). */
  atom: string;
  /** Признак вычислительного ядра — разрешение флага из каталога, а не из вызывающего кода. */
  optimizable: boolean;
  /** Индекс процедуры в {@link RegModule.procedures}. */
  procedure: number;
  /** Первый элемент участка (включительно). */
  start: number;
  /** Индекс за последним элементом участка (исключительно). */
  end: number;
}

/** Зеркало `isOsVbcModule()` из `bytecode.ts` — валидатор формы регистрового артефакта. */
export function isRegModule(m: unknown): m is RegModule {
  if (typeof m !== "object" || m === null) return false;
  const o = m as Record<string, unknown>;
  return (
    o.ir === REGCODE_IR &&
    typeof o.version === "number" &&
    typeof o.moduleName === "string" &&
    Array.isArray(o.constants) &&
    Array.isArray(o.procedures) &&
    Array.isArray(o.code) &&
    // Разметка атомов необязательна; если она есть — это массив.
    (o.atoms === undefined || Array.isArray(o.atoms))
  );
}

/** Список опкодов, которые понимает {@link import("./reginterpreter").RegVM}. */
export const REG_OPS: readonly RegOp[] = [
  "const",
  "const.true",
  "const.false",
  "const.null",
  "move",
  "add",
  "sub",
  "mul",
  "div",
  "idiv",
  "rem",
  "eq",
  "ne",
  "lt",
  "le",
  "gt",
  "ge",
  "and",
  "or",
  "not",
  "invoke",
  "call",
  "jmp",
  "jmp_if",
  "jmp_if_not",
  "try_begin",
  "try_end",
  "throw",
  "ret",
  "obj.new",
  "obj.get",
  "obj.set",
];

/** Найти индекс процедуры по имени; -1, если нет. */
export function findRegProcedure(module: RegModule, name: string): number {
  return module.procedures.findIndex((p) => p.name === name);
}
