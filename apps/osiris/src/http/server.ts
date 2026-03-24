// apps/osiris/src/http/server.ts
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import archiver from 'archiver';
import express, { type Express, type Request, type Response } from 'express';
import { compileSource } from '../../../../src/compiler/compiler';
import * as storage from '../../../../src/runtime/storage';
import { VM, type StackValue } from '../../../../src/runtime/vm/interpreter';
import type { OsVbcModule } from '../../../../src/runtime/vm/bytecode';
import { callHttpApiStream } from '../core/llm-router';
import { handleMessage } from '../core/message-handler';
import { startConsolidationCron, runConsolidationNow } from '../core/consolidation-runner';
import * as memory from '../core/memory-engine';
import { buildOsirisContext } from '../core/osiris-context';
import { runOsirisPipeline } from '../osnova/client';
import { startTunnel } from './tunnel';
import { buildPipelineCompletedEvent, logPipelineCompletedEvent } from './pipeline-observability';

const OSIRIS_VERSION = '0.1.0';
const CHAT_WEB_WWW = path.resolve(__dirname, '..', '..', '..', '..', 'apps', 'chat-web', 'www');

interface ChatRequestBody {
  userId?: unknown;
  message?: unknown;
}

interface PipelineRequestBody {
  task?: unknown;
}

interface CreateTaskBody {
  title?: unknown;
  description?: unknown;
  priority?: unknown;
}

interface PatchTaskBody {
  status?: unknown;
  priority?: unknown;
}

interface TaskDto {
  key: string;
  title: string;
  description: string;
  priority: string;
  status: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

const TASK_MANAGER_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'apps', 'task-manager');
const TASK_STORAGE_ROOT = path.join(os.tmpdir(), 'osnova-storage');
const TASK_APP_ID = 'osnova.task_manager';

let taskCoreModuleCache: OsVbcModule | null = null;

function normalizePriority(input?: string): string {
  const raw = (input ?? 'средний').trim().toLowerCase();
  if (raw === 'high') return 'высокий';
  if (raw === 'medium') return 'средний';
  if (raw === 'low') return 'низкий';
  if (raw === 'высокий' || raw === 'средний' || raw === 'низкий') return raw;
  return 'средний';
}

function normalizeStatus(input?: string): string {
  const raw = (input ?? '').trim().toLowerCase();
  if (raw === 'done') return 'выполнена';
  if (raw === 'active') return 'активна';
  if (raw === 'выполнена' || raw === 'активна') return raw;
  return input?.trim() ?? '';
}

function parseTaskValue(key: string, raw: string): TaskDto {
  const parts = String(raw ?? '').split('|');
  return {
    key,
    title: parts[0] ?? '',
    description: parts[1] ?? '',
    status: parts[2] ?? '',
    priority: parts[3] ?? '',
  };
}

async function getTaskCoreModule(): Promise<OsVbcModule> {
  if (taskCoreModuleCache) return taskCoreModuleCache;
  const sourcePath = path.join(TASK_MANAGER_DIR, 'tasks.core.osnova');
  const sourceText = await import('fs/promises').then((m) => m.readFile(sourcePath, 'utf-8'));
  const compiled = compileSource(sourceText, { baseDir: TASK_MANAGER_DIR });
  if (!compiled.module || compiled.compilerSuccess !== true) {
    throw new Error('failed to compile apps/task-manager/tasks.core.osnova');
  }
  taskCoreModuleCache = compiled.module;
  return taskCoreModuleCache;
}

