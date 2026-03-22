// apps/jarvis/src/types.ts
// Все интерфейсы Jarvis Core

export type JarvisMode = 'chat' | 'task' | 'plan' | 'project';

export type ProjectHint =
  | 'osnova'
  | 'lang'
  | 'vm'
  | 'fabric'
  | 'assistant'
  | 'life'
  | 'unknown';

export interface IncomingMessage {
  id: string;
  userId: string;
  chatId: string;
  text: string;
  timestamp: string; // ISO 8601
  isVoice: boolean;
}

export interface MessageRecord {
  id: number;
  userId: string;
  chatId: string;
  messageId: string | null;
  role: 'user' | 'assistant' | 'system';
  text: string;
  timestamp: string;
  tags: string[]; // хранится как JSON в SQLite
  projectHint: ProjectHint;
  sessionId: string | null;
  rawJson: string | null;
}

export interface FactDraft {
  kind: string;
  project: ProjectHint | null;
  text: string;
  importance: number; // 1–5
  sourceMessageId?: number;
}

export interface Fact extends FactDraft {
  id: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDraft {
  title: string;
  description?: string;
  project: ProjectHint;
  type: string; // 'задача' | 'баг' | 'идея' | ...
  priority: number; // 1–5
  size: 'xs' | 's' | 'm' | 'l' | 'xl';
  status: string; // 'inbox' | 'todo' | 'in_progress' | 'done'
  deadline?: string; // ISO 8601 date
}

export interface Summary {
  id: number;
  userId: string;
  scope: string;
  project: ProjectHint | null;
  periodStart: string | null;
  periodEnd: string | null;
  text: string;
  generatedAt: string;
}

export interface JarvisContext {
  systemPrompt: string;
  conversationHistory: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  memoryFacts: Fact[];
  summarySnippet?: string;
  taskSnapshot?: TaskDraft[];
}
