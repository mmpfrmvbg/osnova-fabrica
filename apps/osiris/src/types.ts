// apps/jarvis/src/types.ts
// Все интерфейсы Jarvis Core

export type JarvisMode = 'chat' | 'task' | 'plan' | 'project';

export type ProjectHint =
  | 'osnova'
  | 'lang'
  | 'vm'
  | 'fabric'
  | 'assistant'
  | 'chat'
  | 'life'
  | 'general'
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
  status: TaskWorkflowStatus;
  deadline?: string; // ISO 8601 date or datetime
  assignee?: string;
  recurrence_rule?: Record<string, unknown> | null; // JSON rule; interpreted by server
  tags?: string[];
  metadata?: Record<string, unknown> | null;
}

export type TaskWorkflowStatus =
  | 'inbox'
  | 'todo'
  | 'in_progress'
  | 'blocked'
  | 'done'
  | 'cancelled';

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

export interface CoreMemoryUser {
  name: string | null;
  role: string | null;
  style: string | null;
  current_focus: string | null;
}

export interface CoreMemoryProject {
  name: string | null;
  stack: string | null;
  state: string | null;
  description?: string | null;
  horizon?: string | null;
  repo?: string | null;
}

export interface CoreMemoryMeta {
  interaction_count: number;
  last_session: string | null;
  [key: string]: string | number | null | undefined;
}

export interface CoreMemoryContent {
  user: CoreMemoryUser;
  project: CoreMemoryProject;
  meta: CoreMemoryMeta;
}

export interface SessionSummary {
  id: number;
  userId: string;
  summary: string;
  messageCount: number;
  createdAt: string;
}

export interface WorkingMemoryResult {
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  summaries: SessionSummary[];
}

export interface Entity {
  id: number;
  userId: string;
  name: string;
  type: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface Relation {
  id: number;
  userId: string;
  fromId: number;
  toId: number;
  predicate: string;
  weight: number;
  createdAt: string;
}

export interface GraphRecallResult {
  entities: Entity[];
  relations: Relation[];
}

export interface ConsolidationResult {
  skipped?: boolean;
  factsRemoved: number;
  coreUpdated: boolean;
  summary: string;
}

export interface ThoughtRecord {
  id: number;
  userId: string;
  messageId: number | null;
  content: string;
  createdAt: string;
}

export interface JobStep {
  iteration: number;
  thought: string;
  action: string;
  args: Record<string, unknown>;
  observation: string;
  timestamp: string;
}

export interface AutonomousJob {
  id: string;
  userId: string;
  goal: string;
  status: 'pending' | 'running' | 'done' | 'stalled' | 'error';
  steps: JobStep[];
  result: string | null;
  error: string | null;
  iteration: number;
  maxIterations: number;
  createdAt: string;
  updatedAt: string;
}

export interface JarvisContext {
  systemPrompt: string;
  conversationHistory: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  memoryFacts: Fact[];
  summarySnippet?: string;
  taskSnapshot?: TaskDraft[];
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    text?: string;
    chat: { id: number };
    from: { id: number };
  };
}

export type TaskEventType =
  | 'created'
  | 'transition'
  | 'field_update'
  | 'dependency_link'
  | 'dependency_unlink'
  | 'recurrence_generated'
  | 'merged'
  | 'cancelled';

export interface TaskEvent {
  id: number;
  userId: string;
  taskId: number;
  eventType: TaskEventType;
  actor: string;
  note: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}
