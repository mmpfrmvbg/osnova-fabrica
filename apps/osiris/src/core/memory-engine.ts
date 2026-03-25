// apps/osiris/src/core/memory-engine.ts
// Реальная реализация на better-sqlite3.

import { getDb, migrate } from '../db/migrations';
import type {
  MessageRecord,
  FactDraft,
  Fact,
  Summary,
  CoreMemoryContent,
  SessionSummary,
  WorkingMemoryResult,
  Entity,
  Relation,
  GraphRecallResult,
  ConsolidationResult,
  ThoughtRecord,
  TaskDraft,
  TaskWorkflowStatus,
  TaskEvent,
} from '../types';

export interface Task {
  id: number;
  userId: string;
  title: string;
  status: 'open' | 'done';
  workflowStatus: TaskWorkflowStatus;
  project: string;
  createdFrom: string | null;
  createdAt: string;
  updatedAt: string;
  doneAt: string | null;
  description: string;
  type: string;
  priority: number;
  size: 'xs' | 's' | 'm' | 'l' | 'xl';
  deadline: string | null;
  assignee: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
  recurrenceRule: Record<string, unknown> | null;
  recurrenceParentId: number | null;
  recurrenceRootId: number | null;
  recurrenceNextDueAt: string | null;
  recurrenceLastGeneratedAt: string | null;
}

let _initialized = false;
function ensureInit(): void {
  if (_initialized) return;
  migrate();
  _initialized = true;
}

function safeJsonParse<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function rowToTask(row: Record<string, unknown>): Task {
  const tags = safeJsonParse<string[]>(row['tags'], []);
  const metadata = safeJsonParse<Record<string, unknown>>(row['metadata'], {});
  const recurrenceRule = safeJsonParse<Record<string, unknown> | null>(
    row['recurrence_rule'],
    null,
  );

  const workflowStatusRaw = (row['workflow_status'] as TaskWorkflowStatus | undefined);
  const workflowStatus: TaskWorkflowStatus = workflowStatusRaw
    ?? ((row['status'] === 'done' ? 'done' : 'todo') as TaskWorkflowStatus);

  return {
    id: row['id'] as number,
    userId: row['user_id'] as string,
    title: row['title'] as string,
    status: (row['status'] as 'open' | 'done') ?? 'open',
    workflowStatus,
    project: (row['project'] as string | null) ?? 'general',
    createdFrom: (row['created_from'] as string | null) ?? null,
    createdAt: row['created_at'] as string,
    updatedAt: (row['updated_at'] as string | null) ?? (row['created_at'] as string),
    doneAt: (row['done_at'] as string | null) ?? null,
    description: (row['description'] as string | null) ?? '',
    type: (row['type'] as string | null) ?? 'task',
    priority: (row['priority'] as number | null) ?? 3,
    size: (row['size'] as Task['size'] | null) ?? 'm',
    deadline: (row['deadline'] as string | null) ?? null,
    assignee: (row['assignee'] as string | null) ?? null,
    tags,
    metadata,
    recurrenceRule,
    recurrenceParentId: (row['recurrence_parent_id'] as number | null) ?? null,
    recurrenceRootId: (row['recurrence_root_id'] as number | null) ?? null,
    recurrenceNextDueAt: (row['recurrence_next_due_at'] as string | null) ?? null,
    recurrenceLastGeneratedAt: (row['recurrence_last_generated_at'] as string | null) ?? null,
  };
}

function rowToTaskEvent(row: Record<string, unknown>): TaskEvent {
  const payload = safeJsonParse<Record<string, unknown>>(
    row['payload'],
    {},
  );
  return {
    id: row['id'] as number,
    userId: row['user_id'] as string,
    taskId: row['task_id'] as number,
    eventType: row['event_type'] as TaskEvent['eventType'],
    actor: (row['actor'] as string) ?? 'system',
    note: (row['note'] as string | null) ?? null,
    payload,
    createdAt: row['created_at'] as string,
  };
}

function rowToMessageRecord(row: Record<string, unknown>): MessageRecord {
  return {
    id: row['id'] as number,
    userId: row['user_id'] as string,
    chatId: row['chat_id'] as string,
    messageId: (row['message_id'] as string | null) ?? null,
    role: row['role'] as 'user' | 'assistant' | 'system',
    text: row['text'] as string,
    timestamp: row['timestamp'] as string,
    tags: JSON.parse((row['tags'] as string | null) ?? '[]') as string[],
    projectHint: (row['project_hint'] as MessageRecord['projectHint']) ?? 'unknown',
    sessionId: (row['session_id'] as string | null) ?? null,
    rawJson: (row['raw_json'] as string | null) ?? null,
  };
}

function rowToFact(row: Record<string, unknown>): Fact {
  return {
    id: row['id'] as number,
    kind: row['kind'] as string,
    project: (row['project'] as Fact['project']) ?? null,
    text: row['text'] as string,
    importance: (row['importance'] as number) ?? 3,
    sourceMessageId: (row['source_message_id'] as number | null) ?? undefined,
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
  };
}

function rowToSummary(row: Record<string, unknown>): Summary {
  return {
    id: row['id'] as number,
    userId: row['user_id'] as string,
    scope: row['scope'] as string,
    project: (row['project'] as Summary['project']) ?? null,
    periodStart: (row['period_start'] as string | null) ?? null,
    periodEnd: (row['period_end'] as string | null) ?? null,
    text: row['text'] as string,
    generatedAt: row['generated_at'] as string,
  };
}

function rowToSessionSummary(row: Record<string, unknown>): SessionSummary {
  return {
    id: row['id'] as number,
    userId: row['user_id'] as string,
    summary: row['summary'] as string,
    messageCount: (row['message_count'] as number) ?? 0,
    createdAt: row['created_at'] as string,
  };
}

function rowToEntity(row: Record<string, unknown>): Entity {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(row['metadata'] as string) as Record<string, unknown>;
  } catch {
    metadata = {};
  }
  return {
    id: row['id'] as number,
    userId: row['user_id'] as string,
    name: row['name'] as string,
    type: row['type'] as string,
    metadata,
    createdAt: row['created_at'] as string,
  };
}

