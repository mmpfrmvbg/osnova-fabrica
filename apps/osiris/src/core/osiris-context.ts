// apps/osiris/src/core/osiris-context.ts
// Структурированное JSON-состояние для вшивания в system-промпт LLM.

import * as memory from './memory-engine';

export interface OsirisContext {
  self: {
    name: string;
    role: string;
    llm_provider: string;
    capabilities: string[];
    limitations: string[];
  };
  owner: {
    name: string;
    style: string;
  };
  state: {
    open_tasks: Array<{ id: number; title: string; created: string }>;
    recent_facts: Array<{ text: string; importance: number; saved: string }>;
    session_summary: string | null;
    last_error: string | null;
  };
}

/** Последняя ошибка LLM в текущей сессии процесса — обновляется из message-handler */
let _lastError: string | null = null;

export function setLastError(msg: string | null): void {
  _lastError = msg;
}

const CAPABILITIES = [
  'chat',
  'task_management',
  'memory_facts',
  'pipeline_build',
  'session_summary',
  'intent_detection',
];

const LIMITATIONS = (process.env['OSIRIS_LIMITATIONS'] ??
  'нет прямого доступа к файлам,нет терминала')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export async function buildOsirisContext(
  userId: string,
  lastError: string | null = _lastError,
): Promise<OsirisContext> {
  const rawTasks = memory.getTasks(userId, 'open');
  const open_tasks = rawTasks.map((t) => ({
    id: t.id,
    title: t.title,
    created: t.createdAt,
  }));

  // В memory-engine нет getRecentFacts(userId); getRelevantFacts(query, project) не привязан к user.
  const recent_facts: OsirisContext['state']['recent_facts'] = [];

  let session_summary: string | null = null;
  try {
    const s = await memory.getLatestSummaryByUser(userId);
    session_summary = s?.text?.trim() ?? null;
  } catch {
    session_summary = null;
  }

  return {
    self: {
      name: 'Осирис',
      role:
        process.env['OSIRIS_ROLE'] ??
        'персональный технический ассистент создателя Основа',
      llm_provider:
        process.env['OSNOVA_PROVIDER'] ??
        process.env['LLM_PROVIDER'] ??
        'unknown',
      capabilities: CAPABILITIES,
      limitations: LIMITATIONS,
    },
    owner: {
      name: process.env['OSIRIS_OWNER_NAME'] ?? 'Создатель',
      style:
        process.env['OSIRIS_OWNER_STYLE'] ?? 'кратко, по делу, можно спорить',
    },
    state: {
      open_tasks,
      recent_facts,
      session_summary,
      last_error: lastError,
    },
  };
}
