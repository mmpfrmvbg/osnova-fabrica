import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FactDraft } from '../types';

describe('memory-engine saveFacts', () => {
  const tempRoot = path.join(os.tmpdir(), 'osiris-memory-engine-tests');

  afterEach(async () => {
    vi.resetModules();
    delete process.env.OSIRIS_DB_PATH;
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });

  it('saves facts for provided userId and reads them back', async () => {
    await fs.promises.mkdir(tempRoot, { recursive: true });
    const dbPath = path.join(tempRoot, `osiris-${Date.now()}.db`);
    process.env.OSIRIS_DB_PATH = dbPath;

    const memory = await import('./memory-engine');
    const drafts: FactDraft[] = [
      {
        kind: 'user_profile',
        project: 'assistant',
        text: 'Любит лаконичные ответы',
        importance: 3,
      },
      {
        kind: 'preference',
        project: 'assistant',
        text: 'Предпочитает TypeScript',
        importance: 4,
      },
    ];

    const saved = await memory.saveFacts(drafts, 0, 'user-test-123');
    const recent = await memory.getRecentFacts('user-test-123');

    expect(saved.length).toBeGreaterThan(0);
    expect(recent.length).toBeGreaterThan(0);
    expect(recent.map((f) => f.text)).toEqual(expect.arrayContaining(drafts.map((d) => d.text)));

    const db = (await import('../db/migrations')).getDb();
    const owners = db
      .prepare('SELECT DISTINCT user_id FROM facts WHERE text IN (?, ?)')
      .all(drafts[0].text, drafts[1].text) as Array<{ user_id: string }>;

    expect(owners).toEqual([{ user_id: 'user-test-123' }]);

    (await import('../db/migrations')).closeDb();
  });
});

describe('memory-engine core_memory', () => {
  const tempRoot = path.join(os.tmpdir(), 'osiris-core-memory-tests');

  afterEach(async () => {
    vi.resetModules();
    delete process.env.OSIRIS_DB_PATH;
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });

  it('updateCoreMemory merges patch and increments version', async () => {
    await fs.promises.mkdir(tempRoot, { recursive: true });
    const dbPath = path.join(tempRoot, `osiris-${Date.now()}.db`);
    process.env.OSIRIS_DB_PATH = dbPath;

    const memory = await import('./memory-engine');

    // Первое обновление — запись создаётся
    await memory.updateCoreMemory('user-cm-test', {
      user: { name: 'Михаил', role: null, style: null, current_focus: null },
    });

    const first = await memory.getCoreMemory('user-cm-test');
    expect(first.user.name).toBe('Михаил');
    expect(first.meta.interaction_count).toBe(0); // не тронуто

    // Второе обновление — merge поверх
    await memory.updateCoreMemory('user-cm-test', {
      user: { name: 'Михаил', role: null, style: null, current_focus: 'Осирис' },
      meta: { interaction_count: 5, last_session: null },
    });

    const second = await memory.getCoreMemory('user-cm-test');
    expect(second.user.name).toBe('Михаил');
    expect(second.user.current_focus).toBe('Осирис');
    expect(second.meta.interaction_count).toBe(5);

    // Версия инкрементирована дважды
    const db = (await import('../db/migrations')).getDb();
    const row = db
      .prepare('SELECT version FROM core_memory WHERE user_id = ?')
      .get('user-cm-test') as { version: number };
    expect(row.version).toBe(2);

    (await import('../db/migrations')).closeDb();
  });
});

describe('memory-engine session_summaries', () => {
  const tempRoot = path.join(os.tmpdir(), 'osiris-session-summary-tests');

  afterEach(async () => {
    vi.resetModules();
    delete process.env.OSIRIS_DB_PATH;
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });

  it('saveSessionSummary and getSessionSummaries returns DESC order', async () => {
    await fs.promises.mkdir(tempRoot, { recursive: true });
    const dbPath = path.join(tempRoot, `osiris-${Date.now()}.db`);
    process.env.OSIRIS_DB_PATH = dbPath;

    const memory = await import('./memory-engine');

    await memory.saveSessionSummary('user-ss-test', 'Первое резюме сессии', 10);
    // небольшая задержка чтобы created_at различался
    await new Promise<void>((r) => setTimeout(r, 10));
    await memory.saveSessionSummary('user-ss-test', 'Второе резюме сессии', 20);

    const summaries = await memory.getSessionSummaries('user-ss-test', 3);

    expect(summaries.length).toBe(2);
    // DESC: последнее первым
    expect(summaries[0].summary).toBe('Второе резюме сессии');
    expect(summaries[1].summary).toBe('Первое резюме сессии');
    expect(summaries[0].messageCount).toBe(20);

    (await import('../db/migrations')).closeDb();
  });
});

describe('memory-engine graph', () => {
  const tempRoot = path.join(os.tmpdir(), 'osiris-graph-tests');

  afterEach(async () => {
    vi.resetModules();
    delete process.env.OSIRIS_DB_PATH;
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });

  it('graphRemember and graphRecall finds relation', async () => {
    await fs.promises.mkdir(tempRoot, { recursive: true });
    const dbPath = path.join(tempRoot, `osiris-${Date.now()}.db`);
    process.env.OSIRIS_DB_PATH = dbPath;

    const memory = await import('./memory-engine');

    await memory.graphRemember('user-graph-test', 'Осирис', 'служит', 'Создателю');
    await memory.graphRemember('user-graph-test', 'Проект Основа', 'использует', 'Capacitor');

    const result = await memory.graphRecall('user-graph-test', 'Осирис');

    expect(result.entities.length).toBeGreaterThan(0);
    const names = result.entities.map((e) => e.name);
    expect(names).toContain('Осирис');

    expect(result.relations.length).toBeGreaterThan(0);
    const predicates = result.relations.map((r) => r.predicate);
    expect(predicates).toContain('служит');

    (await import('../db/migrations')).closeDb();
  });
});
