/**
 * Упаковщик инструкций в VLIW-пакеты: `packInstructions(module, model)`.
 *
 * ## Что он делает и чего не делает
 *
 * Собирает **соседние** инструкции в один пакет, не меняя их взаимный порядок.
 * Перестановкой занимается отдельный планировщик (`reorderScheduler.ts`);
 * смешивать две операции в одной нельзя: при перестановке ломается
 * эквивалентность, и тогда непонятно, что именно её сломало.
 *
 * ## Почему в порядке достаточно
 *
 * VM исполняет слоты пакета последовательно (`reginterpreter.ts`,
 * `executeElement`) и имеет ровно одно отличие от линейного кода: слот,
 * передавший управление, **покидает пакет**. Отсюда два обязательства
 * упаковщика, которых нет в `verifyPackets` (см. `docs/vliw-pack-diagnosis.md`):
 *
 * 1. передача управления закрывает пакет — иначе слоты после неё не исполнятся
 *    (измеренный дефект: `while.osnova` дала `49` вместо `1049`, потеряна ровно
 *    одна инструкция);
 * 2. инструкция-цель перехода и первая инструкция процедуры открывают пакет —
 *    иначе VM, войдя в пакет по адресу, исполнит слоты, стоящие до цели.
 *
 * При выполнении обоих обязательств и сохранении порядка поведение совпадает с
 * линейным **по конструкции**, а не по результатам прогонов.
 *
 * ## Роль `verifyPackets`
 *
 * Аппаратная легальность (RAW / WAR / WAW / ширина / совместимость со слотами)
 * проверяется вызовом `verifyOnePacket` перед каждым расширением пакета.
 * Упаковщик не дублирует эти правила: единственный источник истины —
 * верификатор, поэтому разойтись они не могут.
 */

import {
  isRegPacket,
  type RegCodeElement,
  type RegInstruction,
  type RegModule,
  type RegPacket,
  type RegProcedure,
} from "../runtime/vm/regcode";
import {
  isBranchInstruction,
  verifyControlTransfer,
  verifyRegisters,
  verifySlotAssignment,
  verifyWidth,
  type MachineModel,
} from "./packetVerifier";

/**
 * Инъекция дефектов — ТОЛЬКО для негативного контроля.
 *
 * Смысл: gate должен краснеть, когда упаковщик нарушает конкретное правило.
 * Проверять это на копии алгоритма бессмысленно (копия стареет вместе с кодом),
 * поэтому дефект вносится в **настоящий** упаковщик параметром, а сам параметр
 * запрещён в рабочем коде: за этим следит `packetPacker.audit.test.ts`.
 */
export interface PackDefects {
  /** Не проверять регистры (RAW / WAR / WAW) при расширении пакета. */
  ignoreRegisters?: boolean;
  /** Не проверять совместимость со слотами. */
  ignoreSlots?: boolean;
  /** Не требовать, чтобы передача управления закрывала пакет. */
  ignoreControlTransfer?: boolean;
  /** Не открывать пакет на цели перехода и начале процедуры. */
  ignoreEntryPoints?: boolean;
}

/** Статистика упаковки. Плотность считается как инструкций на элемент кода. */
export interface PackStats {
  /** Инструкций в исходном линейном коде. */
  instructions: number;
  /** Элементов кода до упаковки (по одной инструкции на элемент). */
  elementsBefore: number;
  /** Элементов кода после упаковки: инструкции и пакеты. */
  elementsAfter: number;
  /** Элементов с двумя и более слотами. */
  widePackets: number;
  /** Инструкций, попавших в широкие пакеты. */
  packedInstructions: number;
  /** Плотность до упаковки: всегда `1.00`. */
  densityBefore: number;
  /** Плотность упаковки: `instructions / elementsAfter`. */
  densityAfter: number;
  /** Почему открывался новый пакет (сумма = `elementsAfter`, кроме первого). */
  newPacketReasons: {
    /** Инструкция — цель перехода. */
    target: number;
    /** Инструкция — начало процедуры. */
    procedureStart: number;
    /** Предыдущая инструкция передала управление. */
    previousControl: number;
    /** Пакет стал нелегален: регистры или слоты. */
    conflict: number;
  };
}

/** Результат упаковки. */
export interface PackResult {
  /** Новый модуль: линейный код заменён упакованным. Исходный не меняется. */
  module: RegModule;
  stats: PackStats;
  /** `keys[элемент][слот]` — индекс исходной инструкции в линейном коде. */
  keys: number[][];
  /** `positionOf[исходный индекс]` — индекс элемента в новом потоке. */
  positionOf: number[];
  /** Адреса, которые не удалось пересчитать (должно быть пусто). */
  unmappedAddresses: number[];
}

/** Операции, у которых поле `off` — адрес в потоке кода. */
const OFFSET_OPS = new Set(["jmp", "jmp_if", "jmp_if_not", "try_begin"]);

/** Инструкция с адресом перехода: сужение типа для `off`. */
type OffsetInstruction = RegInstruction & { off: number };

/** Есть ли у инструкции адрес в потоке кода. */
function hasOffset(ins: RegInstruction): ins is OffsetInstruction {
  return OFFSET_OPS.has(ins.op) && typeof (ins as { off?: unknown }).off === "number";
}

/** Развернуть элементы в линейный список инструкций в порядке исполнения. */
function toLinear(code: readonly RegCodeElement[]): RegInstruction[] {
  const out: RegInstruction[] = [];
  for (const el of code) {
    if (isRegPacket(el)) out.push(...el.slots);
    else out.push(el as RegInstruction);
  }
  return out;
}