async function taskInvoke(name: string, args: StackValue[]): Promise<StackValue | null> {
  switch (name) {
    case 'система.время.метка':
      return new Date().toISOString();
    case 'система.строка.объединить':
      return String(args[0] ?? '') + String(args[1] ?? '');
    case 'система.хранилище.записать': {
      const key = String(args[0] ?? '');
      const value = String(args[1] ?? '');
      await storage.storageWrite(TASK_STORAGE_ROOT, TASK_APP_ID, key, value);
      return null;
    }
    case 'система.хранилище.прочитать': {
      const key = String(args[0] ?? '');
      return (await storage.storageRead(TASK_STORAGE_ROOT, TASK_APP_ID, key)) ?? '';
    }
    case 'система.хранилище.удалить': {
      const key = String(args[0] ?? '');
      await storage.storageDelete(TASK_STORAGE_ROOT, TASK_APP_ID, key);
      return null;
    }
    case 'система.хранилище.ключи_с_префиксом': {
      const prefix = String(args[0] ?? '');
      const keys = await storage.storageKeys(TASK_STORAGE_ROOT, TASK_APP_ID);
      return keys.filter((k) => k.startsWith(prefix));
    }
    default:
      throw new Error(`Unsupported task-manager syscall: ${name}`);
  }
}

async function runTaskCoreProcedure(name: string, args: StackValue[]): Promise<StackValue | undefined> {
  const module = await getTaskCoreModule();
  const vm = new VM(module, { invoke: taskInvoke });
  const index = vm.findProcedureIndex(name);
  return vm.runProcedure(index, args);
}

async function listTaskDtos(): Promise<TaskDto[]> {
  const keysValue = await runTaskCoreProcedure('список', []);
  const keys = Array.isArray(keysValue) ? keysValue.map((v) => String(v ?? '')) : [];
  const tasks: TaskDto[] = [];
  for (const key of keys) {
    const raw = await runTaskCoreProcedure('получить', [key]);
    if (typeof raw === 'string' && raw.trim().length > 0) {
      tasks.push(parseTaskValue(key, raw));
    }
  }
  return tasks;
}

export interface StartHttpServerOptions {
  tunnel?: boolean;
}

