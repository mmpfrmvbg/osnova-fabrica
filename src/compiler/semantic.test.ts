import { describe, it, expect } from 'vitest';
import { compileSource } from ".";
import { tokenize } from './lexer';
import { parse } from './parser';
import { analyzeProgram } from './semantic';

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

describe('Program semantics (multi-module)', () => {
  it('два модуля, импорт и вызов экспортированной процедуры -> success', () => {
    const src = [
      'модуль A',
      'процедура экспорт ping()',
      '  вернуть 1',
      'конец',
      'конец',
      '',
      'модуль B',
      'использовать модуль A из "a.osnova"',
      'процедура главная()',
      '  вернуть A.ping()',
      'конец',
      'конец',
      '',
    ].join('\n');

    const { tokens } = tokenize(src);
    const { ast, errors } = parse(tokens);
    expect(errors).toHaveLength(0);
    expect(ast).not.toBeNull();
    const sem = analyzeProgram(ast!);
    expect(sem.errors).toHaveLength(0);
  });

  it('импорт несуществующего модуля -> ошибка unknown_module', () => {
    const src = [
      'модуль B',
      'использовать модуль Unknown из "unknown.osnova"',
      'процедура главная()',
      '  вернуть 0',
      'конец',
      'конец',
      '',
    ].join('\n');

    const { tokens } = tokenize(src);
    const { ast, errors } = parse(tokens);
    expect(errors).toHaveLength(0);
    expect(ast).not.toBeNull();
    const sem = analyzeProgram(ast!);
    expect(sem.errors.some((e) => e.kind === 'unknown_module')).toBe(true);
  });

  it('коллизия экспортов в одном namespace -> ошибка export_collision', () => {
    const src = [
      'модуль A',
      'процедура экспорт ping()',
      '  вернуть 1',
      'конец',
      'конец',
      '',
      'модуль A',
      'процедура экспорт ping()',
      '  вернуть 2',
      'конец',
      'конец',
      '',
      'модуль B',
      'использовать модуль A из "a.osnova"',
      'процедура главная()',
      '  вернуть A.ping()',
      'конец',
      'конец',
      '',
    ].join('\n');

    const { tokens } = tokenize(src);
    const { ast, errors } = parse(tokens);
    expect(errors).toHaveLength(0);
    expect(ast).not.toBeNull();
    const sem = analyzeProgram(ast!);
    expect(sem.errors.some((e) => e.kind === 'export_collision')).toBe(true);
  });
});

describe('Loop control semantic diagnostics', () => {
  it('прервать вне цикла -> break_outside_loop', () => {
    const src = wrap('  прервать');
    expect(hasKind(src, 'break_outside_loop')).toBe(true);
  });

  it('продолжить вне цикла -> continue_outside_loop', () => {
    const src = wrap('  продолжить');
    expect(hasKind(src, 'continue_outside_loop')).toBe(true);
  });
});

describe('semantic checker: string syscalls & keyword_as_identifier', () => {
  it('система.строка.объединить с 2 аргументами — нет ошибок', () => {
    const source =
      'модуль t\nпроцедура главная()\n  пусть s = система.строка.объединить("привет", " мир")\nконец\nконец';
    const result = compileSource(source);
    expect(result.semanticErrors.filter((e) => e.kind === 'unknown_syscall')).toHaveLength(0);
  });

  it('система.строка.из_числа с 1 аргументом — нет ошибок', () => {
    const source =
      'модуль t\nпроцедура главная()\n  пусть s = система.строка.из_числа(42)\nконец\nконец';
    const result = compileSource(source);
    expect(result.semanticErrors.filter((e) => e.kind === 'unknown_syscall')).toHaveLength(0);
  });

  it('объявление переменной с именем ключевого слова даёт keyword_as_identifier', () => {
    const src = [
      'модуль т',
      'процедура главная()',
      '  пусть если = 0',
      '  вернуть 0',
      'конец',
      'конец',
    ].join('\n');
    const result = compileSource(src);
    expect(result.semanticErrors.some((e) => e.kind === 'keyword_as_identifier')).toBe(true);
  });

  it('объявление переменной «и» даёт keyword_as_identifier', () => {
    const src = [
      'модуль т',
      'процедура главная()',
      '  пусть и = 0',
      '  вернуть 0',
      'конец',
      'конец',
    ].join('\n');
    const result = compileSource(src);
    expect(result.semanticErrors.some((e) => e.kind === 'keyword_as_identifier')).toBe(true);
  });
});
