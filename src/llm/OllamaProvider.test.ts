import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OllamaProvider } from './OllamaProvider';

const makeFetchMock = (body: unknown, status = 200) =>
  vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });

describe('OllamaProvider', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('checkHealth: available:true при успешном ответе', async () => {
    vi.stubGlobal('fetch', makeFetchMock({}));
    const provider = new OllamaProvider('http://127.0.0.1:11434');
    const status = await provider.checkHealth();
    expect(status.available).toBe(true);
  });

  it('checkHealth: available:false при сетевой ошибке', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const provider = new OllamaProvider('http://127.0.0.1:11434');
    const status = await provider.checkHealth();
    expect(status.available).toBe(false);
    expect(status.error).toContain('network down');
  });

  it('complete: возвращает content из ответа', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock({
        message: { role: 'assistant', content: 'ответ от ollama' },
        model: 'qwen2.5-coder:7b',
        prompt_eval_count: 8,
        eval_count: 12,
      }),
    );
    const provider = new OllamaProvider('http://127.0.0.1:11434');
    const res = await provider.complete({
      model: 'qwen2.5-coder:7b',
      messages: [{ role: 'user', content: 'тест' }],
      temperature: 0.2,
    });
    expect(res.content).toBe('ответ от ollama');
    expect(res.model).toBe('qwen2.5-coder:7b');
    expect(res.tokensUsed?.total).toBe(20);
  });

  it('complete: бросает ошибку при HTTP 500', async () => {
    vi.stubGlobal('fetch', makeFetchMock({}, 500));
    const provider = new OllamaProvider('http://127.0.0.1:11434');
    await expect(
      provider.complete({
        model: 'qwen2.5-coder:7b',
        messages: [{ role: 'user', content: 'тест' }],
        temperature: 0.2,
      }),
    ).rejects.toThrow('500');
  });
});
