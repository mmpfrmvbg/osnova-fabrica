import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DeepSeekProvider } from './DeepSeekProvider';

const makeFetchMock = (body: unknown, status = 200) =>
  vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });

describe('DeepSeekProvider', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('checkHealth: возвращает available:true при HTTP 200', async () => {
    vi.stubGlobal('fetch', makeFetchMock({ data: [] }));
    const provider = new DeepSeekProvider('test-key');
    const status = await provider.checkHealth();
    expect(status.available).toBe(true);
  });

  it('checkHealth: возвращает available:false при HTTP 401', async () => {
    vi.stubGlobal('fetch', makeFetchMock({}, 401));
    const provider = new DeepSeekProvider('bad-key');
    const status = await provider.checkHealth();
    expect(status.available).toBe(false);
    expect(status.error).toContain('401');
  });

  it('complete: возвращает content из choices[0].message.content', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock({
        choices: [{ message: { content: 'привет мир' }, finish_reason: 'stop' }],
        model: 'deepseek-chat',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );
    const provider = new DeepSeekProvider('test-key');
    const res = await provider.complete({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'тест' }],
      temperature: 0.1,
    });
    expect(res.content).toBe('привет мир');
    expect(res.model).toBe('deepseek-chat');
    expect(res.tokensUsed?.total).toBe(15);
    expect(res.truncated).toBe(false);
  });

  it('complete: truncated=true при finish_reason=length', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock({
        choices: [{ message: { content: 'обрезанный' }, finish_reason: 'length' }],
        model: 'deepseek-chat',
      }),
    );
    const provider = new DeepSeekProvider('test-key');
    const res = await provider.complete({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'тест' }],
      temperature: 0.1,
    });
    expect(res.truncated).toBe(true);
  });

  it('complete: бросает ошибку при HTTP 500', async () => {
    vi.stubGlobal('fetch', makeFetchMock({}, 500));
    const provider = new DeepSeekProvider('test-key');
    await expect(
      provider.complete({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'тест' }],
        temperature: 0.1,
      }),
    ).rejects.toThrow('500');
  });
});
