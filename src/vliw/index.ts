/**
 * Планировщик VLIW для байткода Основа.
 *
 * Вход: линейный код. Выход: пакеты для `.osvbc` v2.
 *
 * ## Два уровня
 *
 * 1. **Модель железа** — {@link ./e2kDevices}: 24 канала выдачи e2k, возможности
 *    устройств и таблица длительностей операций из руководства МЦСТ.
 *    {@link ./e2kModel} — фасад для формата Основа (ширина пакета 4).
 * 2. **Планировщики**:
 *    - {@link ./scheduler} и {@link ./regScheduler} — in-order упаковка без
 *      учёта длительностей (исторический слой, совместим с форматом);
 *    - {@link ./latencyScheduler} — стековый код, учитывает длительности,
 *      вставляет `nop`;
 *    - {@link ./reorderScheduler} — **регистровый** код, снимает in-order:
 *      переставляет независимые инструкции по готовности операндов.
 *
 * Почему перестановка возможна только на регистровом коде — см. заголовок
 * `reorderScheduler.ts`: в стековом байткоде порядок `push`/`pop` — часть
 * семантики, а в регистровом операнды указаны явно.
 */

export {
  VLIW_SLOTS,
  E2K_ISSUE_WIDTH,
  classifyOpcode,
  possibleSlots,
  primaryChannel,
  channelsFor,
  channelToSlot,
  issueWidth,
  opClassOf,
  type SlotType,
  type ChannelId,
} from "./e2kModel";

export {
  ALL_CHANNELS,
  CHANNELS,
  UNITS,
  LATENCY,
  DOMAIN_PENALTY,
  PREDICATE_FILE,
  REGISTER_FILE,
  channelCanRun,
  latencyFor,
  type AluId,
  type ConsumerKind,
  type OpClass,
  type UnitCapability,
} from "./e2kDevices";

export { buildDependencyGraph, type DependencyGraph, type DependencyGraphOptions } from "./dependencyGraph";
export { scheduleLinearBlock, packetsToCodeElements } from "./scheduler";
export { unrollForEach, type UnrollOptions, type UnrollResult } from "./unroll";

export {
  scheduleWithLatency,
  formatSchedule,
  LATENCY_CORPUS,
  LatencyScheduleError,
  type LatencyScheduleResult,
  type ScheduledPacket,
  type ScheduledSlot,
} from "./latencyScheduler";

export {
  scheduleRegWithReorder,
  scheduleRegInOrder,
  scheduleGraphWithReorder,
  scheduleGraphInOrder,
  validateRegSchedule,
  splitLinearRegions,
  linearRegionStarts,
  inOrderBaselineCycles,
  regOpClass,
  ReorderError,
  type ReorderResult,
  type ReorderedPacket,
  type ReorderedSlot,
  type ReorderMetrics,
} from "./reorderScheduler";

export {
  countPipeline,
  formatCounters,
  adjustedLatency,
  packetsFill,
  MEMORY_LATENCY,
  ISSUE_WIDTH,
  type MemoryLevel,
  type PipelineCounters,
} from "./pipelineCounters";

export {
  runReorderEquivalence,
  applyReorderToModule,
  type ReorderEquivalenceReport,
  type ReorderEquivalenceOptions,
  type EquivalenceStep,
} from "./reorderEquivalence";
