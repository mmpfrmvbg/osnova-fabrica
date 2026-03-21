// ============================================================
// src/pipeline/types.ts — Контракты пайплайна osnova-fabrica
// Источник правды: spec.yaml, pipeline.yaml, gates.yaml
// ВСЕ артефакты пайплайна описаны здесь.
// ============================================================

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

// ─── Результат всего прогона ───

export type PipelineStatus = 'success' | 'partial' | 'failure' | 'repair_exhausted';

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
}
