// ============================================================
// src/pipeline/index.ts — публичный API barrel
// ============================================================

// Основной фасад пайплайна
export { Pipeline, runPipelineWithExecAgent } from './pipeline';

// Оркестратор (линейный пайплайн)
export { runPipeline as runPipelineOrchestrator, compileToBuildReport, hasBlockingSemanticErrors } from './orchestrator';

// Типы
export type {
  RawText,
  OsnovaIntent,
  OsnovaSpec,
  OsnovaSource,
  BuildReport,
  GoldenReport,
  PipelineResult,
  ExecutionPlan,
  PipelinePhase,
  PlanStep,
  PlanAgentBuildOptions,
} from './types';

// Вспомогательные модули
export { analyzeShadow, aggregateShadow } from './shadowMode';
export type { ShadowHit, ShadowRfc } from './shadowMode';

// Gate checkers
export { checkG1, checkG2, checkG3 } from './gateChecker';

// Thresholds
export { QUALITY_PARTIAL, QUALITY_PASS } from './thresholds';

// Semantic kinds
export { BLOCKING_SEMANTIC_KINDS, NON_BLOCKING_SEMANTIC_KINDS } from './semanticKinds';
