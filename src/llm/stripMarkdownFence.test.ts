import { describe, it, expect } from 'vitest';
import { stripMarkdownFence } from './stripMarkdownFence';

describe('stripMarkdownFence', () => {
  it('возвращает строку без изменений если нет фенса', () => {
    expect(stripMarkdownFence('модуль т')).toBe('модуль т');
  });

  it('strip-ает ```osnova ... ```', () => {
    const s = '```osnova\nмодуль т\nконец\n```';
    expect(stripMarkdownFence(s)).toBe('модуль т\nконец');
  });

  it('strip-ает ```json ... ```', () => {
    const s = '```json\n{"key": 1}\n```';
    expect(stripMarkdownFence(s)).toBe('{"key": 1}');
  });

  it('strip-ает ``` без языка', () => {
    const s = '```\nкод\n```';
    expect(stripMarkdownFence(s)).toBe('код');
  });

  it('возвращает пустую строку при пустом вводе', () => {
    expect(stripMarkdownFence('')).toBe('');
  });

  it('не трогает код без завершающего фенса', () => {
    const s = '```\nнезакрытый';
    const result = stripMarkdownFence(s);
    expect(result).not.toContain('```');
  });

  it('trim-ит пробелы по краям', () => {
    expect(stripMarkdownFence('  код  ')).toBe('код');
  });

  it('strip-ает ```ts ... ```', () => {
    const s = '```ts\nconst x = 1;\n```';
    expect(stripMarkdownFence(s)).toBe('const x = 1;');
  });
});

