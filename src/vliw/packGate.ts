/**
 * Gate упаковки: линейный прогон против упакованного, плюс проверка структуры.
 *
 * ## Что такое зелёный gate упаковки
 *
 * Четыре условия, каждое проверяется на каждой программе корпуса:
 *
 * 1. **структура** — `verifyPackets(packed, model)` не находит нарушений;
 * 2. **эквивалентность** — исполненные инструкции, значение, трасса хост-вызовов
 *    и текст ошибки совпадают с линейным прогоном;
 * 3. **адреса** — все `off` и `codeOffset` пересчитаны (нет непересчитанных);
 * 4. **упаковка не раздувает код** — элементов после не больше, чем до.
 *
 * ## Чего gate НЕ измеряет
 *
 * Он не измеряет скорость. Число элементов кода — статическая величина; сколько
 * тактов программа займёт на настоящем e2k, из неё не следует. Метрика здесь
 * называется **плотностью упаковки** и определена как инструкций на элемент кода.
 */

import { createDefaultInvokeHandler, type StackValue } from "../runtime/vm/interpreter";
import { RegVM } from "../runtime/vm/reginterpreter";
import { isRegPacket, type RegModule } from "../runtime/vm/regcode";
import { resolveEntryIndex } from "../oracle/parity";
import { packInstructions, type PackDefects, type PackStats } from "./packetPacker";
import { verifyPackets, type MachineModel, type VerifyResult } from "./packetVerifier";

/** Программа корпуса для gate упаковки. */
export interface PackGateCase {
  /** Имя для отчёта. */
  name: string;
  /** Регистровый модуль в линейном виде (без пакетов). */
  module: RegModule;
  /** Точка входа (по умолчанию — как её находит оракул). */
  entryProcedure?: string;
  /** Аргументы точки входа. */
  args?: StackValue[];
  /**
   * Программа заведомо не завершается (оконный цикл). Для таких случаев
   * сравнивается общее начало трасс: обе стороны упираются в лимит шагов,
   * причём на разном числе инструкций (шаг VM — элемент кода, а в пакете
   * инструкций больше).
   */
  expectNonTerminating?: boolean;
}

/** Опции gate. */
export interface PackGateOptions {
  model: MachineModel;
  maxSteps?: number;
  /** Инъекция дефектов: используется только негативным контролем. */
  defects?: PackDefects;
}

/** Результат прогона одной стороны. */
interface RunOutcome {
  value: StackValue | undefined;
  error: string | null;
  /** Ключи исполненных инструкций — индекс в исходном линейном коде. */
  executed: number[];
  /**
   * Сколько РАЗ VM сдвинула указатель на новый элемент кода.
   *
   * Это и есть «шаг VM»: один элемент — один шаг, независимо от того, инструкция
   * это или пакет. Число исполненных инструкций при упаковке не меняется, а это
   * число — уменьшается: в этом и состоит статический эффект пакета.
   */
  elementSteps: number;
  /** Имена и аргументы хост-вызовов. */
  invokes: string[];
}

/** Результат одной программы. */
export interface PackGateCaseResult {
  name: string;
  /** Программа заведомо не завершается: в итоги не входит (лимит шагов искажает суммы). */
  nonTerminating: boolean;
  verify: VerifyResult;
  equivalent: boolean;
  divergenceIndex: number;
  linearSteps: number;
  packedSteps: number;
  /** Шагов VM (элементов кода): линейно и упаковано. */
  linearElementSteps: number;
  packedElementSteps: number;
  linearValue: string;
  packedValue: string;
  stats: PackStats;
  unmappedAddresses: number[];
  /** Пусто — программа зелёная. */
  problems: string[];
}

/** Отчёт gate упаковки. */
export interface PackGateReport {
  passed: boolean;
  modelSlots: number;
  defects: PackDefects;
  cases: PackGateCaseResult[];
  totals: {
    instructions: number;
    elementsBefore: number;
    elementsAfter: number;
    widePackets: number;
    packedInstructions: number;
    densityBefore: number;
    densityAfter: number;
    /** Исполнено инструкций: суммарно линейно и упаковано (не меняется). */
    executedInstructions: number;
    /** Шагов VM (элементов): суммарно линейно и упаковано. */
    linearElementSteps: number;
    packedElementSteps: number;
  };
  green: number;
  red: number;
}