export function createHttpApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(express.text({ type: 'text/plain' }));

  interface PipelineTask {
    taskId: string;
    status: 'pending' | 'running' | 'done' | 'error';
    phase: string;
    message: string;
    result?: unknown;
  }
  const pipelineTasks = new Map<string, PipelineTask>();

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', version: OSIRIS_VERSION });
  });

  app.get('/ota/version', (_req: Request, res: Response) => {
    try {
      const versionFile = path.join(CHAT_WEB_WWW, 'version.json');
      if (!fs.existsSync(versionFile)) {
        res.status(404).json({ error: 'version.json not found' });
        return;
      }
      const content = fs.readFileSync(versionFile, 'utf-8');
      res.json(JSON.parse(content));
    } catch {
      res.status(500).json({ error: 'failed to read version.json' });
    }
  });

  app.get('/ota/bundle', (_req: Request, res: Response) => {
    try {
      if (!fs.existsSync(CHAT_WEB_WWW)) {
        res.status(404).json({ error: 'www directory not found' });
        return;
      }
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="osiris-web.zip"');
      const archive = archiver('zip', { zlib: { level: 9 } });
      archive.on('error', (err) => {
        console.error('[osiris:http] /ota/bundle archiver error', err);
        if (!res.headersSent) res.status(500).end();
      });
      archive.pipe(res);
      archive.directory(CHAT_WEB_WWW, false);
      void archive.finalize();
    } catch (e) {
      console.error('[osiris:http] /ota/bundle failed', e);
      if (!res.headersSent) res.status(500).json({ error: 'failed to create bundle' });
    }
  });

  const MAX_WAIT_MS = 20_000;
  const POLL_INTERVAL_MS = 500;

  app.get('/server-url', async (_req: Request, res: Response) => {
    const port = Number(process.env.HTTP_PORT ?? 3000);
    // Если TUNNEL_URL уже есть — вернуть сразу
    if (process.env.TUNNEL_URL) {
      res.json({ url: process.env.TUNNEL_URL });
      return;
    }
    // Если tunnel не запущен (USE_TUNNEL !== true) — вернуть localhost
    if (process.env.USE_TUNNEL !== 'true') {
      res.json({ url: `http://localhost:${port}` });
      return;
    }
    // Tunnel запущен но URL ещё не готов — ждём до MAX_WAIT_MS
    const deadline = Date.now() + MAX_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise<void>(r => setTimeout(r, POLL_INTERVAL_MS));
      if (process.env.TUNNEL_URL) {
        res.json({ url: process.env.TUNNEL_URL });
        return;
      }
    }
    // Timeout — вернуть localhost как fallback
    res.json({ url: `http://localhost:${port}` });
  });

  app.post('/chat', async (req: Request, res: Response) => {
    try {
      let body: ChatRequestBody = {};
      if (typeof req.body === 'string') {
        try {
          body = JSON.parse(req.body) as ChatRequestBody;
        } catch {
          res.status(400).json({ error: 'invalid JSON in text/plain body' });
          return;
        }
      } else if (req.body && typeof req.body === 'object') {
        body = req.body as ChatRequestBody;
      }

      if (!isNonEmptyString(body.userId) || !isNonEmptyString(body.message)) {
        res.status(400).json({ error: 'userId and message are required strings' });
        return;
      }

      const userId = body.userId.trim();
      const messageText = body.message.trim();

      console.log(`[osiris:http] POST /chat userId=${userId}`);

      const incoming = {
        id: crypto.randomUUID(),
        userId,
        chatId: userId,
        text: messageText,
        timestamp: new Date().toISOString(),
        isVoice: false,
      };

      const result = await handleMessage(incoming);
      res.json({ reply: result.reply });
    } catch (e) {
      console.error('[osiris:http] POST /chat failed', e);
      res.status(500).json({ error: 'internal server error' });
    }
  });

  app.post('/chat/stream', async (req: Request, res: Response) => {
    try {
      let body: ChatRequestBody = {};
      if (typeof req.body === 'string') {
        try {
          body = JSON.parse(req.body) as ChatRequestBody;
        } catch {
          res.status(400).json({ error: 'invalid JSON in text/plain body' });
          return;
        }
      } else if (req.body && typeof req.body === 'object') {
        body = req.body as ChatRequestBody;
      }

      if (!isNonEmptyString(body.userId) || !isNonEmptyString(body.message)) {
        res.status(400).json({ error: 'userId and message are required strings' });
        return;
      }

      const userId = body.userId.trim();
      const messageText = body.message.trim();
      console.log(`[osiris:http] POST /chat/stream userId=${userId}`);

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      const incoming = {
        id: crypto.randomUUID(),
        userId,
        chatId: userId,
        text: messageText,
        timestamp: new Date().toISOString(),
        isVoice: false,
      };

      // 1. Сначала handleMessage для tool calls, памяти, контекста
      const result = await handleMessage(incoming);

      // 2. Определить провайдер — если qwen-cli или нет LLM_API_KEY, стримить нельзя
      const provider = process.env.OSNOVA_PROVIDER ?? 'openai-compatible';
      const hasApiKey = !!process.env.LLM_API_KEY;

      if (provider !== 'qwen-cli' && hasApiKey) {
        // Реальный стриминг через DeepSeek API
        try {
          await callHttpApiStream([{ role: 'user', content: messageText }], (token) => {
            res.write(`data: ${JSON.stringify({ token })}\n\n`);
          });
          res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
          res.end();
        } catch (streamErr) {
          // Fallback: стримим готовый reply из handleMessage если стриминг упал
          console.error('[osiris:http] stream failed, falling back to split', streamErr);
          const tokens = result.reply.split(/(\s+)/);
          for (const token of tokens) {
            res.write(`data: ${JSON.stringify({ token })}\n\n`);
            await new Promise((r) => setTimeout(r, 30));
          }
          res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
          res.end();
        }
      } else {
        // Fallback: имитация для qwen-cli или если нет API ключа
        const tokens = result.reply.split(/(\s+)/);
        for (const token of tokens) {
          res.write(`data: ${JSON.stringify({ token })}\n\n`);
          await new Promise((r) => setTimeout(r, 30));
        }
        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        res.end();
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'internal error';
      res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
      res.end();
    }
  });

  app.post('/pipeline', async (req: Request, res: Response) => {
    const startedAt = Date.now();
    try {
      let body: PipelineRequestBody = {};
      if (typeof req.body === 'string') {
        try {
          body = JSON.parse(req.body) as PipelineRequestBody;
        } catch {
          res.status(400).json({ status: 'error', error: 'invalid JSON in text/plain body' });
          logPipelineCompletedEvent(
            buildPipelineCompletedEvent({
              httpStatus: 400,
              status: 'error',
              pipelineStatus: 'error',
              durationMs: Date.now() - startedAt,
            }),
          );
          return;
        }
      } else if (req.body && typeof req.body === 'object') {
        body = req.body as PipelineRequestBody;
      }

      if (!body.task || typeof body.task !== 'string' || body.task.trim().length === 0) {
        res.status(400).json({ status: 'error', error: 'task is required string' });
        logPipelineCompletedEvent(
          buildPipelineCompletedEvent({
            httpStatus: 400,
            status: 'error',
            pipelineStatus: 'error',
            durationMs: Date.now() - startedAt,
          }),
        );
        return;
      }

      const task = body.task.trim();
      console.log(`[osiris:http] POST /pipeline task="${task}"`);
      const result = await runOsirisPipeline(task);
      // status остаётся бинарным для обратной совместимости клиентов.
      console.log(
        `[osiris:http] POST /pipeline completed status=${result.status} pipelineStatus=${result.pipelineStatus}`,
      );
      res.json({
        status: result.status,
        pipelineStatus: result.pipelineStatus,
        result,
      });
      logPipelineCompletedEvent(
        buildPipelineCompletedEvent({
          httpStatus: 200,
          status: result.status,
          pipelineStatus: result.pipelineStatus,
          durationMs: Date.now() - startedAt,
        }),
      );
    } catch (e) {
      console.error('[osiris:http] POST /pipeline failed', e);
      res.status(500).json({ status: 'error', error: 'internal server error' });
      logPipelineCompletedEvent(
        buildPipelineCompletedEvent({
          httpStatus: 500,
          status: 'error',
          pipelineStatus: 'error',
          durationMs: Date.now() - startedAt,
        }),
      );
    }
  });

  app.post('/tasks', async (req: Request, res: Response) => {
    try {
      let body: CreateTaskBody = {};
      if (typeof req.body === 'string') {
        try {
          body = JSON.parse(req.body) as CreateTaskBody;
        } catch {
          res.status(400).json({ error: 'invalid JSON in text/plain body' });
          return;
        }
      } else if (req.body && typeof req.body === 'object') {
        body = req.body as CreateTaskBody;
      }

      if (!isNonEmptyString(body.title)) {
        res.status(400).json({ error: 'title is required string' });
        return;
      }
      if (body.description !== undefined && typeof body.description !== 'string') {
        res.status(400).json({ error: 'description must be string' });
        return;
      }
      if (body.priority !== undefined && typeof body.priority !== 'string') {
        res.status(400).json({ error: 'priority must be string' });
        return;
      }

      console.log('[osiris:http:tasks] POST /tasks');
      const title = body.title.trim();
      const description = typeof body.description === 'string' ? body.description.trim() : '';
      const priority = normalizePriority(body.priority as string | undefined);
      const createdKeyValue = await runTaskCoreProcedure('создать', [title, description, priority]);
      const key = String(createdKeyValue ?? '');
      const raw = await runTaskCoreProcedure('получить', [key]);
      const task = parseTaskValue(key, String(raw ?? ''));
      res.status(201).json(task);
    } catch (e) {
      console.error('[osiris:http:tasks] POST /tasks failed', e);
      res.status(500).json({ error: 'internal server error' });
    }
  });

  app.get('/tasks', async (_req: Request, res: Response) => {
    try {
      console.log('[osiris:http:tasks] GET /tasks');
      const tasks = await listTaskDtos();
      res.json(tasks);
    } catch (e) {
      console.error('[osiris:http:tasks] GET /tasks failed', e);
      res.status(500).json({ error: 'internal server error' });
    }
  });

  app.patch('/tasks/:key', async (req: Request, res: Response) => {
    try {
      const key = String(req.params.key ?? '').trim();
      if (!key) {
        res.status(400).json({ error: 'key is required' });
        return;
      }

      let body: PatchTaskBody = {};
      if (typeof req.body === 'string') {
        try {
          body = JSON.parse(req.body) as PatchTaskBody;
        } catch {
          res.status(400).json({ error: 'invalid JSON in text/plain body' });
          return;
        }
      } else if (req.body && typeof req.body === 'object') {
        body = req.body as PatchTaskBody;
      }

      if (body.status === undefined && body.priority === undefined) {
        res.status(400).json({ error: 'status or priority is required' });
        return;
      }
      if (body.status !== undefined && typeof body.status !== 'string') {
        res.status(400).json({ error: 'status must be string' });
        return;
      }
      if (body.priority !== undefined && typeof body.priority !== 'string') {
        res.status(400).json({ error: 'priority must be string' });
        return;
      }

      console.log(`[osiris:http:tasks] PATCH /tasks/${key}`);
      const existingRawValue = await runTaskCoreProcedure('получить', [key]);
      const existingRaw = String(existingRawValue ?? '');
      if (!existingRaw.trim()) {
        res.status(404).json({ error: 'task not found' });
        return;
      }
      const current = parseTaskValue(key, existingRaw);
      const nextStatus = body.status !== undefined ? normalizeStatus(body.status) : current.status;
      const nextPriority = body.priority !== undefined ? normalizePriority(body.priority) : current.priority;
      const nextRaw = [current.title, current.description, nextStatus, nextPriority].join('|');
      await runTaskCoreProcedure('обновить', [key, nextRaw]);
      const updatedRaw = await runTaskCoreProcedure('получить', [key]);
      const updated = parseTaskValue(key, String(updatedRaw ?? ''));
      res.json(updated);
    } catch (e) {
      console.error(`[osiris:http:tasks] PATCH /tasks/${String(req.params.key ?? '')} failed`, e);
      res.status(500).json({ error: 'internal server error' });
    }
  });

  app.delete('/tasks/:key', async (req: Request, res: Response) => {
    try {
      const key = String(req.params.key ?? '').trim();
      if (!key) {
        res.status(400).json({ error: 'key is required' });
        return;
      }
      console.log(`[osiris:http:tasks] DELETE /tasks/${key}`);
      const existingRaw = await runTaskCoreProcedure('получить', [key]);
      if (!String(existingRaw ?? '').trim()) {
        res.status(404).json({ error: 'task not found' });
        return;
      }
      await runTaskCoreProcedure('удалить', [key]);
      res.json({ ok: true });
    } catch (e) {
      console.error(`[osiris:http:tasks] DELETE /tasks/${String(req.params.key ?? '')} failed`, e);
      res.status(500).json({ error: 'internal server error' });
    }
  });

  app.get('/pipeline/stream', async (req: Request, res: Response) => {
    const task = typeof req.query.task === 'string' ? req.query.task.trim() : '';
    if (!task) {
      res.status(400).json({ error: 'task query param is required' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (data: object) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    send({ phase: 'queued', message: `Задача принята: "${task}"` });

    try {
      const result = await runOsirisPipeline(task, (phase, message) => {
        send({ phase, message });
      });
      send({
        phase: 'done',
        message: result.status === 'ok' ? result.summary : `Ошибка: ${result.summary}`,
        result,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      send({ phase: 'error', message: `Pipeline упал: ${msg}` });
    } finally {
      res.end();
    }
  });

  app.post('/pipeline/start', async (req: Request, res: Response) => {
    let body: PipelineRequestBody = {};
    if (typeof req.body === 'string') {
      try {
        body = JSON.parse(req.body) as PipelineRequestBody;
      } catch {
        res.status(400).json({ error: 'invalid JSON in text/plain body' });
        return;
      }
    } else if (req.body && typeof req.body === 'object') {
      body = req.body as PipelineRequestBody;
    }

    if (!body.task || typeof body.task !== 'string' || body.task.trim().length === 0) {
      res.status(400).json({ error: 'task is required string' });
      return;
    }

    const task = body.task.trim();
    const taskId = crypto.randomUUID();
    pipelineTasks.set(taskId, {
      taskId,
      status: 'pending',
      phase: 'queued',
      message: 'Задача принята',
      result: undefined,
    });

    console.log(`[osiris:http] POST /pipeline/start task="${task}" taskId=${taskId}`);

    void runOsirisPipeline(task, (phase, message) => {
      const t = pipelineTasks.get(taskId);
      if (t) {
        t.status = 'running';
        t.phase = phase;
        t.message = message;
      }
    })
      .then((result) => {
        const t = pipelineTasks.get(taskId);
        if (t) {
          t.status = result.status === 'ok' ? 'done' : 'error';
          t.phase = 'done';
          t.message = result.summary ?? '';
          t.result = result;
          setTimeout(() => pipelineTasks.delete(taskId), 3600000);
        }
      })
      .catch((e) => {
        const t = pipelineTasks.get(taskId);
        if (t) {
          t.status = 'error';
          t.phase = 'error';
          t.message = e instanceof Error ? e.message : 'pipeline failed';
          setTimeout(() => pipelineTasks.delete(taskId), 3600000);
        }
      });

    res.json({ taskId });
  });

  app.get('/pipeline/status', (req: Request, res: Response) => {
    const taskId = typeof req.query.taskId === 'string' ? req.query.taskId : '';
    const task = pipelineTasks.get(taskId);

    if (!task) {
      res.status(404).json({ error: 'task not found' });
      return;
    }

    console.log(`[osiris:http] GET /pipeline/status taskId=${taskId} status=${task.status}`);
    if (task.status === 'done' || task.status === 'error') {
      res.json({
        taskId: task.taskId,
        status: task.status,
        phase: task.phase,
        message: task.message,
        result: task.result,
      });
      return;
    }

    res.json({
      taskId: task.taskId,
      status: task.status,
      phase: task.phase,
      message: task.message,
    });
  });

  app.get('/debug/context', async (req: Request, res: Response) => {
    try {
      const userId = typeof req.query.userId === 'string' ? req.query.userId.trim() : '';
      if (!userId) {
        res.status(400).json({ error: 'userId query param is required' });
        return;
      }
      const [recentMessages, recentFacts, activeTasks, osirisContext, coreMemory, recentEntities] = await Promise.all([
        memory.getRecentMessages(userId, 5),
        memory.getRecentFacts(userId, 10),
        Promise.resolve(memory.getTasks(userId, 'open')),
        buildOsirisContext(userId),
        memory.getCoreMemory(userId),
        memory.getRecentEntities(userId, 10),
      ]);
      res.json({
        userId,
        recentMessages,
        recentFacts,
        activeTasks,
        osirisContext,
        coreMemory,
        recentEntities,
      });
    } catch (e) {
      console.error('[osiris:debug] GET /debug/context failed', e);
      res.status(500).json({ error: 'internal server error' });
    }
  });

  app.post('/debug/consolidate', async (req: Request, res: Response) => {
    try {
      const userId = typeof req.query.userId === 'string' ? req.query.userId.trim() : undefined;
      await runConsolidationNow(userId);
      res.json({ ok: true, userId: userId ?? 'all' });
    } catch (e) {
      console.error('[osiris:debug] POST /debug/consolidate failed', e);
      res.status(500).json({ error: 'internal server error' });
    }
  });

  return app;
}

export async function startHttpServer(opts?: StartHttpServerOptions): Promise<void> {
  const app = createHttpApp();

  const port = Number(process.env.HTTP_PORT ?? 3000);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid HTTP_PORT: ${process.env.HTTP_PORT ?? ''}`);
  }

  await new Promise<void>((resolve, reject) => {
    const server = app.listen(port, () => {
      console.log('Осирис ready');
      console.log(`Version: ${OSIRIS_VERSION}`);
      console.log(`Mode: HTTP (port ${port})`);
      if (opts?.tunnel === true) {
        startTunnel(port);
      }
      startConsolidationCron();
      resolve();
    });

    server.on('error', reject);

    const shutdown = (signal: string) => {
      console.log(`[osiris] ${signal} received, stopping...`);
      server.close((err) => {
        if (err) {
          console.error('[osiris:http] server.close error', err);
          process.exit(1);
        } else {
          process.exit(0);
        }
      });
    };

    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  });
}
