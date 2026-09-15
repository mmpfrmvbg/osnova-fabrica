/**
 * Оракул **эквивалентности исполнения** переставленного регистрового кода.
 *
 * ## Зачем отдельно от `validateRegSchedule`
 *
 * `validateRegSchedule` проверяет расписание **статически**: порядок выдачи есть
 * топологическая сортировка, эффекты не переставлены, потребитель не выдан
 * раньше готовности операнда. Это необходимо, но не достаточно: статическая
 * проверка не исполняет код.
 *
 * Здесь делается то же, что делает `src/oracle/parity.ts` для двух VM: один и
 * тот же исходник собирается в регистровый код, затем исполняется **дважды** —
 * линейно и после перестановки — на одной `RegVM` с одинаковым хостом.
 * Сравниваются:
 *
 * 1. **итоговое значение**;
 * 2. **трасса вызовов хоста** (`invoke` + `return`) — совпадение итога при
 *    разной последовательности вызовов это расхождение поведения, а не паритет;
 * 3. **мультимножество исполненных инструкций** — порядок сравнивать нельзя
 *    (перестановка для того и делается), но набор обязан совпасть.
 *
 * Именно отсутствие этого оракула названо в `docs/vliw-reg-plan.md` причиной,
 * по которой планировщик нельзя подключать в конвейер по умолчанию.
 */

import { RegVM } from "../runtime/vm/reginterpreter";
import {
  isRegPacket,
  type RegCodeElement,
  type RegInstruction,
  type RegModule,
} from "../runtime/vm/regcode";
import {
  createDefaultInvokeHandler,
  type InvokeHandler,
  type StackValue,
} from "../runtime/vm/interpreter";
import { scheduleRegWithReorder, scheduleRegInOrder, type ReorderOptions } from "./reorderScheduler";
import { countPipeline, type MemoryLevel, type PipelineCounters } from "./pipelineCounters";
import { resolveEntryIndex } from "../oracle/parity";

/** Одно наблюдение прогона. */
export interface EquivalenceStep {
  kind: "invoke" | "return";
  name?: string;
  args?: StackValue[];
  value?: StackValue | undefined;
}

export interface ReorderEquivalenceReport {
  /** Значения совпали. */
  valuesEqual: boolean;
  /** Трассы совпали поэлементно. */
  tracesEqual: boolean;
  /** Первое расхождение трасс (`-1` — нет). */
  traceDivergenceIndex: number;
  /** Наборы исполненных инструкций совпали. */
  instructionsEqual: boolean;
  /** Итог линейного прогона. */
  linearValue: StackValue | undefined;
  /** Итог переставленного прогона. */
  reorderedValue: StackValue | undefined;
  linearTrace: EquivalenceStep[];
  reorderedTrace: EquivalenceStep[];
  linearInstructions: string[];
  reorderedInstructions: string[];
  linearError: string | null;
  reorderedError: string | null;
  /** Перестановка вообще изменила порядок выдачи. */
  orderChanged: boolean;
  /** Итоговое суждение: всё совпало и ошибок нет. */
  ok: boolean;
  message: string;
}

export interface ReorderEquivalenceOptions extends ReorderOptions {
  entryProcedure?: string;
  args?: StackValue[];
  maxSteps?: number;
  invokeFactory?: () => InvokeHandler;
}

/**
 * Глубокая копия **отдельной инструкции**.
 *
 * Мелкая копия (`{ ...ins }`) здесь недостаточна: у `invoke`/`call` есть
 * вложенный массив `args`, и при копировании он остаётся общим с исходной
 * инструкцией. Дефект нашёлся на мультипроцедурном корпусе: оракул сравнивал
 * переставленный модуль с исходным, а тот оказывался уже изменён — линейный
 * прогон давал 1041 вместо 1049.
 *
 * `JSON.parse(JSON.stringify(...))` безопасен: регистровая инструкция — обычные
 * данные (числа, строки, массивы чисел), живых ссылок в ней нет.
 */