function rowToRelation(row: Record<string, unknown>): Relation {
  return {
    id: row['id'] as number,
    userId: row['user_id'] as string,
    fromId: row['from_id'] as number,
    toId: row['to_id'] as number,
    predicate: row['predicate'] as string,
    weight: row['weight'] as number,
    createdAt: row['created_at'] as string,
  };
}

function rowToThought(row: Record<string, unknown>): ThoughtRecord {
  return {
    id: row['id'] as number,
    userId: row['user_id'] as string,
    messageId: (row['message_id'] as number | null) ?? null,
    content: row['content'] as string,
    createdAt: row['created_at'] as string,
  };
}

function upsertEntity(
  db: ReturnType<typeof getDb>,
  userId: string,
  name: string,
  type: string,
  metadata: Record<string, unknown>,
): number {
  const now = new Date().toISOString();
  // INSERT OR IGNORE если ещё нет
  db.prepare(`
    INSERT OR IGNORE INTO entities (user_id, name, type, metadata, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, name, type, JSON.stringify(metadata), now);
  // SELECT id
  const row = db
    .prepare('SELECT id FROM entities WHERE user_id = ? AND name = ?')
    .get(userId, name) as { id: number };
  return row.id;
}

export async function saveSessionSummary(
  userId: string,
  summary: string,
  messageCount: number,
): Promise<void> {
  ensureInit();
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO session_summaries (user_id, summary, message_count, created_at)
    VALUES (?, ?, ?, ?)
  `).run(userId, summary, messageCount, now);
}

export async function getSessionSummaries(
  userId: string,
  limit = 3,
): Promise<SessionSummary[]> {
  ensureInit();
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT * FROM session_summaries
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(userId, limit) as Record<string, unknown>[];
  return rows.map(rowToSessionSummary);
}

export async function getWorkingMemory(
  userId: string,
  softLimit = 20,
): Promise<WorkingMemoryResult> {
  ensureInit();
  const recent = await getRecentMessages(userId, softLimit);
  // getRecentMessages возвращает DESC, переворачиваем в хронологический порядок
  const ordered = recent.slice().reverse();
  const messages = ordered.map((m) => ({
    role: m.role as 'user' | 'assistant' | 'system',
    content: m.text,
  }));
  const summaries = await getSessionSummaries(userId, 3);
  return { messages, summaries };
}

export async function summarizeSession(userId: string): Promise<void> {
  // Импорт здесь чтобы избежать циклической зависимости на верхнем уровне
  const { call: callLlm } = await import('./llm-router');
  const recent = await getRecentMessages(userId, 20);
  if (recent.length === 0) return;
  const ordered = recent.slice().reverse();
  const dialogue = ordered
    .map((m) => `${m.role === 'user' ? 'Пользователь' : 'Осирис'}: ${m.text}`)
    .join('\n');
  const prompt = [
    {
      role: 'system' as const,
      content:
        'Ты — система сжатия диалога. Сожми следующий диалог в 3-4 предложения. ' +
        'Сохрани ключевые факты, решения и контекст. Только текст резюме, без вступлений.',
    },
    { role: 'user' as const, content: dialogue },
  ];
  try {
    const result = await callLlm(prompt, 'chat');
    const summary = result.text.trim();
    if (summary) {
      await saveSessionSummary(userId, summary, recent.length);
    }
  } catch (e) {
    console.error('[osiris:summarizeSession] failed:', e instanceof Error ? e.message : String(e));
  }
}

export async function graphRemember(
  userId: string,
  subject: string,
  predicate: string,
  object: string,
  metadata: Record<string, unknown> = {},
): Promise<{ fromId: number; toId: number; relationId: number }> {
  ensureInit();
  const db = getDb();
  const now = new Date().toISOString();
  const fromId = upsertEntity(db, userId, subject, 'concept', metadata);
  const toId = upsertEntity(db, userId, object, 'concept', {});
  const result = db.prepare(`
    INSERT INTO relations (user_id, from_id, to_id, predicate, weight, created_at)
    VALUES (?, ?, ?, ?, 1.0, ?)
  `).run(userId, fromId, toId, predicate, now);
  return { fromId, toId, relationId: result.lastInsertRowid as number };
}

export async function graphRecall(
  userId: string,
  query: string,
): Promise<GraphRecallResult> {
  ensureInit();
  const db = getDb();
  const pattern = `%${query}%`;
  // Найти сущности по имени или metadata
  const entityRows = db.prepare(`
    SELECT * FROM entities
    WHERE user_id = ? AND (name LIKE ? OR metadata LIKE ?)
    ORDER BY created_at DESC
    LIMIT 20
  `).all(userId, pattern, pattern) as Record<string, unknown>[];
  const entities = entityRows.map(rowToEntity);
  if (entities.length === 0) return { entities: [], relations: [] };

  const ids = entities.map((e) => e.id);
  // Подтянуть relations в обоих направлениях
  const placeholders = ids.map(() => '?').join(', ');
  const relRows = db.prepare(`
    SELECT * FROM relations
    WHERE user_id = ? AND (from_id IN (${placeholders}) OR to_id IN (${placeholders}))
    ORDER BY created_at DESC
    LIMIT 50
  `).all(userId, ...ids, ...ids) as Record<string, unknown>[];
  const relations = relRows.map(rowToRelation);
  return { entities, relations };
}

export async function getRecentEntities(userId: string, limit = 10): Promise<Entity[]> {
  ensureInit();
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM entities
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(userId, limit) as Record<string, unknown>[];
  return rows.map(rowToEntity);
}

