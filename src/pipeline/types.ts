// ============================================================
// src/pipeline/types.ts — Контракты пайплайна osnova-fabrica
// Источник правды: spec.yaml, pipeline.yaml, gates.yaml
// ВСЕ артефакты пайплайна описаны здесь.
// ============================================================

// ─── Диагностика ошибок ───

/** Код ошибки пайплайна: серия 015 (атомы) и FBK016 (обратная связь). */
export type DiagnosticCode =
  | '015-001'  // атом не найден
  | '015-002'  // атом повреждён
  | '015-003'  // зависимость атома не разрешена
  | 'FBK016-001'  // обратная связь отклонена
  | 'FBK016-002'  // таймаут обратной связи
  | 'FBK016-003'; // лимит попыток обратной связи превышен

/** Статус ошибки диагностики. */
export type DiagnosticStatus = 'blocked' | 'resolved' | 'ignored';

/** Отчёт о диагностике ошибки для сбора статусов. */
export interface DiagnosticReport {
  readonly code: DiagnosticCode;
  readonly status: DiagnosticStatus;
  readonly message: string;
  readonly phase?: string;
  readonly atomId?: string;
  readonly retryCount?: number;
  readonly timestamp: string;
}

// ─── Type-guards для DiagnosticCode ───

/** Проверка: код ошибки серии 015 (атомы). */
export function is015DiagnosticCode(code: DiagnosticCode): code is `015-${'001' | '002' | '003'}` {
  return code.startsWith('015-');
}

/** Проверка: код ошибки серии FBK016 (обратная связь). */
export function isFBK016DiagnosticCode(code: DiagnosticCode): code is `FBK016-${'001' | '002' | '003'}` {
  return code.startsWith('FBK016-');
}

// ─── Type-guards для DiagnosticStatus ───

/** Проверка: статус blocked. */
export function isBlockedStatus(status: DiagnosticStatus): status is 'blocked' {
  return status === 'blocked';
}

/** Проверка: статус resolved. */
export function isResolvedStatus(status: DiagnosticStatus): status is 'resolved' {
  return status === 'resolved';
}

/** Проверка: статус ignored. */
export function isIgnoredStatus(status: DiagnosticStatus): status is 'ignored' {
  return status === 'ignored';
}

// ─── Алиасы PipelineStatus ↔ DiagnosticCode ───

/** Серия 015: атом не найден. */
export const DIAGNOSTIC_015_ATOM_NOT_FOUND: DiagnosticCode = '015-001';
/** Серия 015: атом повреждён. */
export const DIAGNOSTIC_015_ATOM_CORRUPTED: DiagnosticCode = '015-002';
/** Серия 015: зависимость атома не разрешена. */
export const DIAGNOSTIC_015_DEP_UNRESOLVED: DiagnosticCode = '015-003';
/** Серия FBK016: обратная связь отклонена. */
export const DIAGNOSTIC_FBK016_REJECTED: DiagnosticCode = 'FBK016-001';
/** Серия FBK016: таймаут обратной связи. */
export const DIAGNOSTIC_FBK016_TIMEOUT: DiagnosticCode = 'FBK016-002';
/** Серия FBK016: лимит попыток обратной связи превышен. */
export const DIAGNOSTIC_FBK016_LIMIT_EXCEEDED: DiagnosticCode = 'FBK016-003';

// ─── Входные данные ───

export interface RawText {
  readonly text: string;
}

// ─── Выход IntakeAgent (фаза intake) ───

export type AppType =
  | 'утилита'
  | 'хранилище'
  | 'ui_приложение'
  | 'актор'
  | 'смешанный'
  | 'алгоритм'
  | 'тест'
  | 'модуль'
  | 'библиотека'
  | 'модуль_типов';

export interface OsnovaIntent {
  readonly intentId: string;
  readonly description: string;
  readonly features: readonly string[];
  readonly appType: AppType;
  readonly constraints: Record<string, unknown>;
  readonly confidence: number; // 0..1
}

// ─── Выход IntakeAgent (фаза spec_generation) ───

export interface OsnovaModule {
  readonly name: string;        // имя файла без расширения
  readonly description: string;
  readonly isMain: boolean;
}

export interface OsnovaType {
  readonly name: string;
  readonly fields: Record<string, string>; // fieldName → OsnovaType
}

