// apps/osiris/src/core/message-handler.ts
import type { IncomingMessage, JarvisMode } from '../types';
import * as memory from './memory-engine';
import { call as callLlm } from './llm-router';
import type { ChatMessage } from './llm-router';
import { extractAction } from '../osnova/action-extractor';
import { runOsirisPipeline } from '../osnova/client';
import { buildPipelineSpecContext } from '../osnova/context-builder';

export interface HandleResult {
  reply: string;
  mode: JarvisMode;
  trackedFacts: number;
  trackedTasks: number;
}

const SYSTEM_PROMPT =
  'Ты — Осирис, персональный AI-ассистент. Отвечай кратко и по делу. ' +
  'Помни контекст разговора.';

// ── Intent detection ───────────────────────────────────────────────────────

function detectIntent(
  text: string,
): { type: 'add_task'; title: string }
  | { type: 'list_tasks' }
  | { type: 'complete_task'; num: number }
  | null {
  let m: RegExpMatchArray | null;

  m = text.match(/добавь задачу\s+(.+)/i)
    ?? text.match(/нужно сделать\s+(.+)/i)
    ?? text.match(/запомни\s+(.+?)\s+нужно сделать/i);
  if (m) return { type: 'add_task', title: m[1].trim() };

  if (/покажи задачи|мои задачи|что нужно сделать/i.test(text)) {
    return { type: 'list_tasks' };
  }

  m = text.match(/выполнено\s+(\d+)/i)
    ?? text.match(/закрой задачу\s+(\d+)/i)
    ?? text.match(/сделал\s+(\d+)/i);
  if (m) return { type: 'complete_task', num: parseInt(m[1], 10) };

  return null;
}

function formatTaskList(tasks: memory.Task[]): string {
  if (tasks.length === 0) return 'Открытых задач нет.';
  return tasks.map((t, i) => `${i + 1}. [#${t.id}] ${t.title}`).join('\n');
}

// ── Суммаризация ───────────────────────────────────────────────────────────

async function maybeSummarize(userId: string): Promise<void> {
  try {
    const count = memory.countUserMessages(userId);
    if (count === 0 || count % 50 !== 0) return;

    const dialog = memory.getMessagesForSummary(userId, 50);
    const result = await callLlm([
      {
        role: 'system',
        content: 'Ты — помощник по суммаризации диалогов. Отвечай только текстом резюме.',
      },
      {
        role: 'user',
        content:
          `Сожми этот диалог в краткое резюме фактов о пользователе ` +
          `и ключевых темах разговора. Максимум 200 слов.\n\n${dialog}`,
      },
    ]);

    await memory.saveSummary({
      userId,
      scope: 'session',
      project: null,
      periodStart: null,
      periodEnd: null,
      text: result.text,
      generatedAt: new Date().toISOString(),
    });
    console.log(`[osiris:memory] summary saved for userId=${userId} at msg#${count}`);
  } catch (e) {
    console.error('[osiris:memory] summarize error:', e instanceof Error ? e.message : e);
  }
}

// ── Main handler ───────────────────────────────────────────────────────────

