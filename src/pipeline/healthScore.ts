// ============================================================
// src/pipeline/healthScore.ts
// Нормализованный health score прогона пайплайна: [0.0, 1.0]
// Формула: base (from status) → qualityBonus → repairPenalty → clamp
// ============================================================

import type { PipelineStatus } from './types';

export interface HealthScoreInput {
  status: PipelineStatus;
  repairAttempts: number;
  goldenQualityScore?: number; // goldenReport?.qualityScore
}

/** Фиксирует значение в диапазоне [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Штраф за repair-попытки: чем больше попыток, тем ниже score. */
export function repairPenalty(attempts: number): number {
  if (attempts === 0) return 1.0;
  if (attempts === 1) return 0.9;
  if (attempts === 2) return 0.75;
  return 0.6; // >= 3
}

/**
 * Вычисляет health score прогона пайплайна.
 * Всегда возвращает число в [0.0, 1.0].
 */
export function calcHealthScore(input: HealthScoreInput): number {
  const BASE: Record<PipelineStatus, number> = {
    success: 1.0,
    partial: 0.6,
    repair_exhausted: 0.2,
    error: 0.0,
    error_015_atom_not_found: 0.0,
    error_015_atom_corrupted: 0.0,
    error_015_dep_unresolved: 0.0,
    error_fbk016_rejected: 0.0,
    error_fbk016_timeout: 0.0,
    error_fbk016_limit_exceeded: 0.0,
  };

  let base = BASE[input.status];

  // qualityBonus: смешиваем base и golden quality поровну
  if (input.goldenQualityScore !== undefined && input.goldenQualityScore > 0) {
    base = base * 0.5 + input.goldenQualityScore * 0.5;
  }

  const penalty = repairPenalty(input.repairAttempts);

  return clamp(base * penalty, 0, 1);
}
