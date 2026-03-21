// ============================================================
// src/steward/auto-approve.ts — Авто-approve RFC
// RFC с risk=low и пустой phase_b одобряется без участия человека.
// Записывает решение в decision journal.
// ============================================================

import { isAutoApprovable } from './rfc';
import { appendDecision } from './decision-journal';
import type { RFC } from './rfc';
import type { DecisionEntry } from './decision-journal';

export interface AutoApproveResult {
  approved: boolean;
  reason: string;
  entry?: DecisionEntry;
}

/**
 * Попытка авто-approve RFC.
 * Если одобрено — записывает в decision journal и возвращает approved=true.
 * journalPath опционален (для тестов).
 */
export function tryAutoApprove(rfc: RFC, journalPath?: string): AutoApproveResult {
  if (!isAutoApprovable(rfc)) {
    const reason = rfc.risk !== 'low'
      ? `risk=${rfc.risk} — требует ручного одобрения`
      : 'имеет phase_b — требует ручного одобрения';
    return { approved: false, reason };
  }

  const entry: DecisionEntry = {
    ts: new Date().toISOString(),
    phase: 'auto_approve',
    rfc_id: rfc.id,
    decision: `Авто-approve RFC ${rfc.id}: ${rfc.title}`,
    rationale: `risk=low, phase_b отсутствует. Тип: ${rfc.type}.`,
    alternatives: ['Ручное одобрение через Telegram'],
    risk: 'low',
    auto_approved: true,
  };

  appendDecision(entry, journalPath);

  return {
    approved: true,
    reason: 'risk=low, нет phase_b — авто-approved',
    entry,
  };
}
