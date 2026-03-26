// apps/osiris/src/http/server.ts
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import archiver from 'archiver';
import express, { type Express, type Request, type Response } from 'express';
import { callHttpApiStream } from '../core/llm-router';
import { handleMessage } from '../core/message-handler';
import { startConsolidationCron, runConsolidationNow } from '../core/consolidation-runner';
import { getJobStatus } from '../core/autonomous-runner';
import { checkProactiveTriggers } from '../core/proactive-engine';
import { startTelegramAdapter } from '../adapters/telegram';
import {
  getCoreMemoryWithVersion,
  deleteFact,
  getRecentFacts,
  getRecentEntities,
  getSessionSummaries,
  updateCoreMemory,
  listTasks,
  getTask,
  createTask,
  getBlockingDependencies,
  transitionTask,
  updateTaskFields,
  linkDependency,
  unlinkDependency,
  getTaskHistory,
} from '../core/memory-engine';
import { getDb, migrate, seedCoreMemoryIfEmpty } from '../db/migrations';
import * as memory from '../core/memory-engine';
import { buildOsirisContext } from '../core/osiris-context';
import { runOsirisPipeline } from '../osnova/client';
import { startTunnel } from './tunnel';
import { buildPipelineCompletedEvent, logPipelineCompletedEvent } from './pipeline-observability';
import { compileSource } from '../../../../src/compiler/compiler';
import { VM, type StackValue } from '../../../../src/runtime/vm/interpreter';
import type { OsVbcModule } from '../../../../src/runtime/vm/bytecode';

function readProductVersion(): string {
  const fallback = '0.0.0';
  try {
    const versionPath = path.resolve(__dirname, '..', '..', '..', '..', 'VERSION');
    if (!fs.existsSync(versionPath)) return fallback;
    const raw = fs.readFileSync(versionPath, 'utf-8').trim();
    return raw || fallback;
  } catch {
    return fallback;
  }
}

const OSIRIS_VERSION = process.env.OSNOVA_VERSION?.trim() || readProductVersion();
const CHAT_WEB_WWW = path.resolve(__dirname, '..', '..', '..', '..', 'apps', 'chat-web', 'www');

interface ChatRequestBody {
  userId?: unknown;
  message?: unknown;
}

interface PipelineRequestBody {
  task?: unknown;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export interface StartHttpServerOptions {
  tunnel?: boolean;
}

export function createHttpApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((
    err: { type?: string },
    _req: import('express').Request,
    res: import('express').Response,
    _next: import('express').NextFunction,
  ) => {
    if (err.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Invalid JSON' });
      return;
    }
    _next(err);
  });
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

  // ── Android OTA API ──────────────────────────────────────────────────────

  const ANDROID_OTA_DIR = '/opt/osnova/android-ota';
  const ANDROID_OTA_LATEST_PATH = path.join(ANDROID_OTA_DIR, 'latest.json');
  const ANDROID_OTA_APK_PATH = path.join(ANDROID_OTA_DIR, 'app.apk');

  app.get('/ota/android/latest', (_req: Request, res: Response) => {
    try {
      if (!fs.existsSync(ANDROID_OTA_LATEST_PATH)) {
        res.status(404).json({ error: 'latest.json not found' });
        return;
      }
      const content = fs.readFileSync(ANDROID_OTA_LATEST_PATH, 'utf-8');
      res.json(JSON.parse(content));
    } catch (e) {
      console.error('[osiris:http] GET /ota/android/latest failed', e);
      res.status(500).json({ error: 'failed to read latest.json' });
    }
  });

