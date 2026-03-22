// apps/jarvis/src/core/memory-engine.ts
// Заглушка: сохранение сообщений, фактов и их извлечение.

import type { MessageRecord, FactDraft, Fact } from '../types';

/**
 * Сохраняет MessageRecord в БД.
 * TODO: подключить better-sqlite3 через db/migrations.ts
 */
export async function saveMessage(_record: Omit<MessageRecord, 'id'>): Promise<number> {
  // stub: возвращает id=0
  return 0;
}

/**
 * Сохраняет массив фактов.
 */
export async function saveFacts(_facts: FactDraft[]): Promise<Fact[]> {
  // stub
  return [];
}

/**
 * Возвращает факты релевантные к запросу.
 * TODO: FTS5 по facts_fts + фильтр по project
 */
export async function getRelevantFacts(
  _userId: string,
  _query: string,
  _project?: string,
  _limit = 10,
): Promise<Fact[]> {
  // stub
  return [];
}
