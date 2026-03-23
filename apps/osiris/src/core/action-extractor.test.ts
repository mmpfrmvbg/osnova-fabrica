import { beforeEach, describe, expect, it, vi } from 'vitest';
import { extractActions } from './action-extractor';

vi.mock('./llm-router', () => ({
  call: vi.fn(),
}));

import { call } from './llm-router';

describe('extractActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns build intent from valid JSON', async () => {
    vi.mocked(call).mockResolvedValueOnce({
      text: '{"intent":"build","facts":[],"tasks":["собрать приложение для заметок"]}',
      tokensUsed: { prompt: 1, completion: 1 },
      model: 'test',
    });

    const result = await extractActions('собери приложение', 'ctx');
    expect(result).toEqual({
      intent: 'build',
      facts: [],
      tasks: ['собрать приложение для заметок'],
    });
  });

  it('returns task intent from valid JSON', async () => {
    vi.mocked(call).mockResolvedValueOnce({
      text: '{"intent":"task","facts":[],"tasks":["подготовить отчет"]}',
      tokensUsed: { prompt: 1, completion: 1 },
      model: 'test',
    });
    const result = await extractActions('добавь задачу', 'ctx');
    expect(result.intent).toBe('task');
    expect(result.tasks.length).toBeGreaterThan(0);
  });

  it('returns fact intent from valid JSON', async () => {
    vi.mocked(call).mockResolvedValueOnce({
      text: '{"intent":"fact","facts":["я работаю аналитиком"],"tasks":[]}',
      tokensUsed: { prompt: 1, completion: 1 },
      model: 'test',
    });
    const result = await extractActions('запомни факт', 'ctx');
    expect(result.intent).toBe('fact');
    expect(result.facts.length).toBeGreaterThan(0);
  });

  it('returns chat intent from valid JSON', async () => {
    vi.mocked(call).mockResolvedValueOnce({
      text: '{"intent":"chat","facts":[],"tasks":[]}',
      tokensUsed: { prompt: 1, completion: 1 },
      model: 'test',
    });
    const result = await extractActions('привет', 'ctx');
    expect(result).toEqual({ intent: 'chat', facts: [], tasks: [] });
  });

  it('returns fallback for invalid JSON text', async () => {
    vi.mocked(call).mockResolvedValueOnce({
      text: 'not-json',
      tokensUsed: { prompt: 1, completion: 1 },
      model: 'test',
    });
    const result = await extractActions('test', 'ctx');
    expect(result).toEqual({ intent: 'chat', facts: [], tasks: [] });
  });

  it('returns fallback on LLM error', async () => {
    vi.mocked(call).mockRejectedValueOnce(new Error('network failed'));
    const result = await extractActions('test', 'ctx');
    expect(result).toEqual({ intent: 'chat', facts: [], tasks: [] });
  });
});
