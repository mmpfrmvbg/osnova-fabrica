import { describe, expect, it } from 'vitest';
import { extractAction } from './action-extractor';

describe('extractAction', () => {
  it('detects build request', () => {
    const action = extractAction('сделай приложение для учёта расходов');
    expect(action.kind).toBe('build');
  });

  it('keeps normal chat as chat action', () => {
    const action = extractAction('привет, как дела?');
    expect(action.kind).toBe('chat');
  });
});

