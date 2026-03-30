/**
 * Ошибки выполнения и recovery для VM — отдельный модуль без зависимости от `./vm`,
 * чтобы `vm.ts` мог импортировать отсюда и не замыкаться с `index.ts`.
 */

// ─── Обработка ошибок выполнения и recovery механизмы ───

/**
 * Базовый интерфейс ошибки выполнения рантайма.
 * Содержит информацию для диагностики и восстановления.
 */
export interface RuntimeError {
  /** Код ошибки для классификации. */
  readonly code: string;
  /** Сообщение об ошибке. */
  readonly message: string;
  /** Опциональная причина (исключение). */
  readonly cause?: unknown;
  /** Метаданные для восстановления (контекст, pc, op и т.д.). */
  readonly metadata?: Record<string, unknown>;
  /** Флаг возможности восстановления. */
  readonly recoverable: boolean;
}

/**
 * Базовый класс ошибки выполнения с поддержкой recovery.
 */
export class RuntimeErrorBase extends Error implements RuntimeError {
  readonly code: string;
  readonly recoverable: boolean;
  readonly metadata?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    options: { recoverable?: boolean; metadata?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "RuntimeError";
    this.code = code;
    this.recoverable = options.recoverable ?? false;
    this.metadata = options.metadata;
    this.cause = options.cause;
  }
}

/**
 * Ошибка выполнения инструкции VM.
 */
export class ExecutionError extends RuntimeErrorBase {
  constructor(
    message: string,
    options: {
      pc?: number;
      op?: string;
      recoverable?: boolean;
      metadata?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super("EXECUTION_ERROR", message, {
      recoverable: options.recoverable ?? false,
      metadata: { pc: options.pc, op: options.op, ...options.metadata },
      cause: options.cause,
    });
    this.name = "ExecutionError";
  }
}

/**
 * Ошибка таймаута выполнения.
 */
export class TimeoutError extends RuntimeErrorBase {
  constructor(
    message: string,
    options: {
      timeoutMs?: number;
      procedure?: string;
      recoverable?: boolean;
      metadata?: Record<string, unknown>;
    } = {},
  ) {
    super("TIMEOUT_ERROR", message, {
      recoverable: options.recoverable ?? true,
      metadata: { timeoutMs: options.timeoutMs, procedure: options.procedure, ...options.metadata },
    });
    this.name = "TimeoutError";
  }
}

/**
 * Ошибка invoke (системного вызова).
 */
export class InvokeError extends RuntimeErrorBase {
  constructor(
    message: string,
    options: {
      invokeName?: string;
      args?: unknown[];
      recoverable?: boolean;
      metadata?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super("INVOKE_ERROR", message, {
      recoverable: options.recoverable ?? false,
      metadata: { invokeName: options.invokeName, args: options.args, ...options.metadata },
      cause: options.cause,
    });
    this.name = "InvokeError";
  }
}

/**
 * Стратегия восстановления после ошибки.
 */
export interface RecoveryStrategy {
  /** Идентификатор стратегии. */
  readonly id: string;
  /** Может ли стратегия обработать данную ошибку. */
  canHandle(error: RuntimeError): boolean;
  /** Выполнить восстановление. Возвращает true при успехе. */
  recover(error: RuntimeError): Promise<boolean> | boolean;
}

/**
 * Менеджер восстановления — регистрирует стратегии и применяет их при ошибках.
 */
export class RecoveryManager {
  private strategies: RecoveryStrategy[] = [];

  /** Зарегистрировать стратегию восстановления. */
  register(strategy: RecoveryStrategy): void {
    this.strategies.push(strategy);
  }

  /**
   * Попытаться восстановить после ошибки.
   * @returns true если восстановление успешно.
   */
  async attemptRecovery(error: RuntimeError): Promise<boolean> {
    for (const strategy of this.strategies) {
      if (strategy.canHandle(error)) {
        try {
          return await Promise.resolve(strategy.recover(error));
        } catch {
          // Стратегия не справилась, пробуем следующую
        }
      }
    }
    return false;
  }

  /** Получить все зарегистрированные стратегии. */
  getStrategies(): readonly RecoveryStrategy[] {
    return this.strategies;
  }

  /** Очистить все стратегии. */
  clear(): void {
    this.strategies = [];
  }
}

/**
 * Встроенная стратегия для TimeoutError — повторная попытка с увеличенным лимитом.
 */
export class TimeoutRetryStrategy implements RecoveryStrategy {
  readonly id = "timeout-retry";
  private maxRetries: number;
  private backoffMs: number;

  constructor(options: { maxRetries?: number; backoffMs?: number } = {}) {
    this.maxRetries = options.maxRetries ?? 3;
    this.backoffMs = options.backoffMs ?? 100;
  }

  canHandle(error: RuntimeError): boolean {
    return error.code === "TIMEOUT_ERROR" && error.recoverable;
  }

  async recover(error: RuntimeError): Promise<boolean> {
    const retries = Number(error.metadata?.retries ?? 0);
    if (retries >= this.maxRetries) {
      return false;
    }
    // Экспоненциальная задержка
    const delay = this.backoffMs * Math.pow(2, retries);
    await new Promise((resolve) => setTimeout(resolve, delay));
    return true;
  }
}

/**
 * Встроенная стратегия для ExecutionError — логирование и продолжение.
 */
export class ExecutionLogStrategy implements RecoveryStrategy {
  readonly id = "execution-log";
  private logger: (error: RuntimeError) => void;

  constructor(logger: (error: RuntimeError) => void = console.error) {
    this.logger = logger;
  }

  canHandle(error: RuntimeError): boolean {
    return error.code === "EXECUTION_ERROR" && error.recoverable;
  }

  recover(error: RuntimeError): boolean {
    this.logger(error);
    return true;
  }
}

/**
 * Создаёт RuntimeError из неизвестного исключения.
 */
export function toRuntimeError(err: unknown): RuntimeError {
  if (err instanceof RuntimeErrorBase) {
    return err;
  }
  if (err instanceof Error) {
    return new RuntimeErrorBase("UNKNOWN_ERROR", err.message, { cause: err });
  }
  return new RuntimeErrorBase("UNKNOWN_ERROR", String(err));
}

/**
 * Проверяет, является ли ошибка recoverable.
 */
export function isRecoverableError(error: unknown): boolean {
  return error instanceof RuntimeErrorBase && error.recoverable;
}
