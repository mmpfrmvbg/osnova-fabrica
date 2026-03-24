// apps/osiris/src/core/message-handler.ts
import type {
  CoreMemoryContent,
  IncomingMessage,
  JarvisMode,
  ProjectHint,
  SessionSummary,
  WorkingMemoryResult,
} from '../types';
import * as memory from './memory-engine';
import { call as callLlm } from './llm-router';
import type { ChatMessage, ToolCall, ToolDefinition } from './llm-router';
import { runSummarizerIfNeeded } from './memory-summarizer';
import { checkConnectivity } from './connectivity';
import { buildOsirisContext, setLastError } from './osiris-context';

export interface HandleResult {
  reply: string;
  mode: JarvisMode;
  trackedFacts: number;
  trackedTasks: number;
}

const SYSTEM_PROMPT =
  'Ты — Осирис, персональный ИИ-ассистент Создателя.\n' +
  '\n' +
  'Правила:\n' +
  '— Отвечай кратко и точно. Без лишних слов.\n' +
  '— Используй tools для памяти и задач — не держи данные в голове.\n' +
  '— Если не знаешь — скажи честно, не придумывай.\n' +
  '— Никаких многостраничных протоколов.\n';

const OSIRIS_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'remember_fact',
      description: 'Сохранить факт о пользователе или проекте в долгосрочную память',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Текст факта' },
          importance: { type: 'number', description: 'Важность 1-5, по умолчанию 3' },
          project: { type: 'string', description: 'Проект (опционально)' },
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recall_facts',
      description: 'Найти релевантные факты из памяти по запросу',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Поисковый запрос' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_task',
      description: 'Добавить задачу пользователю',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Название задачи' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'complete_task',
      description: 'Отметить задачу выполненной по её порядковому номеру из списка',
      parameters: {
        type: 'object',
        properties: {
          task_number: { type: 'number', description: 'Порядковый номер задачи из списка' },
        },
        required: ['task_number'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_tasks',
      description: 'Получить список открытых задач пользователя',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_core_memory',
      description: 'Обновить постоянную память о пользователе/проекте. Вызывать когда узнал что-то важное о создателе, его целях или проекте.',
      parameters: {
        type: 'object',
        properties: {
          patch: {
            type: 'object',
            description: 'Частичный объект CoreMemoryContent для merge. Пример: { "user": { "name": "Михаил" } }',
          },
        },
        required: ['patch'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'graph_remember',
      description:
        'Record a fact as a graph triple: subject → predicate → object. ' +
        'Use for relationships between people, projects, decisions, events.',
      parameters: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: 'Субъект (кто/что)' },
          predicate: { type: 'string', description: 'Предикат (отношение)' },
          object: { type: 'string', description: 'Объект (к кому/чему)' },
          metadata: { type: 'object', description: 'Доп. метаданные (опционально)' },
        },
        required: ['subject', 'predicate', 'object'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'graph_recall',
      description:
        'Search the knowledge graph by entity name or metadata. ' +
        'Returns related entities and their connections.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Поисковый запрос' },
        },
        required: ['query'],
      },
    },
  },
];

const PROJECT_HINTS: ProjectHint[] = [
  'osnova',
  'lang',
  'vm',
  'fabric',
  'assistant',
  'chat',
  'life',
  'unknown',
];