export async function handleMessage(
  message: IncomingMessage,
  _mode: JarvisMode = 'chat',
): Promise<HandleResult> {
  const userId = message.userId;
  const intent = detectIntent(message.text);

  // ── Structured intents (no LLM needed) ──────────────────────────────────
  if (intent?.type === 'add_task') {
    const task = memory.addTask(userId, intent.title);
    return {
      reply: `Задача добавлена: #${task.id} ${task.title}`,
      mode: _mode,
      trackedFacts: 0,
      trackedTasks: 1,
    };
  }

  if (intent?.type === 'list_tasks') {
    const tasks = memory.getTasks(userId, 'open');
    return {
      reply: formatTaskList(tasks),
      mode: _mode,
      trackedFacts: 0,
      trackedTasks: tasks.length,
    };
  }

  if (intent?.type === 'complete_task') {
    // num — это порядковый номер из списка, нужно найти реальный id
    const tasks = memory.getTasks(userId, 'open');
    const task = tasks[intent.num - 1];
    if (!task) {
      return {
        reply: `Задача #${intent.num} не найдена. Используй "мои задачи" чтобы увидеть список.`,
        mode: _mode,
        trackedFacts: 0,
        trackedTasks: 0,
      };
    }
    memory.completeTask(userId, task.id);
    return {
      reply: `Задача выполнена: ${task.title}`,
      mode: _mode,
      trackedFacts: 0,
      trackedTasks: 1,
    };
  }

  const action = extractAction(message.text);
  if (action.kind === 'build') {
    await memory.saveMessage({
      userId,
      chatId: message.chatId ?? userId,
      messageId: message.id,
      role: 'user',
      text: message.text,
      timestamp: message.timestamp ?? new Date().toISOString(),
      tags: ['pipeline'],
      projectHint: 'fabric',
      sessionId: null,
      rawJson: null,
    });

    try {
      const specContext = await buildPipelineSpecContext(message);
      console.log(`[osiris] pipeline requested: "${action.task}"`);
      console.log(
        `[osiris:pipeline] context prepared, userId=${userId}, history=${specContext.userHistory.length}`,
      );
      const pipelineResult = await runOsirisPipeline(action.task);
      const header = `Фабрика запущена, задача: "${action.task}".\n`;
      const reply = pipelineResult.status === 'success'
        ? `${header}Готово: ${pipelineResult.summary}`
        : `${header}Ошибка при генерации: ${pipelineResult.summary}`;

      await memory.saveMessage({
        userId,
        chatId: message.chatId ?? userId,
        messageId: null,
        role: 'assistant',
        text: reply,
        timestamp: new Date().toISOString(),
        tags: ['pipeline'],
        projectHint: 'fabric',
        sessionId: null,
        rawJson: JSON.stringify(pipelineResult.raw),
      });

      return {
        reply,
        mode: _mode,
        trackedFacts: 0,
        trackedTasks: 0,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[osiris:pipeline] failed in message-handler:', msg);
      const reply = `Фабрика запущена, задача: ${action.task}\n\nРезультат: Pipeline завершился с ошибкой: ${msg}.`;

      await memory.saveMessage({
        userId,
        chatId: message.chatId ?? userId,
        messageId: null,
        role: 'assistant',
        text: reply,
        timestamp: new Date().toISOString(),
        tags: ['pipeline'],
        projectHint: 'fabric',
        sessionId: null,
        rawJson: null,
      });

      return {
        reply,
        mode: _mode,
        trackedFacts: 0,
        trackedTasks: 0,
      };
    }
  }

  // ── LLM path ────────────────────────────────────────────────────────────

  // Контекст: summary + открытые задачи в системный промпт
  const summary = await memory.getLatestSummaryByUser(userId);
  const openTasks = memory.getTasks(userId, 'open');
  const taskContext = openTasks.length > 0
    ? `\nОткрытые задачи:\n${formatTaskList(openTasks)}`
    : '\nОткрытых задач нет.';

  const recent = await memory.getRecentMessages(userId, 20);
  const history: ChatMessage[] = recent
    .slice()
    .reverse()
    .map((r) => ({ role: r.role as ChatMessage['role'], content: r.text }));

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT + taskContext },
    ...(summary
      ? [{ role: 'system' as const, content: `Контекст предыдущих разговоров: ${summary.text}` }]
      : []),
    ...history,
    { role: 'user', content: message.text },
  ];

  await memory.saveMessage({
    userId,
    chatId: message.chatId ?? userId,
    messageId: message.id,
    role: 'user',
    text: message.text,
    timestamp: message.timestamp ?? new Date().toISOString(),
    tags: [],
    projectHint: 'chat',
    sessionId: null,
    rawJson: null,
  });

  let reply: string;
  try {
    const result = await callLlm(messages, _mode);
    reply = result.text;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[osiris:handler] LLM error:', msg);
    reply = `[ошибка LLM] ${msg}`;
  }

  await memory.saveMessage({
    userId,
    chatId: message.chatId ?? userId,
    messageId: null,
    role: 'assistant',
    text: reply,
    timestamp: new Date().toISOString(),
    tags: [],
    projectHint: 'chat',
    sessionId: null,
    rawJson: null,
  });

  setImmediate(() => { void maybeSummarize(userId); });

  return { reply, mode: _mode, trackedFacts: 0, trackedTasks: 0 };
}