export async function consolidateFacts(userId: string): Promise<ConsolidationResult> {
  ensureInit();
  const db = getDb();

  // 1. Факты старше 24 часов
  const oldRows = db.prepare(`
    SELECT id, text FROM facts
    WHERE user_id = ?
      AND created_at < datetime('now', '-1 day')
    ORDER BY created_at ASC
  `).all(userId) as Array<{ id: number; text: string }>;

  if (oldRows.length < 5) {
    return { skipped: true, factsRemoved: 0, coreUpdated: false, summary: 'too few facts' };
  }

  const factsBefore = oldRows.length;

  // 2. Найти дубли (нормализованный текст)
  const seen = new Map<string, number>(); // normalized → первый id
  const dupeIds: number[] = [];
  for (const row of oldRows) {
    const key = row.text.trim().toLowerCase();
    if (seen.has(key)) {
      dupeIds.push(row.id);
    } else {
      seen.set(key, row.id);
    }
  }
  // 3. Удалить дубли сразу
  if (dupeIds.length > 0) {
    const placeholders = dupeIds.map(() => '?').join(', ');
    db.prepare(`DELETE FROM facts WHERE id IN (${placeholders})`).run(...dupeIds);
  }

  // 4. Оставшиеся факты (до 50) для LLM-анализа
  const remaining = db.prepare(`
    SELECT id, text FROM facts
    WHERE user_id = ?
      AND created_at < datetime('now', '-1 day')
    ORDER BY created_at ASC
    LIMIT 50
  `).all(userId) as Array<{ id: number; text: string }>;

  let llmRemovedIds: number[] = [];
  let coreUpdated = false;
  let llmSummary = '';

  if (remaining.length > 0) {
    // 5. LLM-анализ
    const { call: callLlm } = await import('./llm-router');
    const factsList = remaining
      .map((f) => `[${f.id}] ${f.text}`)
      .join('\n');
    const prompt = [
      {
        role: 'system' as const,
        content:
          'Ты — система консолидации памяти. Проанализируй список фактов о пользователе. ' +
          'Найди дубли, устаревшие или малоинформативные факты для удаления. ' +
          'Верни ТОЛЬКО валидный JSON (без markdown, без пояснений) в формате:\n' +
          '{"keep":[ids],"remove":[ids],"core_memory_update":{},"summary":"..."}\n' +
          'Если нечего удалять — remove:[], core_memory_update:{}',
      },
      { role: 'user' as const, content: `Факты:\n${factsList}` },
    ];

    try {
      const result = await callLlm(prompt, 'chat');
      // Извлечь JSON из ответа (LLM иногда добавляет текст вокруг)
      const jsonMatch = result.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as {
          keep?: number[];
          remove?: number[];
          core_memory_update?: Record<string, unknown>;
          summary?: string;
        };
        llmRemovedIds = Array.isArray(parsed.remove) ? parsed.remove.map(Number) : [];
        llmSummary = typeof parsed.summary === 'string' ? parsed.summary : '';
        // 6. Удалить по рекомендации LLM
        if (llmRemovedIds.length > 0) {
          const ph = llmRemovedIds.map(() => '?').join(', ');
          db.prepare(`DELETE FROM facts WHERE id IN (${ph}) AND user_id = ?`)
            .run(...llmRemovedIds, userId);
        }
        // 7. Обновить core memory если patch не пустой
        const patch = parsed.core_memory_update ?? {};
        if (Object.keys(patch).length > 0) {
          await updateCoreMemory(userId, patch as Parameters<typeof updateCoreMemory>[1]);
          coreUpdated = true;
        }
      }
    } catch (e) {
      console.error('[osiris:consolidate] LLM step failed:',
        e instanceof Error ? e.message : String(e));
      // Продолжаем без LLM — дубли уже удалены
    }
  }

  const factsAfter = db.prepare(
    'SELECT COUNT(*) as cnt FROM facts WHERE user_id = ?',
  ).get(userId) as { cnt: number };

  const allRemovedIds = [...dupeIds, ...llmRemovedIds];
  const now = new Date().toISOString();

  // 8. Записать в лог
  db.prepare(`
    INSERT INTO consolidation_log
      (user_id, ran_at, facts_before, facts_after, removed_ids, summary)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    now,
    factsBefore,
    factsAfter.cnt,
    JSON.stringify(allRemovedIds),
    llmSummary,
  );

  return {
    factsRemoved: allRemovedIds.length,
    coreUpdated,
    summary: llmSummary || `removed ${allRemovedIds.length} duplicates`,
  };
}

export function getDistinctUserIds(): string[] {
  ensureInit();
  const db = getDb();
  const rows = db.prepare(`
    SELECT DISTINCT user_id FROM facts
    UNION
    SELECT DISTINCT user_id FROM tasks
    UNION
    SELECT DISTINCT user_id FROM messages
  `).all() as Array<{ user_id: string }>;
  return rows.map((r) => r.user_id);
}

export async function saveThought(
  userId: string,
  content: string,
  messageId?: number,
): Promise<number> {
  ensureInit();
  const db = getDb();
  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO thoughts (user_id, message_id, content, created_at)
    VALUES (?, ?, ?, ?)
  `).run(userId, messageId ?? null, content, now);
  return result.lastInsertRowid as number;
}

export async function getRecentThoughts(
  userId: string,
  limit = 5,
): Promise<ThoughtRecord[]> {
  ensureInit();
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM thoughts
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(userId, limit) as Record<string, unknown>[];
  return rows.map(rowToThought);
}

function touchFacts(rows: Record<string, unknown>[]): void {
  if (rows.length === 0) return;
  const ids = rows.map((r) => r['id'] as number);
  const placeholders = ids.map(() => '?').join(',');
  const now = new Date().toISOString();
  getDb()
    .prepare(`UPDATE facts SET last_accessed_at = ? WHERE id IN (${placeholders})`)
    .run(now, ...ids);
}

const DEFAULT_CORE_MEMORY: CoreMemoryContent = {
  user: { name: null, role: null, style: null, current_focus: null },
  project: { name: null, stack: null, state: null },
  meta: { interaction_count: 0, last_session: null },
};

export async function saveMessage(record: Omit<MessageRecord, 'id'>): Promise<number> {
  ensureInit();
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO messages
      (user_id, chat_id, message_id, role, text, timestamp,
       tags, project_hint, session_id, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    record.userId,
    record.chatId,
    record.messageId ?? null,
    record.role,
    record.text,
    record.timestamp,
    JSON.stringify(record.tags ?? []),
    record.projectHint ?? 'unknown',
    record.sessionId ?? null,
    record.rawJson ?? null,
  );
  return Number(result.lastInsertRowid);
}