function cloneInstruction(ins: RegInstruction): RegInstruction {
  return JSON.parse(JSON.stringify(ins)) as RegInstruction;
}

function cloneModule(module: RegModule): RegModule {
  return JSON.parse(JSON.stringify(module)) as RegModule;
}

/** Обёртка-имя для `procedureRanges` (читаемость вызывающего кода). */
function moduleProcedures(module: RegModule): Array<{ start: number; end: number }> {
  return procedureRanges(module);
}

/**
 * Применить перестановку ко **всем** процедурам модуля.
 *
 * ## Почему это нужно отдельно от {@link applyReorderToModule}
 *
 * `applyReorderToModule` планирует одну процедуру (точку входа). Для реальной
 * программы этого мало: она состоит из 5–50 процедур, и перестановка одной из
 * них даёт выигрыш на 1/N кода. Все прежние замеры (3–17%) относились именно к
 * одной процедуре и потому не описывали программу целиком.
 *
 * Здесь планируется каждая процедура, затем **все** адреса пересчитываются
 * глобально: `codeOffset` процедур, цели переходов, `try_begin`. Карта
 * «старый индекс элемента → новый» строится по всем процедурам сразу, поэтому
 * вызов из одной процедуры в другую остаётся корректным.
 *
 * @param module исходный модуль (не мутируется)
 * @param options уровень памяти, кластеры
 */
export function applyReorderToWholeModule(
  module: RegModule,
  options: ReorderOptions = {},
): { scheduled: RegModule; orderChanged: boolean; proceduresScheduled: number } {
  const ranges = procedureRanges(module);

  /** Новые элементы по каждой процедуре + карта индексов. */
  const newBodies: RegCodeElement[][] = [];
  const indexMap = new Map<number, number>();
  let orderChanged = false;
  let newLength = 0;

  // 1. Спланировать каждую процедуру и построить карту индексов.
  for (const range of ranges) {
    const body: RegInstruction[] = [];
    const bodyToModule: number[] = [];
    for (let i = range.start; i < range.end; i++) {
      const el = module.code[i]!;
      if (isRegPacket(el)) continue;
      bodyToModule.push(i);
      body.push(el as RegInstruction);
    }

    // `offsetBase: range.start` ОБЯЗАТЕЛЕН. Переходы внутри среза несут
    // АБСОЛЮТНЫЕ адреса по всему `module.code`; без базы разбиение на участки
    // строится неверно и планировщик переставляет инструкции через реальные
    // границы циклов. Дефект найден на `while.osnova`: 1041 вместо 1049.
    const result = scheduleRegWithReorder(body, {
      ...options,
      offsetBase: range.start,
    });
    if (result.order.some((v, i) => v !== i)) orderChanged = true;

    const newBody: RegCodeElement[] = result.order.map((origIdx, pos) => {
      indexMap.set(bodyToModule[origIdx]!, newLength + pos);
      // ГЛУБОКАЯ копия: иначе `off`/`args` остаются общими с исходным модулем,
      // и пересчёт адресов ниже портит оригинал (см. `cloneInstruction`).
      return cloneInstruction(body[origIdx]!);
    });
    newBodies.push(newBody);
    newLength += newBody.length;
  }

  // 2. Пересчитать переходы внутри каждой процедуры по общей карте.
  for (const newBody of newBodies) {
    for (const el of newBody) {
      const ins = el as RegInstruction;
      if (
        ins.op === "jmp" ||
        ins.op === "jmp_if" ||
        ins.op === "jmp_if_not" ||
        ins.op === "try_begin"
      ) {
        const mapped = indexMap.get(ins.off);
        if (mapped !== undefined) ins.off = mapped;
      }
    }
  }

  // 3. Собрать модуль и пересчитать codeOffset всех процедур.
  const scheduled = cloneModule(module);
  scheduled.code = newBodies.flat();
  for (const p of scheduled.procedures) {
    const mapped = indexMap.get(p.codeOffset);
    if (mapped !== undefined) p.codeOffset = mapped;
  }

  return {
    scheduled,
    orderChanged,
    proceduresScheduled: ranges.length,
  };
}

