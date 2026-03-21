// ============================================================
// src/pipeline/shadowMode.ts — Shadow Mode tracker (RFC-002, RFC-003)
// Логирует попытки LLM использовать новые/запрещённые паттерны
// НЕ меняет семантику компилятора / оркестратора.
// Критерий перехода к Phase B: correctRate >= 0.80 за 50+ трейсов.
// ============================================================

export type ShadowRfc = 'RFC-002' | 'RFC-003';

export interface ShadowHit {
  rfc: ShadowRfc;
  /** Число обнаруженных целевых паттернов в source */
  count: number;
  /** true если паттерн использован корректно */
  correct: boolean;
}

export interface ShadowReport {
  hits: ShadowHit[];
  /** Итоговое число hits по RFC (сумма count) */
  totalByRfc: Record<ShadowRfc, number>;
  /** Число корректных hits */
  correctByRfc: Record<ShadowRfc, number>;
}

// ─── Детекторы RFC-002 (sentinel pattern) ───

/**
 * Считает сравнения с пусто/-1/"error" как sentinel (анти-паттерн).
 * Ищет: == пусто / != пусто / == -1 / == "error" / == ""
 */
export function detectSentinelAntiPattern(source: string): number {
  const patterns = [
    /[!=]=\s*пусто/g,
    /[!=]=\s*-1\b/g,
    /[!=]=\s*"error"/g,
    /[!=]=\s*""/g,
  ];
  return patterns.reduce((sum, re) => sum + (source.match(re) ?? []).length, 0);
}

/**
 * Считает корректные попробовать/иначе_попытка блоки.
 */
export function detectCorrectTryCatch(source: string): number {
  return (source.match(/попробовать[\s\S]*?иначе_попытка/g) ?? []).length;
}

/**
 * Анализирует source на RFC-002 (sentinel vs try-catch).
 * Корректно = есть попробовать и нет sentinel сравнений.
 */
export function analyzeRfc002(source: string): ShadowHit {
  const sentinelCount = detectSentinelAntiPattern(source);
  const tryCount = detectCorrectTryCatch(source);
  // Корректно если есть try и нет sentinel, или нет ни того ни другого (нейтральный код)
  const hasSentinel = sentinelCount > 0;
  const hasTry = tryCount > 0;
  const correct = (hasTry && !hasSentinel) || (!hasTry && !hasSentinel);
  return {
    rfc: 'RFC-002',
    count: sentinelCount + tryCount,
    correct,
  };
}

// ─── Детекторы RFC-003 (invented syntax) ───

/**
 * Считает invented syntax паттерны.
 * Ищет: структура( / данные <имя> = / система.типы. / система.хранилище.установить_поле
 */
export function detectInventedSyntax(source: string): number {
  const patterns = [
    // \b не работает для кириллицы — без границы слова
    /структура\s*\(/g,
    /^данные\s+\S+\s*=/gm,
    /система\.типы\./g,
    /система\.хранилище\.установить_поле/g,
    /система\.объект\.новый\s*\(/g,
  ];
  return patterns.reduce((sum, re) => sum + (source.match(re) ?? []).length, 0);
}

/**
 * Анализирует source на RFC-003 (invented syntax).
 * Корректно = invented syntax не обнаружен.
 */
export function analyzeRfc003(source: string): ShadowHit {
  const count = detectInventedSyntax(source);
  return {
    rfc: 'RFC-003',
    count,
    correct: count === 0,
  };
}

// ─── Главная функция ───

/**
 * Проанализировать source и вернуть ShadowReport.
 * Вызывать из orchestrator после codegen, не изменяя flow.
 */
export function analyzeShadow(source: string): ShadowReport {
  const hits: ShadowHit[] = [analyzeRfc002(source), analyzeRfc003(source)];
  const totalByRfc: Record<ShadowRfc, number> = { 'RFC-002': 0, 'RFC-003': 0 };
  const correctByRfc: Record<ShadowRfc, number> = { 'RFC-002': 0, 'RFC-003': 0 };
  for (const h of hits) {
    totalByRfc[h.rfc] = h.count;
    correctByRfc[h.rfc] = h.correct ? 1 : 0;
  }
  return { hits, totalByRfc, correctByRfc };
}

// ─── Агрегат по пачке трейсов ───

export interface ShadowAggregate {
  rfc: ShadowRfc;
  totalTraces: number;
  correctTraces: number;
  correctRate: number;
  /** true если готово к Phase B */
  readyForPhaseB: boolean;
}

const PHASE_B_MIN_TRACES = 50;
const PHASE_B_MIN_RATE = 0.8;

/**
 * Агрегировать ShadowHit[] по множеству трейсов.
 * hits — все ShadowHit для одного RFC из разных трейсов.
 */
export function aggregateShadow(rfc: ShadowRfc, hits: ShadowHit[]): ShadowAggregate {
  const total = hits.length;
  const correct = hits.filter(h => h.correct).length;
  const rate = total > 0 ? correct / total : 0;
  return {
    rfc,
    totalTraces: total,
    correctTraces: correct,
    correctRate: rate,
    readyForPhaseB: total >= PHASE_B_MIN_TRACES && rate >= PHASE_B_MIN_RATE,
  };
}
