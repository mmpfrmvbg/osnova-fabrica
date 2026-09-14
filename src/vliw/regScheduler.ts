/**
 * VLIW-планировщик для регистрового кода.
 *
 * Стековый планировщик (`scheduler.ts`) был вынужден упаковывать инструкции
 * **in-order**: любая перестановка ломала порядок `push`/`pop`. Здесь это
 * ограничение снимается — зависимости видны по регистрам (`regGraph.ts`),
 * поэтому независимые инструкции свободно ложатся в слоты I0/I1 одного пакета.
 *
 * ## Как устроено
 *
 * 1. Код делится на **линейные участки**: границы — цели переходов, `ret`,
 *    `jmp*`. Внутри участка управление линейно, переставлять безопасно.
 * 2. Внутри участка — упаковка в порядке программы: инструкция кладётся в уже
 *    открытый пакет, если это не нарушает инвариант пакета.
 * 3. **Внутри пакета регистр нельзя ни читать, ни писать повторно.** Дешёвый и
 *    достаточный инвариант: он закрывает RAW/WAR/WAW внутри пакета разом —
 *    слоты пакета это один «такт» без переименования регистров.
 * 4. Переход (`jmp*`, `ret`) занимает отдельный пакет целиком.
 *
 * ## Адреса
 *
 * `off` и `codeOffset` в регистровом коде — абсолютные индексы элементов. При
 * упаковке число элементов уменьшается, поэтому все переходы **пересчитываются**
 * тем же проходом, что строит карту «индекс инструкции → индекс элемента».
 */

import {
  isRegPacket,
  type RegCodeElement,
  type RegInstruction,
  type RegPacket,
} from "../runtime/vm/regcode";
import { VLIW_SLOTS, possibleSlots, type SlotType } from "./e2kModel";
import { buildRegDependencyGraph, type RegGraphOptions } from "./regGraph";

const SLOT_ORDER: SlotType[] = ["I0", "I1", "M", "B"];

function slotIndex(st: SlotType): number {
  const i = SLOT_ORDER.indexOf(st);
  return i >= 0 ? i : 0;
}

/** Инструкция завершает линейный участок. */
export function isTerminator(ins: RegInstruction): boolean {
  return ins.op === "jmp" || ins.op === "jmp_if" || ins.op === "jmp_if_not" || ins.op === "ret";
}

/** Цели переходов: здесь начинается новый линейный участок. */
export function branchTargets(code: readonly RegInstruction[]): Set<number> {
  const targets = new Set<number>();
  for (const ins of code) {
    if (ins.op === "jmp" || ins.op === "jmp_if" || ins.op === "jmp_if_not") {
      targets.add(ins.off);
    }
    if (ins.op === "try_begin") targets.add(ins.off);
  }
  return targets;
}

/** Регистры, которые инструкция пишет. */
function defsOf(ins: RegInstruction): number[] {
  switch (ins.op) {
    case "try_begin":
      // Интерпретатор кладёт пойманное значение сюда — это запись.
      return [ins.catchReg];
    case "obj.set":
    case "throw":
    case "jmp":
    case "jmp_if":
    case "jmp_if_not":
    case "try_end":
    case "ret":
      return [];
    case "invoke":
    case "call":
    case "obj.get":
      return ins.d === undefined ? [] : [ins.d];
    default: {
      const d = (ins as { d?: number }).d;
      return d === undefined ? [] : [d];
    }
  }
}

/** Регистры, которые инструкция читает. */
function usesOf(ins: RegInstruction): number[] {
  switch (ins.op) {
    case "move":
    case "not":
      return [ins.a];
    case "add":
    case "sub":
    case "mul":
    case "div":
    case "rem":
    case "eq":
    case "ne":
    case "lt":
    case "le":
    case "gt":
    case "ge":
    case "and":
    case "or":
      return [ins.a, ins.b];
    case "invoke":
    case "call":
      return ins.args.slice(0, ins.argc);
    case "jmp_if":
    case "jmp_if_not":
      return ins.cond === undefined ? [] : [ins.cond];
    case "throw":
      return ins.a === undefined ? [] : [ins.a];
    case "ret":
      return ins.v === undefined ? [] : [ins.v];
    case "obj.get":
      return [ins.a, ins.key];
    case "obj.set": {
      const uses = [ins.a, ins.key];
      if (ins.b !== undefined) uses.push(ins.b);
      return uses;
    }
    default:
      return [];
  }
}

