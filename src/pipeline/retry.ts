// ============================================================
// src/pipeline/retry.ts — Retry механизм для pipeline этапов
// ============================================================

import { logger } from '../logger';

const log = logger('retry');

/** Конфигурация retry политики. */
export interface RetryConfig {
  /** Максимальное количество попыток. */
  maxAttempts: number;
  /** Базовая задержка между попытками (мс). */
  baseDelayMs?: number;
  /** Экспоненциальный множитель задержки (default: 2 — exponential backoff). */
  backoffMultiplier?: number;
  /** Максимальная задержка между попытками (мс). */
  maxDelayMs?: number;
  /** Предикат: определять, является ли ошибка retryable. */
  isRetryable?: (error: Error) => boolean;
  /** Колбэк: логирование каждой retry попытки. */
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
}

/** Результат выполнения с retry. */
export interface RetryResult<T> {
  /** Успешный результат. */
  value?: T;
  /** Ошибка, если все попытки исчерпаны. */
  error?: Error;
  /** Количество выполненных попыток. */
  attempts: number;
  /** Общая длительность всех попыток (мс). */
  totalDurationMs: number;
}

/**
 * Выполняет функцию с retry логикой.
 * @param fn — асинхронная функция для выполнения
 * @param config — конфигурация retry
 * @returns результат выполнения
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig,
): Promise<RetryResult<T>> {
  const {
    maxAttempts,
    baseDelayMs = 1000,
    backoffMultiplier = 2,
    maxDelayMs = 30000,
    isRetryable = () => true,
    onRetry,
  } = config;

  const startTime = Date.now();
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const value = await fn();
      return {
        value,
        attempts: attempt,
        totalDurationMs: Date.now() - startTime,
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt >= maxAttempts) {
        break;
      }

      if (!isRetryable(lastError)) {
        log.warn('non-retryable error', { attempt, error: lastError.message });
        break;
      }

      const delayMs = Math.min(
        baseDelayMs * Math.pow(backoffMultiplier, attempt - 1),
        maxDelayMs,
      );

      log.warn('retry attempt', { attempt, maxAttempts, delayMs, error: lastError.message });
      onRetry?.(attempt, lastError, delayMs);

      await sleep(delayMs);
    }
  }

  return {
    error: lastError,
    attempts: maxAttempts,
    totalDurationMs: Date.now() - startTime,
  };
}

/**
 * Выполняет функцию с retry логикой, выбрасывая ошибку при неудаче.
 * @param fn — асинхронная функция для выполнения
 * @param config — конфигурация retry
 * @returns успешный результат
 * @throws ошибка, если все попытки исчерпаны
 */
export async function withRetryOrThrow<T>(
  fn: () => Promise<T>,
  config: RetryConfig,
): Promise<T> {
  const result = await withRetry(fn, config);
  if (result.error) {
    throw result.error;
  }
  return result.value!;
}

/**
 * Стандартная конфигурация для pipeline этапов.
 * Максимум 3 попытки, exponential backoff от 1с до 30с.
 */
export const DEFAULT_PIPELINE_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  backoffMultiplier: 2,
  maxDelayMs: 30000,
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
