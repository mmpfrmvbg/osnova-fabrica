import * as memory from '../core/memory-engine';
import type { IncomingMessage } from '../types';

export interface PipelineSpecContext {
  task: string;
  userHistory: string[];
  activeTasks?: string[];
}

export async function buildPipelineSpecContext(
  incoming: IncomingMessage,
): Promise<PipelineSpecContext> {
  const task = incoming.text.trim();
  const recent = await memory.getRecentMessages(incoming.userId, 10);
  const userHistory = recent
    .slice()
    .reverse()
    .map((m) => `${m.role}: ${m.text}`);
  const activeTasks = memory
    .getTasks(incoming.userId, 'open')
    .map((t) => `#${t.id} ${t.title}`);

  return {
    task,
    userHistory,
    activeTasks,
  };
}