export async function saveFacts(
  facts: FactDraft[],
  messageId = 0,
  userId = 'system',
): Promise<Fact[]> {
  ensureInit();
  const db = getDb();
  const insertFact = db.prepare(`
    INSERT INTO facts
      (user_id, kind, project, text, source_message_id,
       importance, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertFts = db.prepare(`
    INSERT INTO facts_fts(rowid, text, project) VALUES (?, ?, ?)
  `);

  const now = new Date().toISOString();
  const saved: Fact[] = [];

  const insertAll = db.transaction(() => {
    for (const f of facts) {
      const sourceId = (f.sourceMessageId ?? messageId) || null;
      const r = insertFact.run(
        userId,
        f.kind,
        f.project ?? null,
        f.text,
        sourceId,
        f.importance,
        now,
        now,
      );
      const id = Number(r.lastInsertRowid);
      insertFts.run(id, f.text, f.project ?? '');
      saved.push({ ...f, id, createdAt: now, updatedAt: now });
    }
  });
  insertAll();
  return saved;
}

export async function getRelevantFacts(
  query: string,
  project: string,
  limit = 10,
): Promise<Fact[]> {
  ensureInit();
  const db = getDb();
  const like = `%${query}%`;
  let rows: Record<string, unknown>[] = [];
  try {
    if (project && project !== 'unknown') {
      rows = db
        .prepare(
          `
        SELECT f.* FROM facts f
        JOIN facts_fts ON facts_fts.rowid = f.id
        WHERE facts_fts MATCH ?
          AND f.project = ?
        ORDER BY rank
        LIMIT ?
      `,
        )
        .all(query, project, limit) as Record<string, unknown>[];
    } else {
      rows = db
        .prepare(
          `
        SELECT f.* FROM facts f
        JOIN facts_fts ON facts_fts.rowid = f.id
        WHERE facts_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `,
        )
        .all(query, limit) as Record<string, unknown>[];
    }
  } catch {
    if (project && project !== 'unknown') {
      rows = db
        .prepare(
          `
      SELECT * FROM facts
      WHERE text LIKE ?
        AND project = ?
      ORDER BY importance DESC
      LIMIT ?
    `,
        )
        .all(like, project, limit) as Record<string, unknown>[];
    } else {
      rows = db
        .prepare(
          `
      SELECT * FROM facts
      WHERE text LIKE ?
      ORDER BY importance DESC
      LIMIT ?
    `,
        )
        .all(like, limit) as Record<string, unknown>[];
    }
  }
  touchFacts(rows);
  return rows.map(rowToFact);
}

export async function getRecentMessages(
  userId: string,
  limit = 20,
): Promise<MessageRecord[]> {
  ensureInit();
  const db = getDb();
  const rows = db
    .prepare(
      `
    SELECT * FROM messages
    WHERE user_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `,
    )
    .all(userId, limit) as Record<string, unknown>[];
  return rows.map(rowToMessageRecord);
}

export async function saveSummary(summary: Omit<Summary, 'id'>): Promise<number> {
  ensureInit();
  const db = getDb();
  const result = db
    .prepare(
      `
    INSERT INTO summaries
      (user_id, scope, project, period_start, period_end,
       text, generated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      summary.userId,
      summary.scope,
      summary.project ?? null,
      summary.periodStart ?? null,
      summary.periodEnd ?? null,
      summary.text,
      summary.generatedAt,
    );
  return Number(result.lastInsertRowid);
}

export async function getLatestSummary(project: string, scope: string): Promise<Summary | null> {
  ensureInit();
  const db = getDb();
  const row = db
    .prepare(
      `
    SELECT * FROM summaries
    WHERE project = ? AND scope = ?
    ORDER BY generated_at DESC
    LIMIT 1
  `,
    )
    .get(project, scope) as Record<string, unknown> | undefined;
  return row ? rowToSummary(row) : null;
}

export function countUserMessages(userId: string): number {
  ensureInit();
  const db = getDb();
  const row = db
    .prepare('SELECT COUNT(*) as cnt FROM messages WHERE user_id = ?')
    .get(userId) as { cnt: number };
  return row.cnt;
}

export function getMessagesForSummary(userId: string, limit = 50): string {
  ensureInit();
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT role, text FROM messages
       WHERE user_id = ?
       ORDER BY timestamp DESC
       LIMIT ?`,
    )
    .all(userId, limit) as { role: string; text: string }[];
  return rows
    .reverse()
    .map((r) => `${r.role === 'user' ? 'Пользователь' : 'Осирис'}: ${r.text}`)
    .join('\n');
}

export async function getLatestSummaryByUser(
  userId: string,
): Promise<Summary | null> {
  ensureInit();
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM summaries
       WHERE user_id = ?
       ORDER BY generated_at DESC
       LIMIT 1`,
    )
    .get(userId) as Record<string, unknown> | undefined;
  return row ? rowToSummary(row) : null;
}

export async function getCoreMemory(userId: string): Promise<CoreMemoryContent> {
  ensureInit();
  const db = getDb();
  const row = db
    .prepare('SELECT content FROM core_memory WHERE user_id = ?')
    .get(userId) as { content: string } | undefined;
  if (!row) return structuredClone(DEFAULT_CORE_MEMORY);
  try {
    return JSON.parse(row.content) as CoreMemoryContent;
  } catch {
    return structuredClone(DEFAULT_CORE_MEMORY);
  }
}

export async function getCoreMemoryWithVersion(
  userId: string,
): Promise<{ content: CoreMemoryContent; version: number }> {
  ensureInit();
  const db = getDb();
  const row = db
    .prepare('SELECT content, version FROM core_memory WHERE user_id = ?')
    .get(userId) as { content: string; version: number } | undefined;
  if (!row) return { content: structuredClone(DEFAULT_CORE_MEMORY), version: 0 };
  try {
    return { content: JSON.parse(row.content) as CoreMemoryContent, version: row.version };
  } catch {
    return { content: structuredClone(DEFAULT_CORE_MEMORY), version: 0 };
  }
}

function deepMerge<T extends Record<string, unknown>>(
  target: T,
  patch: Partial<T>,
): T {
  const result = { ...target };
  for (const key of Object.keys(patch) as (keyof T)[]) {
    const patchVal = patch[key];
    const targetVal = result[key];
    if (
      patchVal !== null &&
      typeof patchVal === 'object' &&
      !Array.isArray(patchVal) &&
      typeof targetVal === 'object' &&
      targetVal !== null &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        patchVal as Record<string, unknown>,
      ) as T[keyof T];
    } else {
      result[key] = patchVal as T[keyof T];
    }
  }
  return result;
}