/** Пакет, который сейчас набирается: слоты по индексу слота e2k. */
interface OpenPacket {
  /** Индекс элемента, под которым пакет встанет в потоке. */
  elementIndex: number;
  slots: (RegInstruction | null)[];
  /** Индексы инструкций, уже положенных в пакет. */
  instructions: number[];
  /** Регистры, тронутые в этом пакете: второй раз нельзя ни читать, ни писать. */
  touched: Set<number>;
}

/** Результат планирования. */
export interface RegScheduleResult {
  /** Элементы кода: инструкции и пакеты, в порядке исполнения. */
  elements: RegCodeElement[];
  /** Карта «индекс исходной инструкции → индекс элемента» (для адресов переходов). */
  positionOf: number[];
  /**
   * Ключи инструкций по элементам: `keys[элемент][слот]` — индекс инструкции в
   * исходном линейном коде. Это авторитетная карта «что где лежит»: оракулу она
   * нужна, чтобы сверять **набор исполненных инструкций**, не полагаясь на
   * восстановление по копии модуля.
   */
  keys: number[][];
  /** Пакеты по порядку (метрики, отладка). */
  packets: RegPacket[];
}

/**
 * Пересчитать `codeOffset` процедур под новый поток элементов.
 * Вызывается после {@link scheduleRegCode}: упаковка уменьшает число элементов,
 * поэтому старый абсолютный адрес начала процедуры указывает уже не туда.
 */
export function retargetProcedureOffsets(
  module: { procedures: { codeOffset: number }[] },
  positionOf: readonly number[],
): void {
  for (const proc of module.procedures) {
    const old = proc.codeOffset;
    const next = old >= 0 && old < positionOf.length ? positionOf[old] : undefined;
    if (next !== undefined && next >= 0) proc.codeOffset = next;
  }
}

/**
 * Планирование линейного регистрового кода.
 *
 * @param code линейный код с абсолютными адресами.
 */
export function scheduleRegCode(
  code: readonly RegInstruction[],
  options: RegGraphOptions = {},
): RegScheduleResult {
  const graph = buildRegDependencyGraph(code, options);
  const n = code.length;
  const positionOf: number[] = new Array(n).fill(-1);
  const elements: RegCodeElement[] = [];
  const packets: RegPacket[] = [];
  /** Ключи инструкций по элементам: keys[элемент][слот] = исходный индекс. */
  const keys: number[][] = [];

  const startElementIndex = new Set<number>([0, n]);
  for (const t of branchTargets(code)) startElementIndex.add(t);
  for (let i = 0; i < n; i++) {
    const ins = code[i]!;
    if (isTerminator(ins)) startElementIndex.add(i + 1);
    // `try_begin` открывает защищённый блок: инструкции из тела и из обработчика
    // не должны попасть в один пакет — интерпретатор, войдя в пакет с этим
    // слотом, продолжит исполнять остальные слоты уже в другом состоянии
    // обработчиков. Исключения и так последовательны по смыслу.
    if (ins.op === "try_begin") startElementIndex.add(i);
  }

  let current: OpenPacket | null = null;
  /** Достижим ли текущий участок линейно. */
  let reachable = true;
  /** Есть ли на адрес `index` переход (тогда это точка входа, а не мёртвый хвост). */
  const isTarget = (index: number): boolean => startElementIndex.has(index);

  const openAt = (): OpenPacket => {
    const p: OpenPacket = {
      elementIndex: elements.length,
      slots: Array(VLIW_SLOTS).fill(null),
      instructions: [],
      touched: new Set<number>(),
    };
    return p;
  };

  /** Закрыть пакет: запомнить адреса его инструкций и положить элемент в поток. */
  const flush = (): void => {
    if (current === null) return;
    const p = current;
    current = null;
    if (p.instructions.length === 0) return;
    const slots = p.slots.filter((s): s is RegInstruction => s !== null);
    const packet: RegPacket = { packet: true, slots };
    elements.push(packet);
    packets.push(packet);
    keys.push([...p.instructions]);
    for (const idx of p.instructions) positionOf[idx] = p.elementIndex;
  };

  for (let i = 0; i < n; i++) {
    // Метка — точка входа: поток управления снова достижим, участок начинается.
    if (startElementIndex.has(i)) {
      flush();
      reachable = true;
    }
    if (!reachable) continue;

    const ins = code[i]!;

    if (isTerminator(ins)) {
      // Переход — отдельный пакет: слоты после передачи управления не исполняются.
      flush();
      elements.push({ packet: true, slots: [ins] });
      packets.push({ packet: true, slots: [ins] });
      keys.push([i]);
      positionOf[i] = elements.length - 1;
      if (ins.op === "ret" && !isTarget(i + 1)) {
        // Всё до следующей метки — мёртвый хвост кодогена. Пропускаем: попади он
        // в пакет, VM исполнила бы его уже после возврата.
        reachable = false;
      }
      continue;
    }

    if (current === null) current = openAt();
    // Предшественник по зависимости не может оказаться в том же пакете: слоты
    // пакета — один «такт», значения видны только со следующего пакета.
    if (hasPredInPacket(graph.preds[i]!, current) || !canPlace(current, ins)) {
      flush();
      current = openAt();
    }
    if (!place(current, ins, i)) {
      throw new Error(
        `VLIW(reg): инструкция «${ins.op}» не помещается ни в один слот пакета`,
      );
    }
  }
  flush();

  retargetBranches(code, positionOf, elements);
  return { elements, positionOf, keys, packets };
}

