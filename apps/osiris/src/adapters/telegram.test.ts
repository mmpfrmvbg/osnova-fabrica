import { describe, expect, it, vi, afterEach } from 'vitest';

describe('Telegram adapter: handleTelegramUpdate', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('вызывает sendMessage с ответом от handleMessage', async () => {
    // Мокаем handleMessage
    vi.doMock('../core/message-handler', () => ({
      handleMessage: vi.fn().mockResolvedValue({
        reply: 'ответ от осириса',
        mode: 'chat',
        trackedFacts: 0,
        trackedTasks: 0,
      }),
    }));

    // Собираем fetch-вызовы
    const fetchCalls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(
      async (url: string, options?: RequestInit) => {
        fetchCalls.push({
          url: String(url),
          body: typeof options?.body === 'string' ? options.body : '',
        });
        return {
          ok: true,
          json: async () => ({}),
          text: async () => '',
        };
      },
    ));

    const { handleTelegramUpdate } = await import('./telegram');

    const mockUpdate = {
      update_id: 42,
      message: {
        text: 'привет',
        chat: { id: 100500 },
        from: { id: 777 },
      },
    };

    await handleTelegramUpdate(mockUpdate);

    // Проверяем что был вызов sendMessage с нужным текстом
    const sendCall = fetchCalls.find((c) => c.url.includes('sendMessage'));
    expect(sendCall).toBeDefined();
    const bodyParsed = JSON.parse(sendCall!.body) as {
      chat_id: number;
      text: string;
      parse_mode: string;
    };
    expect(bodyParsed.chat_id).toBe(100500);
    expect(bodyParsed.text).toBe('ответ от осириса');
    expect(bodyParsed.parse_mode).toBe('Markdown');
  });
});
