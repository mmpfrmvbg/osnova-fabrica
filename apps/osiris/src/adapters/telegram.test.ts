import { describe, expect, it, vi, afterEach } from 'vitest';

describe('Telegram adapter', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('handleTelegramUpdate: отправляет reply с экранированным текстом', async () => {
    vi.doMock('../core/message-handler', () => ({
      handleMessage: vi.fn().mockResolvedValue({
        reply: 'ответ *со звёздочкой* и _подчёркиванием_',
        mode: 'chat',
        trackedFacts: 0,
        trackedTasks: 0,
      }),
    }));
    vi.doMock('../core/memory-engine', () => ({
      getCoreMemory: vi.fn().mockResolvedValue({ meta: {} }),
      updateCoreMemory: vi.fn().mockResolvedValue(undefined),
    }));

    const fetchCalls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(
      async (url: string, options?: RequestInit) => {
        fetchCalls.push({
          url: String(url),
          body: typeof options?.body === 'string' ? options.body : '',
        });
        return { ok: true, json: async () => ({}), text: async () => '' };
      },
    ));

    const { handleTelegramUpdate } = await import('./telegram');

    await handleTelegramUpdate({
      update_id: 1,
      message: { text: 'привет', chat: { id: 100 }, from: { id: 42 } },
    });

    const sendCall = fetchCalls.find((c) => c.url.includes('sendMessage'));
    expect(sendCall).toBeDefined();
    const body = JSON.parse(sendCall!.body) as { text: string; parse_mode: string };
    // Символы * и _ должны быть экранированы
    expect(body.text).toContain('\\*');
    expect(body.text).toContain('\\_');
    expect(body.parse_mode).toBe('MarkdownV2');
  });

  it('handleTelegramUpdate: /start отправляет приветствие без handleMessage', async () => {
    const handleMessageMock = vi.fn();
    vi.doMock('../core/message-handler', () => ({
      handleMessage: handleMessageMock,
    }));
    vi.doMock('../core/memory-engine', () => ({
      getCoreMemory: vi.fn().mockResolvedValue({ meta: {} }),
      updateCoreMemory: vi.fn().mockResolvedValue(undefined),
    }));

    const fetchCalls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(
      async (url: string, options?: RequestInit) => {
        fetchCalls.push({
          url: String(url),
          body: typeof options?.body === 'string' ? options.body : '',
        });
        return { ok: true, json: async () => ({}), text: async () => '' };
      },
    ));

    const { handleTelegramUpdate } = await import('./telegram');

    await handleTelegramUpdate({
      update_id: 2,
      message: { text: '/start', chat: { id: 200 }, from: { id: 99 } },
    });

    // handleMessage не должен вызываться для /start
    expect(handleMessageMock).not.toHaveBeenCalled();
    const sendCall = fetchCalls.find((c) => c.url.includes('sendMessage'));
    expect(sendCall).toBeDefined();
    const body = JSON.parse(sendCall!.body) as { chat_id: number; text: string };
    expect(body.chat_id).toBe(200);
    expect(body.text).toContain('Осирис');
  });
});