/**
 * Границы тела каждой процедуры в модуле.
 *
 * Регистровый код — один плоский массив `code`; процедура начинается со своего
 * `codeOffset` и заканчивается там, где начинается следующая (или конец кода).
 */
function procedureRanges(module: RegModule): Array<{ start: number; end: number }> {
  const offsets = module.procedures.map((p) => p.codeOffset);
  return offsets.map((start) => {
    const next = offsets
      .filter((c) => c > start)
      .sort((a, b) => a - b)[0];
    return { start, end: next ?? module.code.length };
  });
}

/**
 * Применить расписание перестановки к модулю: разложить инструкции процедуры по
 * пакетам в новом порядке и пересчитать **все** абсолютные адреса.
 *
 * ## Почему пересчитывать нужно весь модуль, а не одну процедуру
 *
 * Первая версия обновляла только адреса внутри планируемой процедуры. Это
 * ломало многоproцедурные модули: `codeOffset` остальных процедур оставался
 * старым и начинал указывать внутрь переставленного тела — вызов уходил не туда.
 * Дефект нашёл оракул эквивалентности на `task_stats.osnova` (расхождение трасс
 * на шаге 3), статическая проверка расписания его не видит.
 *
 * Поэтому строится полная карта «старый индекс инструкции → новый индекс
 * элемента» и по ней пересчитываются и переходы, и `codeOffset` всех процедур.
 *
 * @param module исходный модуль (не мутируется)
 * @param procedureIndex какую процедуру планировать
 */
export function applyReorderToModule(
  module: RegModule,
  procedureIndex: number,
  options: ReorderOptions = {},
): { scheduled: RegModule; orderChanged: boolean } {
  const proc = module.procedures[procedureIndex];
  if (!proc) throw new Error(`vliw(reorder): нет процедуры #${procedureIndex}`);

  const ranges = procedureRanges(module);
  const range = ranges[procedureIndex]!;
  const start = range.start;
  const end = range.end;

  // Тело планируемой процедуры — только её собственные инструкции. Чужие не
  // трогаем, но их позиции всё равно должны попасть в карту адресов.
  const body: RegInstruction[] = [];
  /** Индекс инструкции в body → индекс в module.code. */
  const bodyToModule: number[] = [];
  for (let i = start; i < end; i++) {
    const el = module.code[i]!;
    if (isRegPacket(el)) continue;
    bodyToModule.push(i);
    body.push(el as RegInstruction);
  }

  // Та же причина, что в `applyReorderToWholeModule`: `offsetBase: start`
  // обязателен для корректного разбиения на участки внутри среза.
  const result = scheduleRegWithReorder(body, { ...options, offsetBase: start });

  // Карта «индекс инструкции в body → новый индекс элемента внутри процедуры».
  const newPosInBody = new Map<number, number>();
  result.order.forEach((origIdx, pos) => newPosInBody.set(origIdx, pos));

  /** Карта «старый индекс в module.code → новый индекс в module.code». */
  const moduleIndexMap = new Map<number, number>();

  // 1. Переставленные инструкции процедуры.
  const newBody: RegCodeElement[] = result.order.map((origIdx) => {
    const oldIndex = bodyToModule[origIdx]!;
    const copy: RegInstruction = { ...body[origIdx]! };
    moduleIndexMap.set(oldIndex, start + newPosInBody.get(origIdx)!);
    return copy;
  });

  // 2. Инструкции всех остальных процедур — порядок не меняется, но позиции
  //    сдвигаются на разницу длин. Считаем новые позиции по смещению.
  const delta = newBody.length - body.length;
  for (const r of ranges) {
    if (r.start === start) continue;
    for (let i = r.start; i < r.end; i++) {
      if (isRegPacket(module.code[i]!)) continue;
      moduleIndexMap.set(i, i + delta);
    }
  }

  // 3. Пересчёт переходов внутри планируемой процедуры.
  for (let k = 0; k < newBody.length; k++) {
    const ins = newBody[k] as RegInstruction;
    if (
      ins.op === "jmp" ||
      ins.op === "jmp_if" ||
      ins.op === "jmp_if_not" ||
      ins.op === "try_begin"
    ) {
      const mapped = moduleIndexMap.get(ins.off);
      if (mapped !== undefined) ins.off = mapped;
    }
  }

  const scheduled = cloneModule(module);
  scheduled.code = [
    ...module.code.slice(0, start),
    ...newBody,
    ...module.code.slice(end),
  ];

  // 4. Пересчёт codeOffset ВСЕХ процедур — иначе вызов уйдёт в переставленное
  //    тело планируемой процедуры (см. заголовок).
  for (const p of scheduled.procedures) {
    const mapped = moduleIndexMap.get(p.codeOffset);
    if (mapped !== undefined) p.codeOffset = mapped;
  }

  return { scheduled, orderChanged: result.order.some((v, i) => v !== i) };
}

