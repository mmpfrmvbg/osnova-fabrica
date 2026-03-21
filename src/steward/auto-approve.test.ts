import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tryAutoApprove } from './auto-approve';
import type { RFC } from './rfc';

const TEST_JOURNAL = path.resolve('runs/test-auto-approve.jsonl');

const lowRFC: RFC = {
  id: 'RFC-001',
  type: 'rfc',
  title: 'Тест авто-approve',
  status: 'draft',
  risk: 'low',
  author: 'lang-agent',
  created_at: '2026-03-21T00:00:00Z',
  updated_at: '2026-03-21T00:00:00Z',
  description: 'Описание',
};

beforeEach(() => {
  if (fs.existsSync(TEST_JOURNAL)) fs.unlinkSync(TEST_JOURNAL);
});
afterEach(() => {
  if (fs.existsSync(TEST_JOURNAL)) fs.unlinkSync(TEST_JOURNAL);
});

describe('tryAutoApprove', () => {
  it('risk=low без phase_b → approved=true', () => {
    const r = tryAutoApprove(lowRFC, TEST_JOURNAL);
    expect(r.approved).toBe(true);
    expect(r.entry?.auto_approved).toBe(true);
  });

  it('записывает в journal', () => {
    tryAutoApprove(lowRFC, TEST_JOURNAL);
    const content = fs.readFileSync(TEST_JOURNAL, 'utf-8');
    expect(content).toContain('RFC-001');
    expect(content).toContain('auto_approve');
  });

  it('risk=medium → approved=false', () => {
    const r = tryAutoApprove({ ...lowRFC, risk: 'medium' }, TEST_JOURNAL);
    expect(r.approved).toBe(false);
    expect(r.reason).toContain('medium');
  });

  it('risk=high → approved=false', () => {
    const r = tryAutoApprove({ ...lowRFC, risk: 'high' }, TEST_JOURNAL);
    expect(r.approved).toBe(false);
  });

  it('risk=low + phase_b → approved=false', () => {
    const r = tryAutoApprove(
      { ...lowRFC, phase_b: { shadow_mode_pct: 85 } },
      TEST_JOURNAL,
    );
    expect(r.approved).toBe(false);
    expect(r.reason).toContain('phase_b');
  });

  it('anti-rfc risk=low → approved=true', () => {
    const r = tryAutoApprove(
      { ...lowRFC, type: 'anti-rfc', hypothesis: 'few-shot решит проблему' },
      TEST_JOURNAL,
    );
    expect(r.approved).toBe(true);
  });
});
