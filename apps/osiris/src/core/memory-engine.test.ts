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
