import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { appendDecision, loadRecentDecisions, formatDecisionsContext } from './decision-journal';
import type { DecisionEntry } from './decision-journal';

const TEST_FILE = path.resolve('runs/test-decisions.jsonl');

const entry1: DecisionEntry = {
  ts: '2026-03-21T10:00:00Z',
  phase: 'plan',
  rfc_id: 'RFC-001',
  decision: 'Начать Phase A',
  rationale: 'Достаточно данных',
  risk: 'low',
};
const entry2: DecisionEntry = {
  ts: '2026-03-21T11:00:00Z',
  phase: 'auto_approve',
  rfc_id: 'RFC-001',
  decision: 'Авто-approve',
  rationale: 'risk=low, нет phase_b',
  risk: 'low',
  auto_approved: true,
};

beforeEach(() => {
  if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
});
afterEach(() => {
  if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
});

describe('appendDecision + loadRecentDecisions', () => {
  it('записывает и читает одну запись', () => {
    appendDecision(entry1, TEST_FILE);
    const loaded = loadRecentDecisions(10, TEST_FILE);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.rfc_id).toBe('RFC-001');
  });

  it('lastN=1 возвращает только последнюю', () => {
    appendDecision(entry1, TEST_FILE);
    appendDecision(entry2, TEST_FILE);
    const loaded = loadRecentDecisions(1, TEST_FILE);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.phase).toBe('auto_approve');
  });

  it('файл не существует → пустой массив', () => {
    const loaded = loadRecentDecisions(5, TEST_FILE + '.missing');
    expect(loaded).toHaveLength(0);
  });
});

describe('formatDecisionsContext', () => {
  it('нет файла → строка про отсутствие решений', () => {
    const ctx = formatDecisionsContext(5, TEST_FILE + '.missing');
    expect(ctx).toContain('нет предыдущих решений');
  });

  it('форматирует записи в читаемый контекст', () => {
    appendDecision(entry1, TEST_FILE);
    const ctx = formatDecisionsContext(5, TEST_FILE);
    expect(ctx).toContain('RFC-001');
    expect(ctx).toContain('Начать Phase A');
  });
});
