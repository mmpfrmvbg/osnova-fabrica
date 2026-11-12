/**
 * Gate конвейера VLIW: четыре конфигурации на одной программе.
 *
 * ## Что проверяется
 *
 * Каждая программа корпуса прогоняется **четыре раза** — по одной на конфигурацию
 * конвейера (`docs/vliw-packing.md`):
 *
 * | конфигурация | что должно совпасть с эталоном |
 * | --- | --- |
 * | `linear` | эталон |
 * | `reorder` | НАБОР исполненных инструкций, трасса вызовов, значение, ошибка |
 * | `packets` | ПОСЛЕДОВАТЕЛЬНОСТЬ исполненных инструкций (упаковка порядка не меняет) |
 * | `reorder+packets` | набор — с эталоном, а последовательность — с `reorder` |
 *
 * Последняя строка — главное: упаковка обязана сохранить порядок, заданный
 * перестановкой. Именно этот стык не проверялся ни разу, пока конвейер не был
 * объединён. Плюс два требования к метрике:
 *
 * 5. `verifyPackets` не находит нарушений в обеих упакованных конфигурациях;
 * 6. **плотность упаковки после объединения не ниже**, чем от одной упаковки.
 *
 * ## Чего gate не измеряет
 *
 * Скорость. Плотность упаковки и шаги VM — статические величины. **Шаги VM — не
 * метрика скорости и не должны попадать в отчёты как ускорение**: VM считает шагом
 * элемент кода, а не такт e2k (`docs/vliw-packing.md`, §0).
 */

import { createDefaultInvokeHandler, type StackValue } from "../runtime/vm/interpreter";
import { RegVM } from "../runtime/vm/reginterpreter";
import { isRegPacket, type RegModule } from "../runtime/vm/regcode";
import { resolveEntryIndex } from "../oracle/parity";
import type { ReorderOptions } from "./reorderScheduler";
import type { PackDefects } from "./packetPacker";
import { verifyPackets, type MachineModel, type VerifyResult } from "./packetVerifier";
import { buildVliwConfigs, type PipelineDefects, type VliwConfig, type VliwConfigId } from "./vliwPipeline";

/** Программа корпуса для gate конвейера. */
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
   * сравнивается общее начало трасс: распакованные конфигурации упираются в
   * лимит шагов на одном числе инструкций, упакованные за тот же лимит успевают
   * исполнить больше (шаг VM — элемент кода, а в пакете инструкций несколько).
   */
  expectNonTerminating?: boolean;
}

/** Опции gate. */
export interface PackGateOptions {
  model: MachineModel;
  maxSteps?: number;
  /** Инъекция дефектов упаковщика: только для негативного контроля. */
  defects?: PackDefects;
  /** Инъекция дефектов сборки конвейера: только для негативного контроля. */
  pipelineDefects?: PipelineDefects;
  /** Опции перестановки. */
  reorder?: ReorderOptions;
}

/** Прогон одной конфигурации. */
interface RunOutcome {
  value: StackValue | undefined;
  error: string | null;
  /** Ключи исполненных инструкций — индекс в ИСХОДНОМ линейном коде. */
  executed: number[];
  /** Сколько раз VM сменила элемент кода (шаг VM, не такт). */
  elementSteps: number;
  /** Имена и аргументы хост-вызовов. */
  invokes: string[];
}

/** Как сравнивается конфигурация с эталоном. */
type ComparisonMode =
  | "эталон"
  | "последовательность"
  | "набор"
  | "набор + порядок перестановки"
  | "порядок перестановки";

/** Результат одной конфигурации на одной программе. */
export interface VliwConfigCaseResult {
  id: VliwConfigId;
  title: string;
  verify: VerifyResult;
  equivalent: boolean;
  comparison: ComparisonMode;
  /** `-1` — расхождений нет. Для режима «набор» — позиция в отсортированном наборе. */
  divergenceIndex: number;
  executedInstructions: number;
  elementSteps: number;
  elements: number;
  density: number;
  widePackets: number;
  unmappedAddresses: number[];
  problems: string[];
}

/** Результат одной программы. */
export interface PackGateCaseResult {
  name: string;
  /** Программа заведомо не завершается: в итоги не входит. */
  nonTerminating: boolean;
  configs: VliwConfigCaseResult[];
  /** Плотность упаковки: от одной упаковки и после объединения. */
  densityPackets: number;
  densityCombined: number;
  problems: string[];
}

