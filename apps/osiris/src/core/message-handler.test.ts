import { describe, expect, it } from 'vitest';
import { needsDeepThought } from './message-handler';

describe('needsDeepThought', () => {
  it('returns true for long text', () => {
    const long = 'а'.repeat(101);
    expect(needsDeepThought(long)).toBe(true);
  });

  it('returns true for question mark', () => {
    expect(needsDeepThought('Что такое рекурсия?')).toBe(true);
  });

  it('returns true for trigger word', () => {
    expect(needsDeepThought('объясни мне как работает память')).toBe(true);
  });

  it('returns false for short command without triggers', () => {
    expect(needsDeepThought('запомни: меня зовут Михаил')).toBe(false);
  });

  it('returns false for short affirmative', () => {
    expect(needsDeepThought('понял, спасибо')).toBe(false);
  });
});