export async function updateCoreMemory(
  userId: string,
  patch: Partial<CoreMemoryContent>,
): Promise<void> {
  ensureInit();
  const db = getDb();
  const current = await getCoreMemory(userId);
  const merged = deepMerge(
    current as unknown as Record<string, unknown>,
    patch as Record<string, unknown>,
  ) as unknown as CoreMemoryContent;
  const now = new Date().toISOString();

  const existing = db
    .prepare('SELECT version FROM core_memory WHERE user_id = ?')
    .get(userId) as { version: number } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE core_memory
      SET content = ?, updated_at = ?, version = version + 1
      WHERE user_id = ?
    `).run(JSON.stringify(merged), now, userId);
  } else {
    db.prepare(`
      INSERT INTO core_memory (user_id, content, updated_at, version)
      VALUES (?, ?, ?, 1)
    `).run(userId, JSON.stringify(merged), now);
  }
}

export function addTask(
  userId: string,
  title: string,
  project = 'general',
  createdFrom: string | null = null,
): Task {
  ensureInit();
  const db = getDb();
  const now = new Date().toISOString();
  const r = db
    .prepare(
      `INSERT INTO tasks
        (user_id, title, status, workflow_status, project, created_from, created_at, updated_at,
         description, type, priority, size, tags, metadata, recurrence_rule, recurrence_parent_id,
         recurrence_root_id, recurrence_next_due_at, recurrence_last_generated_at, deadline, assignee)
       VALUES (?, ?, 'open', 'todo', ?, ?, ?, ?, '', 'task', 3, 'm', '[]', '{}', NULL, NULL,
               NULL, NULL, NULL, NULL, NULL)`,
    )
    .run(
      userId,
      title,
      project,
      createdFrom,
      now,
      now,
    );

  // Re-read to return a fully-populated Task object
  const row = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(
    Number(r.lastInsertRowid),
    userId,
  ) as Record<string, unknown>;
  return rowToTask(row);
}

export function getTasks(userId: string, status: 'open' | 'done' = 'open'): Task[] {
  ensureInit();
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM tasks
       WHERE user_id = ?
         AND status = ?
       ORDER BY created_at ASC`,
    )
    .all(userId, status) as Record<string, unknown>[];
  return rows.map(rowToTask);
}

export function completeTask(userId: string, id: number): void {
  ensureInit();
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE tasks SET status = 'done', workflow_status = 'done', done_at = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`,
  ).run(now, now, id, userId);
}

export function updateTask(
  userId: string,
  taskId: number,
  patch: { status?: 'open' | 'done'; title?: string },
): boolean {
  ensureInit();
  const db = getDb();
  const setParts: string[] = [];
  const values: unknown[] = [];
  if (patch.status !== undefined) {
    setParts.push('status = ?');
    values.push(patch.status);
    if (patch.status === 'done') {
      setParts.push('done_at = ?');
      setParts.push('workflow_status = ?');
      values.push('done');
      values.push(new Date().toISOString());
    } else {
      setParts.push('done_at = NULL');
      setParts.push('workflow_status = ?');
      values.push('todo');
    }
    setParts.push('updated_at = ?');
    values.push(new Date().toISOString());
  }
  if (patch.title !== undefined) {
    setParts.push('title = ?');
    values.push(patch.title);
  }
  if (setParts.length === 0) return false;
  values.push(taskId, userId);
  const result = db
    .prepare(
      `UPDATE tasks SET ${setParts.join(', ')} WHERE id = ? AND user_id = ?`,
    )
    .run(...values);
  return result.changes > 0;
}

function toLegacyStatus(workflowStatus: TaskWorkflowStatus): 'open' | 'done' {
  return workflowStatus === 'done' || workflowStatus === 'cancelled' ? 'done' : 'open';
}

function getBlockingDependencyIds(userId: string, taskId: number): number[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT dependency_id
       FROM task_dependencies
       WHERE user_id = ?
         AND task_id = ?
         AND kind = 'blocking'`,
    )
    .all(userId, taskId) as Array<{ dependency_id: number }>;
  return rows.map((r) => r.dependency_id);
}

function areBlockingDependenciesDone(userId: string, taskId: number): boolean {
  const depIds = getBlockingDependencyIds(userId, taskId);
  if (depIds.length === 0) return true;
  const db = getDb();
  const placeholders = depIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT id, workflow_status
       FROM tasks
       WHERE user_id = ?
         AND id IN (${placeholders})`,
    )
    .all(userId, ...depIds) as Array<{ id: number; workflow_status: TaskWorkflowStatus }>;
  const byId = new Map<number, TaskWorkflowStatus>();
  for (const r of rows) byId.set(r.id, r.workflow_status);
  return depIds.every((id) => byId.get(id) === 'done');
}

function insertTaskEvent(params: {
  userId: string;
  taskId: number;
  eventType: TaskEvent['eventType'];
  actor?: string;
  note?: string | null;
  payload?: Record<string, unknown>;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO task_events (user_id, task_id, event_type, actor, note, payload)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    params.userId,
    params.taskId,
    params.eventType,
    params.actor ?? 'system',
    params.note ?? null,
    JSON.stringify(params.payload ?? {}),
  );
}

function computeRecurrenceNext(rule: Record<string, unknown>, fromIso: string): string | null {
  const kind = typeof rule['kind'] === 'string' ? rule['kind'] : '';
  const fromTs = Date.parse(fromIso);
  if (!Number.isFinite(fromTs)) return null;

  const addDays = (days: number) => new Date(fromTs + days * 24 * 60 * 60 * 1000).toISOString();

  if (kind === 'daily') {
    const intervalDays = Number.isFinite(rule['intervalDays'])
      ? (rule['intervalDays'] as number)
      : 1;
    return addDays(intervalDays);
  }

  if (kind === 'weekly') {
    const intervalWeeks = Number.isFinite(rule['intervalWeeks'])
      ? (rule['intervalWeeks'] as number)
      : 1;
    return addDays(intervalWeeks * 7);
  }

  return null;
}

function transitionError(note: string): never {
  // HTTP layer will convert this into 400/409; keep as Error for now.
  throw new Error(note);
}

export function getTask(userId: string, taskId: number): Task | null {
  ensureInit();
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?')
    .get(taskId, userId) as Record<string, unknown> | undefined;
  return row ? rowToTask(row) : null;
}

export function createTask(
  userId: string,
  draft: TaskDraft,
  createdFrom: string | null = null,
  actor = 'user',
): Task {
  ensureInit();
  const db = getDb();
  const now = new Date().toISOString();

  const workflowStatus: TaskWorkflowStatus = draft.status ?? 'todo';
  const legacyStatus = toLegacyStatus(workflowStatus);

  const r = db.prepare(
    `INSERT INTO tasks
      (user_id, title, status, workflow_status, description, type, priority, size,
       project, created_from, created_at, updated_at, deadline, assignee,
       tags, metadata, recurrence_rule, recurrence_parent_id, recurrence_root_id,
       recurrence_next_due_at, recurrence_last_generated_at)
     VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    userId,
    draft.title,
    legacyStatus,
    workflowStatus,
    draft.description ?? '',
    draft.type ?? 'task',
    draft.priority ?? 3,
    draft.size ?? 'm',
    draft.project ?? 'general',
    createdFrom,
    now,
    now,
    draft.deadline ?? null,
    draft.assignee ?? null,
    JSON.stringify(draft.tags ?? []),
    JSON.stringify(draft.metadata ?? {}),
    draft.recurrence_rule ? JSON.stringify(draft.recurrence_rule) : null,
    null,
    null,
    null,
    null,
  );

  const taskId = Number(r.lastInsertRowid);
  insertTaskEvent({
    userId,
    taskId,
    eventType: 'created',
    actor,
    note: null,
    payload: { draft },
  });
  const created = getTask(userId, taskId);
  if (!created) transitionError('task creation failed');
  return created;
}