interface Outcome {
  value: StackValue | undefined;
  trace: EquivalenceStep[];
  instructions: string[];
  error: string | null;
}

async function runModule(
  module: RegModule,
  entryIndex: number,
  args: StackValue[],
  invokeFactory: () => InvokeHandler,
  maxSteps: number,
): Promise<Outcome> {
  const trace: EquivalenceStep[] = [];
  const instructions: string[] = [];
  const host = invokeFactory();
  const vm = new RegVM(module, {
    maxSteps,
    invoke: (name, a) => {
      trace.push({ kind: "invoke", name, args: a.slice() });
      return host(name, a);
    },
    onExecute: (info) => {
      // Ключ — позиция инструкции в ПЕРЕДАННОМ модуле: обе стороны сравниваются
      // как объекты одного и того же исходного кода, поэтому ключ сопоставим по
      // содержимому инструкции, а не по адресу.
      const el = module.code[info.pc];
      if (el === undefined) return;
      const ins = isRegPacket(el) ? el.slots[info.slotIndex] : el;
      if (ins === undefined) return;
      instructions.push(instructionKey(ins as RegInstruction));
    },
  });
  let value: StackValue | undefined;
  let error: string | null = null;
  try {
    value = await vm.runProcedure(entryIndex, args);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  trace.push({ kind: "return", value });
  return { value, trace, instructions, error };
}

/**
 * Ключ инструкции для сравнения наборов. Берём опкод и операнды, но НЕ адреса
 * переходов: они законно меняются при перестановке.
 */
function instructionKey(ins: RegInstruction): string {
  const o = ins as unknown as Record<string, unknown>;
  const parts: string[] = [String(o.op)];
  for (const k of ["d", "a", "b", "i", "k", "key", "v", "cond", "catchReg", "name", "fi"]) {
    if (o[k] !== undefined) parts.push(`${k}=${String(o[k])}`);
  }
  if (Array.isArray(o.args)) parts.push(`args=[${(o.args as number[]).join(",")}]`);
  return parts.join(" ");
}

function sameValue(a: StackValue | undefined, b: StackValue | undefined): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** Сравнение двух способов планирования: эквивалентность + метрики. */
export interface ReorderComparison {
  equivalence: ReorderEquivalenceReport;
  /**
   * Метрики **всего модуля** — сколько процедур запланировано, сколько всего
   * тактов. Именно эти числа описывают программу; метрики точки входа ниже
   * нужны только для счётчиков конвейера.
   */
  inOrder: {
    packets: number;
    cycles: number;
    nopCycles: number;
    ilp: number;
    counters: PipelineCounters;
    module: ModuleScheduleMetrics;
  };
  reordered: {
    packets: number;
    cycles: number;
    nopCycles: number;
    ilp: number;
    counters: PipelineCounters;
    module: ModuleScheduleMetrics;
  };
  /** Выигрыш по тактам **на всём модуле**: `(inOrder - reordered) / inOrder`. */
  cycleGain: number;
  /** Выигрыш по блокировкам конвейера. */
  bubGain: number;
}

/** Суммарные метрики планирования по всем процедурам модуля. */
export interface ModuleScheduleMetrics {
  /** Сколько процедур запланировано. */
  procedures: number;
  /** Всего инструкций во всех процедурах. */
  instructions: number;
  /** Всего пакетов. */
  packets: number;
  /** Суммарные такты по всем процедурам. */
  cycles: number;
  /** Суммарные пустые такты. */
  nopCycles: number;
  /** Инструкций на пакет по всему модулю. */
  ilp: number;
}

/**
 * Собрать сравнение: эквивалентность исполнения плюс метрики обоих способов.
 *
 * Метрики считаются на **том же** графе и с теми же длительностями — разница
 * только в порядке, иначе сравнение было бы нечестным.
 */
export async function compareReorders(
  module: RegModule,
  options: ReorderEquivalenceOptions = {},
): Promise<ReorderComparison> {
  const entryIndex = resolveEntryIndex(module.procedures, options.entryProcedure);
  const memoryLevel: MemoryLevel = options.memoryLevel ?? "l1";
  const reorderOpts: ReorderOptions = {
    memoryLevel,
    ...(options.callPure !== undefined ? { callPure: options.callPure } : {}),
  };

  const eqOptions: ReorderEquivalenceOptions = {
    ...options,
    memoryLevel,
  };
  const equivalence = await runReorderEquivalence(module, eqOptions);

  // Метрики считаем по ВСЕМУ модулю, а не по одной точке входа.
  //
  // Раньше здесь бралась только процедура точки входа, и «выигрыш 17%»
  // относился к 1/N кода реальной программы. Владелец указал на это как на
  // фундаментальное ограничение: пока планируется одна процедура, никакой замер
  // не описывает программу. Теперь планируются все процедуры, и метрики —
  // суммарные по модулю.
  interface ModuleMetrics {
    procedures: number;
    instructions: number;
    packets: number;
    cycles: number;
    nopCycles: number;
    /** Инструкций на пакет по всему модулю. */
    ilp: number;
  }

  const measureModule = (
    scheduleOne: (body: RegInstruction[], offsetBase: number) => ReturnType<typeof scheduleRegInOrder>,
  ): ModuleMetrics => {
    const ranges = moduleProcedures(module);
    let instructions = 0;
    let packets = 0;
    let cycles = 0;
    let nopCycles = 0;
    for (const range of ranges) {
      const body = module.code
        .slice(range.start, range.end)
        .filter((el) => !isRegPacket(el)) as RegInstruction[];
      if (body.length === 0) continue;
      const r = scheduleOne(body, range.start);
      instructions += r.metrics.instructionCount;
      packets += r.metrics.packetCount;
      cycles += r.metrics.cycles;
      nopCycles += r.metrics.nopCycles;
    }
    return {
      procedures: ranges.length,
      instructions,
      packets,
      cycles,
      nopCycles,
      ilp: packets > 0 ? instructions / packets : 0,
    };
  };

  const ioModule = measureModule((body, base) =>
    scheduleRegInOrder(body, { ...reorderOpts, offsetBase: base }),
  );
  const roModule = measureModule((body, base) =>
    scheduleRegWithReorder(body, { ...reorderOpts, offsetBase: base }),
  );

  // Счётчики конвейера считаем по расписанию точки входа — это единственная
  // процедура, которая в корпусе реально исполняется, поэтому TICKS/BUB_E2
  // осмысленны именно для неё. Суммарные такты по модулю дают метрику охвата.
  const proc = module.procedures[entryIndex]!;
  const starts = module.procedures
    .map((p) => p.codeOffset)
    .filter((c) => c >= 0)
    .sort((a, b) => a - b);
  const next = starts.find((c) => c > proc.codeOffset);
  const body = module.code
    .slice(proc.codeOffset, next ?? module.code.length)
    .filter((el) => !isRegPacket(el)) as RegInstruction[];

  const io = scheduleRegInOrder(body, { ...reorderOpts, offsetBase: proc.codeOffset });
  const ro = scheduleRegWithReorder(body, { ...reorderOpts, offsetBase: proc.codeOffset });
  const ioCounters = countPipeline(io, memoryLevel);
  const roCounters = countPipeline(ro, memoryLevel);

  return {
    equivalence,
    inOrder: {
      packets: io.metrics.packetCount,
      cycles: io.metrics.cycles,
      nopCycles: io.metrics.nopCycles,
      ilp: io.metrics.ilp,
      counters: ioCounters,
      module: ioModule,
    },
    reordered: {
      packets: ro.metrics.packetCount,
      cycles: ro.metrics.cycles,
      nopCycles: ro.metrics.nopCycles,
      ilp: ro.metrics.ilp,
      counters: roCounters,
      module: roModule,
    },
    cycleGain:
      ioModule.cycles > 0
        ? (ioModule.cycles - roModule.cycles) / ioModule.cycles
        : 0,
    bubGain:
      ioCounters.BUB_E2 > 0
        ? (ioCounters.BUB_E2 - roCounters.BUB_E2) / ioCounters.BUB_E2
        : 0,
  };
}

/** Текстовый отчёт сравнения — для CLI и логов. */
export function formatComparison(
  name: string,
  cmp: ReorderComparison,
  memoryLevel: MemoryLevel = "l1",
): string {
  const eq = cmp.equivalence;
  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
  const lines: string[] = [];
  lines.push(`[${eq.ok ? "OK" : "FAIL"}] ${name}`);
  lines.push(`  эквивалентность: ${eq.message}`);
  lines.push(`  порядок изменён: ${eq.orderChanged ? "да" : "нет"}`);
  lines.push(`  память:          ${memoryLevel}`);
  lines.push(
    `  модуль:          процедур ${cmp.reordered.module.procedures}, ` +
      `инструкций ${cmp.reordered.module.instructions}`,
  );
  lines.push(
    `  такты (модуль):  ${cmp.inOrder.module.cycles} -> ${cmp.reordered.module.cycles}  ` +
      `(выигрыш ${pct(cmp.cycleGain)})`,
  );
  lines.push(
    `  такты (вход):    ${cmp.inOrder.cycles} -> ${cmp.reordered.cycles}`,
  );
  lines.push(
    `  BUB_E2:          ${cmp.inOrder.counters.BUB_E2} -> ${cmp.reordered.counters.BUB_E2}  (выигрыш ${pct(cmp.bubGain)})`,
  );
  lines.push(
    `  пакетов:         ${cmp.inOrder.packets} -> ${cmp.reordered.packets}`,
  );
  lines.push(
    `  ILP:             ${cmp.inOrder.ilp.toFixed(2)} -> ${cmp.reordered.ilp.toFixed(2)}`,
  );
  lines.push(
    `  IPC (вход):      ${cmp.inOrder.counters.IPC.toFixed(3)} -> ${cmp.reordered.counters.IPC.toFixed(3)}`,
  );
  return lines.join("\n");
}

function sameStep(a: EquivalenceStep | undefined, b: EquivalenceStep | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "invoke" && b.kind === "invoke") {
    if (a.name !== b.name) return false;
    const x = a.args ?? [];
    const y = b.args ?? [];
    if (x.length !== y.length) return false;
    return x.every((v, i) => sameValue(v, y[i]));
  }
  return sameValue(a.value, b.value);
}

