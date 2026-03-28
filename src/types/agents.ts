// ============================================================
// src/types/agents.ts — общий контракт пайплайн-агентов
// ============================================================

/** Краткий отчёт для логов и трейсов (все агенты). */
export interface AgentReport {
  readonly ok: boolean;
  readonly summaryText: string;
}

/**
 * Базовый контракт: validate → run → report.
 * validate: доменная проверка входа (у ReviewAgent также возвращает отчёт для совместимости API).
 */
export interface BaseAgent {
  validate(input: unknown, ctx?: unknown, plan?: unknown): void | AgentReport;
  run(input?: unknown, ...rest: unknown[]): unknown | Promise<unknown>;
  report(): AgentReport;
}
