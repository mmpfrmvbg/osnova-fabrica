// src/intelligence/decay.ts
// watching → stale после DECAY_DAYS дней без обновления.
// Запускается как часть lifecycle или отдельно.

import { readSignals, writeSignals, type IntelligenceSignal } from './store';

const DECAY_DAYS = 30;

export interface DecayResult {
  total: number;
  decayed: number; // watching → stale
  unchanged: number;
}

export function applyDecay(
  signals: IntelligenceSignal[],
  nowMs = Date.now(),
): { signals: IntelligenceSignal[]; result: DecayResult } {
  const cutoffMs = nowMs - DECAY_DAYS * 24 * 60 * 60 * 1000;
  let decayed = 0;

  const updated = signals.map((s) => {
    if (s.status !== 'watching') return s;
    const fetchedMs = new Date(s.fetched_at).getTime();
    if (fetchedMs < cutoffMs) {
      decayed++;
      return { ...s, status: 'stale' as const };
    }
    return s;
  });

  return {
    signals: updated,
    result: { total: signals.length, decayed, unchanged: signals.length - decayed },
  };
}

export function runDecay(storePath?: string): DecayResult {
  const signals = readSignals(storePath);
  const { signals: updated, result } = applyDecay(signals);
  if (result.decayed > 0) {
    writeSignals(updated, storePath);
  }
  return result;
}
