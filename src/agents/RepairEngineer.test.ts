import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RepairEngineerAgent } from './RepairEngineer';
import type { OsnovaSource, BuildReport, GoldenReport } from '../pipeline/types';

// Mock LLM — возвращает код без изменений (контент будет равно userPrompt),
// чтобы тесты могли проверить что попало в промпт.
vi.mock('../llm/index', () => ({
  getLLMProvider: () => ({
    complete: async (req: { messages: { role: string; content: string }[] }) => {
      const userMsg = req.messages.find((m: { role: string }) => m.role === 'user');
      return {
        content: (userMsg?.content as string) ?? '',
        model: 'mock',
        done: true,
      };
    },
  }),
}));

vi.mock('../pipeline-llm/buildOsnovaPrompt', () => ({
  buildOsnovaRepairPrompt: vi.fn(
    (source: string, errors: string[], prefix?: string, errorKinds?: unknown) =>
      JSON.stringify({ source, errors, prefix, errorKinds }),
  ),
}));

import { buildOsnovaRepairPrompt } from '../pipeline-llm/buildOsnovaPrompt';

function makeSource(source = 'модуль т\nпроцедура главная()\n  вернуть 0\nконец\nконец'): OsnovaSource {
  return { filename: 'main.osnova', source };
}

function makeBuildReport(overrides: Partial<BuildReport> = {}): BuildReport {
  return {
    success: false,
    lexerErrors: [],
    parserErrors: [],
    compilerErrors: [],
    semanticErrors: [],
    bytecode: null,
    compilerSuccess: false,
    durationMs: 10,
    ...overrides,
  };
}

function makeGoldenReport(overrides: Partial<GoldenReport> = {}): GoldenReport {
  return {
    executed: true,
    passed: false,
    qualityScore: 0.3,
    vmErrors: [],
    outputDiff: null,
    durationMs: 10,
    ...overrides,
  };
}

describe('RepairEngineerAgent.fix', () => {
  beforeEach(() => {
    vi.mocked(buildOsnovaRepairPrompt).mockClear();
  });

  it('вызывает buildOsnovaRepairPrompt с исходным кодом', async () => {
    const agent = new RepairEngineerAgent();
    await agent.fix(makeSource('код'));
    expect(buildOsnovaRepairPrompt).toHaveBeenCalledWith(
      'код',
      expect.any(Array),
      undefined,
      undefined,
    );
  });

  it('передаёт lexer ошибки в errors', async () => {
    const agent = new RepairEngineerAgent();
    const report = makeBuildReport({
      lexerErrors: [{ line: 1, column: 5, message: 'unexpected token' }],
    });
    await agent.fix(makeSource(), report);
    const errors = vi.mocked(buildOsnovaRepairPrompt).mock.calls[0][1] as string[];
    expect(errors.some((e: string) => e.includes('unexpected token'))).toBe(true);
  });

  it('передаёт parser ошибки в errors', async () => {
    const agent = new RepairEngineerAgent();
    const report = makeBuildReport({
      parserErrors: [{ line: 3, column: 1, message: 'expected конец' }],
    });
    await agent.fix(makeSource(), report);
    const errors = vi.mocked(buildOsnovaRepairPrompt).mock.calls[0][1] as string[];
    expect(errors.some((e: string) => e.includes('expected конец'))).toBe(true);
  });

  it('передаёт errorKinds (blocking) в buildOsnovaRepairPrompt', async () => {
    const agent = new RepairEngineerAgent();
    const report = makeBuildReport({
      semanticErrors: [
        { kind: 'unknown_syscall', message: 'bad syscall' },
        { kind: 'undeclared_var', message: 'x' },
      ],
    });
    await agent.fix(makeSource(), report);
    const errorKinds = vi.mocked(buildOsnovaRepairPrompt).mock.calls[0][3] as string[];
    expect(errorKinds).toBeDefined();
    expect(errorKinds).toEqual(['unknown_syscall', 'undeclared_var']);
  });

  it('передаёт только blocking semantic errors', async () => {
    const agent = new RepairEngineerAgent();
    const report = makeBuildReport({
      semanticErrors: [
        { kind: 'unknown_syscall', message: 'система.foo.bar неизвестен' },
        { kind: 'chained_compare', message: 'цепочечные сравнения' }, // non-blocking for RepairEngineer
      ],
    });
    await agent.fix(makeSource(), report);
    const errors = vi.mocked(buildOsnovaRepairPrompt).mock.calls[0][1] as string[];
    expect(errors.some((e: string) => e.includes('система.foo.bar'))).toBe(true);
    expect(errors.some((e: string) => e.includes('цепочечные сравнения'))).toBe(false);
  });

  it('передаёт VM ошибки из goldenReport', async () => {
    const agent = new RepairEngineerAgent();
    const golden = makeGoldenReport({
      vmErrors: [{ message: 'stack overflow' }],
    });
    await agent.fix(makeSource(), undefined, golden);
    const errors = vi.mocked(buildOsnovaRepairPrompt).mock.calls[0][1] as string[];
    expect(errors.some((e: string) => e.includes('stack overflow'))).toBe(true);
  });

  it('передаёт outputDiff из goldenReport', async () => {
    const agent = new RepairEngineerAgent();
    const golden = makeGoldenReport({ outputDiff: 'expected 5 got 0' });
    await agent.fix(makeSource(), undefined, golden);
    const errors = vi.mocked(buildOsnovaRepairPrompt).mock.calls[0][1] as string[];
    expect(errors.some((e: string) => e.includes('expected 5 got 0'))).toBe(true);
  });

  it('передаёт prefix с номером попытки', async () => {
    const agent = new RepairEngineerAgent();
    await agent.fix(makeSource(), undefined, undefined, 2);
    const prefix = vi.mocked(buildOsnovaRepairPrompt).mock.calls[0][2] as string | undefined;
    expect(prefix).toContain('2');
  });

  it('возвращает OsnovaSource с тем же filename', async () => {
    const agent = new RepairEngineerAgent();
    const result = await agent.fix(makeSource());
    expect(result.filename).toBe('main.osnova');
  });

  it('не падает при пустом buildReport и goldenReport', async () => {
    const agent = new RepairEngineerAgent();
    await expect(agent.fix(makeSource())).resolves.not.toThrow();
  });
});

