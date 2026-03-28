// ============================================================
// src/agents/types.ts — контракты агентов пайплайна
// ============================================================

import type { RawText, OsnovaIntent, OsnovaSpec } from '../pipeline/types';

/** Ошибка валидации входа IntakeAgent (пустой текст задачи и т.п.). */
export class IntakeValidationError extends Error {
  constructor(
    message: string,
    public readonly field?: string,
  ) {
    super(message);
    this.name = 'IntakeValidationError';
  }
}

/**
 * Контракт агента первичной обработки: задача в сыром виде → intent → spec.
 */
export interface IAgent {
  validate(input: unknown, ctx?: unknown, plan?: unknown): void;
  parse(input: RawText): RawText;
  parseIntent(input: RawText): Promise<OsnovaIntent>;
  generateSpec(intent: OsnovaIntent): Promise<OsnovaSpec>;
  checkSpec(spec: OsnovaSpec): void;
}
