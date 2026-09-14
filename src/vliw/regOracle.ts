/**
 * Оракул VLIW-планировщика на **регистровом** коде.
 *
 * Сверяет не «похожесть», а наблюдаемое поведение: линейный регистровый код и
 * тот же код, упакованный планировщиком, исполняются на одной и той же
 * регистровой VM с одинаковым хостом; сравниваются **трассы вызовов хоста** и
 * итоговое значение. Только после этого появляется метрика ILP — сам по себе
 * параллелизм ничего не доказывает, если планировщик сломал семантику.
 *
 * Метрика считается на реальном коде (корпус `reg-parity` и фикстуры), а не на
 * синтетических независимых парах: вопрос среза — «есть ли ILP там, где язык
 * его допускает», а не «умеет ли планировщик складывать два числа параллельно».
 */

import { compileSource, type CompileResult } from "../compiler/compiler";
import { compileToReg } from "../compiler/regcodegen";
import { createDefaultInvokeHandler, type InvokeHandler, type StackValue } from "../runtime/vm/interpreter";
import { RegVM } from "../runtime/vm/reginterpreter";
import type { RegCodeElement, RegInstruction, RegModule, RegPacket } from "../runtime/vm/regcode";
import { isRegPacket } from "../runtime/vm/regcode";
import {
  regPackMetrics,
  retargetProcedureOffsets,
  scheduleRegCode,
  type RegPackMetrics,
} from "./regScheduler";
import { resolveEntryIndex } from "../oracle/parity";

/** Одно наблюдение прогона: вызов хоста или итог. */
export type RegInstructionStatus = "equal" | "diverged" | "not_comparable";

export interface RegVliwStep {
  kind: "invoke" | "return";
  name?: string;
  args?: StackValue[];
  value?: StackValue | undefined;
}

export interface RegVliwOracleReport {
  /** Модуль, собранный из исходника (линейный). */
  linear: RegModule;
  /** Модуль после планирования. */
  scheduled: RegModule;
  linearResult: StackValue | undefined;
  scheduledResult: StackValue | undefined;
  /** Совпали итоговые значения. */
  equal: boolean;
  /** Совпали трассы вызовов хоста (главное доказательство). */
  tracesEqual: boolean;
  /** Индекс первого расхождения трасс (`-1` — нет). */
  divergenceIndex: number;
  linearTrace: RegVliwStep[];
  scheduledTrace: RegVliwStep[];
  /**
   * Сравнение потоков исполненных инструкций.
   *
   * `not_comparable` — прогон упёрся в лимит шагов. Счётчик шагов VM
   * инкрементируется **на элемент кода**, а не на инструкцию
   * (`reginterpreter.ts`: пакет — это один шаг), поэтому упакованная сторона за
   * те же 200 000 шагов исполняет больше инструкций, чем линейная. Наборы
   * различаются по построению, а не из-за ошибки планировщика: сравнивать их
   * осмысленно только на завершающихся программах.
   */
  instructionsStatus: RegInstructionStatus;
  /** `instructionsStatus !== "diverged"` — расхождения не найдено. */
  instructionsEqual: boolean;
  /** Индекс первого расхождения потоков инструкций (`-1` — нет). */
  instructionDivergenceIndex: number;
  linearInstructionCount: number;
  scheduledInstructionCount: number;
  /** Прогон упёрся в лимит шагов (бесконечный `цикл`): обе стороны обязаны упереться. */
  stepLimitReached: boolean;
  /** Ошибки прогонов (пусто при нормальном завершении). */
  linearError: string | null;
  scheduledError: string | null;
  metrics: RegPackMetrics;
}

export interface RegVliwOracleOptions {
  entryProcedure?: string;
  args?: StackValue[];
  /** Лимит шагов на прогон (различные ошибки лимита — не расхождение планировщика). */
  maxSteps?: number;
}

/** Собрать регистровый модуль из исходника; `null`, если не компилируется. */
export function regModuleOf(source: string): { module: RegModule; compiled: CompileResult } | null {
  const compiled = compileSource(source);
  if (!compiled.module || !compiled.moduleAst) return null;
  return { module: compileToReg(compiled.moduleAst), compiled };
}

function cloneModule(module: RegModule): RegModule {
  // Регистровый модуль — обычные данные (числа/строки/массивы/объекты), поэтому
  // структурная копия безопасна и не тащит живых ссылок.
  return JSON.parse(JSON.stringify(module)) as RegModule;
}

