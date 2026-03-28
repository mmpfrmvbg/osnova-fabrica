/**
 * Доп. unit-сценарии пайплайна (без интеграции с полным моком LLM — см. orchestrator.test.ts).
 */
import { describe, it, expect } from 'vitest';

describe('Pipeline: A-3 — success с non-blocking semanticErrors НЕ является аномалией', () => {
  it('при non-blocking semanticErrors + golden passed → status=success', async () => {
    const { compileToBuildReport, hasBlockingSemanticErrors } = await import('./orchestrator');

    const mockCompileResult = {
      compilerSuccess: true,
      lexerErrors: [],
      parserErrors: [],
      compilerErrors: [],
      semanticErrors: [{ kind: 'non_blocking_warning', message: 'предупреждение' }],
      module: {},
      durationMs: 1,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = compileToBuildReport(mockCompileResult as any);
    expect(hasBlockingSemanticErrors(report)).toBe(false);
    expect(report.semanticErrors!.length).toBe(1);
    expect(report.success).toBe(true);
    expect(report.semanticErrorCount).toBe(1);
  });

  it('при BLOCKING semanticError → status=partial (не success)', async () => {
    const { BLOCKING_SEMANTIC_KINDS } = await import('./semanticKinds');
    const { compileToBuildReport, hasBlockingSemanticErrors } = await import('./orchestrator');
    const blockingKind = BLOCKING_SEMANTIC_KINDS[0]!;

    const mockCompileResult = {
      compilerSuccess: true,
      lexerErrors: [],
      parserErrors: [],
      compilerErrors: [],
      semanticErrors: [{ kind: blockingKind, message: 'blocking error' }],
      module: {},
      durationMs: 1,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = compileToBuildReport(mockCompileResult as any);
    expect(hasBlockingSemanticErrors(report)).toBe(true);
    expect(report.success).toBe(false);
    expect(report.semanticErrorCount).toBe(1);
  });
});

describe('A-2: extractLastErrorKind', () => {
  it('undefined buildReport → "unknown"', async () => {
    const { extractLastErrorKind } = await import('./orchestrator');
    expect(extractLastErrorKind(undefined)).toBe('unknown');
  });

  it('пустой buildReport без ошибок → "unknown"', async () => {
    const { extractLastErrorKind } = await import('./orchestrator');
    const report = {
      success: true,
      lexerErrors: [],
      parserErrors: [],
      compilerErrors: [],
      semanticErrors: [],
      bytecode: null,
      compilerSuccess: true,
      durationMs: 1,
    };
    expect(extractLastErrorKind(report)).toBe('unknown');
  });

  it('lexer error → "lexer_error"', async () => {
    const { extractLastErrorKind } = await import('./orchestrator');
    const report = {
      success: false,
      lexerErrors: [{ line: 1, column: 1, message: 'err' }],
      parserErrors: [],
      compilerErrors: [],
      semanticErrors: [],
      bytecode: null,
      compilerSuccess: false,
      durationMs: 1,
    };
    expect(extractLastErrorKind(report)).toBe('lexer_error');
  });

  it('blocking semantic error → возвращает kind', async () => {
    const { extractLastErrorKind } = await import('./orchestrator');
    const { BLOCKING_SEMANTIC_KINDS } = await import('./semanticKinds');
    const kind = BLOCKING_SEMANTIC_KINDS[0]!;
    const report = {
      success: false,
      lexerErrors: [],
      parserErrors: [],
      compilerErrors: [],
      semanticErrors: [{ kind, message: 'block' }],
      bytecode: null,
      compilerSuccess: false,
      durationMs: 1,
    };
    expect(extractLastErrorKind(report)).toBe(kind);
  });
});
