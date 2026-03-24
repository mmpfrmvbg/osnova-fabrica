// apps/osiris/src/core/memory-engine.ts
// Реальная реализация на better-sqlite3.

import { getDb, migrate } from '../db/migrations';
import type { MessageRecord, FactDraft, Fact, Summary, CoreMemoryContent } from '../types';

export interface Task {
  id: number;
  userId: string;
  title: string;
  status: 'open' | 'done';
  createdAt: string;
  doneAt: string | null;
}

let _initialized = false;
function ensureInit(): void {
  if (_initialized) return;
  migrate();
  _initialized = true;
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

export function addTask(userId: string, title: string): Task {
  ensureInit();
  const db = getDb();
  const now = new Date().toISOString();
  const r = db
    .prepare(
      `INSERT INTO tasks (user_id, title, status, created_at)
       VALUES (?, ?, 'open', ?)`,
    )
    .run(userId, title, now);
  return { id: Number(r.lastInsertRowid), userId, title, status: 'open', createdAt: now, doneAt: null };
}

export function getTasks(userId: string, status: 'open' | 'done' = 'open'): Task[] {
  ensureInit();
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM tasks WHERE user_id = ? AND status = ?
       ORDER BY created_at ASC`,
    )
    .all(userId, status) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r['id'] as number,
    userId: r['user_id'] as string,
    title: r['title'] as string,
    status: r['status'] as 'open' | 'done',
    createdAt: r['created_at'] as string,
    doneAt: (r['done_at'] as string | null) ?? null,
  }));
}

export function completeTask(userId: string, id: number): void {
  ensureInit();
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE tasks SET status = 'done', done_at = ?
     WHERE id = ? AND user_id = ?`,
  ).run(now, id, userId);
}

export function deleteTask(userId: string, id: number): void {
  ensureInit();
  const db = getDb();
  db.prepare(`DELETE FROM tasks WHERE id = ? AND user_id = ?`).run(id, userId);
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