/** Есть ли среди предшественников инструкция из этого пакета. */
function hasPredInPacket(preds: readonly number[], packet: OpenPacket): boolean {
  return preds.some((p) => packet.instructions.includes(p));
}

/** Поместится ли инструкция в пакет, не нарушив инвариант «регистр один раз». */
function canPlace(packet: OpenPacket, ins: RegInstruction): boolean {
  for (const r of [...defsOf(ins), ...usesOf(ins)]) {
    if (packet.touched.has(r)) return false;
  }
  return possibleSlots(ins.op).some((st) => packet.slots[slotIndex(st)] == null);
}

/** Положить инструкцию в свободный слот; `false` — не нашлось слота. */
function place(packet: OpenPacket, ins: RegInstruction, instructionIndex: number): boolean {
  for (const st of possibleSlots(ins.op)) {
    const idx = slotIndex(st);
    if (packet.slots[idx] != null) continue;
    packet.slots[idx] = ins;
    packet.instructions.push(instructionIndex);
    for (const r of [...defsOf(ins), ...usesOf(ins)]) packet.touched.add(r);
    return true;
  }
  return false;
}

/** Переписать абсолютные адреса переходов под новый поток элементов. */
function retargetBranches(
  code: readonly RegInstruction[],
  positionOf: readonly number[],
  elements: readonly RegCodeElement[],
): void {
  const targetOf = (oldIndex: number): number | null => {
    if (oldIndex < 0 || oldIndex >= positionOf.length) return null;
    const p = positionOf[oldIndex];
    return p !== undefined && p >= 0 ? p : null;
  };
  for (const el of elements) {
    const slots = isRegPacket(el) ? el.slots : [el as RegInstruction];
    for (const ins of slots) {
      if (ins.op === "jmp" || ins.op === "jmp_if" || ins.op === "jmp_if_not") {
        const next = targetOf(ins.off);
        if (next !== null) ins.off = next;
      } else if (ins.op === "try_begin") {
        const next = targetOf(ins.off);
        if (next !== null) ins.off = next;
      }
    }
  }
  void code;
}

/** Метрики упаковки: сколько пакетов и какой ILP получился. */
export interface RegPackMetrics {
  instructionCount: number;
  packetCount: number;
  /** Инструкций на пакет: > 1 означает реальный параллелизм. */
  ilp: number;
  /** Заполненность слотов: `ilp / VLIW_SLOTS`. */
  utilization: number;
}

export function regPackMetrics(
  code: readonly RegInstruction[],
  packets: readonly RegPacket[],
): RegPackMetrics {
  const instructionCount = code.length;
  const packetCount = packets.length;
  return {
    instructionCount,
    packetCount,
    ilp: packetCount > 0 ? instructionCount / packetCount : 0,
    utilization: packetCount > 0 ? instructionCount / (packetCount * VLIW_SLOTS) : 0,
  };
}