export function getBlockingDependencies(userId: string, taskId: number): Array<Pick<Task, 'id' | 'title' | 'workflowStatus' | 'project'>> {
  ensureInit();
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT d.*
       FROM tasks d
       JOIN task_dependencies td
         ON td.dependency_id = d.id
       WHERE td.user_id = ?
         AND td.task_id = ?
         AND td.kind = 'blocking'`,
    )
    .all(userId, taskId) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r['id'] as number,
    title: r['title'] as string,
    workflowStatus: (r['workflow_status'] as TaskWorkflowStatus | null) ?? 'todo',
    project: (r['project'] as string | null) ?? 'general',
  }));
}

export function listTasks(
  userId: string,
  filters: {
    status?: TaskWorkflowStatus | 'active';
    project?: string | null;
    search?: string | null;
    sort?: 'created_at_asc' | 'created_at_desc' | 'priority_desc';
    limit?: number;
    offset?: number;
  } = {},
): Task[] {
  ensureInit();
  const db = getDb();
  const limit = Number.isFinite(filters.limit) && (filters.limit as number) > 0 ? Math.min(filters.limit as number, 200) : 50;
  const offset = Number.isFinite(filters.offset) && (filters.offset as number) >= 0 ? filters.offset as number : 0;

  const statusFilter = filters.status ?? 'active';
  let where = 'WHERE user_id = ?';
  const values: unknown[] = [userId];

  if (statusFilter !== 'active') {
    where += ' AND workflow_status = ?';
    values.push(statusFilter);
  } else {
    where += ' AND workflow_status NOT IN (\'done\', \'cancelled\')';
  }

  if (filters.project) {
    where += ' AND project = ?';
    values.push(filters.project);
  }

  if (filters.search && filters.search.trim()) {
    where += ' AND (title LIKE ? OR description LIKE ?)';
    const q = `%${filters.search.trim()}%`;
    values.push(q, q);
  }

  const sort = filters.sort ?? 'priority_desc';
  const orderBy = (() => {
    switch (sort) {
      case 'created_at_asc': return 'created_at ASC';
      case 'created_at_desc': return 'created_at DESC';
      case 'priority_desc': return 'priority DESC, created_at ASC';
      default: return 'priority DESC, created_at ASC';
    }
  })();

  const rows = db
    .prepare(
      `SELECT * FROM tasks
       ${where}
       ORDER BY ${orderBy}
       LIMIT ?
       OFFSET ?`,
    )
    .all(...values, limit, offset) as Record<string, unknown>[];

  return rows.map(rowToTask);
}

export function updateTaskFields(
  userId: string,
  taskId: number,
  patch: Partial<Pick<TaskDraft, 'title' | 'description' | 'project' | 'priority' | 'size' | 'deadline' | 'assignee' | 'type' | 'recurrence_rule' | 'tags' | 'metadata'>> & {
    title?: string;
  } & { workflow_status?: TaskWorkflowStatus } = {},
  actor = 'user',
): boolean {
  ensureInit();
  const db = getDb();

  const setParts: string[] = [];
  const values: unknown[] = [];

  if (patch.title !== undefined) {
    setParts.push('title = ?');
    values.push(patch.title);
  }
  if (patch.description !== undefined) {
    setParts.push('description = ?');
    values.push(patch.description);
  }
  if (patch.type !== undefined) {
    setParts.push('type = ?');
    values.push(patch.type);
  }
  if (patch.project !== undefined) {
    setParts.push('project = ?');
    values.push(patch.project);
  }
  if (patch.priority !== undefined) {
    setParts.push('priority = ?');
    values.push(patch.priority);
  }
  if (patch.size !== undefined) {
    setParts.push('size = ?');
    values.push(patch.size);
  }
  if (patch.deadline !== undefined) {
    setParts.push('deadline = ?');
    values.push(patch.deadline);
  }
  if (patch.assignee !== undefined) {
    setParts.push('assignee = ?');
    values.push(patch.assignee);
  }
  if (patch.tags !== undefined) {
    setParts.push('tags = ?');
    values.push(JSON.stringify(patch.tags ?? []));
  }
  if (patch.metadata !== undefined) {
    setParts.push('metadata = ?');
    values.push(JSON.stringify(patch.metadata ?? {}));
  }
  if (patch.recurrence_rule !== undefined) {
    setParts.push('recurrence_rule = ?');
    values.push(patch.recurrence_rule ? JSON.stringify(patch.recurrence_rule) : null);
  }

  if (setParts.length === 0) return false;

  values.push(new Date().toISOString(), taskId, userId);
  const result = db
    .prepare(
      `UPDATE tasks SET ${setParts.join(', ')}, updated_at = ? WHERE id = ? AND user_id = ?`,
    )
    .run(...values);

  insertTaskEvent({
    userId,
    taskId,
    eventType: 'field_update',
    actor,
    note: null,
    payload: { patch: patch },
  });

  return result.changes > 0;
}

export function transitionTask(
  userId: string,
  taskId: number,
  nextStatus: TaskWorkflowStatus,
  opts: { note?: string; actor?: string } = {},
): Task {
  ensureInit();
  const actor = opts.actor ?? 'user';
  const task = getTask(userId, taskId);
  if (!task) transitionError('task not found');

  const fromStatus = task.workflowStatus;
  if (fromStatus === 'done' || fromStatus === 'cancelled') {
    transitionError(`invalid transition from ${fromStatus}`);
  }

  const depsReady = areBlockingDependenciesDone(userId, taskId);
  let actualStatus: TaskWorkflowStatus = nextStatus;
  if (!depsReady) {
    if (nextStatus === 'in_progress') {
      transitionError('dependencies_not_done');
    }
    if (nextStatus === 'todo' || nextStatus === 'blocked') {
      actualStatus = 'blocked';
    }
  }

  // Minimal state machine validation
  const allowed = (() => {
    if (fromStatus === 'inbox') return actualStatus === 'todo' || actualStatus === 'cancelled';
    if (fromStatus === 'todo') return ['in_progress', 'blocked', 'done', 'cancelled'].includes(actualStatus);
    if (fromStatus === 'in_progress') return ['done', 'blocked', 'cancelled'].includes(actualStatus);
    if (fromStatus === 'blocked') return ['todo', 'in_progress', 'cancelled', 'blocked'].includes(actualStatus);
    return false;
  })();
  if (!allowed) transitionError(`invalid transition from ${fromStatus} to ${actualStatus}`);

  const db = getDb();
  const now = new Date().toISOString();
  const legacyStatus = toLegacyStatus(actualStatus);

  // If transitioning to done/cancelled, set done_at; legacy API uses done_at.
  const doneAt = (actualStatus === 'done' || actualStatus === 'cancelled') ? now : null;

  db.prepare(
    `UPDATE tasks
       SET workflow_status = ?, status = ?, done_at = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`,
  ).run(actualStatus, legacyStatus, doneAt, now, taskId, userId);

  insertTaskEvent({
    userId,
    taskId,
    eventType: actualStatus === 'done' ? 'transition' : 'transition',
    actor,
    note: opts.note ?? null,
    payload: { from: fromStatus, to: actualStatus, requested: nextStatus },
  });

  // Auto-unblock tasks depending on this one.
  if (actualStatus === 'done') {
    const affected = db
      .prepare(
        `SELECT DISTINCT task_id
         FROM task_dependencies
         WHERE user_id = ? AND dependency_id = ? AND kind = 'blocking'`,
      )
      .all(userId, taskId) as Array<{ task_id: number }>;

    for (const a of affected) {
      const tid = a.task_id;
      const t = getTask(userId, tid);
      if (!t) continue;
      if (t.workflowStatus !== 'blocked') continue;
      if (!areBlockingDependenciesDone(userId, tid)) continue;
      db.prepare(
        `UPDATE tasks
           SET workflow_status = 'todo', status = 'open', updated_at = ?
         WHERE id = ? AND user_id = ?`,
      ).run(now, tid, userId);
      insertTaskEvent({
        userId,
        taskId: tid,
        eventType: 'transition',
        actor: 'system',
        note: 'unblocked',
        payload: { reason: 'dependency_done', dependencyTaskId: taskId },
      });
    }
  }

  // Recurrence generation
  if (actualStatus === 'done') {
    const refreshed = getTask(userId, taskId);
    if (refreshed?.recurrenceRule) {
      const nextDueAt = computeRecurrenceNext(refreshed.recurrenceRule, now);
      if (nextDueAt) {
        const rootId = refreshed.recurrenceRootId ?? refreshed.id;

        const r = db.prepare(
          `INSERT INTO tasks
            (user_id, title, status, workflow_status, description, type, priority, size,
             project, created_from, created_at, updated_at,
             recurrence_rule, recurrence_parent_id, recurrence_root_id,
             deadline, recurrence_next_due_at, recurrence_last_generated_at, metadata, tags, assignee)
           VALUES
            (?, ?, 'open', 'todo', ?, ?, ?, ?, ?, 'recurrence', ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
        ).run(
          userId,
          refreshed.title,
          refreshed.description,
          refreshed.type,
          refreshed.priority,
          refreshed.size,
          refreshed.project,
          now,
          now,
          JSON.stringify(refreshed.recurrenceRule),
          refreshed.id,
          rootId,
          nextDueAt,
          JSON.stringify(refreshed.metadata ?? {}),
          JSON.stringify(refreshed.tags ?? []),
          refreshed.assignee,
        );

        // mark parent recurrence generation
        db.prepare(
          `UPDATE tasks
             SET recurrence_next_due_at = ?, recurrence_last_generated_at = ?, updated_at = ?
           WHERE id = ? AND user_id = ?`,
        ).run(nextDueAt, now, now, taskId, userId);

        insertTaskEvent({
          userId,
          taskId,
          eventType: 'recurrence_generated',
          actor: 'system',
          note: 'created next recurring task',
          payload: { nextDueAt, newTaskId: Number(r.lastInsertRowid) },
        });
      }
    }
  }

  const updated = getTask(userId, taskId);
  if (!updated) transitionError('task disappeared');
  return updated;
}

