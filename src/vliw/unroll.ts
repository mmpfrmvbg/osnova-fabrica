/**
 * Loop unrolling для байткода Основа (первый под-шаг software pipelining).
 *
 * Распознаёт канонический скелет цикла `для_каждого`, который генерирует
 * `src/compiler/codegen.ts`, и разворачивает его в прямой линейный код:
 *
 *   source → система.итератор.из → local.set src
 *   → для каждой итерации i в [0, N):
 *       local.get src; const i; система.массив.получить; local.set item
 *       [const i; local.set index]
 *       <тело>
 *   → код после цикла
 *
 * Зачем это VLIW-планировщику: он умеет паковать только линейный код без
 * `jmp`/`jmp_if_not`. Unrolling убирает управляющий поток цикла, после чего
 * `scheduleLinearBlock` может упаковать тело в пакеты, а оракул — сверить
 * linear (unrolled) и scheduled результаты.
 *
 * Ограничения первого шага (честные, задокументированные):
 * - один цикл `для_каждого`; тело без ветвлений/вложенных циклов/прервать/продолжить;
 * - число итераций известно статически: либо литерал массива в источнике
 *   (авто-детект по числу `система.массив.добавить`), либо явный `tripCount`.
 *
 * Итерации с общим `itemSlot` разворачиваются последовательно (семантика
 * сохраняется); настоящий меж-итерационный параллелизм (переименование слотов)
 * — это следующий под-шаг software pipelining.
 */

import type { OsVbcModule, RawInstruction, CodeElement } from "../runtime/vm/bytecode";
import { isVliwPacket } from "../runtime/vm/bytecode";

const INVOKE_ITERATOR = "система.итератор.из";
const INVOKE_LENGTH = "система.массив.длина";
const INVOKE_GET = "система.массив.получить";
const INVOKE_PUSH = "система.массив.добавить";
const INVOKE_NEW_ARRAY = "система.массив.создать";

/** Опкоды управляющего потока: после unroll их в развёрнутом теле быть не должно. */
const CONTROL_FLOW_OPS = new Set<string>(["jmp", "jmp_if", "jmp_if_not"]);

export interface UnrollOptions {
  /** Число итераций (trip count). Если не задано — авто-детект из литерала массива. */
  tripCount?: number;
  /**
   * Переименовывать `item`/`index` по итерациям (software pipelining): каждая итерация
   * получает свой слот, устраняя ложную store→load зависимость через общий слот.
   * По умолчанию true. Отключить (`false`) — прежнее поведение с общим слотом.
   */
  rename?: boolean;
}

export interface UnrollResult {
  /** Модуль v1 с развёрнутым линейным кодом (без пакетов). */
  module: OsVbcModule;
  /** Фактическое число развёрнутых итераций. */
  tripCount: number;
  /** Остался ли управляющий поток (jmp/jmp_if*) в итоговом коде. */
  hasControlFlow: boolean;
}

function opOf(ins: RawInstruction): string {
  return (ins as { op: string }).op;
}

function asInvoke(ins: RawInstruction): string | undefined {
  return opOf(ins) === "invoke" ? (ins as { op: "invoke"; name: string }).name : undefined;
}

function asLocalIndex(ins: RawInstruction): number | undefined {
  return (ins as { op: "local.get" | "local.set"; i: number }).i;
}

function isLocalOp(ins: RawInstruction, op: string): boolean {
  return opOf(ins) === op;
}

function fail(msg: string): never {
  throw new Error(`unroll: ${msg}`);
}

function toLinearCode(code: CodeElement[]): RawInstruction[] {
  if (code.some((el) => isVliwPacket(el))) {
    fail("код уже содержит VLIW-пакеты; unroll ожидает линейный байткод v1");
  }
  return code as RawInstruction[];
}

/**
 * Авто-детект числа итераций: источник цикла — литерал массива `[e1, ..., eN]`.
 * Распознаём канонический след литерала: `local.set slot` сразу после `invoke создать`,
 * затем серия `local.get slot; <elem>; invoke добавить; pop`, завершающаяся `local.get slot`
 * непосредственно перед `invoke система.итератор.из`. Число итераций = число `добавить`.
 * Источник-переменная (или выражение) здесь не распознаётся → нужен явный `tripCount`.
 */
