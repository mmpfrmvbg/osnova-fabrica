import { describe, expect, it, vi } from 'vitest';
import { buildContext } from './context-builder';

vi.mock('./memory-engine', () => ({
  getLatestSummaryByUser: vi.fn(),
  getRecentMessages: vi.fn(),
}));

import * as memory from './memory-engine';

describe('buildContext', () => {
  it('includes summary and recent messages with roles', async () => {
    vi.mocked(memory.getLatestSummaryByUser).mockResolvedValueOnce({
      id: 1,
      userId: 'u1',
      scope: 'session',
      project: null,
      periodStart: null,
      periodEnd: null,
      text: 'Резюме пользователя',
      generatedAt: '2026-03-23T00:00:00.000Z',
    });
    vi.mocked(memory.getRecentMessages).mockResolvedValueOnce([
      {
        id: 2,
        userId: 'u1',
        chatId: 'c1',
        messageId: 'm2',
        role: 'assistant',
        text: 'Понял, помогу',
        timestamp: '2026-03-23T10:01:00.000Z',
        tags: [],
        projectHint: 'chat',
        sessionId: null,
        rawJson: null,
      },
      {
        id: 1,
        userId: 'u1',
        chatId: 'c1',
        messageId: 'm1',
        role: 'user',
        text: 'Мне нужен план',
        timestamp: '2026-03-23T10:00:00.000Z',
        tags: [],
        projectHint: 'chat',
        sessionId: null,
        rawJson: null,
      },
    ]);

    const result = await buildContext({
      id: 'm3',
      userId: 'u1',
      chatId: 'c1',
      text: 'Текущее сообщение',
      timestamp: '2026-03-23T10:02:00.000Z',
      isVoice: false,
    });

    expect(result).toContain('Сводка:');
    expect(result).toContain('Резюме пользователя');
    expect(result).toContain('Последние сообщения:');
    expect(result).toContain('user: Мне нужен план');
    expect(result).toContain('assistant: Понял, помогу');
  });

  it('omits summary block when no summary exists', async () => {
    vi.mocked(memory.getLatestSummaryByUser).mockResolvedValueOnce(null);
    vi.mocked(memory.getRecentMessages).mockResolvedValueOnce([]);

    const result = await buildContext({
      id: 'm1',
      userId: 'u1',
      chatId: 'c1',
      text: 'Привет',
      timestamp: '2026-03-23T10:00:00.000Z',
      isVoice: false,
    });

    expect(result).not.toContain('Сводка:');
    expect(result).toContain('Последние сообщения:');
  });
});
