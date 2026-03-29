/**
 * Тесты публичного API compiler/index.ts
 * Проверяет корректность экспортов и типов
 */

import { describe, it, expect } from 'vitest';
import * as compiler from './index';

describe('compiler/index.ts exports', () => {
  it('должен экспортировать lexer', () => {
    expect(compiler.tokenize).toBeDefined();
    expect(typeof compiler.tokenize).toBe('function');
  });

  it('должен экспортировать parser', () => {
    expect(compiler.parse).toBeDefined();
    expect(typeof compiler.parse).toBe('function');
  });

  it('должен экспортировать semantic', () => {
    expect(compiler.analyzeProgram).toBeDefined();
    expect(typeof compiler.analyzeProgram).toBe('function');
  });

  it('должен экспортировать codegen', () => {
    expect(compiler.compile).toBeDefined();
    expect(typeof compiler.compile).toBe('function');
    expect(compiler.compileProgram).toBeDefined();
    expect(typeof compiler.compileProgram).toBe('function');
    // compileSource — фасад для компиляции исходника
    expect(compiler.compileSource).toBeDefined();
    expect(typeof compiler.compileSource).toBe('function');
  });

  it('должен экспортировать Compiler class', () => {
    expect(compiler.Compiler).toBeDefined();
    const c = new compiler.Compiler();
    expect(c.compile).toBeDefined();
  });

  it('должен экспортировать VM', () => {
    expect(compiler.VM).toBeDefined();
    expect(compiler.InterpreterError).toBeDefined();
    expect(compiler.runProgram).toBeDefined();
    expect(compiler.loadModule).toBeDefined();
  });

  it('должен экспортировать типы SemanticError', () => {
    // Типы проверяются на этапе компиляции TypeScript
    const error: compiler.SemanticError = {
      message: 'test error',
      kind: 'undeclared_var',
      line: 1,
    };
    expect(error.message).toBe('test error');
  });

  it('должен компилировать простой код', () => {
    const source = `
модуль test
процедура главная()
  вернуть 42
конец`.trim();
    const c = new compiler.Compiler();
    const result = c.compile(source);
    expect(result.compilerSuccess).toBe(true);
    expect(result.module).not.toBeNull();
    expect(result.lexerErrors).toHaveLength(0);
    expect(result.parserErrors).toHaveLength(0);
  });

  it('должен обрабатывать ошибки компиляции', () => {
    const source = `
модуль test
процедура тест()
  пусть x = 42
  вернуть x
конец`.trim();
    const c = new compiler.Compiler();
    const result = c.compile(source);
    // Компиляция должна пройти успешно
    expect(result).toBeDefined();
  });

  it('должен выполнять код через VM', async () => {
    const source = `
модуль test
процедура главная()
  вернуть 100
конец`.trim();
    const compiler_instance = new compiler.Compiler();
    const result = await compiler_instance.execute(source);
    expect(result).toBe(100);
  });
});