export function generateRecurrenceNextIfNeeded(
  userId: string,
  taskId: number,
  opts: { actor?: string } = {},
): number | null {
  ensureInit();
  const actor = opts.actor ?? 'system';
  const task = getTask(userId, taskId);
  if (!task) return null;
  if (task.workflowStatus !== 'done') return null;
  if (!task.recurrenceRule) return null;
  if (task.recurrenceLastGeneratedAt) return null;

  const fromIso = task.doneAt ?? task.updatedAt;
  const nextDueAt = computeRecurrenceNext(task.recurrenceRule, fromIso);
  if (!nextDueAt) return null;

  const db = getDb();
  const now = new Date().toISOString();
  const rootId = task.recurrenceRootId ?? task.id;

  const r = db.prepare(
    `INSERT INTO tasks
      (user_id, title, status, workflow_status, description, type, priority, size,
       project, created_from, created_at, updated_at,
       recurrence_rule, recurrence_parent_id, recurrence_root_id,
       deadline, recurrence_next_due_at, recurrence_last_generated_at, metadata, tags, assignee)
     VALUES
      (?, ?, 'open', 'todo', ?, ?, ?, ?, ?, 'recurrence', ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
  ).run(
    userId,
    task.title,
    task.description,
    task.type,
    task.priority,
    task.size,
    task.project,
    now,
    now,
    JSON.stringify(task.recurrenceRule),
    task.id,
    rootId,
    nextDueAt,
    JSON.stringify(task.metadata ?? {}),
    JSON.stringify(task.tags ?? []),
    task.assignee,
  );

  const newTaskId = Number(r.lastInsertRowid);

  db.prepare(
    `UPDATE tasks
       SET recurrence_next_due_at = ?, recurrence_last_generated_at = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`,
  ).run(nextDueAt, now, now, taskId, userId);

  insertTaskEvent({
    userId,
    taskId,
    eventType: 'recurrence_generated',
    actor,
    note: 'created next recurring task',
    payload: { nextDueAt, newTaskId },
  });

  insertTaskEvent({
    userId,
    taskId: newTaskId,
    eventType: 'created',
    actor,
    note: 'created by recurrence',
    payload: { recurrenceRootId: rootId, fromTaskId: taskId, nextDueAt },
  });

  return newTaskId;
}

export function linkDependency(
  userId: string,
  taskId: number,
  dependencyId: number,
): boolean {
  ensureInit();
  if (taskId === dependencyId) return false;
  const db = getDb();
  const task = getTask(userId, taskId);
  const dep = getTask(userId, dependencyId);
  if (!task || !dep) return false;

  try {
    db.prepare(
      `INSERT INTO task_dependencies (user_id, task_id, dependency_id, kind)
       VALUES (?, ?, ?, 'blocking')`,
    ).run(userId, taskId, dependencyId);
  } catch {
    return false; // already linked or constraint
  }

  insertTaskEvent({
    userId,
    taskId,
    eventType: 'dependency_link',
    actor: 'user',
    note: null,
    payload: { dependencyId },
  });
  return true;
}

export function unlinkDependency(
  userId: string,
  taskId: number,
  dependencyId: number,
): boolean {
  ensureInit();
  const db = getDb();
  const res = db.prepare(
    `DELETE FROM task_dependencies
     WHERE user_id = ? AND task_id = ? AND dependency_id = ? AND kind = 'blocking'`,
  ).run(userId, taskId, dependencyId);
  if (res.changes <= 0) return false;

  insertTaskEvent({
    userId,
    taskId,
    eventType: 'dependency_unlink',
    actor: 'user',
    note: null,
    payload: { dependencyId },
  });
  return true;
}

export function getTaskHistory(
  userId: string,
  taskId: number,
  limit = 50,
): TaskEvent[] {
  ensureInit();
  const db = getDb();
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 50;
  const rows = db
    .prepare(
      `SELECT * FROM task_events
       WHERE user_id = ? AND task_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(userId, taskId, safeLimit) as Record<string, unknown>[];
  return rows.map(rowToTaskEvent);
}

export function mergeTasks(
  userId: string,
  taskIds: number[],
  survivorId?: number,
  opts: { note?: string; actor?: string } = {},
): Task {
  ensureInit();
  const actor = opts.actor ?? 'user';
  const uniq = Array.from(new Set(taskIds.map((n) => Math.trunc(n)).filter((n) => Number.isFinite(n) && n > 0)));
  if (uniq.length === 0) transitionError('no tasks to merge');

  const sid = survivorId && uniq.includes(survivorId) ? survivorId : uniq[0];
  const others = uniq.filter((id) => id !== sid);

  const survivor = getTask(userId, sid);
  if (!survivor) transitionError('survivor task not found');

  const db = getDb();
  const now = new Date().toISOString();

  // Rewire dependencies so references to cancelled tasks point to survivor.
  if (others.length > 0) {
    const ph = others.map(() => '?').join(', ');
    db.prepare(
      `UPDATE task_dependencies
         SET task_id = ?
       WHERE user_id = ?
         AND task_id IN (${ph})`,
    ).run(sid, userId, ...others);

    db.prepare(
      `UPDATE task_dependencies
         SET dependency_id = ?
       WHERE user_id = ?
         AND dependency_id IN (${ph})
         AND task_id <> dependency_id`,
    ).run(sid, userId, ...others);
  }

  // Cancel other tasks
  for (const oid of others) {
    try {
      transitionTask(userId, oid, 'cancelled', { actor: 'system', note: `merged into #${sid}` });
    } catch {
      // ignore one failing cancel; best effort
    }
  }

  // Append merge note
  const note = opts.note ?? `Merged ${others.length} tasks into #${sid}`;
  const newDescription = survivor.description
    ? `${survivor.description}\n\n[merge] ${note}`
    : `[merge] ${note}`;

  db.prepare('UPDATE tasks SET description = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(newDescription, now, sid, userId);

  insertTaskEvent({
    userId,
    taskId: sid,
    eventType: 'merged',
    actor,
    note: note,
    payload: { survivorId: sid, mergedIds: others },
  });

  const updated = getTask(userId, sid);
  if (!updated) transitionError('merged task not found');
  return updated;
}

export function deleteTask(userId: string, id: number): void {
  ensureInit();
  const db = getDb();
  db.prepare(`DELETE FROM tasks WHERE id = ? AND user_id = ?`).run(id, userId);
}

export function deleteFact(userId: string, factId: number): boolean {
  ensureInit();
  const db = getDb();
  const result = db
    .prepare('DELETE FROM facts WHERE id = ? AND user_id = ?')
    .run(factId, userId);
  return result.changes > 0;
}

export async function getRecentFacts(
  userId: string,
  limit = 5,
): Promise<Fact[]> {
  ensureInit();
  const db = getDb();
  // Сначала ищем факты конкретного пользователя
  const rows = db
    .prepare(
      `SELECT * FROM facts
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(userId, limit) as Record<string, unknown>[];
  if (rows.length > 0) touchFacts(rows);
  // Если у пользователя нет фактов — возвращаем последние глобальные
  if (rows.length === 0) {
    const globalRows = db
      .prepare(
        `SELECT * FROM facts
         ORDER BY importance DESC, created_at DESC
         LIMIT ?`,
      )
      .all(limit) as Record<string, unknown>[];
    return globalRows.map(rowToFact);
  }
  return rows.map(rowToFact);
}
