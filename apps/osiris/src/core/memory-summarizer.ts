import * as memory from './memory-engine';
import { call } from './llm-router';
import type { ChatMessage } from './llm-router';

export const SUMMARY_THRESHOLD = 20;
export const SUMMARY_WINDOW = 50;

function toDialogLine(role: 'user' | 'assistant' | 'system', text: string): string {
  if (role === 'assistant') return `assistant: ${text}`;
  if (role === 'system') return `system: ${text}`;
  return `user: ${text}`;
}

export async function runSummarizerIfNeeded(userId: string): Promise<void> {
  try {
    const count = memory.countUserMessages(userId);
    if (count <= SUMMARY_THRESHOLD) return;

    const recent = await memory.getRecentMessages(userId, SUMMARY_WINDOW);
    if (recent.length === 0) return;
    const dialog = recent
      .slice()
      .reverse()
      .map((m) => toDialogLine(m.role, m.text))
      .join('\n');

    const prompt: ChatMessage[] = [
      {
        role: 'system',
        content:
          'Ты — помощник по суммаризации диалогов. Сделай краткое резюме фактов о пользователе и ключевых тем.',
      },
      {
        role: 'user',
        content: `Сделай краткое резюме следующего диалога (максимум 200 слов):\n\n${dialog}`,
      },
    ];

    const result = await call(prompt);
    await memory.saveSummary({
      userId,
      scope: 'session',
      project: null,
      periodStart: null,
      periodEnd: null,
      text: result.text,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error(
      '[osiris:memory-summarizer] failed:',
      e instanceof Error ? e.message : String(e),
    );
  }
}