function toProjectHint(value: unknown): ProjectHint {
  if (typeof value === 'string' && PROJECT_HINTS.includes(value as ProjectHint)) {
    return value as ProjectHint;
  }
  return 'assistant';
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
  void checkConnectivity().then((result) => console.log('[osiris:connectivity]', result));
  const userId = message.userId;
  const workingMemory: WorkingMemoryResult = await memory.getWorkingMemory(userId, 20);

  // ── LLM path ────────────────────────────────────────────────────────────

  const openTasks = memory.getTasks(userId, 'open');
  const taskContext = openTasks.length > 0
    ? `\nОткрытые задачи:\n${formatTaskList(openTasks)}`
    : '\nОткрытых задач нет.';

  const [coreMemory, osirisCtx] = await Promise.all([
    memory.getCoreMemory(userId),
    buildOsirisContext(userId),
  ]);
  const previousSummaries: SessionSummary[] = workingMemory.summaries;
  const osirisCtxJson = JSON.stringify(osirisCtx, null, 2);

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `[CORE MEMORY]\n${JSON.stringify(coreMemory, null, 2)}`,
    },
    { role: 'system', content: SYSTEM_PROMPT + taskContext },
    {
      role: 'system',
      content:
        `SYSTEM CONTEXT (machine-generated, always up to date):\n<json>\n${osirisCtxJson}\n</json>`,
    },
    ...(previousSummaries.length > 0
      ? [{
        role: 'system' as const,
        content: `[PREVIOUS SESSIONS]\n${previousSummaries.map((s) => s.summary).join('\n---\n')}`,
      }]
      : []),
    ...workingMemory.messages,
    { role: 'user' as const, content: message.text },
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
  let trackedFacts = 0;
  let trackedTasks = 0;

  async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (name === 'remember_fact') {
      const content = typeof args.content === 'string' ? args.content.trim() : '';
      if (!content) return 'Ошибка: content обязателен.';
      const rawImportance = typeof args.importance === 'number' ? args.importance : 3;
      const importance = Math.max(1, Math.min(5, Number(rawImportance) || 3));
      const project = toProjectHint(args.project);
      await memory.saveFacts(
        [{ kind: 'user_profile', project, text: content, importance }],
        0,
        userId,
      );
      trackedFacts += 1;
      return 'Факт сохранён.';
    }
    if (name === 'recall_facts') {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) return 'Ошибка: query обязателен.';
      const facts = await memory.getRelevantFacts(query, 'unknown', 5);
      return JSON.stringify(facts);
    }
    if (name === 'add_task') {
      const title = typeof args.title === 'string' ? args.title.trim() : '';
      if (!title) return 'Ошибка: title обязателен.';
      const task = memory.addTask(userId, title);
      trackedTasks += 1;
      return `Задача добавлена: #${task.id}`;
    }
    if (name === 'complete_task') {
      const taskNumber = typeof args.task_number === 'number' ? args.task_number : Number.NaN;
      if (!Number.isFinite(taskNumber)) return 'Ошибка: task_number обязателен.';
      const tasks = memory.getTasks(userId, 'open');
      const task = tasks[Math.trunc(taskNumber) - 1];
      if (!task) return 'Задача не найдена.';
      memory.completeTask(userId, task.id);
      trackedTasks += 1;
      return 'Задача выполнена.';
    }
    if (name === 'get_tasks') {
      const tasks = memory.getTasks(userId, 'open');
      return formatTaskList(tasks);
    }
    if (name === 'update_core_memory') {
      const patch = typeof args.patch === 'object' && args.patch !== null
        ? args.patch as Partial<CoreMemoryContent>
        : {};
      await memory.updateCoreMemory(userId, patch);
      return 'Память обновлена.';
    }
    if (name === 'graph_remember') {
      const subject = typeof args.subject === 'string' ? args.subject.trim() : '';
      const predicate = typeof args.predicate === 'string' ? args.predicate.trim() : '';
      const object = typeof args.object === 'string' ? args.object.trim() : '';
      if (!subject || !predicate || !object) {
        return 'Ошибка: subject, predicate и object обязательны.';
      }
      const meta = typeof args.metadata === 'object' && args.metadata !== null
        ? args.metadata as Record<string, unknown>
        : {};
      const ids = await memory.graphRemember(userId, subject, predicate, object, meta);
      return `Граф обновлён: ${subject} → ${predicate} → ${object} (ids: ${ids.fromId},${ids.toId},${ids.relationId})`;
    }
    if (name === 'graph_recall') {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) return 'Ошибка: query обязателен.';
      const result = await memory.graphRecall(userId, query);
      return JSON.stringify(result);
    }
    return 'Инструмент не найден.';
  }

  try {
    const firstResult = await callLlm(messages, _mode, {
      tools: OSIRIS_TOOLS,
      tool_choice: 'auto',
    });

    const toolCalls = firstResult.toolCalls ?? [];
    if (toolCalls.length > 0) {
      const toolMessages: ChatMessage[] = [];
      for (const tc of toolCalls) {
        const toolName = tc.function?.name ?? '';
        let args: Record<string, unknown> = {};
        try {
          args = tc.function?.arguments
            ? JSON.parse(tc.function.arguments) as Record<string, unknown>
            : {};
        } catch {
          args = {};
        }
        const toolResult = await executeTool(toolName, args);
        toolMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: toolName,
          content: toolResult,
        });
      }

      const extendedMessages: ChatMessage[] = [
        ...messages,
        {
          role: 'assistant',
          content: firstResult.text ?? '',
          tool_calls: toolCalls as ToolCall[],
        },
        ...toolMessages,
      ];

      const secondResult = await callLlm(extendedMessages, _mode, { tool_choice: 'none' });
      reply = secondResult.text;
      setLastError(null);
      const msgCount = memory.countUserMessages(userId);
      if (msgCount > 0 && msgCount % 20 === 0) {
        setImmediate(() => { void memory.summarizeSession(userId); });
      }
    } else {
      reply = firstResult.text;
      setLastError(null);
      const msgCount = memory.countUserMessages(userId);
      if (msgCount > 0 && msgCount % 20 === 0) {
        setImmediate(() => { void memory.summarizeSession(userId); });
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[osiris:handler] LLM error:', msg);
    setLastError(msg);
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

  return { reply, mode: _mode, trackedFacts, trackedTasks };
}
