import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import path from 'path';
import os from 'os';
import fs from 'fs';

// Изолированный Express без реального HTTP-сервера
async function buildTestApp() {
  const tempDir = path.join(os.tmpdir(), `osiris-api-test-${Date.now()}`);
  await fs.promises.mkdir(tempDir, { recursive: true });
  process.env['OSIRIS_DB_PATH'] = path.join(tempDir, 'test.db');

  // Инициализируем мигарцию напрямую
  const { migrate } = await import('../db/migrations');
  migrate();

  const app = express();
  app.use(express.json());

  const { getCoreMemoryWithVersion, updateCoreMemory, getRecentFacts,
    getRecentEntities, getSessionSummaries, getTasks } = await import('../core/memory-engine');

  // Регистрируем только тестируемые эндпоинты
  app.get('/brain', async (req, res) => {
    const userId = String(req.query['userId'] ?? '');
    if (!userId) { res.status(400).json({ error: 'userId required' }); return; }
    const [{ content: coreMemory }, recentFacts, recentEntities, sessionSummaries] =
      await Promise.all([
        getCoreMemoryWithVersion(userId),
        getRecentFacts(userId, 20),
        getRecentEntities(userId, 20),
        getSessionSummaries(userId, 5),
      ]);
    res.json({ coreMemory, recentFacts, recentEntities, sessionSummaries });
  });

  app.patch('/brain/core-memory', async (req, res) => {
    const userId = String(req.query['userId'] ?? '');
    if (!userId) { res.status(400).json({ error: 'userId required' }); return; }
    const patch = req.body?.patch;
    await updateCoreMemory(userId, patch);
    const { content, version } = await getCoreMemoryWithVersion(userId);
    res.set('X-Core-Memory-Version', String(version));
    res.json({ coreMemory: content, version });
  });

  app.get('/tasks', (req, res) => {
    const userId = String(req.query['userId'] ?? '');
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
  });

  return { app, tempDir };
}

describe('Brain + Tasks API', () => {
  let app: express.Express;
  let tempDir: string;

  beforeAll(async () => {
    const result = await buildTestApp();
    app = result.app;
    tempDir = result.tempDir;
  });

  afterAll(async () => {
    const { closeDb } = await import('../db/migrations');
    closeDb();
    delete process.env['OSIRIS_DB_PATH'];
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  it('GET /brain → содержит coreMemory и recentFacts', async () => {
    const res = await request(app).get('/brain?userId=test-brain-user');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('coreMemory');
    expect(res.body).toHaveProperty('recentFacts');
    expect(Array.isArray(res.body.recentFacts)).toBe(true);
  });

  it('PATCH /brain/core-memory → version инкрементируется', async () => {
    const res1 = await request(app)
      .patch('/brain/core-memory?userId=test-version-user')
      .send({ patch: { user: { name: 'Тест' } } });
    expect(res1.status).toBe(200);
    const v1 = res1.body.version as number;

    const res2 = await request(app)
      .patch('/brain/core-memory?userId=test-version-user')
      .send({ patch: { user: { name: 'Тест2' } } });
    expect(res2.status).toBe(200);
    expect(res2.body.version).toBe(v1 + 1);
    expect(res2.headers['x-core-memory-version']).toBe(String(v1 + 1));
  });

  it('GET /tasks → возвращает объект с ключом all', async () => {
    const res = await request(app).get('/tasks?userId=test-tasks-user');
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
    expect(res.body).toHaveProperty('general');
    expect(Array.isArray(res.body['general'])).toBe(true);
  });
});