export interface ProcedureSignature {
  readonly name: string;
  readonly params: Record<string, string>;
  readonly returnType: string;
}

export interface OsnovaSpec {
  readonly specId: string;
  readonly modules: readonly OsnovaModule[];
  readonly mainModule: string;
  readonly types: readonly OsnovaType[];
  readonly procedures: readonly ProcedureSignature[];
  readonly syscalls: readonly string[]; // 'система.хранилище', 'система.окно', etc
  readonly expectedReturnValue?: unknown;
  readonly expectVM?: {
    readonly returnValue?: unknown;
  };
  readonly conventions: Record<string, unknown>;
}

// ─── Выход OsnovaCodegen / RepairEngineer ───

export interface OsnovaSource {
  readonly filename: string;   // 'main.osnova'
  readonly source: string;     // полный исходный текст на языке Основа
  readonly tokensUsed?: number;
}

// ─── Выход фазы build (тулчейн компилятора) ───

export interface LexerError {
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

export interface ParserError {
  readonly line: number;
  readonly column: number;
  readonly message: string;
  readonly node?: string;
}

export interface CompilerError {
  readonly message: string;
  readonly node?: string;
}

export interface BuildReport {
  readonly success: boolean;
  readonly lexerErrors: readonly LexerError[];
  readonly parserErrors: readonly ParserError[];
  readonly compilerErrors: readonly CompilerError[];
  readonly semanticErrors?: readonly import('../compiler/semantic').SemanticError[];
  /** Всего семантических ошибок (blocking + non-blocking), для трейсов и аналитики */
  readonly semanticErrorCount?: number;
  readonly bytecode: unknown | null;  // OsvbcModule JSON
  readonly compilerSuccess: boolean;
  readonly durationMs: number;
}

// ─── Выход фазы golden_check ───

export interface VMError {
  readonly message: string;
  readonly opcode?: string;
  readonly stack?: unknown[];
}

export interface GoldenReport {
  readonly executed: boolean;
  readonly passed: boolean;
  readonly qualityScore: number;      // 0..1
  readonly vmErrors: readonly VMError[];
  readonly outputDiff: string | null;
  readonly durationMs: number;
}

// ─── План выполнения (PlanAgent / ExecAgent; фазы см. orchestrator.ts) ───

/** Фаза линейного пайплайна. */
export type PipelinePhase =
  | 'intake'
  | 'spec_generation'
  /** Между spec и codegen: quality gate G1 (gates.yaml), до роли OsnovaCodegen. */
  | 'g1_spec_ready'
  | 'codegen'
  | 'build'
  | 'golden_check'
  | 'repair';

export interface PlanStep {
  readonly phase: PipelinePhase;
  /** Порядок выполнения, с 1. */
  readonly order: number;
  readonly description?: string;
}

export interface ExecutionPlan {
  readonly planId: string;
  readonly intentId: string;
  readonly specId: string;
  /** true — план с нуля (intake → …); false — только после готовой spec. */
  readonly fromScratch: boolean;
  readonly steps: readonly PlanStep[];
}

/** Опции построения плана (PlanAgent.buildPlan). */
export interface PlanAgentBuildOptions {
  readonly fromScratch?: boolean;
  readonly includeRepair?: boolean;
}

// ─── Результат всего прогона ───

/** Статус пайплайна с учётом ошибок серий 015 и FBK016. */
export type PipelineStatus =
  | 'success'
  | 'partial'
  | 'repair_exhausted'
  | 'error'
  | 'error_015_atom_not_found'
  | 'error_015_atom_corrupted'
  | 'error_015_dep_unresolved'
  | 'error_fbk016_rejected'
  | 'error_fbk016_timeout'
  | 'error_fbk016_limit_exceeded';

export interface PipelineResult {
  readonly status: PipelineStatus;
  readonly intent?: OsnovaIntent;
  readonly spec?: OsnovaSpec;
  readonly source?: OsnovaSource;
  readonly buildReport?: BuildReport;
  readonly goldenReport?: GoldenReport;
  readonly repairAttempts: number;
  readonly totalDurationMs: number;
  /** Shadow Mode: hits по RFC-002 / RFC-003 (не влияет на логику) */
  readonly shadow_hits?: import('./shadowMode').ShadowHit[];
  readonly error?: string;
  /** Диагностика ошибок серий 015 и FBK016 */
  readonly diagnostics?: readonly DiagnosticReport[];
}
