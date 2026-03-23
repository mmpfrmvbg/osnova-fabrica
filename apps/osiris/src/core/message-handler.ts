// apps/osiris/src/core/message-handler.ts
import type { IncomingMessage, JarvisMode } from '../types';
import * as memory from './memory-engine';
import { call as callLlm } from './llm-router';
import type { ChatMessage } from './llm-router';
import { runOsirisPipeline } from '../osnova/client';
import { buildPipelineSpecContext } from '../osnova/context-builder';
import { buildContext } from './context-builder';
import { extractActions } from './action-extractor';
import { runSummarizerIfNeeded } from './memory-summarizer';

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

  const llmContext = await buildContext(message);
  const extracted = await extractActions(message.text, llmContext);

  if (extracted.intent === 'task' && extracted.tasks.length > 0) {
    const created = extracted.tasks.map((title) => memory.addTask(userId, title));
    return {
      reply: `Добавил задачи:\n${created.map((t) => `#${t.id} ${t.title}`).join('\n')}`,
      mode: _mode,
      trackedFacts: 0,
      trackedTasks: created.length,
    };
  }

  if (extracted.intent === 'fact' && extracted.facts.length > 0) {
    const saved = await memory.saveFacts(
      extracted.facts.map((text) => ({
        kind: 'user_profile',
        project: 'assistant',
        text,
        importance: 3,
      })),
    );
    return {
      reply: `Запомнил ${saved.length} факт(ов).`,
      mode: _mode,
      trackedFacts: saved.length,
      trackedTasks: 0,
    };
  }

  if (extracted.intent === 'build') {
    const buildTask = extracted.tasks[0] ?? message.text;
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
    setImmediate(() => { void runSummarizerIfNeeded(userId); });

    try {
      const specContext = await buildPipelineSpecContext(message);
      console.log(`[osiris] pipeline requested: "${buildTask}"`);
      console.log(
        `[osiris:pipeline] context prepared, userId=${userId}, history=${specContext.userHistory.length}`,
      );
      const pipelineResult = await runOsirisPipeline(buildTask);
      const header = `Фабрика запущена, задача: "${buildTask}".\n`;
      const reply = pipelineResult.status === 'ok'
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
      const reply = `Фабрика запущена, задача: ${buildTask}\n\nРезультат: Pipeline завершился с ошибкой: ${msg}.`;

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

  const openTasks = memory.getTasks(userId, 'open');
  const taskContext = openTasks.length > 0
    ? `\nОткрытые задачи:\n${formatTaskList(openTasks)}`
    : '\nОткрытых задач нет.';

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT + taskContext },
    { role: 'system', content: `Контекст диалога:\n${llmContext}` },
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
  setImmediate(() => { void runSummarizerIfNeeded(userId); });

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

  return { reply, mode: _mode, trackedFacts: 0, trackedTasks: 0 };
}
