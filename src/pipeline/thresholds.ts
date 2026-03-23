// ============================================================
// src/pipeline/thresholds.ts — Единый источник правды для порогов
// pipeline.yaml и gates.yaml ссылаются на эти значения в комментариях.
// ============================================================

/** Минимальный qualityScore для успешного прохода G3. */
export const QUALITY_PASS = 0.7;

/** Минимальный qualityScore для partial (без repair). */
export const QUALITY_PARTIAL = 0.5;
