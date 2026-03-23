// apps/osiris/src/http/server.ts
import * as crypto from 'crypto';
import express, { type Request, type Response } from 'express';
import { handleMessage } from '../core/message-handler';
import { runOsirisPipeline } from '../osnova/client';
import { startTunnel } from './tunnel';

const OSIRIS_VERSION = '0.1.0';

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

export async function startHttpServer(opts?: StartHttpServerOptions): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(express.text({ type: 'text/plain' }));

  const port = Number(process.env.HTTP_PORT ?? 3000);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid HTTP_PORT: ${process.env.HTTP_PORT ?? ''}`);
  }

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', version: OSIRIS_VERSION });
  });

  app.get('/server-url', (_req: Request, res: Response) => {
    res.json({ url: process.env.TUNNEL_URL ?? `http://localhost:${port}` });
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

  app.post('/pipeline', async (req: Request, res: Response) => {
    try {
      let body: PipelineRequestBody = {};
      if (typeof req.body === 'string') {
        try {
          body = JSON.parse(req.body) as PipelineRequestBody;
        } catch {
          res.status(400).json({ status: 'error', error: 'invalid JSON in text/plain body' });
          return;
        }
      } else if (req.body && typeof req.body === 'object') {
        body = req.body as PipelineRequestBody;
      }

      if (!body.task || typeof body.task !== 'string' || body.task.trim().length === 0) {
        res.status(400).json({ status: 'error', error: 'task is required string' });
        return;
      }

      const task = body.task.trim();
      console.log(`[osiris:http] POST /pipeline task="${task}"`);
      const result = await runOsirisPipeline(task);
      res.json({ status: result.status === 'success' ? 'ok' : 'error', result });
    } catch (e) {
      console.error('[osiris:http] POST /pipeline failed', e);
      res.status(500).json({ status: 'error', error: 'internal server error' });
    }
  });

  await new Promise<void>((resolve, reject) => {
    const server = app.listen(port, () => {
      console.log('Осирис ready');
      console.log(`Version: ${OSIRIS_VERSION}`);
      console.log(`Mode: HTTP (port ${port})`);
      if (opts?.tunnel === true) {
        startTunnel(port);
      }
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
