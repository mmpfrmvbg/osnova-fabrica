import { describe, it, expect } from 'vitest';
import { checkG1, checkG2, checkG3 } from './gateChecker';
import type { OsnovaIntent, OsnovaSpec, BuildReport, GoldenReport } from './types';

// ─── Фабрики ───

function makeIntent(overrides: Partial<OsnovaIntent> = {}): OsnovaIntent {
  return {
    intentId: 'i1',
    description: 'тест',
    features: ['вычисление'],
    appType: 'утилита',
    constraints: {},
    confidence: 0.9,
    ...overrides,
  };
}

function makeSpec(overrides: Partial<OsnovaSpec> = {}): OsnovaSpec {
  return {
    specId: 's1',
    modules: [{ name: 'главный', description: '', isMain: true }],
    mainModule: 'главный',
    types: [],
    procedures: [],
    syscalls: [],
    conventions: {},
    ...overrides,
  };
}

function makeBuildReport(overrides: Partial<BuildReport> = {}): BuildReport {
  return {
    success: true,
    lexerErrors: [],
    parserErrors: [],
    compilerErrors: [],
    semanticErrors: [],
    bytecode: { instructions: [] },
    compilerSuccess: true,
    durationMs: 100,
    ...overrides,
  };
}

function makeGoldenReport(overrides: Partial<GoldenReport> = {}): GoldenReport {
  return {
    executed: true,
    passed: true,
    qualityScore: 0.9,
    vmErrors: [],
    outputDiff: null,
    durationMs: 50,
    ...overrides,
  };
}

// ─── G1 тесты ───

describe('checkG1', () => {
  it('проходит при валидном intent и spec', () => {
    const r = checkG1(makeIntent(), makeSpec());
    expect(r.passed).toBe(true);
    expect(r.gateId).toBe('G1_spec_ready');
    expect(r.failedChecks).toHaveLength(0);
  });

  it('не блокирует утилиту при низкой confidence', () => {
    const r = checkG1(makeIntent({ confidence: 0.3, appType: 'утилита' }), makeSpec());
    expect(r.passed).toBe(true);
  });

  it('блокирует не-утилиту при confidence < 0.7', () => {
    const r = checkG1(makeIntent({ confidence: 0.5, appType: 'ui_приложение' }), makeSpec());
    expect(r.passed).toBe(false);
    expect(r.failedChecks.some(f => f.includes('g1_confidence'))).toBe(true);
  });

  it('блокирует при отсутствии features', () => {
    const r = checkG1(makeIntent({ features: [] }), makeSpec());
    expect(r.passed).toBe(false);
    expect(r.failedChecks.some(f => f.includes('g1_features_present'))).toBe(true);
  });

  it('блокирует при отсутствии modules', () => {
    const r = checkG1(makeIntent(), makeSpec({ modules: [] }));
    expect(r.passed).toBe(false);
    expect(r.failedChecks.some(f => f.includes('g1_modules_defined'))).toBe(true);
  });

  it('предупреждает (не блокирует) при отсутствии mainModule', () => {
    const r = checkG1(makeIntent(), makeSpec({ mainModule: '' }));
    // warning не блокирует
    expect(r.passed).toBe(true);
    expect(r.failedChecks.some(f => f.includes('warning'))).toBe(true);
  });
});

// ─── G2 тесты ───