/**
 * Сверка набора исполненных инструкций.
 *
 * Порядок сравнивать нельзя: планировщик переставляет независимые инструкции —
 * в этом весь смысл. Сравнивается **мультимножество** ключей: упакованный код
 * обязан исполнить ровно те же инструкции столько же раз. Ключ — позиция
 * инструкции в линейном коде (обе стороны исполняют те же объекты).
 */
function sameInstructionMultiset(a: readonly string[], b: readonly string[]): boolean {
  return firstMultisetDifference(a, b) < 0;
}

/** Первое расхождение мультимножеств (`-1`, если равны). */
function firstMultisetDifference(a: readonly string[], b: readonly string[]): number {
  const countA = new Map<string, number>();
  for (const k of a) countA.set(k, (countA.get(k) ?? 0) + 1);
  const countB = new Map<string, number>();
  for (const k of b) countB.set(k, (countB.get(k) ?? 0) + 1);
  // Разные длины — расхождение уже есть; индекс берём по концу общего префикса.
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (const [k, n] of countA) {
    if ((countB.get(k) ?? 0) !== n) {
      const i = a.indexOf(k);
      return i >= 0 ? i : 0;
    }
  }
  for (const [k, n] of countB) {
    if ((countA.get(k) ?? 0) !== n) {
      const i = b.indexOf(k);
      return i >= 0 ? i : 0;
    }
  }
  return -1;
}

interface RunOutcome {
  value: StackValue | undefined;
  trace: RegVliwStep[];
  /**
   * Ключи исполненных инструкций. Ключ строится по позиции инструкции в
   * **исходном линейном** массиве: обе стороны исполняют те же объекты, поэтому
   * ключ сопоставим. Для упакованного модуля позиция берётся из слота.
   */
  instructions: string[];
  error: string | null;
}

async function runReg(
  module: RegModule,
  entryIndex: number,
  args: StackValue[],
  invokeFactory: () => InvokeHandler,
  maxSteps: number,
  keyOf: (el: RegCodeElement, slotIndex: number, pc: number) => string,
): Promise<RunOutcome> {
  const trace: RegVliwStep[] = [];
  const instructions: string[] = [];
  const host = invokeFactory();
  const vm = new RegVM(module, {
    maxSteps,
    invoke: (name, a) => {
      trace.push({ kind: "invoke", name, args: a.slice() });
      return host(name, a);
    },
    onExecute: (info) => {
      const el = module.code[info.pc];
      if (el === undefined) return;
      instructions.push(keyOf(el, info.slotIndex, info.pc));
    },
  });
  let value: StackValue | undefined;
  let error: string | null = null;
  try {
    value = await vm.runProcedure(entryIndex, args);
  } catch (e) {
    // Лимит шагов — не ошибка планировщика: программа может быть бесконечной
    // (`цикл` в оконных приложениях). Сравниваем то, что успело исполниться.
    error = e instanceof Error ? e.message : String(e);
  }
  trace.push({ kind: "return", value });
  return { value, trace, instructions, error };
}

