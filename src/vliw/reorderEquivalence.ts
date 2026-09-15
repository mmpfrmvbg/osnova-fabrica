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
import { scheduleRegWithReorder, type ReorderOptions } from "./reorderScheduler";
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

function cloneModule(module: RegModule): RegModule {
  return JSON.parse(JSON.stringify(module)) as RegModule;
}

/**
 * Применить расписание перестановки к модулю: разложить инструкции по пакетам в
 * новом порядке и пересчитать абсолютные адреса переходов.
 *
 * Адреса в регистровом коде абсолютные (индексы элементов `code`), поэтому после
 * перестановки их обязательно нужно пересчитать — иначе `jmp` уедет не туда.
 * Карта «старый индекс инструкции → новый индекс элемента» строится из
 * `result.order`: `order[k]` — исходный индекс инструкции на позиции `k`.
 */
export function applyReorderToModule(
  module: RegModule,
  procedureIndex: number,
  options: ReorderOptions = {},
): { scheduled: RegModule; orderChanged: boolean } {
  const proc = module.procedures[procedureIndex];
  if (!proc) throw new Error(`vliw(reorder): нет процедуры #${procedureIndex}`);

  // Границы процедуры: от её codeOffset до следующего codeOffset (или конца).
  const starts = module.procedures
    .map((p) => p.codeOffset)
    .filter((c) => c >= 0)
    .sort((a, b) => a - b);
  const next = starts.find((c) => c > proc.codeOffset);
  const start = proc.codeOffset;
  const end = next ?? module.code.length;

  const body = module.code.slice(start, end).filter((el) => !isRegPacket(el)) as RegInstruction[];
  const result = scheduleRegWithReorder(body, options);

  // Карта «исходный индекс внутри body → новый индекс элемента».
  const newPosition = new Map<number, number>();
  result.order.forEach((origIdx, pos) => newPosition.set(origIdx, pos));

  // Копируем инструкции и пересчитываем адреса переходов.
  const newElements: RegCodeElement[] = result.order.map((origIdx, pos) => {
    const ins = body[origIdx]!;
    const copy: RegInstruction = { ...ins };
    if (
      copy.op === "jmp" ||
      copy.op === "jmp_if" ||
      copy.op === "jmp_if_not" ||
      copy.op === "try_begin"
    ) {
      // Цель перехода — абсолютный индекс в исходном `module.code`. Переводим
      // его в индекс внутри body, затем в новую позицию.
      const targetInBody = copy.off - start;
      const mapped = newPosition.get(targetInBody);
      if (mapped !== undefined) {
        copy.off = start + mapped;
      }
    }
    void pos;
    return copy;
  });

  const scheduled = cloneModule(module);
  scheduled.code = [
    ...module.code.slice(0, start),
    ...newElements,
    ...module.code.slice(end),
  ];

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

  const { scheduled, orderChanged } = applyReorderToModule(module, entryIndex, {
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
