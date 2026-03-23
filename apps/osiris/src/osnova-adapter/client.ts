// apps/jarvis/src/osnova-adapter/client.ts
// Заглушка: клиент к фабрике ОС-НОВА (runPipeline).
// В реальности вызывает src/pipeline/orchestrator.ts через IPC или HTTP.

import type { TaskDraft } from '../types';

export interface OsnovaTaskResult {
  taskId: string;
  status: 'queued' | 'running' | 'success' | 'failure';
  traceId?: string;
}

/**
 * Создаёт задачу в фабрике (запускает pipeline).
 */
export async function createTask(_draft: TaskDraft): Promise<OsnovaTaskResult> {
  // stub
  return { taskId: 'stub-task-id', status: 'queued' };
}

/**
 * Обновляет статус задачи.
 */
export async function updateTask(
  _taskId: string,
  _status: OsnovaTaskResult['status'],
): Promise<void> {
  // stub
}

/**
 * Возвращает список задач по проекту.
 */
export async function getTasks(_project: string): Promise<OsnovaTaskResult[]> {
  // stub
  return [];
}