function formatValue(value: StackValue | undefined): string {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Есть ли в модуле готовые пакеты (для линейной стороны это недопустимо). */
function hasPackets(module: RegModule): boolean {
  return module.code.some((el) => isRegPacket(el));
}

async function execute(
  module: RegModule,
  entryIndex: number,
  args: StackValue[],
  maxSteps: number,
  keyOf: (pc: number, slotIndex: number) => number,
): Promise<RunOutcome> {
  const executed: number[] = [];
  const invokes: string[] = [];
  let elementSteps = 0;
  let lastPc = -1;
  const host = createDefaultInvokeHandler();
  const vm = new RegVM(module, {
    maxSteps,
    invoke: (name, callArgs) => {
      invokes.push(`${name}(${callArgs.map((a) => formatValue(a)).join(",")})`);
      return host(name, callArgs);
    },
    onExecute: (info) => {
      if (info.pc !== lastPc) {
        elementSteps++;
        lastPc = info.pc;
      }
      executed.push(keyOf(info.pc, info.slotIndex));
    },
  });
  let value: StackValue | undefined;
  let error: string | null = null;
  try {
    value = await vm.runProcedure(entryIndex, args);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return { value, error, executed, elementSteps, invokes };
}

interface Comparison {
  equivalent: boolean;
  divergenceIndex: number;
}

/**
 * Сравнить два прогона.
 *
 * @param prefixOnly сравнивать только общее начало (программа не завершается,
 *   стороны упираются в лимит шагов на разном числе инструкций: шаг VM — элемент
 *   кода, а в пакете инструкций больше, поэтому упакованный прогон успевает
 *   исполнить больше и его трасса длиннее)
 */
function compareOutcomes(a: RunOutcome, b: RunOutcome, prefixOnly: boolean): Comparison {
  const limit = prefixOnly ? Math.min(a.executed.length, b.executed.length) : Math.max(a.executed.length, b.executed.length);
  for (let i = 0; i < limit; i++) {
    if (a.executed[i] !== b.executed[i]) return { equivalent: false, divergenceIndex: i };
  }
  if (!prefixOnly && a.executed.length !== b.executed.length) {
    return { equivalent: false, divergenceIndex: Math.min(a.executed.length, b.executed.length) };
  }
  // Ошибка сравнивается и в режиме префикса: если одна сторона упёрлась в лимит
  // шагов, а другая завершилась, это расхождение, а не свойство лимита.
  if ((a.error ?? null) !== (b.error ?? null)) return { equivalent: false, divergenceIndex: limit };
  if (!prefixOnly && formatValue(a.value) !== formatValue(b.value)) {
    return { equivalent: false, divergenceIndex: limit };
  }
  if (!prefixOnly && a.invokes.length !== b.invokes.length) {
    return { equivalent: false, divergenceIndex: limit };
  }
  const invokeLimit = prefixOnly ? Math.min(a.invokes.length, b.invokes.length) : a.invokes.length;
  for (let i = 0; i < invokeLimit; i++) {
    if (a.invokes[i] !== b.invokes[i]) return { equivalent: false, divergenceIndex: limit };
  }
  return { equivalent: true, divergenceIndex: -1 };
}

async function runCase(testCase: PackGateCase, options: PackGateOptions): Promise<PackGateCaseResult> {
  const model = options.model;
  const maxSteps = options.maxSteps ?? 200_000;
  const problems: string[] = [];
  const linear = testCase.module;

  if (hasPackets(linear)) {
    throw new Error(`gate упаковки: ${testCase.name} — вход не линейный (в модуле уже есть пакеты)`);
  }

  const entryIndex = resolveEntryIndex(linear.procedures, testCase.entryProcedure);
  const args = testCase.args ?? [];
  const prefixOnly = testCase.expectNonTerminating === true;

  const packed = packInstructions(linear, model, options.defects);

  const linearOutcome = await execute(linear, entryIndex, args.slice(), maxSteps, (pc) => pc);
  const packedOutcome = await execute(packed.module, entryIndex, args.slice(), maxSteps, (pc, slot) => {
    const elementKeys = packed.keys[pc];
    const key = elementKeys?.[slot];
    return key === undefined ? -1 : key;
  });

  const verify = verifyPackets(packed.module, model);
  const comparison = compareOutcomes(linearOutcome, packedOutcome, prefixOnly);

  if (!verify.ok) problems.push(`верификатор: ${verify.reason} (элемент ${verify.at})`);
  if (!comparison.equivalent) {
    problems.push(`эквивалентность: расхождение на шаге ${comparison.divergenceIndex}`);
  }
  if (packed.unmappedAddresses.length > 0) {
    problems.push(`адреса: не пересчитано ${packed.unmappedAddresses.length} (${packed.unmappedAddresses.slice(0, 5).join(", ")})`);
  }
  if (packed.stats.elementsAfter > packed.stats.elementsBefore) {
    problems.push(
      `упаковка раздула код: элементов ${packed.stats.elementsBefore} → ${packed.stats.elementsAfter}`,
    );
  }
  if (prefixOnly && linearOutcome.error === null) {
    problems.push("ожидалось незавершение, но линейный прогон завершился");
  }

  return {
    name: testCase.name,
    nonTerminating: prefixOnly,
    verify,
    equivalent: comparison.equivalent,
    divergenceIndex: comparison.divergenceIndex,
    linearSteps: linearOutcome.executed.length,
    packedSteps: packedOutcome.executed.length,
    linearElementSteps: linearOutcome.elementSteps,
    packedElementSteps: packedOutcome.elementSteps,
    linearValue: formatValue(linearOutcome.value),
    packedValue: formatValue(packedOutcome.value),
    stats: packed.stats,
    unmappedAddresses: packed.unmappedAddresses,
    problems,
  };
}

/** Прогнать gate упаковки по корпусу. */
export async function runPackGate(
  cases: readonly PackGateCase[],
  options: PackGateOptions,
): Promise<PackGateReport> {
  const results: PackGateCaseResult[] = [];
  for (const testCase of cases) results.push(await runCase(testCase, options));

  // Итоги — по завершающимся программам: у незавершающейся стороны упираются в
  // лимит шагов, и её числа зависят от лимита, а не от упаковки.
  const totals = results
    .filter((r) => !r.nonTerminating)
    .reduce(
    (acc, r) => ({
      instructions: acc.instructions + r.stats.instructions,
      elementsBefore: acc.elementsBefore + r.stats.elementsBefore,
      elementsAfter: acc.elementsAfter + r.stats.elementsAfter,
      widePackets: acc.widePackets + r.stats.widePackets,
      packedInstructions: acc.packedInstructions + r.stats.packedInstructions,
      densityBefore: 0,
      densityAfter: 0,
      executedInstructions: acc.executedInstructions + r.linearSteps,
      linearElementSteps: acc.linearElementSteps + r.linearElementSteps,
      packedElementSteps: acc.packedElementSteps + r.packedElementSteps,
    }),
    {
      instructions: 0,
      elementsBefore: 0,
      elementsAfter: 0,
      widePackets: 0,
      packedInstructions: 0,
      densityBefore: 0,
      densityAfter: 0,
      executedInstructions: 0,
      linearElementSteps: 0,
      packedElementSteps: 0,
    },
  );
  totals.densityBefore = totals.elementsBefore > 0 ? totals.instructions / totals.elementsBefore : 0;
  totals.densityAfter = totals.elementsAfter > 0 ? totals.instructions / totals.elementsAfter : 0;

  const red = results.filter((r) => r.problems.length > 0).length;

  return {
    passed: red === 0,
    modelSlots: options.model.slots,
    defects: options.defects ?? {},
    cases: results,
    totals,
    green: results.length - red,
    red,
  };
}

/** Отчёт в виде текста. */
export function formatPackGateReport(report: PackGateReport): string {
  const lines: string[] = [];
  const defects = Object.entries(report.defects).filter(([, v]) => v === true);
  lines.push("gate упаковки: плотность упаковки (не скорость)");
  lines.push(
    `модель: ${report.modelSlots} слотов` +
      (defects.length > 0 ? `; ВНЕСЁННЫЕ ДЕФЕКТЫ: ${defects.map(([k]) => k).join(", ")}` : ""),
  );
  lines.push(`программ: ${report.cases.length}, зелёных: ${report.green}, красных: ${report.red}`);
  lines.push("");
  lines.push(
    "программа | инструкций | элементов | плотность | широких | инструкций исполнено | шагов VM | верификатор | эквивалентность",
  );
  for (const c of report.cases) {
    const density = `${c.stats.densityBefore.toFixed(2)} → ${c.stats.densityAfter.toFixed(2)}`;
    const elements = `${c.stats.elementsBefore} → ${c.stats.elementsAfter}`;
    const verify = c.verify.ok ? "ok" : `КРАСНЫЙ (элемент ${c.verify.at})`;
    const equivalence = c.equivalent ? "совпадает" : `расхождение@${c.divergenceIndex}`;
    lines.push(
      `${c.name} | ${c.stats.instructions} | ${elements} | ${density} | ${c.stats.widePackets} | ` +
        `${c.linearSteps} → ${c.packedSteps} | ${c.linearElementSteps} → ${c.packedElementSteps} | ` +
        `${verify} | ${equivalence}`,
    );
    for (const p of c.problems) lines.push(`    ! ${p}`);
  }
  lines.push("");
  lines.push(
    `итого по завершающимся программам: инструкций ${report.totals.instructions}, элементов ` +
      `${report.totals.elementsBefore} → ${report.totals.elementsAfter}, плотность упаковки ` +
      `${report.totals.densityBefore.toFixed(2)} → ${report.totals.densityAfter.toFixed(2)}, ` +
      `широких пакетов ${report.totals.widePackets}, инструкций внутри пакетов ${report.totals.packedInstructions}`,
  );
  lines.push(
    `исполнено инструкций ${report.totals.executedInstructions} (не зависит от упаковки); ` +
      `шагов VM (элементов) ${report.totals.linearElementSteps} → ${report.totals.packedElementSteps}`,
  );
  lines.push(
    "шаг VM — это свойство этой VM (один элемент = один шаг), а не такт e2k: " +
      "замеров на железе нет, и ускорение этими числами не доказано",
  );
  lines.push(report.passed ? "gate зелёный" : `gate красный (${report.red} программ)`);
  return lines.join("\n");
}
