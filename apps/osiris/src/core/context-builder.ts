import type { IncomingMessage } from '../types';
import * as memory from './memory-engine';

function toRoleLabel(role: 'user' | 'assistant' | 'system'): string {
  if (role === 'assistant') return 'assistant';
  if (role === 'system') return 'system';
  return 'user';
}

export async function buildContext(
  message: IncomingMessage,
  recentLimit = 20,
): Promise<string> {
  const summary = await memory.getLatestSummaryByUser(message.userId);
  const recent = await memory.getRecentMessages(message.userId, recentLimit);
  const orderedRecent = recent.slice().reverse();

  const parts: string[] = [];
  if (summary?.text?.trim()) {
    parts.push('Сводка:\n' + summary.text.trim());
  }

  const recentLines = orderedRecent.map((m) => `${toRoleLabel(m.role)}: ${m.text}`);
  parts.push(
    'Последние сообщения:\n' +
      (recentLines.length > 0 ? recentLines.join('\n') : 'Нет сохраненных сообщений.'),
  );

  return parts.join('\n\n');
}
