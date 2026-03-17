/**
 * src/llm/errors.ts — стандартизированные ошибки LLM-агентов.
 *
 * Использование:
 *   throw new LlmError('parse', 'IntakeAgent', { cause: err, model, attempt })
 *   catch (e) { if (e instanceof LlmError) { log.error(e.message, e.context); } }
 */

export type LlmErrorKind =
  | 'call'       // ошибка сети/запуска провайдера
  | 'parse'      // не удалось разобрать JSON из ответа
  | 'timeout'    // превышен таймаут
  | 'truncated'  // ответ обрезан (нет завершающего токена)
  | 'unknown';   // неопознанная ошибка

export interface LlmErrorContext {
  /** Название агента или метода, где произошла ошибка. */
  agent: string;
  /** Название провайдера (qwen-cli, deepseek, ollama). */
  provider?: string;
  /** Модель LLM. */
  model?: string;
  /** Номер попытки (repair-loop). */
  attempt?: number;
  /** Исходная ошибка. */
  cause?: unknown;
}

export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly context: LlmErrorContext;

  constructor(kind: LlmErrorKind, agent: string, ctx: Omit<LlmErrorContext, 'agent'> = {}) {
    const cause = ctx.cause instanceof Error ? ctx.cause.message : String(ctx.cause ?? '');
    const where = ctx.model ? `${agent}/${ctx.model}` : agent;
    const attempt = ctx.attempt !== undefined ? ` (attempt ${ctx.attempt})` : '';
    super(`[LlmError:${kind}] ${where}${attempt}${cause ? ': ' + cause : ''}`);
    this.name = 'LlmError';
    this.kind = kind;
    this.context = { ...ctx, agent };
  }
}

/**
 * Обёртывает произвольный Error в LlmError с kind='call'.
 * Если уже LlmError — пробрасывает как есть.
 */
export function wrapLlmError(err: unknown, agent: string, ctx: Omit<LlmErrorContext, 'agent' | 'cause'> = {}): LlmError {
  if (err instanceof LlmError) return err;
  return new LlmError('call', agent, { ...ctx, cause: err });
}
