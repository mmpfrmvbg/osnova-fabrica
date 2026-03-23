import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runSummarizerIfNeeded, SUMMARY_THRESHOLD } from './memory-summarizer';

vi.mock('./memory-engine', () => ({
  countUserMessages: vi.fn(),
  getRecentMessages: vi.fn(),
  saveSummary: vi.fn(),
}));

vi.mock('./llm-router', () => ({
  call: vi.fn(),
}));

import * as memory from './memory-engine';
import { call } from './llm-router';

describe('runSummarizerIfNeeded', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not call LLM when threshold is not reached', async () => {
    vi.mocked(memory.countUserMessages).mockReturnValueOnce(SUMMARY_THRESHOLD);

    await runSummarizerIfNeeded('user-1');

    expect(call).not.toHaveBeenCalled();
    expect(memory.saveSummary).not.toHaveBeenCalled();
  });

  it('calls LLM and saves summary when threshold is reached', async () => {
    vi.mocked(memory.countUserMessages).mockReturnValueOnce(SUMMARY_THRESHOLD + 1);
    vi.mocked(memory.getRecentMessages).mockResolvedValueOnce([
      {
        id: 1,
        userId: 'user-1',
        chatId: 'chat-1',
        messageId: 'm1',
        role: 'user',
        text: 'Привет, запомни мои предпочтения.',
        timestamp: '2026-03-23T00:00:00.000Z',
        tags: [],
        projectHint: 'chat',
        sessionId: null,
        rawJson: null,
      },
      {
        id: 2,
        userId: 'user-1',
        chatId: 'chat-1',
        messageId: 'm2',
        role: 'assistant',
        text: 'Хорошо, я запомнил.',
        timestamp: '2026-03-23T00:01:00.000Z',
        tags: [],
        projectHint: 'chat',
        sessionId: null,
        rawJson: null,
      },
    ]);
    vi.mocked(call).mockResolvedValueOnce({
      text: 'Резюме диалога',
      tokensUsed: { prompt: 1, completion: 1 },
      model: 'test',
    });

    await runSummarizerIfNeeded('user-1');

    expect(call).toHaveBeenCalledTimes(1);
    expect(memory.saveSummary).toHaveBeenCalledTimes(1);
    expect(memory.saveSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        text: 'Резюме диалога',
      }),
    );
  });

  it('handles LLM errors without throwing', async () => {
    vi.mocked(memory.countUserMessages).mockReturnValueOnce(SUMMARY_THRESHOLD + 1);
    vi.mocked(memory.getRecentMessages).mockResolvedValueOnce([
      {
        id: 1,
        userId: 'user-1',
        chatId: 'chat-1',
        messageId: 'm1',
        role: 'user',
        text: 'Привет',
        timestamp: '2026-03-23T00:00:00.000Z',
        tags: [],
        projectHint: 'chat',
        sessionId: null,
        rawJson: null,
      },
    ]);
    vi.mocked(call).mockRejectedValueOnce(new Error('llm failed'));

    await expect(runSummarizerIfNeeded('user-1')).resolves.toBeUndefined();
    expect(memory.saveSummary).not.toHaveBeenCalled();
  });
});
