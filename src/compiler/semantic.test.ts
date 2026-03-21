import { describe, it, expect } from 'vitest';
import { compileSource } from './compiler';

function hasKind(src: string, kind: string): boolean {
  const result = compileSource(src);
  return (result.semanticErrors ?? []).some((e) => e.kind === kind);
}

const wrap = (body: string) =>
  `модуль т\nпроцедура главная()\n${body}\nконец\nконец`;

describe('RFC-003 Phase B: invented_syntax', () => {
  it('структура() → invented_syntax', () => {
    const src = wrap('  пусть x = структура(1, 2)');
    expect(hasKind(src, 'invented_syntax')).toBe(true);
  });

  it('система.типы.создать → invented_syntax', () => {
    const src = wrap('  пусть x = система.типы.создать("User")');
    expect(hasKind(src, 'invented_syntax')).toBe(true);
  });

  it('система.хранилище.установить_поле → invented_syntax', () => {
    const src = wrap('  система.хранилище.установить_поле("k", "f", 1)');
    expect(hasKind(src, 'invented_syntax')).toBe(true);
  });

  it('корректный объектный литерал → нет invented_syntax', () => {
    const src = wrap('  пусть x = { поле: 1 }\n  вернуть x.поле');
    expect(hasKind(src, 'invented_syntax')).toBe(false);
  });

  it('данные как имя переменной → invented_syntax', () => {
    const src = wrap('  пусть данные = 42\n  вернуть данные');
    expect(hasKind(src, 'invented_syntax')).toBe(true);
  });
});

describe('RFC-002 Phase B: sentinel_pattern', () => {
  it('пусть x = пусто вне try → sentinel_pattern', () => {
    const src = wrap('  пусть результат = пусто\n  вернуть результат');
    expect(hasKind(src, 'sentinel_pattern')).toBe(true);
  });

  it('пусть x = пусто внутри попробовать → НЕ sentinel_pattern', () => {
    const src = wrap(
      '  попробовать\n' +
        '    пусть д = пусто\n' +
        '    д = система.хранилище.прочитать("к")\n' +
        '    вернуть д\n' +
        '  иначе_попытка е\n' +
        '    вернуть пусто\n' +
        '  конец',
    );
    expect(hasKind(src, 'sentinel_pattern')).toBe(false);
  });

  it('вернуть пусто (без пусть) → НЕ sentinel_pattern', () => {
    const src = wrap('  вернуть пусто');
    expect(hasKind(src, 'sentinel_pattern')).toBe(false);
  });
});
