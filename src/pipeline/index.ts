// ============================================================
// src/pipeline/index.ts — публичный API barrel
// ============================================================

// Основной фасад пайплайна
export { Pipeline, runPipelineWithExecAgent } from './pipeline';

// Оркестратор (линейный пайплайн)
export { runPipeline as runPipelineOrchestrator, compileToBuildReport, hasBlockingSemanticErrors, extractLastErrorKind, executePipeline } from './orchestrator';

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
  GateId,
  GateResult,
  PipelineLLMHealth,
  PipelineTracePersistedStatus,
  DiagnosticCode,
  DiagnosticStatus,
  DiagnosticReport,
  DiagnosticPipelineStatus,
  PipelineStatus,
} from './types';

export {
  toPipelineTracePersistedStatus,
  PIPELINE_STATUS_FOR_DIAGNOSTIC,
  pipelineStatusFromDiagnosticCode,
  diagnosticCodeFromPipelineStatus,
  is015DiagnosticCode,
  isFBK016DiagnosticCode,
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

// Retry
export { withRetry, withRetryOrThrow, DEFAULT_PIPELINE_RETRY_CONFIG } from './retry';
export type { RetryConfig, RetryResult } from './retry';