function sameTraceStep(a: RegVliwStep | undefined, b: RegVliwStep | undefined): boolean {
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

/**
 * Прогон оракула: исходник → линейный регистровый код → планировщик → сверка.
 *
 * @param source `.osnova`-исходник.
 */
export async function runRegVliwOracle(
  source: string,
  options: RegVliwOracleOptions = {},
): Promise<RegVliwOracleReport> {
  const built = regModuleOf(source);
  if (!built) {
    throw new Error("vliw(reg): исходник не компилируется");
  }
  const linear = built.module;
  const entryIndex = resolveEntryIndex(linear.procedures, options.entryProcedure);
  const args = options.args ?? [];
  const invokeFactory = createDefaultInvokeHandler;
  const maxSteps = options.maxSteps ?? 200_000;

  // Планировщик работает на **копии** модуля (он мутирует адреса переходов) и
  // сам сообщает, какая инструкция легла в какой элемент и слот (`keys`).
  // Поэтому сверка набора исполненных инструкций не зависит от ссылок на копию.
  const scheduled = cloneModule(linear);
  const schedule = scheduleRegCode(scheduled.code as never);
  scheduled.code = schedule.elements as RegCodeElement[];
  scheduled.vliwSlots = 4;
  // Адреса процедур тоже сдвинулись: упаковка уменьшила число элементов.
  retargetProcedureOffsets(scheduled, schedule.positionOf);

  /** Линейный модуль: один элемент — одна инструкция, ключ равен позиции. */
  const keyLinear = (_el: RegCodeElement, _slotIndex: number, pc: number): string =>
    String(pc);
  /** Упакованный модуль: ключ берётся из карты планирования. */
  const keyScheduled = (_el: RegCodeElement, slotIndex: number, pc: number): string => {
    const slotKeys = schedule.keys[pc];
    const key = slotKeys?.[slotIndex];
    return key === undefined ? "?" : String(key);
  };

  // Линейный модуль исполняется как есть (до планирования — чтобы мутация
  // адресов планировщиком не влияла на «эталонную» сторону).
  const linearOutcome = await runReg(
    linear,
    entryIndex,
    args.slice(),
    invokeFactory,
    maxSteps,
    keyLinear,
  );

  const scheduledOutcome = await runReg(
    scheduled,
    entryIndex,
    args.slice(),
    invokeFactory,
    maxSteps,
    keyScheduled,
  );

  const stepLimitReached =
    linearOutcome.error !== null && scheduledOutcome.error !== null;

  // Сравниваем наблюдаемые шаги. Если оба прогона упёрлись в лимит (бесконечный
  // `цикл`), хвост сравнить не с чем: у сторон разное число элементов на шаг,
  // поэтому обрезаем до общего префикса и не считаем «хвостовой return»
  // расхождением. Итог в этом случае не определён у обеих сторон.
  const traceLen = stepLimitReached
    ? Math.min(linearOutcome.trace.length, scheduledOutcome.trace.length)
    : Math.max(linearOutcome.trace.length, scheduledOutcome.trace.length);
  let divergenceIndex = -1;
  for (let i = 0; i < traceLen; i++) {
    if (!sameTraceStep(linearOutcome.trace[i], scheduledOutcome.trace[i])) {
      divergenceIndex = i;
      break;
    }
  }
  if (!stepLimitReached && linearOutcome.trace.length !== scheduledOutcome.trace.length) {
    divergenceIndex = Math.min(linearOutcome.trace.length, scheduledOutcome.trace.length);
  }
  // Набор исполненных инструкций: порядок сравнивать нельзя (планировщик для
  // того и переставляет), но набор обязан совпасть — иначе одна из сторон
  // исполнила лишнее или пропустила нужное. При упоре в лимит шагов сравнение
  // неприменимо: счётчик шагов считает элементы, а не инструкции, поэтому
  // упакованная сторона успевает исполнить больше (см. `instructionsStatus`).
  const multisetEqual = sameInstructionMultiset(
    linearOutcome.instructions,
    scheduledOutcome.instructions,
  );
  const instructionsStatus: RegInstructionStatus = stepLimitReached
    ? "not_comparable"
    : multisetEqual
      ? "equal"
      : "diverged";
  const instructionsEqual = instructionsStatus !== "diverged";
  const instructionDivergenceIndex =
    instructionsStatus === "diverged"
      ? firstMultisetDifference(linearOutcome.instructions, scheduledOutcome.instructions)
      : -1;

  const metrics = regPackMetrics(linear.code as never, schedule.packets);
  return {
    linear,
    scheduled,
    linearResult: linearOutcome.value,
    scheduledResult: scheduledOutcome.value,
    equal: sameValue(linearOutcome.value, scheduledOutcome.value),
    // При лимите шагов оба прогона не завершились: трасса обрезана у обеих
    // сторон, и «хвостовой return» ставить некуда. Расхождением считается
    // только расхождение в общем префиксе — а он проверен выше.
    tracesEqual: divergenceIndex < 0 || stepLimitReached,
    divergenceIndex,
    linearTrace: linearOutcome.trace,
    scheduledTrace: scheduledOutcome.trace,
    instructionsStatus,
    instructionsEqual,
    instructionDivergenceIndex,
    linearInstructionCount: linearOutcome.instructions.length,
    scheduledInstructionCount: scheduledOutcome.instructions.length,
    stepLimitReached,
    linearError: linearOutcome.error,
    scheduledError: scheduledOutcome.error,
    metrics,
  };
}

/** Пакеты модуля (для отчётов и тестов). */
export function packetsOf(module: RegModule): RegPacket[] {
  return module.code.filter((el): el is RegPacket => isRegPacket(el));
}
