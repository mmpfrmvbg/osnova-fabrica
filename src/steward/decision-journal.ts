// ============================================================
// src/steward/decision-journal.ts — Decision Journal
// Хранит историю решений в decisions.jsonl (append-only).
// Qwen загружает последние N записей как контекст при PLAN-шаге.
// ============================================================

import * as fs from 'fs';
import * as path from 'path';

export type DecisionPhase = 'plan' | 'phase_a' | 'phase_b' | 'close' | 'reject' | 'auto_approve';

export interface DecisionEntry {
  ts: string;              // ISO-8601
  phase: DecisionPhase;
  rfc_id: string;          // RFC-001, ...
  decision: string;        // краткое решение
  rationale: string;       // обоснование
  alternatives?: string[]; // рассмотренные альтернативы
  risk: 'low' | 'medium' | 'high';
  auto_approved?: boolean;
}

/**
 * Записать одно решение в конец decisions.jsonl (append).
 */
export function appendDecision(entry: DecisionEntry, filePath?: string): void {
  const target = filePath ?? path.resolve('runs/decisions.jsonl');
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(target, JSON.stringify(entry) + '\n', 'utf-8');
}

/**
 * Загрузить последние N решений для контекста PLAN-шага.
 */
export function loadRecentDecisions(n: number, filePath?: string): DecisionEntry[] {
  const target = filePath ?? path.resolve('runs/decisions.jsonl');
  if (!fs.existsSync(target)) return [];
  const lines = fs.readFileSync(target, 'utf-8')
    .split('\n')
    .filter(l => l.trim().length > 0);
  const parsed: DecisionEntry[] = [];
  for (const line of lines) {
    try { parsed.push(JSON.parse(line) as DecisionEntry); } catch { /* skip */ }
  }
  return parsed.slice(-n);
}

/**
 * Форматировать последние N решений в читаемый контекст для промпта.
 */
export function formatDecisionsContext(n: number, filePath?: string): string {
  const entries = loadRecentDecisions(n, filePath);
  if (entries.length === 0) return '(нет предыдущих решений)';
  return entries.map(e =>
    `[${e.ts}] ${e.rfc_id} / ${e.phase} / risk=${e.risk}\n  Решение: ${e.decision}\n  Обоснование: ${e.rationale}`
  ).join('\n\n');
}
