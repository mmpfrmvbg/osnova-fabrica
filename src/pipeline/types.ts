// ============================================================
// src/pipeline/types.ts — Контракты пайплайна osnova-fabrica
// Источник правды: spec.yaml, pipeline.yaml, gates.yaml
// ВСЕ артефакты пайплайна описаны здесь.
// ============================================================

import type { LLMProviderStatus } from '../llm/types';
import type { SemanticError } from '../compiler/semantic';
import { QUALITY_PASS, QUALITY_PARTIAL } from './thresholds';

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
  /** Фаза пайплайна, на которой зафиксирована диагностика (см. {@link PipelinePhase}). */
  readonly phase?: PipelinePhase;
  readonly atomId?: string;
  readonly retryCount?: number;
  readonly timestamp: string;
}

// ─── State v5: blockers (.osnova/state.yaml) — серии EPK-260328-015 / FBK016 ───

/** Номер GitHub issue в поле `issue` записи `blockers` state v5. */
export type ForgeStateBlockerIssueId = number;

/**
 * Поле `atm_id` записи `blockers`: обычно `{@link FORGE_STATE_BLOCKER_ATM_PREFIX}` +
 * {@link FORGE_STATE_BLOCKER_EPK_ATM_015} или {@link FORGE_STATE_BLOCKER_EPK_ATM_FBK016} + `-` + порядковый суффикс.
 */
export type ForgeStateBlockerAtmId = string;

/** Префикс идентификатора атома в `atm_id` state v5. */
export const FORGE_STATE_BLOCKER_ATM_PREFIX = 'ATM-' as const;

/** Базовый токен серии 015 в `atm_id` (атомы Forge); согласовано с {@link DiagnosticCode} `015-*`. */
export const FORGE_STATE_BLOCKER_EPK_ATM_015 = 'EPK-260328-015' as const;

/** Базовый токен серии FBK016 в `atm_id` (обратная связь); согласовано с {@link DiagnosticCode} `FBK016-*`. */
export const FORGE_STATE_BLOCKER_EPK_ATM_FBK016 = 'EPK-260328-FBK016' as const;

/** Запись в массиве `blockers` при `v: 5` в `.osnova/state.yaml`. */
export interface ForgeStateBlockerRecord {
  readonly issue: ForgeStateBlockerIssueId;
  readonly atm_id: ForgeStateBlockerAtmId;
  readonly open: boolean;
  readonly updated: string;
}

/** Префикс `atm_id` blockers v5 для серии 015 (до порядкового суффикса). */
export const FORGE_STATE_BLOCKER_ATM_015_PREFIX =
  `${FORGE_STATE_BLOCKER_ATM_PREFIX}${FORGE_STATE_BLOCKER_EPK_ATM_015}-` as const;

/** Префикс `atm_id` blockers v5 для серии FBK016 (до порядкового суффикса). */
export const FORGE_STATE_BLOCKER_ATM_FBK016_PREFIX =
  `${FORGE_STATE_BLOCKER_ATM_PREFIX}${FORGE_STATE_BLOCKER_EPK_ATM_FBK016}-` as const;

/** Проверка: `atm_id` относится к сценарию blockers серии 015. */
export function is015ForgeBlockerAtmId(atmId: string): boolean {
  return atmId.startsWith(FORGE_STATE_BLOCKER_ATM_015_PREFIX);
}

/** Проверка: `atm_id` относится к сценарию blockers серии FBK016. */
export function isFBK016ForgeBlockerAtmId(atmId: string): boolean {
  return atmId.startsWith(FORGE_STATE_BLOCKER_ATM_FBK016_PREFIX);
}

/**
 * Семья сценария Forge blockers по `atm_id` (`015` / `FBK016`), если строка совпадает с префиксами v5.
 */
export function forgeBlockerScenarioFromAtmId(atmId: string): '015' | 'FBK016' | null {
  if (is015ForgeBlockerAtmId(atmId)) return '015';
  if (isFBK016ForgeBlockerAtmId(atmId)) return 'FBK016';
  return null;
}