function detectTripCount(code: RawInstruction[], iterIdx: number): number | undefined {
  const prev = code[iterIdx - 1];
  if (!prev || !isLocalOp(prev, "local.get")) return undefined;
  const slot = asLocalIndex(prev)!;

  let setPos = -1;
  for (let i = iterIdx - 2; i >= 0; i--) {
    if (isLocalOp(code[i]!, "local.set") && asLocalIndex(code[i]!) === slot) {
      setPos = i;
      break;
    }
  }
  if (setPos <= 0) return undefined;
  if (asInvoke(code[setPos - 1]!) !== INVOKE_NEW_ARRAY) return undefined;

  let count = 0;
  for (let i = setPos + 1; i < iterIdx - 1; i++) {
    if (asInvoke(code[i]!) === INVOKE_PUSH) count++;
  }
  return count;
}

function assertInvoke(ins: RawInstruction, name: string, what: string): void {
  if (asInvoke(ins) !== name) fail(`ожидался invoke ${name} (${what}), получено: ${opOf(ins)}`);
}

function assertLocalOp(ins: RawInstruction, op: string, what: string): void {
  if (!isLocalOp(ins, op)) fail(`ожидался ${op} (${what}), получено: ${opOf(ins)}`);
}

/** Переписывает ссылки на `itemSlot`/`indexSlot` в инструкции на новые слоты. */
function remapSlot(
  ins: RawInstruction,
  itemSlot: number,
  newItem: number,
  indexSlot: number | undefined,
  newIndex: number | undefined,
): RawInstruction {
  const op = opOf(ins);
  if (op === "local.get" || op === "local.set") {
    const idx = asLocalIndex(ins);
    if (idx === itemSlot) return { ...ins, i: newItem } as RawInstruction;
    if (indexSlot !== undefined && idx === indexSlot) return { ...ins, i: newIndex } as RawInstruction;
  }
  return { ...ins } as RawInstruction;
}

/**
 * Разворачивает единственный `для_каждого` в модуле в линейный код.
 * Модуль должен быть v1 с одной процедурой и линейным code (как в CLI планировщика).
 */
