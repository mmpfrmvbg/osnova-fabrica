// ============================================================
// src/vliw/oracle.ts — VLIW-оракул
// Берёт линейный байткод, планирует его в пакеты (scheduleLinearBlock),
// исполняет ОБА (линейный и пакетный) на VM и сверяет результат.
// Если совпало — планировщик не изменил семантику. Плюс метрики ILP.
// ============================================================

import { VM } from '../runtime/vm/interpreter';
import type { OsVbcModule, RawInstruction, CodeElement } from '../runtime/vm/bytecode';
import { getInvokeArgCount } from '../runtime/vm/invokeRegistry';
import { buildDependencyGraph } from './dependencyGraph';
import { scheduleLinearBlock, packetsToCodeElements } from './scheduler';
import { unrollForEach } from './unroll';

/** Read-only системные вызовы: не имеют побочных эффектов → не сериализуются в графе. */
const PURE_INVOKES = new Set<string>([
  'система.массив.получить',
  'система.массив.длина',
  'система.итератор.из',
  'система.объект.получить',
  'система.объект.ключи',
]);

export interface OracleReport {
  /** Результат линейного исполнения. */
  linearResult: unknown;
  /** Результат пакетного (scheduled) исполнения. */
  scheduledResult: unknown;
  /** Совпали ли результаты (корректность планировщика). */
  equal: boolean;
  /** Число VLIW-пакетов. */
  packetCount: number;
  /** Средняя заполненность пакета (слотов на пакет) — метрика ILP. */
  avgSlots: number;
  /** Полная заполненность по всем пакетам (слотов / (пакетов × VLIW_SLOTS)). */
  utilization: number;
}

async function runModule(mod: OsVbcModule): Promise<unknown> {
  const vm = new VM(mod, { maxSteps: 1_000_000 });
  const entry = mod.procedures[0]?.name ?? 'main';
  const idx = vm.findProcedureIndex(entry);
  return vm.runProcedure(idx, []);
}

/**
 * Прогоняет оракул: линейный → планировщик → пакетный → сверка.
 * Принимает модуль с плоским (линейным) code.
 */
export async function runOracle(mod: OsVbcModule, vliwSlots = 4): Promise<OracleReport> {
  const linearResult = await runModule(mod);

  const flat = mod.code as RawInstruction[];
  const graph = buildDependencyGraph(flat, {
    callArgc: (fi) => mod.procedures[fi]?.argc ?? 0,
    invokeArgc: (name) => getInvokeArgCount(name),
    callPure: (fi) => mod.procedures[fi]?.pure === true,
    invokePure: (name) => PURE_INVOKES.has(name),
  });
  const packets = scheduleLinearBlock(flat, graph);
  const elements: CodeElement[] = packetsToCodeElements(packets);
  const scheduledMod: OsVbcModule = { ...mod, version: 2, code: elements, vliwSlots };
  const scheduledResult = await runModule(scheduledMod);

  const packetCount = packets.length;
  const totalSlots = packets.reduce((s, p) => s + p.length, 0);
  const avgSlots = packetCount > 0 ? totalSlots / packetCount : 0;

  return {
    linearResult,
    scheduledResult,
    equal: JSON.stringify(linearResult) === JSON.stringify(scheduledResult),
    packetCount,
    avgSlots,
    utilization: packetCount > 0 ? totalSlots / (packetCount * vliwSlots) : 0,
  };
}

export interface UnrollOracleReport extends OracleReport {
  /** Фактическое число развёрнутых итераций. */
  tripCount: number;
  /** Остался ли управляющий поток (jmp/jmp_if*) после unroll. */
  hasControlFlow: boolean;
}

/**
 * Оракул loop unrolling: `для_каждого` → линейный код (unroll) → пакеты → сверка.
 * `linearResult` — результат развёрнутого линейного кода, `scheduledResult` — пакетного.
 */
export async function runUnrollOracle(
  mod: OsVbcModule,
  options: { tripCount?: number; vliwSlots?: number; rename?: boolean } = {},
): Promise<UnrollOracleReport> {
  const { module: unrolled, tripCount, hasControlFlow } = unrollForEach(mod, {
    tripCount: options.tripCount,
    rename: options.rename,
  });
  const report = await runOracle(unrolled, options.vliwSlots);
  return { ...report, tripCount, hasControlFlow };
}
