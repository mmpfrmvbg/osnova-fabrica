// ============================================================
// src/tools/blocker-resolver.ts — Чтение state и извлечение blockers
// Только чистые функции + безопасные ошибки, без IO и записи
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';
import type { ForgeStateBlockerRecord } from './blocker-types';
import {
  parseForgeBlockerAtmId,
  type ParseForgeBlockerAtmIdResult,
} from '../pipeline/blocker-resolver';

/** Путь к файлу состояния по умолчанию относительно корня репозитория. */
export const DEFAULT_STATE_PATH = '.osnova/state.yaml';

/** Результат загрузки YAML state. */
export type LoadStateResult =
  | { ok: true; state: ForgeStateV5 }
  | { ok: false; reason: 'file_not_found' | 'parse_error'; error?: unknown };

/** Структура state v5 (подмножество полей для работы с blockers). */
export interface ForgeStateV5 {
  readonly v: 5;
  readonly blockers?: readonly ForgeStateBlockerRecord[];
}

/**
 * Загружает и парсит YAML state по указанному пути.
 * @param repoPath абсолютный путь к корню репозитория
 * @param statePath относительный путь к state.yaml (по умолчанию .osnova/state.yaml)
 * @returns результат загрузки
 */
export function loadForgeState(
  repoPath: string,
  statePath: string = DEFAULT_STATE_PATH
): LoadStateResult {
  const fullPath = path.isAbsolute(statePath)
    ? statePath
    : path.join(repoPath, statePath);

  if (!fs.existsSync(fullPath)) {
    return { ok: false, reason: 'file_not_found' };
  }

  try {
    const content = fs.readFileSync(fullPath, 'utf-8');
    const parsed = yaml.load(content) as unknown;

    if (!isForgeStateV5(parsed)) {
      return { ok: false, reason: 'parse_error', error: new Error('Invalid state version') };
    }

    return { ok: true, state: parsed };
  } catch (error) {
    return { ok: false, reason: 'parse_error', error };
  }
}

/**
 * Извлекает и нормализует список blockers из state.
 * Возвращает только валидные записи (с корректным atm_id форматом).
 * @param state загруженный state v5
 * @returns нормализованный список blockers с диагностикой
 */
export function extractBlockersFromState(
  state: ForgeStateV5
): {
  blockers: ForgeStateBlockerRecord[];
  diagnostics: {
    total: number;
    valid: number;
    invalid: number;
    invalidReasons: Array<{ atm_id: string; reason: ParseForgeBlockerAtmIdResult }>;
  };
} {
  const rawBlockers = state.blockers ?? [];
  const validBlockers: ForgeStateBlockerRecord[] = [];
  const invalidReasons: Array<{ atm_id: string; reason: ParseForgeBlockerAtmIdResult }> = [];

  for (const blocker of rawBlockers) {
    const parseResult = parseForgeBlockerAtmId(blocker.atm_id);
    if (parseResult.ok) {
      validBlockers.push(blocker);
    } else {
      invalidReasons.push({ atm_id: blocker.atm_id, reason: parseResult });
    }
  }

  return {
    blockers: validBlockers,
    diagnostics: {
      total: rawBlockers.length,
      valid: validBlockers.length,
      invalid: invalidReasons.length,
      invalidReasons,
    },
  };
}

/**
 * Загружает state и извлекает blockers одним вызовом.
 * @param repoPath абсолютный путь к корню репозитория
 * @param statePath относительный путь к state.yaml
 * @returns результат с blockers или ошибкой загрузки
 */
export function loadAndExtractBlockers(
  repoPath: string,
  statePath: string = DEFAULT_STATE_PATH
):
  | {
      ok: true;
      blockers: ForgeStateBlockerRecord[];
      diagnostics: {
        total: number;
        valid: number;
        invalid: number;
        invalidReasons: Array<{ atm_id: string; reason: ParseForgeBlockerAtmIdResult }>;
      };
    }
  | { ok: false; reason: 'file_not_found' | 'parse_error'; error?: unknown } {
  const loadResult = loadForgeState(repoPath, statePath);
  if (!loadResult.ok) {
    return loadResult;
  }

  const extractResult = extractBlockersFromState(loadResult.state);
  return {
    ok: true,
    blockers: extractResult.blockers,
    diagnostics: extractResult.diagnostics,
  };
}

/**
 * Проверка: объект является state v5.
 */
function isForgeStateV5(value: unknown): value is ForgeStateV5 {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return obj.v === 5;
}