describe('checkG2', () => {
  it('проходит при чистом билде', () => {
    expect(checkG2(makeBuildReport()).passed).toBe(true);
  });

  it('блокирует при lexer ошибках', () => {
    const r = checkG2(makeBuildReport({ lexerErrors: [{ line: 1, column: 1, message: 'bad token' }] }));
    expect(r.passed).toBe(false);
    expect(r.action).toBe('route_to_repair');
  });

  it('блокирует при parser ошибках', () => {
    const r = checkG2(makeBuildReport({ parserErrors: [{ line: 2, column: 1, message: 'unexpected' }] }));
    expect(r.passed).toBe(false);
  });

  it('блокирует при compilerSuccess=false', () => {
    const r = checkG2(makeBuildReport({ compilerSuccess: false, bytecode: null }));
    expect(r.passed).toBe(false);
    expect(r.failedChecks.some(f => f.includes('g2_compiler_success'))).toBe(true);
  });

  it('блокирует при blocking semantic errors (unknown_syscall)', () => {
    const r = checkG2(makeBuildReport({
      semanticErrors: [{ kind: 'unknown_syscall', message: 'система.foo.bar неизвестен' }],
    }));
    expect(r.passed).toBe(false);
    expect(r.failedChecks.some(f => f.includes('g2_semantic_clean'))).toBe(true);
  });

  it('блокирует при blocking semantic errors (syscall_argc)', () => {
    const r = checkG2(makeBuildReport({
      semanticErrors: [{ kind: 'syscall_argc', message: 'неверное число аргументов' }],
    }));
    expect(r.passed).toBe(false);
    expect(r.action).toBe('route_to_repair');
    expect(r.failedChecks.some(f => f.includes('g2_semantic_clean'))).toBe(true);
  });

  it('блокирует при blocking semantic errors (redeclare_var)', () => {
    const r = checkG2(makeBuildReport({
      semanticErrors: [{ kind: 'redeclare_var', message: "повторное объявление 'x' через пусть" }],
    }));
    expect(r.passed).toBe(false);
    expect(r.action).toBe('route_to_repair');
    expect(r.failedChecks.some(f => f.includes('g2_semantic_clean'))).toBe(true);
  });

  it('предупреждает (не блокирует) при медленном билде', () => {
    const r = checkG2(makeBuildReport({ durationMs: 35000 }));
    expect(r.passed).toBe(true);
    expect(r.failedChecks.some(f => f.includes('warning'))).toBe(true);
  });
});

// ─── G3 тесты ───

describe('checkG3', () => {
  it('проходит при qualityScore >= 0.7', () => {
    expect(checkG3(makeGoldenReport({ qualityScore: 0.7 })).passed).toBe(true);
    expect(checkG3(makeGoldenReport({ qualityScore: 1.0 })).passed).toBe(true);
  });

  it('проходит при executed без vmErrors и qualityScore=0 (нет expectVM.returnValue)', () => {
    const r = checkG3(makeGoldenReport({ executed: true, vmErrors: [], qualityScore: 0, outputDiff: 'whatever' }));
    expect(r.passed).toBe(true);
    expect(r.failedChecks).toHaveLength(0);
  });

  it('блокирует при qualityScore < 0.7', () => {
    const r = checkG3(makeGoldenReport({ qualityScore: 0.6 }));
    expect(r.passed).toBe(false);
    expect(r.action).toBe('route_to_repair');
  });

  it('блокирует при VM crash (executed=false)', () => {
    const r = checkG3(makeGoldenReport({ executed: false, qualityScore: 0 }));
    expect(r.passed).toBe(false);
    expect(r.failedChecks.some(f => f.includes('g3_vm_executed'))).toBe(true);
  });

  it('блокирует при VM ошибках', () => {
    const r = checkG3(makeGoldenReport({ vmErrors: [{ message: 'stack underflow' }], qualityScore: 0.5 }));
    expect(r.passed).toBe(false);
  });

  it('блокирует при diff И qualityScore < 0.5', () => {
    const r = checkG3(makeGoldenReport({ outputDiff: 'expected 1 got 2', qualityScore: 0.3 }));
    expect(r.passed).toBe(false);
    expect(r.failedChecks.some(f => f.includes('g3_output_diff_acceptable'))).toBe(true);
  });

  it('не добавляет diff-check если qualityScore >= 0.5', () => {
    const r = checkG3(makeGoldenReport({ outputDiff: 'minor diff', qualityScore: 0.6 }));
    // g3_golden_or_quality упадёт, но g3_output_diff_acceptable не должен
    expect(r.failedChecks.some(f => f.includes('g3_output_diff_acceptable'))).toBe(false);
  });

  it('граничное значение qualityScore = 0.5 блокирует (< 0.7)', () => {
    const r = checkG3(makeGoldenReport({ qualityScore: 0.5 }));
    expect(r.passed).toBe(false);
  });
});
