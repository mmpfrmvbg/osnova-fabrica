/**
 * Планировщик VLIW для байткода Основа (Этап 1).
 * Вход: линейный блок инструкций. Выход: пакеты для .osvbc v2.
 * Поверхность экспорта совпадает с публичными API `e2kModel`, `dependencyGraph`, `scheduler`.
 */

export { VLIW_SLOTS, classifyOpcode, type SlotType } from "./e2kModel";
export { buildDependencyGraph, type DependencyGraph, type DependencyGraphOptions } from "./dependencyGraph";
export { scheduleLinearBlock, packetsToCodeElements } from "./scheduler";
export { unrollForEach, type UnrollOptions, type UnrollResult } from "./unroll";