/** Собирает `atm_id` записи blockers v5 из EPK-базы и порядкового суффикса. */
export function composeForgeStateBlockerAtmId(
  epkBase: typeof FORGE_STATE_BLOCKER_EPK_ATM_015 | typeof FORGE_STATE_BLOCKER_EPK_ATM_FBK016,
  ordinalSuffix: string
): ForgeStateBlockerAtmId {
  return `${FORGE_STATE_BLOCKER_ATM_PREFIX}${epkBase}-${ordinalSuffix}` as ForgeStateBlockerAtmId;
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

// ─── Связка DiagnosticCode ↔ DiagnosticPipelineStatus (см. PIPELINE_STATUS_FOR_DIAGNOSTIC) ───

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

/** Подмножество {@link PipelineStatus}: только исходы 015 / FBK016 (1:1 с {@link DiagnosticCode}). */
export type DiagnosticPipelineStatus =
  | 'error_015_atom_not_found'
  | 'error_015_atom_corrupted'
  | 'error_015_dep_unresolved'
  | 'error_fbk016_rejected'
  | 'error_fbk016_timeout'
  | 'error_fbk016_limit_exceeded';

/** Итоговый статус пайплайна по коду диагностики (единый контракт 015/FBK016). */
export const PIPELINE_STATUS_FOR_DIAGNOSTIC: Readonly<Record<DiagnosticCode, DiagnosticPipelineStatus>> = {
  '015-001': 'error_015_atom_not_found',
  '015-002': 'error_015_atom_corrupted',
  '015-003': 'error_015_dep_unresolved',
  'FBK016-001': 'error_fbk016_rejected',
  'FBK016-002': 'error_fbk016_timeout',
  'FBK016-003': 'error_fbk016_limit_exceeded',
};

export function pipelineStatusFromDiagnosticCode(code: DiagnosticCode): DiagnosticPipelineStatus {
  return PIPELINE_STATUS_FOR_DIAGNOSTIC[code];
}

/** Все {@link DiagnosticCode} (6) — исчерпывающий перечень для Forge / оркестратора. */
export const ALL_DIAGNOSTIC_CODES = [
  DIAGNOSTIC_015_ATOM_NOT_FOUND,
  DIAGNOSTIC_015_ATOM_CORRUPTED,
  DIAGNOSTIC_015_DEP_UNRESOLVED,
  DIAGNOSTIC_FBK016_REJECTED,
  DIAGNOSTIC_FBK016_TIMEOUT,
  DIAGNOSTIC_FBK016_LIMIT_EXCEEDED,
] as const satisfies readonly DiagnosticCode[];

/** Все {@link DiagnosticPipelineStatus} (6), в том же порядке, что и {@link ALL_DIAGNOSTIC_CODES}. */
export const ALL_DIAGNOSTIC_PIPELINE_STATUSES = [
  'error_015_atom_not_found',
  'error_015_atom_corrupted',
  'error_015_dep_unresolved',
  'error_fbk016_rejected',
  'error_fbk016_timeout',
  'error_fbk016_limit_exceeded',
] as const satisfies readonly DiagnosticPipelineStatus[];

function buildDiagnosticCodeForPipelineStatus(): Readonly<Record<DiagnosticPipelineStatus, DiagnosticCode>> {
  const m = {} as Record<DiagnosticPipelineStatus, DiagnosticCode>;
  for (const code of ALL_DIAGNOSTIC_CODES) {
    m[PIPELINE_STATUS_FOR_DIAGNOSTIC[code]] = code;
  }
  return m;
}

/** Обратное к {@link PIPELINE_STATUS_FOR_DIAGNOSTIC}: исход пайплайна → код диагностики. */
export const DIAGNOSTIC_CODE_FOR_PIPELINE_STATUS: Readonly<Record<DiagnosticPipelineStatus, DiagnosticCode>> =
  buildDiagnosticCodeForPipelineStatus();

export function diagnosticCodeFromPipelineStatus(status: DiagnosticPipelineStatus): DiagnosticCode {
  return DIAGNOSTIC_CODE_FOR_PIPELINE_STATUS[status];
}

/**
 * Подмножество {@link PipelineErrorType} для серий 015 / FBK016 — 1:1 с {@link DiagnosticCode}
 * и {@link DiagnosticPipelineStatus}.
 */
export type DiagnosticPipelineErrorType =
  | 'atom_not_found'
  | 'atom_corrupted'
  | 'dependency_unresolved'
  | 'feedback_rejected'
  | 'feedback_timeout'
  | 'feedback_limit_exceeded';

/** Код диагностики → тип ошибки пайплайна (единый слой для 015/FBK016). */
export const PIPELINE_ERROR_TYPE_FOR_DIAGNOSTIC_CODE: Readonly<
  Record<DiagnosticCode, DiagnosticPipelineErrorType>
> = {
  '015-001': 'atom_not_found',
  '015-002': 'atom_corrupted',
  '015-003': 'dependency_unresolved',
  'FBK016-001': 'feedback_rejected',
  'FBK016-002': 'feedback_timeout',
  'FBK016-003': 'feedback_limit_exceeded',
};

export function pipelineErrorTypeFromDiagnosticCode(code: DiagnosticCode): DiagnosticPipelineErrorType {
  return PIPELINE_ERROR_TYPE_FOR_DIAGNOSTIC_CODE[code];
}

function buildDiagnosticCodeForPipelineErrorType(): Readonly<
  Record<DiagnosticPipelineErrorType, DiagnosticCode>
> {
  const m = {} as Record<DiagnosticPipelineErrorType, DiagnosticCode>;
  for (const code of ALL_DIAGNOSTIC_CODES) {
    m[PIPELINE_ERROR_TYPE_FOR_DIAGNOSTIC_CODE[code]] = code;
  }
  return m;
}

/** Обратное к {@link PIPELINE_ERROR_TYPE_FOR_DIAGNOSTIC_CODE}. */
export const DIAGNOSTIC_CODE_FOR_PIPELINE_ERROR_TYPE: Readonly<
  Record<DiagnosticPipelineErrorType, DiagnosticCode>
> = buildDiagnosticCodeForPipelineErrorType();

export function diagnosticCodeFromPipelineErrorType(t: DiagnosticPipelineErrorType): DiagnosticCode {
  return DIAGNOSTIC_CODE_FOR_PIPELINE_ERROR_TYPE[t];
}

export function pipelineStatusFromPipelineErrorType(t: DiagnosticPipelineErrorType): DiagnosticPipelineStatus {
  return pipelineStatusFromDiagnosticCode(diagnosticCodeFromPipelineErrorType(t));
}

export function pipelineErrorTypeFromPipelineStatus(status: DiagnosticPipelineStatus): DiagnosticPipelineErrorType {
  return pipelineErrorTypeFromDiagnosticCode(diagnosticCodeFromPipelineStatus(status));
}

/** Проверка: тип ошибки относится к исходам 015/FBK016. */
export function isDiagnosticPipelineErrorType(t: PipelineErrorType): t is DiagnosticPipelineErrorType {
  return Object.prototype.hasOwnProperty.call(DIAGNOSTIC_CODE_FOR_PIPELINE_ERROR_TYPE, t);
}

/** Семья сценария (`015` / `FBK016`) по коду диагностики. */
export function forgeBlockerScenarioFromDiagnosticCode(code: DiagnosticCode): '015' | 'FBK016' {
  return is015DiagnosticCode(code) ? '015' : 'FBK016';
}

/** EPK-база `atm_id` blockers v5 для данного {@link DiagnosticCode}. */
export function forgeBlockerEpkBaseForDiagnosticCode(
  code: DiagnosticCode
): typeof FORGE_STATE_BLOCKER_EPK_ATM_015 | typeof FORGE_STATE_BLOCKER_EPK_ATM_FBK016 {
  return forgeBlockerScenarioFromDiagnosticCode(code) === '015'
    ? FORGE_STATE_BLOCKER_EPK_ATM_015
    : FORGE_STATE_BLOCKER_EPK_ATM_FBK016;
}

/**
 * 14 токенов сценариев blockers диагностики Forge: 6 кодов, 6 исходов пайплайна 015/FBK016,
 * плюс два семейства (серия атомов / обратная связь).
 */
export const DIAGNOSTIC_FORGE_BLOCKER_SCENARIOS = [
  ...ALL_DIAGNOSTIC_CODES,
  ...ALL_DIAGNOSTIC_PIPELINE_STATUSES,
  '015',
  'FBK016',
] as const;

export type DiagnosticForgeBlockerScenarioToken = (typeof DIAGNOSTIC_FORGE_BLOCKER_SCENARIOS)[number];

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
  /**
   * Классификация приложения. Если нет — `checkG1` в `gateChecker.ts` подставляет `утилита`
   * и может добавить предупреждение `g1_app_type_classified` (не блокирующее).
   */
  readonly appType?: AppType;
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

/** Ошибка codegen; `kind` опционально — для маршрутизации A-2 (`extractLastErrorKind` в orchestrator). */
export interface CompilerError {
  readonly message: string;
  readonly node?: string;
  readonly kind?: string;
}

/**
 * Отчёт фазы build. `success` задаётся в `orchestrator.compileToBuildReport`:
 * `compilerSuccess`, пустые lexer/parser, нет blocking semantic errors.
 *
 * **G2 (`checkG2`)** смотрит на `lexerErrors`, `parserErrors`, `compilerSuccess`, `bytecode`,
 * `semanticErrors` (blocking по `kind`, см. `semanticKinds`), `durationMs` — не на поле `success` в изоляции.
 */
export interface BuildReport {
  readonly success: boolean;
  readonly lexerErrors: readonly LexerError[];
  readonly parserErrors: readonly ParserError[];
  readonly compilerErrors: readonly CompilerError[];
  /** Для G2: блокирующие виды — пересечение с `BLOCKING_SEMANTIC_KINDS` в gateChecker. */
  readonly semanticErrors?: readonly SemanticError[];
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

/**
 * Результат фазы golden. **G3 (`checkG3`)** использует `executed`, `vmErrors`, `qualityScore`, `outputDiff`;
 * при `executed` без ошибок VM и `qualityScore === 0` допускается ранний проход (см. `gateChecker`, режим без expectVM).
 * **Health:** `qualityScore` передаётся в `calcHealthScore` (`healthScore.ts`) как `goldenQualityScore` при наличии прогона.
 */
export interface GoldenReport {
  readonly executed: boolean;
  readonly passed: boolean;
  readonly qualityScore: number;      // 0..1
  readonly vmErrors: readonly VMError[];
  readonly outputDiff: string | null;
  readonly durationMs: number;
}

// ─── Quality gates (gates.yaml) — исполнитель: gateChecker.ts ───

export type GateId = 'G1_spec_ready' | 'G2_build_pass' | 'G3_golden_pass';

export interface GateResult {
  readonly passed: boolean;
  readonly gateId: GateId;
  readonly failedChecks: readonly string[];
  readonly action?: string;
}

/** Снимок {@link LLMProvider.checkHealth} на границе пайплайна (без смены HTTP API). */
export type PipelineLLMHealth = LLMProviderStatus;

// ─── Spec / gate пороги (EPK-022 контракт; согласовано с thresholds.ts и gateChecker) ───

/** Минимум {@link OsnovaIntent.confidence} для G1, если {@link OsnovaIntent.appType} не `утилита`. */
export const SPEC_G1_CONFIDENCE_MIN = 0.7;

/** Подстановка confidence в intake, если в JSON нет валидного числа (IntakeAgent). */
export const SPEC_INTENT_CONFIDENCE_DEFAULT = 0.8;

/** Порог G3 «pass»: то же значение, что {@link QUALITY_PASS}. */
export const SPEC_QUALITY_PASS = QUALITY_PASS;

/** Порог G3 «partial / diff»: то же значение, что {@link QUALITY_PARTIAL}. */
export const SPEC_QUALITY_PARTIAL = QUALITY_PARTIAL;

/** Предупреждение G2 по длительности build (мс), см. checkG2. */
export const SPEC_BUILD_DURATION_WARN_MS = 30_000;

/** Префикс строки в {@link GateResult.failedChecks} для G1 (до `:`). */
export type SpecG1CheckPrefix =
  | 'g1_confidence'
  | 'g1_features_present'
  | 'g1_modules_defined'
  | 'g1_main_module_set'
  | 'g1_app_type_classified';

/** Префикс строки в {@link GateResult.failedChecks} для G2 (до `:`). */
export type SpecG2CheckPrefix =
  | 'g2_lexer_clean'
  | 'g2_parser_clean'
  | 'g2_compiler_success'
  | 'g2_semantic_clean'
  | 'g2_build_time';

/** Префикс строки в {@link GateResult.failedChecks} для G3 (до `:`). */
export type SpecG3CheckPrefix =
  | 'g3_vm_executed'
  | 'g3_no_vm_errors'
  | 'g3_golden_or_quality'
  | 'g3_output_diff_acceptable';

/** Объединение префиксов gate-проверок для spec-валидации и агентов. */
export type SpecGateCheckPrefix = SpecG1CheckPrefix | SpecG2CheckPrefix | SpecG3CheckPrefix;

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

// ─── Интерфейс шага пайплайна ───

/** Контекст выполнения шага пайплайна. */
export interface PipelineContext {
  readonly intent?: OsnovaIntent;
  readonly spec?: OsnovaSpec;
  readonly source?: OsnovaSource;
  readonly buildReport?: BuildReport;
  readonly goldenReport?: GoldenReport;
  readonly repairAttempts: number;
  readonly diagnostics?: DiagnosticReport[];
}

/** Результат выполнения шага пайплайна. */
export interface StepResult {
  readonly success: boolean;
  readonly context: PipelineContext;
  readonly error?: PipelineError;
  readonly nextPhase?: PipelinePhase;
  readonly repairAttempts?: number;
}

/** Типы ошибок пайплайна. */
export type PipelineErrorType =
  | 'atom_not_found'
  | 'atom_corrupted'
  | 'dependency_unresolved'
  | 'feedback_rejected'
  | 'feedback_timeout'
  | 'feedback_limit_exceeded'
  | 'compilation_failed'
  | 'validation_failed'
  | 'execution_failed'
  | 'timeout'
  | 'unknown';

/** Ошибка выполнения пайплайна. */
export interface PipelineError {
  readonly type: PipelineErrorType;
  readonly message: string;
  readonly phase?: PipelinePhase;
  readonly code?: DiagnosticCode;
  readonly retryable?: boolean;
}

/**
 * Конвертирует CompileError из компилятора в PipelineError.
 * Используется для связки ошибок компиляции с pipeline ошибками.
 */
export function pipelineErrorFromCompileError(
  error: { message: string; line?: number; column?: number; kind?: string; node?: string },
  phase?: PipelinePhase
): PipelineError {
  return {
    type: 'compilation_failed',
    message: error.message,
    phase: phase ?? 'build',
    retryable: false,
  };
}

/** Интерфейс шага обработки пайплайна. */
export interface IPipelineStep {
  /** Идентификатор шага. */
  readonly id: string;
  /** Фаза пайплайна, которую обрабатывает шаг. */
  readonly phase: PipelinePhase;
  /** Порядок выполнения. */
  readonly order: number;
  /** Выполняет шаг пайплайна. */
  execute(context: PipelineContext): Promise<StepResult>;
  /** Проверяет готовность шага к выполнению. */
  canExecute?(context: PipelineContext): boolean;
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
  | DiagnosticPipelineStatus;

/** Проверка: исход пайплайна — одна из ошибок серии 015 (атомы Forge). */
export function is015DiagnosticPipelineStatus(
  status: PipelineStatus
): status is Extract<
  DiagnosticPipelineStatus,
  'error_015_atom_not_found' | 'error_015_atom_corrupted' | 'error_015_dep_unresolved'
> {
  return (
    status === 'error_015_atom_not_found' ||
    status === 'error_015_atom_corrupted' ||
    status === 'error_015_dep_unresolved'
  );
}

/** Проверка: исход пайплайна — одна из ошибок серии FBK016 (обратная связь). */
export function isFBK016DiagnosticPipelineStatus(
  status: PipelineStatus
): status is Extract<
  DiagnosticPipelineStatus,
  | 'error_fbk016_rejected'
  | 'error_fbk016_timeout'
  | 'error_fbk016_limit_exceeded'
> {
  return (
    status === 'error_fbk016_rejected' ||
    status === 'error_fbk016_timeout' ||
    status === 'error_fbk016_limit_exceeded'
  );
}

/** Семья сценария blockers по исходу пайплайна 015/FBK016. */
export function forgeBlockerScenarioFromPipelineStatus(status: DiagnosticPipelineStatus): '015' | 'FBK016' {
  return is015DiagnosticPipelineStatus(status) ? '015' : 'FBK016';
}

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
  /** Kind последней ошибки при repair_exhausted (A-2) */
  readonly lastErrorKind?: string;
  /** Собранные диагностики 015 / FBK016 (Forge / обратная связь); оркестратор может не заполнять. */
  readonly diagnostics?: readonly DiagnosticReport[];
}

/**
 * Статус, сохраняемый в `runs/traces.jsonl` (схема в `traceStore.ts`).
 * Подмножество {@link PipelineStatus}; коды 015/FBK016 в трейс не пишутся.
 */
export type PipelineTracePersistedStatus =
  | 'success'
  | 'partial'
  | 'repair_exhausted'
  | 'error';

/** Нормализует статус для записи трейса: прочие {@link PipelineStatus} → `error`. */
export function toPipelineTracePersistedStatus(status: PipelineStatus): PipelineTracePersistedStatus {
  if (
    status === 'success' ||
    status === 'partial' ||
    status === 'repair_exhausted' ||
    status === 'error'
  ) {
    return status;
  }
  return 'error';
}