  app.get('/ota/android/app.apk', (_req: Request, res: Response) => {
    try {
      if (!fs.existsSync(ANDROID_OTA_APK_PATH)) {
        res.status(404).json({ error: 'app.apk not found' });
        return;
      }
      res.setHeader('Content-Type', 'application/vnd.android.package-archive');
      res.sendFile(ANDROID_OTA_APK_PATH);
    } catch (e) {
      console.error('[osiris:http] GET /ota/android/app.apk failed', e);
      res.status(500).json({ error: 'failed to send apk' });
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
      const [recentMessages, recentFacts, activeTasks, osirisContext, coreMemory, recentEntities, recentThoughts] = await Promise.all([
        memory.getRecentMessages(userId, 5),
        memory.getRecentFacts(userId, 10),
        Promise.resolve(memory.getTasks(userId, 'open')),
        buildOsirisContext(userId),
        memory.getCoreMemory(userId),
        memory.getRecentEntities(userId, 10),
        memory.getRecentThoughts(userId, 3),
      ]);
      res.json({
        userId,
        recentMessages,
        recentFacts,
        activeTasks,
        osirisContext,
        coreMemory,
        recentEntities,
        recentThoughts,
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

  app.post('/debug/proactive', async (req: Request, res: Response) => {
    try {
      const userId = typeof req.query['userId'] === 'string'
        ? req.query['userId']
        : 'default';
      await checkProactiveTriggers(userId);
      res.json({ triggered: true });
    } catch (e) {
      console.error('[osiris:http] POST /debug/proactive failed', e);
      res.status(500).json({ error: 'internal server error' });
    }
  });

  app.get('/jobs/:jobId', async (req: Request, res: Response) => {
    try {
      const { jobId } = req.params;
      if (!jobId || typeof jobId !== 'string') {
        res.status(400).json({ error: 'jobId required' });
        return;
      }
      const job = await getJobStatus(jobId);
      if (!job) {
        res.status(404).json({ error: 'job not found' });
        return;
      }
      res.json(job);
    } catch (e) {
      console.error('[osiris:http] GET /jobs/:jobId failed', e);
      res.status(500).json({ error: 'internal server error' });
    }
  });

  // ── Brain API ────────────────────────────────────────────────────────────

  app.get('/brain', async (req: Request, res: Response) => {
    try {
      const userId = typeof req.query['userId'] === 'string' ? req.query['userId'] : '';
      if (!userId) { res.status(400).json({ error: 'userId required' }); return; }
      const [{ content: coreMemory }, recentFacts, recentEntities, sessionSummaries] =
        await Promise.all([
          getCoreMemoryWithVersion(userId),
          getRecentFacts(userId, 20),
          getRecentEntities(userId, 20),
          getSessionSummaries(userId, 5),
        ]);
      res.json({ coreMemory, recentFacts, recentEntities, sessionSummaries });
    } catch (e) {
      console.error('[osiris:http] GET /brain failed', e);
      res.status(500).json({ error: 'internal server error' });
    }
  });

  app.patch('/brain/core-memory', async (req: Request, res: Response) => {
    try {
      const userId = typeof req.query['userId'] === 'string' ? req.query['userId'] : '';
      if (!userId) { res.status(400).json({ error: 'userId required' }); return; }
      const patch = req.body?.patch;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        res.status(400).json({ error: 'patch must be an object' });
        return;
      }
      await updateCoreMemory(userId, patch as Parameters<typeof updateCoreMemory>[1]);
      const { content, version } = await getCoreMemoryWithVersion(userId);
      res.set('X-Core-Memory-Version', String(version));
      res.json({ coreMemory: content, version });
    } catch (e) {
      console.error('[osiris:http] PATCH /brain/core-memory failed', e);
      res.status(500).json({ error: 'internal server error' });
    }
  });

  app.delete('/brain/facts/:factId', async (req: Request, res: Response) => {
    try {
      const userId = typeof req.query['userId'] === 'string' ? req.query['userId'] : '';
      if (!userId) { res.status(400).json({ error: 'userId required' }); return; }
      const factId = parseInt(req.params['factId'] ?? '', 10);
      if (!Number.isFinite(factId)) {
        res.status(400).json({ error: 'invalid factId' });
        return;
      }
      const deleted = deleteFact(userId, factId);
      if (!deleted) { res.status(404).json({ error: 'fact not found' }); return; }
      res.json({ deleted: true });
    } catch (e) {
      console.error('[osiris:http] DELETE /brain/facts/:factId failed', e);
      res.status(500).json({ error: 'internal server error' });
    }
  });

  // ── Tasks API ────────────────────────────────────────────────────────────

  app.get('/tasks', (req: Request, res: Response) => {
    try {
      const userId = typeof req.query['userId'] === 'string' ? req.query['userId'] : '';
      if (!userId) { res.status(400).json({ error: 'userId required' }); return; }

      const statusParam = typeof req.query['status'] === 'string' ? req.query['status'] : 'active';
      const project = typeof req.query['project'] === 'string' ? req.query['project'] : null;
      const search = typeof req.query['search'] === 'string' ? req.query['search'] : null;
      const sort = typeof req.query['sort'] === 'string'
        ? req.query['sort'] as 'created_at_asc' | 'created_at_desc' | 'priority_desc'
        : undefined;
      const limit = parseInt(String(req.query['limit'] ?? '50'), 10);
      const offset = parseInt(String(req.query['offset'] ?? '0'), 10);

      const tasks = listTasks(userId, {
        status: statusParam === 'active' ? 'active' : (statusParam as any),
        project,
        search,
        sort,
        limit,
        offset,
      });

      res.json({
        tasks: tasks.map((t) => ({
          id: t.id,
          title: t.title,
          status: t.workflowStatus,
          project: t.project,
          priority: t.priority,
          deadline: t.deadline,
          assignee: t.assignee,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
        })),
      });
    } catch (e) {
      console.error('[osiris:http] GET /tasks failed', e);
      res.status(500).json({ error: 'internal server error' });
    }
  });

  app.get('/tasks/history', (req: Request, res: Response) => {
    try {
      const userId = typeof req.query['userId'] === 'string' ? req.query['userId'] : '';
      if (!userId) { res.status(400).json({ error: 'userId required' }); return; }

      const limit = parseInt(String(req.query['limit'] ?? '20'), 10);
      const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 20;

      const done = listTasks(userId, { status: 'done', sort: 'created_at_desc', limit: safeLimit, offset: 0 });
      const cancelled = listTasks(userId, { status: 'cancelled', sort: 'created_at_desc', limit: safeLimit, offset: 0 });
      const merged = [...done, ...cancelled]
        .sort((a, b) => String(b.doneAt ?? b.updatedAt).localeCompare(String(a.doneAt ?? a.updatedAt)))
        .slice(0, safeLimit);

      res.json({
        tasks: merged.map((t) => ({
          id: t.id,
          title: t.title,
          status: t.workflowStatus,
          project: t.project,
          createdAt: t.createdAt,
          doneAt: t.doneAt,
        })),
      });
    } catch (e) {
      console.error('[osiris:http] GET /tasks/history failed', e);
      res.status(500).json({ error: 'internal server error' });
    }
  });

  app.get('/tasks/:taskId', (req: Request, res: Response) => {
    try {
      const userId = typeof req.query['userId'] === 'string' ? req.query['userId'] : '';
      if (!userId) { res.status(400).json({ error: 'userId required' }); return; }

      const taskId = parseInt(req.params['taskId'] ?? '', 10);
      if (!Number.isFinite(taskId)) {
        res.status(400).json({ error: 'invalid taskId' });
        return;
      }

      const task = getTask(userId, taskId);
      if (!task) { res.status(404).json({ error: 'task not found' }); return; }

      const dependencies = getBlockingDependencies(userId, taskId);
      res.json({ task: { ...task, status: task.workflowStatus }, dependencies });
    } catch (e) {
      console.error('[osiris:http] GET /tasks/:taskId failed', e);
      res.status(500).json({ error: 'internal server error' });
    }
  });

  app.get('/tasks/:taskId/history', (req: Request, res: Response) => {
    try {
      const userId = typeof req.query['userId'] === 'string' ? req.query['userId'] : '';
      if (!userId) { res.status(400).json({ error: 'userId required' }); return; }

      const taskId = parseInt(req.params['taskId'] ?? '', 10);
      if (!Number.isFinite(taskId)) {
        res.status(400).json({ error: 'invalid taskId' });
        return;
      }

      const limit = parseInt(String(req.query['limit'] ?? '50'), 10);
      const events = getTaskHistory(userId, taskId, limit);
      res.json({ events });
    } catch (e) {
      console.error('[osiris:http] GET /tasks/:taskId/history failed', e);
      res.status(500).json({ error: 'internal server error' });
    }
  });

  app.post('/tasks', (req: Request, res: Response) => {
    try {
      const userId = typeof req.query['userId'] === 'string' ? req.query['userId'] : '';
      if (!userId) { res.status(400).json({ error: 'userId required' }); return; }

      const body = req.body ?? {};
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      if (!title) { res.status(400).json({ error: 'title required' }); return; }

      const project = typeof body.project === 'string' ? body.project : 'general';
      const status = typeof body.status === 'string' ? body.status : 'todo';

      const task = createTask(userId, {
        title,
        description: typeof body.description === 'string' ? body.description : '',
        project,
        type: typeof body.type === 'string' ? body.type : 'task',
        priority: Number.isFinite(body.priority) ? Number(body.priority) : 3,
        size: typeof body.size === 'string' ? body.size : 'm',
        status,
        deadline: typeof body.deadline === 'string' ? body.deadline : undefined,
        assignee: typeof body.assignee === 'string' ? body.assignee : undefined,
        recurrence_rule: typeof body.recurrence_rule === 'object' && body.recurrence_rule !== null
          ? body.recurrence_rule
          : null,
        tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
        metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata : null,
      }, 'api', 'user');

      res.json({ task });
    } catch (e) {
      console.error('[osiris:http] POST /tasks failed', e);
      res.status(500).json({ error: 'internal server error' });
    }
  });

  app.post('/tasks/:taskId/transition', (req: Request, res: Response) => {
    try {
      const userId = typeof req.query['userId'] === 'string' ? req.query['userId'] : '';
      if (!userId) { res.status(400).json({ error: 'userId required' }); return; }

      const taskId = parseInt(req.params['taskId'] ?? '', 10);
      if (!Number.isFinite(taskId)) {
        res.status(400).json({ error: 'invalid taskId' });
        return;
      }

      const status = typeof req.body?.status === 'string' ? req.body.status : '';
      const note = typeof req.body?.note === 'string' ? req.body.note : undefined;
      if (!status) { res.status(400).json({ error: 'status required' }); return; }

      const updated = transitionTask(userId, taskId, status as any, { note, actor: 'user' });
      res.json({ task: updated, status: updated.workflowStatus });
    } catch (e) {
      console.error('[osiris:http] POST /tasks/:taskId/transition failed', e);
      const msg = e instanceof Error ? e.message : 'internal server error';
      if (msg === 'dependencies_not_done' || msg.includes('invalid transition')) {
        res.status(409).json({ error: msg });
        return;
      }
      res.status(500).json({ error: msg });
    }
  });

  // Backward compatible endpoint (legacy clients): { status: "done" | "pending" }
  app.patch('/tasks/:taskId', (req: Request, res: Response) => {
    try {
      const userId = typeof req.query['userId'] === 'string' ? req.query['userId'] : '';
      if (!userId) { res.status(400).json({ error: 'userId required' }); return; }

      const taskId = parseInt(req.params['taskId'] ?? '', 10);
      if (!Number.isFinite(taskId)) {
        res.status(400).json({ error: 'invalid taskId' });
        return;
      }

      const body = req.body ?? {};
      const status = typeof body.status === 'string' ? body.status : undefined;

      if (status === 'done') {
        const updated = transitionTask(userId, taskId, 'done', { actor: 'user', note: 'legacy done' });
        res.json({ task: updated });
        return;
      }
      if (status === 'pending') {
        const updated = transitionTask(userId, taskId, 'todo', { actor: 'user', note: 'legacy pending->todo' });
        res.json({ task: updated });
        return;
      }

      const ok = updateTaskFields(userId, taskId, {
        title: typeof body.title === 'string' ? body.title : undefined,
        description: typeof body.description === 'string' ? body.description : undefined,
        project: typeof body.project === 'string' ? body.project : undefined,
        priority: Number.isFinite(body.priority) ? Number(body.priority) : undefined,
        size: typeof body.size === 'string' ? body.size : undefined,
        deadline: typeof body.deadline === 'string' ? body.deadline : undefined,
        assignee: typeof body.assignee === 'string' ? body.assignee : undefined,
        type: typeof body.type === 'string' ? body.type : undefined,
        recurrence_rule: typeof body.recurrence_rule === 'object' && body.recurrence_rule !== null
          ? body.recurrence_rule
          : undefined,
        tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
        metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata : undefined,
      }, 'user');

      if (!ok) { res.status(404).json({ error: 'task not found or nothing to update' }); return; }
      const task = getTask(userId, taskId);
      res.json({ task });
    } catch (e) {
      console.error('[osiris:http] PATCH /tasks/:taskId failed', e);
      res.status(500).json({ error: 'internal server error' });
    }
  });

  app.post('/tasks/:taskId/dependencies', (req: Request, res: Response) => {
    try {
      const userId = typeof req.query['userId'] === 'string' ? req.query['userId'] : '';
      if (!userId) { res.status(400).json({ error: 'userId required' }); return; }

      const taskId = parseInt(req.params['taskId'] ?? '', 10);
      const dependencyId = typeof req.body?.dependencyId === 'number'
        ? req.body.dependencyId
        : parseInt(req.body?.dependencyId ?? '', 10);

      if (!Number.isFinite(taskId) || !Number.isFinite(dependencyId)) {
        res.status(400).json({ error: 'invalid taskId/dependencyId' });
        return;
      }

      const ok = linkDependency(userId, taskId, dependencyId);
      res.json({ ok });
    } catch (e) {
      console.error('[osiris:http] POST /tasks/:taskId/dependencies failed', e);
      res.status(500).json({ error: 'internal server error' });
    }
  });

  app.delete('/tasks/:taskId/dependencies', (req: Request, res: Response) => {
    try {
      const userId = typeof req.query['userId'] === 'string' ? req.query['userId'] : '';
      if (!userId) { res.status(400).json({ error: 'userId required' }); return; }

      const taskId = parseInt(req.params['taskId'] ?? '', 10);
      const dependencyIdRaw = typeof req.query['dependencyId'] === 'string' ? req.query['dependencyId'] : '';
      const dependencyId = parseInt(dependencyIdRaw, 10);

      if (!Number.isFinite(taskId) || !Number.isFinite(dependencyId)) {
        res.status(400).json({ error: 'invalid taskId/dependencyId' });
        return;
      }

      const ok = unlinkDependency(userId, taskId, dependencyId);
      res.json({ ok });
    } catch (e) {
      console.error('[osiris:http] DELETE /tasks/:taskId/dependencies failed', e);
      res.status(500).json({ error: 'internal server error' });
    }
  });

  // ── Compile API ──────────────────────────────────────────────────────────

  app.post('/compile', (req: Request, res: Response) => {
    try {
      const source = req.body?.source;
      if (!source || typeof source !== 'string' || source.trim().length === 0) {
        res.status(400).json({ ok: false, errors: ['source is required string'] });
        return;
      }
      const result = compileSource(source.trim());
      if (!result.compilerSuccess) {
        const errors = [
          ...result.lexerErrors.map((e) => `[lexer] ${e.message}`),
          ...result.parserErrors.map((e) => `[parser] ${e.message}`),
          ...result.compilerErrors.map((e) => e.message),
        ];
        res.json({ ok: false, errors });
        return;
      }
      res.json({ ok: true, bytecode: result.module });
    } catch (e) {
      console.error('[osiris:http] POST /compile failed', e);
      res.status(500).json({ ok: false, errors: ['internal error'] });
    }
  });

  const osInvoke = (name: string, args: StackValue[]): StackValue | null => {
    if (name === 'система.лог.вывести') { console.log(...args); return null; }
    if (name === 'система.массив.создать') return [];
    if (name === 'система.массив.добавить') {
      const arr = args[0] as unknown[]; if (Array.isArray(arr)) arr.push(args[1]); return null;
    }
    if (name === 'система.массив.длина') return Array.isArray(args[0]) ? (args[0] as unknown[]).length : 0;
    if (name === 'система.массив.получить') { const v = (args[0] as unknown[])[args[1] as number]; return v === undefined ? null : v as StackValue; }
    if (name === 'система.массив.установить') {
      const arr = args[0] as unknown[]; const idx = Number(args[1]) | 0;
      if (Array.isArray(arr) && idx >= 0 && idx < arr.length) arr[idx] = args[2]; return null;
    }
    return null;
  };

  app.post('/run', async (req: Request, res: Response) => {
    try {
      const bytecode = req.body?.bytecode as OsVbcModule | undefined;
      if (!bytecode || typeof bytecode !== 'object') {
        res.status(400).json({ ok: false, error: 'bytecode object is required' });
        return;
      }
      const vm = new VM(bytecode, { invoke: osInvoke, maxSteps: 1_000_000 });
      const mainIdx = (() => {
        try { return vm.findProcedureIndex('главная'); } catch { /* */ }
        try { return vm.findProcedureIndex('старт'); } catch { /* */ }
        try { return vm.findProcedureIndex('main'); } catch { /* */ }
        return 0;
      })();
      const result = await vm.runProcedure(mainIdx, []);
      res.json({ ok: true, result: result ?? null });
    } catch (e) {
      console.error('[osiris:http] POST /run failed', e);
      res.status(500).json({ ok: false, error: e instanceof Error ? e.message : 'internal error' });
    }
  });

  app.post('/internal/push-test', (req, res) => {
    const { text, urgency } = req.body as { text?: string; urgency?: string };
    const u = urgency || 'normal';
    const t = text || '';
    console.log(`[PUSH] ${u}: ${t}`);
    res.json({ ok: true });
  });

  app.get('/export/training', (req, res) => {
    try {
      const userId = typeof req.query['userId'] === 'string'
        ? req.query['userId'].trim()
        : '';
      const limit = parseInt(String(req.query['limit'] ?? '1000'), 10);
      const safeLimit = Number.isFinite(limit) && limit > 0
        ? Math.min(limit, 10000)
        : 1000;
      const qualityParam = req.query['quality'];
      const qualityFilter =
        qualityParam === '1' ? 1 :
        qualityParam === '0' ? 0 :
        null;

      type SampleRow = {
        user_message: string;
        assistant_reply: string;
      };

      const rows: SampleRow[] = (() => {
        if (userId && qualityFilter !== null) {
          return getDb()
            .prepare(
              'SELECT user_message, assistant_reply FROM training_samples WHERE user_id = ? AND quality = ? ORDER BY id DESC LIMIT ?'
            )
            .all(userId, qualityFilter, safeLimit) as SampleRow[];
        }
        if (userId) {
          return getDb()
            .prepare(
              'SELECT user_message, assistant_reply FROM training_samples WHERE user_id = ? ORDER BY id DESC LIMIT ?'
            )
            .all(userId, safeLimit) as SampleRow[];
        }
        if (qualityFilter !== null) {
          return getDb()
            .prepare(
              'SELECT user_message, assistant_reply FROM training_samples WHERE quality = ? ORDER BY id DESC LIMIT ?'
            )
            .all(qualityFilter, safeLimit) as SampleRow[];
        }
        return getDb()
          .prepare(
            'SELECT user_message, assistant_reply FROM training_samples ORDER BY id DESC LIMIT ?'
          )
          .all(safeLimit) as SampleRow[];
      })();

      const jsonl = rows
        .map((r) =>
          JSON.stringify({
            messages: [
              { role: 'user', content: r.user_message },
              { role: 'assistant', content: r.assistant_reply },
            ],
          })
        )
        .join('\n');

      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="osiris-training.jsonl"'
      );
      res.send(jsonl || '');
    } catch (e) {
      console.error('[osiris:export] training export failed', e);
      res.status(500).json({ error: 'export failed' });
    }
  });

  return app;
}

export async function startHttpServer(opts?: StartHttpServerOptions): Promise<void> {
  migrate();
  seedCoreMemoryIfEmpty('web-user');
  const app = createHttpApp();

  const port = Number(process.env.HTTP_PORT ?? 3000);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid HTTP_PORT: ${process.env.HTTP_PORT ?? ''}`);
  }

  await new Promise<void>((resolve, reject) => {
    let server: any = null;
    let shuttingDown = false;

    const onReady = () => {
      console.log('Осирис ready');
      console.log(`Version: ${OSIRIS_VERSION}`);
      console.log(`Mode: HTTP (port ${port})`);
      // Cleanup stale running jobs after restart
      try {
        getDb().exec(
          "UPDATE autonomous_jobs SET status='error', error='Server restarted' WHERE status='running'",
        );
      } catch {
        // таблица может не существовать при первом запуске до миграции — игнорируем
      }
      if (opts?.tunnel === true) {
        startTunnel(port);
      }
      startConsolidationCron();
      startTelegramAdapter(); // фоновый polling, не await
      resolve();
    };

    const shutdown = (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`[osiris] ${signal} received, stopping...`);
      try {
        closeDb();
      } catch {
        // ignore
      }

      const s = server;
      if (!s) return process.exit(0);

      // Node 18+ (incl. 20): helps drop keep-alive quickly.
      try {
        if (typeof s.closeIdleConnections === 'function') s.closeIdleConnections();
        if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
      } catch {
        // ignore
      }

      const forceTimer = setTimeout(() => {
        console.error('[osiris:http] shutdown timeout, forcing exit');
        process.exit(1);
      }, 8_000);
      // don't keep event loop alive only for the timer
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      if (typeof forceTimer.unref === 'function') forceTimer.unref();

      s.close((err: any) => {
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

    const tryListen = (attempt: number) => {
      server = app.listen(port, onReady);
      server.once('error', (err: any) => {
        const code = err?.code;
        if (code === 'EADDRINUSE' && attempt < 6 && !shuttingDown) {
          const delayMs = 400 * attempt;
          console.warn(
            `[osiris:http] port ${port} busy (EADDRINUSE), retry in ${delayMs}ms (attempt ${attempt}/6)`,
          );
          try {
            server?.close?.();
          } catch {
            // ignore
          }
          setTimeout(() => tryListen(attempt + 1), delayMs);
          return;
        }
        reject(err);
      });
    };

    tryListen(1);
  });
}