function sameMultiset(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const m = new Map<string, number>();
  for (const k of a) m.set(k, (m.get(k) ?? 0) + 1);
  for (const k of b) {
    const n = m.get(k);
    if (n === undefined || n === 0) return false;
    m.set(k, n - 1);
  }
  return true;
}

/**
 * Прогон оракула эквивалентности.
 *
 * @param module регистровый модуль (уже собранный из исходника)
 * @param options опции: уровень памяти, точка входа, аргументы, лимит шагов
 */
export async function runReorderEquivalence(
  module: RegModule,
  options: ReorderEquivalenceOptions = {},
): Promise<ReorderEquivalenceReport> {
  const entryIndex = resolveEntryIndex(module.procedures, options.entryProcedure);
  const args = options.args ?? [];
  const maxSteps = options.maxSteps ?? 1_000_000;
  const invokeFactory = options.invokeFactory ?? (() => createDefaultInvokeHandler());

  // Планируем ВЕСЬ модуль, а не одну точку входа: именно так планировщик будет
  // применяться в реальности. Оракул обязан проверять тот вариант, который
  // пойдёт в дело, иначе он доказывает эквивалентность не того кода.
  const { scheduled, orderChanged } = applyReorderToWholeModule(module, {
    ...(options.memoryLevel !== undefined ? { memoryLevel: options.memoryLevel } : {}),
    ...(options.callPure !== undefined ? { callPure: options.callPure } : {}),
  });

  const linear = await runModule(
    cloneModule(module),
    entryIndex,
    args,
    invokeFactory,
    maxSteps,
  );
  const reordered = await runModule(
    scheduled,
    entryIndex,
    args,
    invokeFactory,
    maxSteps,
  );

  // Трассы: усечём до общего префикса и найдём первое расхождение.
  let divergence = -1;
  const len = Math.min(linear.trace.length, reordered.trace.length);
  for (let i = 0; i < len; i++) {
    if (!sameStep(linear.trace[i], reordered.trace[i])) {
      divergence = i;
      break;
    }
  }
  const tracesEqual =
    divergence < 0 && linear.trace.length === reordered.trace.length;

  const valuesEqual = sameValue(linear.value, reordered.value);
  const instructionsEqual = sameMultiset(linear.instructions, reordered.instructions);

  // Обе стороны упали одинаково — это не расхождение планировщика, но и не
  // доказательство: помечаем как «оба упали» и не считаем успехом.
  const bothFailed =
    linear.error !== null &&
    reordered.error !== null &&
    linear.error === reordered.error;

  const ok =
    tracesEqual &&
    valuesEqual &&
    instructionsEqual &&
    !bothFailed &&
    linear.error === null &&
    reordered.error === null;

  const message = bothFailed
    ? `обе стороны упали одинаково: «${linear.error}» — эквивалентность не доказана`
    : !tracesEqual
      ? `расхождение трасс на шаге ${divergence}`
      : !valuesEqual
        ? "расхождение итоговых значений"
        : !instructionsEqual
          ? "расхождение набора исполненных инструкций"
          : linear.error !== null
            ? `линейный прогон упал: «${linear.error}»`
            : reordered.error !== null
              ? `переставленный прогон упал: «${reordered.error}»`
              : `совпало: ${JSON.stringify(linear.value)} (трасса ${linear.trace.length} шагов, инструкций ${linear.instructions.length})`;

  return {
    valuesEqual,
    tracesEqual,
    traceDivergenceIndex: divergence,
    instructionsEqual,
    linearValue: linear.value,
    reorderedValue: reordered.value,
    linearTrace: linear.trace,
    reorderedTrace: reordered.trace,
    linearInstructions: linear.instructions,
    reorderedInstructions: reordered.instructions,
    linearError: linear.error,
    reorderedError: reordered.error,
    orderChanged,
    ok,
    message,
  };
}
