// src/env.ts — валидация переменных окружения перед запуском пайплайна
// Вызывается из src/cli.ts до runPipeline()

import { setLogLevel, type LogLevel } from './logger';
import {
  PROVIDER_DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  getDefaultModel,
} from './llm/defaults.js';

export function validateEnv(): void {
  const provider = process.env.OSNOVA_PROVIDER ?? DEFAULT_PROVIDER;
  const valid = Object.keys(PROVIDER_DEFAULT_MODEL);

  if (!valid.includes(provider)) {
    console.error(
      `[env] OSNOVA_PROVIDER="${provider}" неверный. Допустимые: ${valid.join(', ')}`,
    );
    process.exit(1);
  }

  if (provider === 'deepseek' && !process.env.DEEPSEEK_API_KEY) {
    console.error(
      '[env] DEEPSEEK_API_KEY не задан. Обязателен при OSNOVA_PROVIDER=deepseek',
    );
    process.exit(1);
  }

  if (provider === 'ollama' && !process.env.OLLAMA_URL) {
    console.warn(
      '[env] OLLAMA_URL не задан, будет использован http://localhost:11434',
    );
  }

  if (!process.env.OSNOVA_MODEL) {
    console.warn(
      `[env] OSNOVA_MODEL не задан, будет использован: ${getDefaultModel(
        provider,
      )}`,
    );
  }

  // Применяем LOG_LEVEL из окружения к логгеру
  const logLevel = process.env.LOG_LEVEL as LogLevel | undefined;
  const validLevels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
  if (logLevel && validLevels.includes(logLevel)) {
    setLogLevel(logLevel);
  } else if (logLevel) {
    console.warn(
      `[env] LOG_LEVEL="${logLevel}" неверный. Допустимые: ${validLevels.join(', ')}. Используется info.`,
    );
  }
}
