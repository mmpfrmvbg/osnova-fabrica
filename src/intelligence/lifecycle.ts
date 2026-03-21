// src/intelligence/lifecycle.ts
// updateLifecycle: new → watching, stale → archived.
// update_rfc_status: хук для будущего RFC-трекинга.

import { applyDecay } from './decay';
import {
  readSignals,
  writeSignals,
  upsertSignal,
  type IntelligenceSignal,
  type SignalStatus,
} from './store';

export interface LifecycleTransition {
  id: string;
  from: SignalStatus;
  to: SignalStatus;
}

/**
 * Применяет lifecycle-переходы к массиву сигналов:
 *   new     → watching  (сигнал обработан)
 *   stale   → archived  (устарел окончательно)
 */
export function updateLifecycle(
  signals: IntelligenceSignal[],
): { signals: IntelligenceSignal[]; transitions: LifecycleTransition[] } {
  const transitions: LifecycleTransition[] = [];

  const updated = signals.map((s) => {
    if (s.status === 'new') {
      transitions.push({ id: s.id, from: 'new', to: 'watching' });
      return { ...s, status: 'watching' as const };
    }
    if (s.status === 'stale') {
      transitions.push({ id: s.id, from: 'stale', to: 'archived' });
      return { ...s, status: 'archived' as const };
    }
    return s;
  });

  return { signals: updated, transitions };
}

/**
 * Запускает lifecycle + decay по store, сохраняет результат.
 */
export function runLifecycle(storePath?: string): {
  transitions: LifecycleTransition[];
  decayed: number;
} {
  const signals = readSignals(storePath);

  // Сначала decay (watching → stale)
  const { signals: afterDecay, result: decayResult } = applyDecay(signals);

  // Затем lifecycle (new → watching, stale → archived)
  const { signals: afterLifecycle, transitions } = updateLifecycle(afterDecay);

  writeSignals(afterLifecycle, storePath);

  return { transitions, decayed: decayResult.decayed };
}

/**
 * Заглушка для будущего RFC-трекинга.
 * update_rfc_status — обновляет статус RFC-сигнала по внешнему событию.
 */
export function update_rfc_status(
  signalId: string,
  newStatus: SignalStatus,
  storePath?: string,
): void {
  const signals = readSignals(storePath);
  const signal = signals.find((s) => s.id === signalId);
  if (!signal) {
    console.warn(`[lifecycle] signal not found: ${signalId}`);
    return;
  }
  upsertSignal({ ...signal, status: newStatus }, storePath);
}