/** Отчёт gate. */
export interface PackGateReport {
  passed: boolean;
  modelSlots: number;
  defects: PackDefects;
  cases: PackGateCaseResult[];
  totals: {
    instructions: number;
    /** Элементов кода по конфигурациям. */
    elements: Record<VliwConfigId, number>;
    /** Плотность упаковки по конфигурациям. */
    density: Record<VliwConfigId, number>;
    /** Шагов VM (элементов) по конфигурациям. */
    elementSteps: Record<VliwConfigId, number>;
    executedInstructions: number;
  };
  green: number;
  red: number;
}

const CONFIG_ORDER: VliwConfigId[] = ["linear", "reorder", "packets", "reorder+packets"];

function formatValue(value: StackValue | undefined): string {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function hasPackets(module: RegModule): boolean {
  return module.code.some((el) => isRegPacket(el));
}

async function execute(
  config: VliwConfig,
  entryIndex: number,
  args: StackValue[],
  maxSteps: number,
): Promise<RunOutcome> {
  const executed: number[] = [];
  const invokes: string[] = [];
  let elementSteps = 0;
  let lastPc = -1;
  const host = createDefaultInvokeHandler();
  const vm = new RegVM(config.module, {
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
      const key = config.keys[info.pc]?.[info.slotIndex];
      executed.push(key === undefined ? -1 : key);
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
  ok: boolean;
  at: number;
}

/** Совпадают ли последовательности (общее начало, если `prefixOnly`). */
function sameSequence(a: readonly number[], b: readonly number[], prefixOnly: boolean): Comparison {
  const limit = prefixOnly ? Math.min(a.length, b.length) : Math.max(a.length, b.length);
  for (let i = 0; i < limit; i++) {
    if (a[i] !== b[i]) return { ok: false, at: i };
  }
  if (!prefixOnly && a.length !== b.length) return { ok: false, at: Math.min(a.length, b.length) };
  return { ok: true, at: -1 };
}

/** Совпадают ли наборы исполненных инструкций (порядок при перестановке законно другой). */
function sameMultiset(a: readonly number[], b: readonly number[]): Comparison {
  if (a.length !== b.length) return { ok: false, at: Math.min(a.length, b.length) };
  const x = [...a].sort((p, q) => p - q);
  const y = [...b].sort((p, q) => p - q);
  for (let i = 0; i < x.length; i++) {
    if (x[i] !== y[i]) return { ok: false, at: i };
  }
  return { ok: true, at: -1 };
}

/** Совпадают ли значение, трасса хост-вызовов и текст ошибки. */
function sameRuntime(a: RunOutcome, b: RunOutcome, prefixOnly: boolean): Comparison {
  if ((a.error ?? null) !== (b.error ?? null)) return { ok: false, at: -1 };
  if (!prefixOnly && formatValue(a.value) !== formatValue(b.value)) return { ok: false, at: -1 };
  if (!prefixOnly && a.invokes.length !== b.invokes.length) return { ok: false, at: -1 };
  const limit = prefixOnly ? Math.min(a.invokes.length, b.invokes.length) : a.invokes.length;
  for (let i = 0; i < limit; i++) {
    if (a.invokes[i] !== b.invokes[i]) return { ok: false, at: -1 };
  }
  return { ok: true, at: -1 };
}

async function runCase(testCase: PackGateCase, options: PackGateOptions): Promise<PackGateCaseResult> {
  const model = options.model;
  const maxSteps = options.maxSteps ?? 200_000;
  const prefixOnly = testCase.expectNonTerminating === true;
  const linear = testCase.module;

  if (hasPackets(linear)) {
    throw new Error(`gate конвейера: ${testCase.name} — вход не линейный (в модуле уже есть пакеты)`);
  }

  const entryIndex = resolveEntryIndex(linear.procedures, testCase.entryProcedure);
  const args = testCase.args ?? [];
  // Дефекты упаковщика применяются к ОБЕИМ упакованным конфигурациям: gate должен
  // ловить их и в одиночной упаковке, и в объединённой.
  const configs = buildVliwConfigs(
    linear,
    model,
    options.reorder ?? {},
    options.defects,
    options.pipelineDefects,
  );

  const outcomes: Record<VliwConfigId, RunOutcome> = {} as Record<VliwConfigId, RunOutcome>;
  for (const id of CONFIG_ORDER) {
    outcomes[id] = await execute(configs[id], entryIndex, args.slice(), maxSteps);
  }

  const baseline = outcomes.linear;
  const reorderOutcome = outcomes.reorder;
  const caseProblems: string[] = [];
  const results: VliwConfigCaseResult[] = [];

  for (const id of CONFIG_ORDER) {
    const config = configs[id];
    const outcome = outcomes[id];
    const problems: string[] = [...config.problems];
    const packed = id === "packets" || id === "reorder+packets";
    const verify: VerifyResult = packed ? verifyPackets(config.module, model) : { ok: true };
    if (!verify.ok) problems.push(`верификатор: ${verify.reason} (элемент ${verify.at})`);

    let equivalent = true;
    let mode: ComparisonMode = "эталон";
    let at = -1;

    if (id === "packets") {
      mode = "последовательность";
      const seq = sameSequence(outcome.executed, baseline.executed, prefixOnly);
      const runtime = sameRuntime(outcome, baseline, prefixOnly);
      equivalent = seq.ok && runtime.ok;
      at = seq.ok ? runtime.at : seq.at;
    } else if (id === "reorder") {
      mode = "набор";
      const set = sameMultiset(outcome.executed, baseline.executed);
      const runtime = sameRuntime(outcome, baseline, prefixOnly);
      equivalent = set.ok && runtime.ok;
      at = set.ok ? runtime.at : set.at;
    } else if (id === "reorder+packets") {
      const order = sameSequence(outcome.executed, reorderOutcome.executed, true);
      const runtime = sameRuntime(outcome, baseline, prefixOnly);
      if (prefixOnly) {
        /**
         * Незавершающаяся программа: набор с эталоном сравнить НЕЛЬЗЯ.
         *
         * За один и тот же лимит шагов упакованная сторона исполняет больше
         * инструкций (шаг VM — элемент кода, а в пакете их несколько), поэтому
         * длины трасс разные по построению, и равные наборы невозможны. Что
         * проверяется вместо этого: порядок относительно конфигурации
         * перестановки — он обязан совпасть посимвольно на общем начале; сама
         * перестановка сверена с эталоном по набору отдельной строкой.
         */
        mode = "порядок перестановки";
        equivalent = order.ok && runtime.ok;
        at = order.ok ? runtime.at : order.at;
      } else {
        mode = "набор + порядок перестановки";
        const set = sameMultiset(outcome.executed, baseline.executed);
        equivalent = set.ok && order.ok && runtime.ok;
        at = !set.ok ? set.at : !order.ok ? order.at : runtime.at;
      }
      if (!order.ok) {
        problems.push(
          `упаковка изменила порядок, заданный перестановкой: первое расхождение на шаге ${order.at}`,
        );
      }
    }

    if (!equivalent) {
      problems.push(`эквивалентность (${mode}): расхождение${at >= 0 ? ` на шаге ${at}` : ""}`);
    }
    if (config.unmappedAddresses.length > 0) {
      problems.push(
        `адреса: не пересчитано ${config.unmappedAddresses.length} ` +
          `(${config.unmappedAddresses.slice(0, 5).join(", ")})`,
      );
    }
    if (config.elements > config.instructions) {
      problems.push(`код раздут: элементов ${config.elements} при ${config.instructions} инструкциях`);
    }

    results.push({
      id,
      title: config.title,
      verify,
      equivalent,
      comparison: mode,
      divergenceIndex: at,
      executedInstructions: outcome.executed.length,
      elementSteps: outcome.elementSteps,
      elements: config.elements,
      density: config.density,
      widePackets: config.widePackets,
      unmappedAddresses: config.unmappedAddresses,
      problems,
    });
    for (const p of problems) caseProblems.push(`${config.title}: ${p}`);
  }

  if (prefixOnly && baseline.error === null) {
    caseProblems.push("ожидалось незавершение, но линейный прогон завершился");
  }

  const densityPackets = results.find((r) => r.id === "packets")!.density;
  const densityCombined = results.find((r) => r.id === "reorder+packets")!.density;
  if (densityCombined + 1e-9 < densityPackets) {
    caseProblems.push(
      `плотность после объединения ниже, чем от одной упаковки: ` +
        `${densityCombined.toFixed(4)} против ${densityPackets.toFixed(4)}`,
    );
  }

  return {
    name: testCase.name,
    nonTerminating: prefixOnly,
    configs: results,
    densityPackets,
    densityCombined,
    problems: caseProblems,
  };
}

/** Прогнать gate конвейера по корпусу. */
export async function runPackGate(
  cases: readonly PackGateCase[],
  options: PackGateOptions,
): Promise<PackGateReport> {
  const results: PackGateCaseResult[] = [];
  for (const testCase of cases) results.push(await runCase(testCase, options));

  // Итоги — по завершающимся программам: у незавершающейся стороны упираются в
  // лимит шагов, и её числа зависят от лимита, а не от конфигурации.
  const counted = results.filter((r) => !r.nonTerminating);
  const instructions = counted.reduce(
    (sum, r) => sum + (r.configs.find((c) => c.id === "linear")?.executedInstructions ?? 0),
    0,
  );
  const empty = (): Record<VliwConfigId, number> => ({
    linear: 0,
    reorder: 0,
    packets: 0,
    "reorder+packets": 0,
  });
  const elements = empty();
  const elementSteps = empty();
  for (const r of counted) {
    for (const c of r.configs) {
      elements[c.id] += c.elements;
      elementSteps[c.id] += c.elementSteps;
    }
  }
  const elementsTotal = counted.reduce(
    (sum, r) => sum + (r.configs.find((c) => c.id === "linear")?.elements ?? 0),
    0,
  );
  const density = empty();
  for (const id of CONFIG_ORDER) {
    density[id] = elements[id] > 0 ? elementsTotal / elements[id] : 0;
  }

  const red = results.filter((r) => r.problems.length > 0).length;

  return {
    passed: red === 0,
    modelSlots: options.model.slots,
    defects: options.defects ?? {},
    cases: results,
    totals: { instructions: elementsTotal, elements, density, elementSteps, executedInstructions: instructions },
    green: results.length - red,
    red,
  };
}

/** Отчёт в виде текста. */
export function formatPackGateReport(report: PackGateReport): string {
  const lines: string[] = [];
  const defects = Object.entries(report.defects).filter(([, v]) => v === true);
  lines.push("gate конвейера VLIW: четыре конфигурации (плотность упаковки, не скорость)");
  lines.push(
    `модель: ${report.modelSlots} слотов` +
      (defects.length > 0 ? `; ВНЕСЁННЫЕ ДЕФЕКТЫ: ${defects.map(([k]) => k).join(", ")}` : ""),
  );
  lines.push(`программ: ${report.cases.length}, зелёных: ${report.green}, красных: ${report.red}`);
  lines.push("");
  lines.push(
    "программа | элементов л/п/у/о | плотность у → о | эквивалентность 4 конфигураций | верификатор | шагов VM л → о",
  );
  for (const c of report.cases) {
    const byId = (id: VliwConfigId) => c.configs.find((x) => x.id === id)!;
    const elements = CONFIG_ORDER.map((id) => byId(id).elements).join("/");
    const density = `${c.densityPackets.toFixed(2)} → ${c.densityCombined.toFixed(2)}`;
    const eq = CONFIG_ORDER.map((id) => (byId(id).equivalent ? "✓" : "✗")).join("");
    const verified = c.configs.filter((x) => x.id === "packets" || x.id === "reorder+packets");
    const verify = verified.every((x) => x.verify.ok) ? "ok" : "КРАСНЫЙ";
    const steps = `${byId("linear").elementSteps} → ${byId("reorder+packets").elementSteps}`;
    lines.push(`${c.name} | ${elements} | ${density} | ${eq} | ${verify} | ${steps}`);
    for (const p of c.problems) lines.push(`    ! ${p}`);
  }
  lines.push("");
  lines.push("конфигурации: л = линейно, п = перестановка, у = упаковка, о = перестановка+упаковка");
  lines.push(
    `итого по завершающимся: элементов ` +
      CONFIG_ORDER.map((id) => `${report.totals.elements[id]} (${id})`).join(", "),
  );
  lines.push(
    `плотность упаковки ${report.totals.density.packets.toFixed(2)} (упаковка) → ` +
      `${report.totals.density["reorder+packets"].toFixed(2)} (перестановка+упаковка)`,
  );
  lines.push(
    `шагов VM ${report.totals.elementSteps.linear} (линейно) → ` +
      `${report.totals.elementSteps["reorder+packets"]} (перестановка+упаковка); ` +
      `исполнено инструкций ${report.totals.executedInstructions} — одинаково во всех конфигурациях`,
  );
  lines.push(
    "**шаги VM — не метрика скорости и не ускорение**: VM считает шагом элемент кода, а не такт e2k; " +
      "замеров на железе нет",
  );
  lines.push(report.passed ? "gate зелёный" : `gate красный (${report.red} программ)`);
  return lines.join("\n");
}