/** Адреса, с которых может начаться исполнение: цели переходов и начала процедур. */
function entryPoints(
  code: readonly RegInstruction[],
  procedures: readonly RegProcedure[],
): Set<number> {
  const starts = new Set<number>([0, code.length]);
  for (const proc of procedures) {
    if (proc.codeOffset >= 0 && proc.codeOffset < code.length) starts.add(proc.codeOffset);
  }
  for (const ins of code) {
    if (!hasOffset(ins)) continue;
    if (ins.off >= 0 && ins.off < code.length) starts.add(ins.off);
  }
  return starts;
}

/** Глубокая копия инструкции: `{...ins}` оставляет `args` общим массивом. */
function cloneInstruction(ins: RegInstruction): RegInstruction {
  return JSON.parse(JSON.stringify(ins)) as RegInstruction;
}

/**
 * Упаковать инструкции модуля в VLIW-пакеты.
 *
 * @param module регистровый модуль; исходный объект не мутируется
 * @param model модель машины: число слотов и совместимость операций
 * @param defects инъекция дефектов для негативного контроля; в рабочем коде не
 *   передаётся (см. {@link PackDefects})
 */
export function packInstructions(
  module: RegModule,
  model: MachineModel,
  defects?: PackDefects,
): PackResult {
  const linear = toLinear(module.code);
  const starts = entryPoints(linear, module.procedures);
  const reasons = { target: 0, procedureStart: 0, previousControl: 0, conflict: 0 };

  const procedureStarts = new Set(module.procedures.map((p) => p.codeOffset));
  const targetStarts = entryPoints(linear, []);

  const elements: RegCodeElement[] = [];
  const keys: number[][] = [];
  const positionOf: number[] = new Array(linear.length).fill(-1);
  let packet: RegInstruction[] = [];
  let packetOrigins: number[] = [];

  const flush = (): void => {
    if (packet.length === 0) return;
    const elementIndex = elements.length;
    for (const origin of packetOrigins) positionOf[origin] = elementIndex;
    keys.push([...packetOrigins]);
    if (packet.length === 1) elements.push(packet[0]!);
    else elements.push({ packet: true, slots: packet } as RegPacket);
    packet = [];
    packetOrigins = [];
  };

  /** Можно ли добавить инструкцию к текущему пакету без нарушения инвариантов. */
  const canJoin = (ins: RegInstruction): boolean => {
    if (packet.length === 0) return true;
    const candidate = [...packet, ins];
    if (verifyWidth(candidate, model) !== null) return false;
    if (defects?.ignoreControlTransfer !== true && verifyControlTransfer(candidate) !== null) return false;
    if (defects?.ignoreSlots !== true && verifySlotAssignment(candidate, model) !== null) return false;
    if (defects?.ignoreRegisters !== true && verifyRegisters(candidate) !== null) return false;
    return true;
  };

  for (let i = 0; i < linear.length; i++) {
    const ins = linear[i]!;

    // Обязательство 2: начало области открывает пакет.
    if (packet.length > 0 && starts.has(i) && defects?.ignoreEntryPoints !== true) {
      if (procedureStarts.has(i) && !targetStarts.has(i)) reasons.procedureStart++;
      else reasons.target++;
      flush();
    }

    if (isBranchInstruction(ins) && defects?.ignoreControlTransfer !== true) {
      // Обязательство 1: передача управления закрывает пакет и стоит последней.
      if (!canJoin(ins)) {
        if (packet.length > 0) reasons.conflict++;
        flush();
      }
      packet.push(cloneInstruction(ins));
      packetOrigins.push(i);
      flush();
      continue;
    }

    if (!canJoin(ins)) {
      reasons.conflict++;
      flush();
    }
    packet.push(cloneInstruction(ins));
    packetOrigins.push(i);
  }
  flush();

  // Пересчёт адресов: индексы инструкций заменяются индексами элементов.
  const unmappedAddresses: number[] = [];
  const remap = (value: number): number => {
    const mapped = positionOf[value];
    if (mapped === undefined || mapped < 0) {
      unmappedAddresses.push(value);
      return value;
    }
    return mapped;
  };

  for (const el of elements) {
    if (isRegPacket(el)) {
      for (const slot of el.slots) {
        if (hasOffset(slot)) slot.off = remap(slot.off);
      }
    } else if (hasOffset(el as RegInstruction)) {
      const ins = el as OffsetInstruction;
      ins.off = remap(ins.off);
    }
  }

  const instructions = linear.length;
  const elementsAfter = elements.length;
  const widePackets = elements.filter(isRegPacket).length;
  const packedInstructions = keys.filter((k) => k.length > 1).reduce((sum, k) => sum + k.length, 0);

  const packedModule: RegModule = {
    ...module,
    procedures: module.procedures.map((proc) => {
      const mapped = positionOf[proc.codeOffset];
      if (mapped === undefined || mapped < 0) {
        unmappedAddresses.push(proc.codeOffset);
        return { ...proc };
      }
      return { ...proc, codeOffset: mapped };
    }),
    code: elements,
  };

  return {
    module: packedModule,
    stats: {
      instructions,
      elementsBefore: instructions,
      elementsAfter,
      widePackets,
      packedInstructions,
      densityBefore: instructions > 0 ? 1 : 0,
      densityAfter: elementsAfter > 0 ? instructions / elementsAfter : 0,
      newPacketReasons: reasons,
    },
    keys,
    positionOf,
    unmappedAddresses,
  };
}