export function unrollForEach(module: OsVbcModule, options: UnrollOptions = {}): UnrollResult {
  if (module.procedures.length !== 1) {
    fail(`поддерживается ровно одна процедура, сейчас: ${module.procedures.length}`);
  }
  const proc = module.procedures[0]!;
  if (proc.codeOffset !== 0) {
    fail("поддерживается одна процедура с codeOffset 0");
  }

  const code = toLinearCode(module.code);

  // 1. Найти маркер цикла: invoke система.итератор.из.
  const iterIdx = code.findIndex((ins) => asInvoke(ins) === INVOKE_ITERATOR);
  if (iterIdx < 0) fail("цикл для_каждого не найден (нет invoke система.итератор.из)");

  // 2. Префикс цикла: source expr + итератор.из + local.set src.
  assertLocalOp(code[iterIdx + 1]!, "local.set", "сохранение источника цикла");
  const srcSlot = asLocalIndex(code[iterIdx + 1]!)!;
  if (code[iterIdx + 2] === undefined || !isLocalOp(code[iterIdx + 2]!, "local.get")) {
    fail("после сохранения источника ожидался local.get src");
  }
  assertInvoke(code[iterIdx + 3]!, INVOKE_LENGTH, "вычисление длины");
  assertLocalOp(code[iterIdx + 4]!, "local.set", "сохранение длины");
  if (opOf(code[iterIdx + 5]!) !== "const") fail("ожидался const 0 (инициализация счётчика)");
  assertLocalOp(code[iterIdx + 6]!, "local.set", "инициализация счётчика");
  const idxSlot = asLocalIndex(code[iterIdx + 6]!)!;

  const loopStart = iterIdx + 7;

  // 3. Заголовок цикла: local.get idx; local.get len; lt; jmp_if_not exit.
  if (!isLocalOp(code[loopStart]!, "local.get") || asLocalIndex(code[loopStart]!) !== idxSlot) {
    fail("ожидался local.get счётчика в начале цикла");
  }
  if (opOf(code[loopStart + 2]!) !== "lt") fail("ожидался lt в условии цикла");
  if (opOf(code[loopStart + 3]!) !== "jmp_if_not") fail("ожидался jmp_if_not выхода из цикла");
  const exit = (code[loopStart + 3] as { off: number }).off;

  // 4. Пролог тела: local.get src; local.get idx; получить; local.set item; [local.get idx; local.set index].
  if (!isLocalOp(code[loopStart + 4]!, "local.get") || asLocalIndex(code[loopStart + 4]!) !== srcSlot) {
    fail("ожидался local.get src в прологе тела");
  }
  assertInvoke(code[loopStart + 6]!, INVOKE_GET, "получение элемента");
  assertLocalOp(code[loopStart + 7]!, "local.set", "сохранение элемента");
  const itemSlot = asLocalIndex(code[loopStart + 7]!)!;

  let hasIndex = false;
  let indexSlot: number | undefined;
  let bodyStart = loopStart + 8;
  if (
    isLocalOp(code[loopStart + 8]!, "local.get") &&
    asLocalIndex(code[loopStart + 8]!) === idxSlot &&
    isLocalOp(code[loopStart + 9]!, "local.set")
  ) {
    hasIndex = true;
    indexSlot = asLocalIndex(code[loopStart + 9]!)!;
    bodyStart = loopStart + 10;
  }

  // 5. Инкремент счётчика — последние 4 инструкции перед jmp loopStart.
  //    exit указывает сразу за `jmp loopStart`, значит incStart = exit - 5.
  const bodyEnd = exit - 5;
  if (bodyEnd < bodyStart) fail("тело цикла пустое или границы цикла не распознаны");

  const body = code.slice(bodyStart, bodyEnd);
  if (body.some((ins) => CONTROL_FLOW_OPS.has(opOf(ins)) || opOf(ins) === "ret")) {
    fail("тело содержит ветвление/прервать/продолжить/вернуть — не поддерживается на этом шаге");
  }
  if (body.some((ins) => asInvoke(ins) === INVOKE_ITERATOR)) {
    fail("вложенный для_каждого не поддерживается");
  }

  // 6. Число итераций.
  const detected = detectTripCount(code, iterIdx);
  const tripCount = options.tripCount ?? detected;
  if (tripCount === undefined) {
    fail("число итераций неизвестно: источник не литерал массива — задайте tripCount");
  }
  if (tripCount < 0) fail("tripCount не может быть отрицательным");

  // 7. Сборка развёрнутого кода.
  const constants: unknown[] = [...module.constants];
  const constIndex = (value: unknown): number => {
    for (let i = 0; i < constants.length; i++) {
      if (Object.is(constants[i], value)) return i;
    }
    constants.push(value);
    return constants.length - 1;
  };

  const rename = options.rename ?? true;
  const hasIndexRename = hasIndex && indexSlot !== undefined;
  const perIter = rename ? (hasIndexRename ? 2 : 1) : 0;
  const baseSlot = proc.localsCount;
  const newLocalsCount = baseSlot + tripCount * perIter;

  const out: RawInstruction[] = [];
  // Префикс: source expr + итератор.из + local.set src (длина/счётчик больше не нужны).
  out.push(...code.slice(0, iterIdx + 2));

  for (let i = 0; i < tripCount; i++) {
    const newItem = rename ? baseSlot + i * perIter : itemSlot;
    const newIndex = rename && hasIndexRename ? baseSlot + i * perIter + 1 : indexSlot;
    out.push({ op: "local.get", i: srcSlot } as RawInstruction);
    out.push({ op: "const", type: "i32", k: constIndex(i) } as RawInstruction);
    out.push({ op: "invoke", name: INVOKE_GET } as RawInstruction);
    out.push({ op: "local.set", i: newItem } as RawInstruction);
    if (hasIndexRename) {
      out.push({ op: "const", type: "i32", k: constIndex(i) } as RawInstruction);
      out.push({ op: "local.set", i: newIndex! } as RawInstruction);
    }
    for (const ins of body) {
      out.push(remapSlot(ins, itemSlot, newItem, indexSlot, newIndex));
    }
  }

  // Код после цикла (включая ret).
  out.push(...code.slice(exit).map((ins) => ({ ...ins } as RawInstruction)));

  // Кодоген всегда дописывает `const.null; ret` в конец процедуры. После явного
  // `вернуть` это мёртвый код, который ломает планировщик (второй ret переставляется
  // раньше первого). Обрезаем всё после первого ret — он терминирует процедуру.
  const firstRet = out.findIndex((ins) => opOf(ins) === "ret");
  if (firstRet >= 0) out.length = firstRet + 1;

  const hasControlFlow = out.some((ins) => CONTROL_FLOW_OPS.has(opOf(ins)));

  return {
    module: {
      version: 1,
      moduleName: module.moduleName,
      constants,
      procedures: module.procedures.map((p) => ({ ...p, localsCount: newLocalsCount })),
      code: out,
    },
    tripCount,
    hasControlFlow,
  };
}
