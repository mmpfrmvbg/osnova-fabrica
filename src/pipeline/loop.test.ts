/**
 * Тесты автономной петли runLoop с mock LLM.
 * Проверяют: сходимость к success, остановку по лимиту итераций и запись трейса.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runLoop } from './loop';

const VALID_OSNOVA = [
  'модуль Главный',
  'процедура главная()',
  '  пусть сумма = 0',
  '  пусть счётчик = 1',
  '  пока счётчик <= 10',
  '    сумма = сумма + счётчик',
  '    счётчик = счётчик + 1',
  '  конец',
  '  система.лог.вывести(сумма)',
  '  вернуть сумма',
  'конец',
  'конец',
  '',
].join('\n');

// Mock LLM provider: возвращает заготовленные ответы для каждого агента.
const createMockProvider = () => ({
  id: 'mock',
  name: 'MockLLM',
  async checkHealth() {
    return { available: true };
  },
  async listModels() {
    return [];
  },
  async complete(request: { messages: { role: string; content: string }[] }) {
    const messages = request.messages;
    const lastMsg = messages[messages.length - 1];
    const content = typeof lastMsg.content === 'string' ? lastMsg.content : '';
    const systemContent = messages[0]?.role === 'system' ? (messages[0].content as string) : '';

    if (messages.length === 1 && content.includes('Analyze this programming task')) {
      return {
        content: JSON.stringify({
          intent: 'Посчитать сумму чисел от 1 до 10',
          confidence: 0.95,
          language: 'osnova',
          features: ['arithmetic loop', 'print result'],
          params: {},
        }),
        model: 'mock',
        done: true,
      };
    }

    if (
      messages.length === 2 &&
      systemContent.includes('modules') &&
      (systemContent.includes('Return ONLY this JSON') || systemContent.includes('Верни ТОЛЬКО'))
    ) {
      return {
        content: JSON.stringify({
          modules: [{ name: 'Главный', description: 'Main', isMain: true }],
          mainModule: 'главная',
          types: [],
          procedures: [{ name: 'главная', params: {}, returnType: 'Ничто' }],
          syscalls: ['система.лог.вывести'],
          conventions: {},
        }),
        model: 'mock',
        done: true,
      };
    }

    if (systemContent.includes('OsnovaCodegen')) {
      return { content: VALID_OSNOVA, model: 'mock', done: true };
    }

    // RepairEngineer (fallback) — валидный код
    return { content: VALID_OSNOVA, model: 'mock', done: true };
  },
  async completeStream() {
    throw new Error('completeStream not used in loop');
  },
});

vi.mock('../llm/index', () => ({
  getLLMProvider: () => createMockProvider(),
  DEFAULT_PROVIDER: 'deepseek',
  getDefaultModel: () => 'mock',
  PROVIDER_DEFAULT_MODEL: {},
}));

vi.mock('../runtime/goldenApps', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runtime/goldenApps')>();
  return {
    ...actual,
    runGoldenCheck: vi.fn(),
  };
});

function tmpTrace(): string {
  return path.join(
    os.tmpdir(),
    `loop-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  );
}

describe('runLoop (mock LLM)', () => {
  beforeEach(async () => {
    const goldenApps = await import('../runtime/goldenApps');
    vi.mocked(goldenApps.runGoldenCheck).mockReset();
  });

  it('сходится к success и пишет трейс итераций', async () => {
    const goldenApps = await import('../runtime/goldenApps');
    vi.mocked(goldenApps.runGoldenCheck).mockResolvedValue({
      executed: true,
      passed: true,
      qualityScore: 0.9,
      vmErrors: [],
      outputDiff: null,
      durationMs: 10,
    });

    const traceFile = tmpTrace();
    const result = await runLoop('посчитай сумму от 1 до 10', { maxIterations: 3, traceFile });

    expect(result.status).toBe('success');
    expect(result.iterations.length).toBeGreaterThanOrEqual(1);
    const done = result.iterations.find(i => i.phase === 'done');
    expect(done?.status).toBe('success');
    expect(result.source?.source).toContain('модуль');

    expect(fs.existsSync(traceFile)).toBe(true);
    const lines = fs.readFileSync(traceFile, 'utf-8').split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const first = JSON.parse(lines[0]!);
    expect(first).toMatchObject({ iteration: 1, phase: 'codegen' });
  }, 20000);

  it('останавливается по лимиту итераций при постоянно падающем golden', async () => {
    const goldenApps = await import('../runtime/goldenApps');
    vi.mocked(goldenApps.runGoldenCheck).mockResolvedValue({
      executed: true,
      passed: false,
      qualityScore: 0.1,
      vmErrors: [{ message: 'wrong output' }],
      outputDiff: 'big diff',
      durationMs: 10,
    });

    const result = await runLoop('тест exhaustion', { maxIterations: 3 });

    expect(result.status).toBe('repair_exhausted');
    expect(result.iterations.length).toBeGreaterThanOrEqual(3);
    const failed = result.iterations.filter(i => i.status === 'failed');
    expect(failed.length).toBeGreaterThanOrEqual(1);
  }, 20000);

  it('возвращает partial при qualityScore в [0.5, 0.7)', async () => {
    const goldenApps = await import('../runtime/goldenApps');
    vi.mocked(goldenApps.runGoldenCheck).mockResolvedValue({
      executed: true,
      passed: false,
      qualityScore: 0.6,
      vmErrors: [],
      outputDiff: 'minor diff',
      durationMs: 10,
    });

    const result = await runLoop('тест partial', { maxIterations: 3 });
    expect(result.status).toBe('partial');
  }, 20000);
});
