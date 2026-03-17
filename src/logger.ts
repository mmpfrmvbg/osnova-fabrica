/**
 * src/logger.ts — общий логгер проекта.
 *
 * Уровни (LOG_LEVEL): debug < info < warn < error
 * По умолчанию: info.
 *
 * Использование:
 *   import { logger } from '../logger';
 *   const log = logger('osnova-pipeline');
 *   log.info('запуск фазы', { phase });
 *   log.debug('деталь', data);
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function resolveLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  return (raw in LEVELS ? raw : 'info') as LogLevel;
}

let _activeLevel: LogLevel = resolveLevel();

/** Для тестов: установить уровень программно. */
export function setLogLevel(level: LogLevel): void {
  _activeLevel = level;
}

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

/** Создаёт логгер с префиксом для раздела кода. */
export function logger(prefix: string): Logger {
  function emit(level: LogLevel, msg: string, data?: unknown): void {
    if (LEVELS[level] < LEVELS[_activeLevel]) return;
    const line = `[${prefix}] ${msg}`;
    if (level === 'error') {
      data !== undefined ? console.error(line, data) : console.error(line);
    } else if (level === 'warn') {
      data !== undefined ? console.warn(line, data) : console.warn(line);
    } else {
      data !== undefined ? console.log(line, data) : console.log(line);
    }
  }
  return {
    debug: (msg, data) => emit('debug', msg, data),
    info:  (msg, data) => emit('info',  msg, data),
    warn:  (msg, data) => emit('warn',  msg, data),
    error: (msg, data) => emit('error', msg, data),
  };
}
