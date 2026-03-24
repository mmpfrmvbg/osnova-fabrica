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
  getTasks,
  updateTask,
} from '../core/memory-engine';
import { getDb } from '../db/migrations';
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
      const tasks = getTasks(userId, 'open');
      const grouped = tasks.reduce<Record<string, typeof tasks>>((acc, t) => {
        const key = t.project || 'general';
        if (!acc[key]) acc[key] = [];
        acc[key].push(t);
        return acc;
      }, {});
      if (Object.keys(grouped).length === 0) grouped['general'] = [];
      res.json(grouped);
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
      const tasks = getTasks(userId, 'done').slice(0, safeLimit);
      res.json({ tasks });
    } catch (e) {
      console.error('[osiris:http] GET /tasks/history failed', e);
      res.status(500).json({ error: 'internal server error' });
    }
  });

  app.patch('/tasks/:taskId', (req: Request, res: Response) => {
    try {
      const userId = typeof req.query['userId'] === 'string' ? req.query['userId'] : '';
      if (!userId) { res.status(400).json({ error: 'userId required' }); return; }
      const taskId = parseInt(req.params['taskId'] ?? '', 10);
      if (!Number.isFinite(taskId)) {
        res.status(400).json({ error: 'invalid taskId' });
        return;
      }
      const status = req.body?.status as string | undefined;
      if (status !== 'done' && status !== 'pending') {
        res.status(400).json({ error: 'status must be "done" or "pending"' });
        return;
      }
      const mappedStatus: 'open' | 'done' = status === 'pending' ? 'open' : 'done';
      const updated = updateTask(userId, taskId, { status: mappedStatus });
      if (!updated) { res.status(404).json({ error: 'task not found' }); return; }
      const all = [...getTasks(userId, 'open'), ...getTasks(userId, 'done')];
      const task = all.find((t) => t.id === taskId);
      res.json({ task: task ?? null });
    } catch (e) {
      console.error('[osiris:http] PATCH /tasks/:taskId failed', e);
      res.status(500).json({ error: 'internal server error' });
    }
  });

  app.post('/internal/push-test', (req, res) => {
    const { text, urgency } = req.body as { text?: string; urgency?: string };
    const u = urgency || 'normal';
    const t = text || '';
    console.log(`[PUSH] ${u}: ${t}`);
    res.json({ ok: true });
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
