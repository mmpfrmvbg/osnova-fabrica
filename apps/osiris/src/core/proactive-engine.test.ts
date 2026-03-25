import { describe, expect, it, vi, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

describe('proactive-engine: stale task trigger', () => {
  const tempRoot = path.join(os.tmpdir(), 'osiris-proactive-tests');

  afterEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    delete process.env['OSIRIS_DB_PATH'];
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });

  it('notifyPush вызывается при задаче старше 3 дней', async () => {
    await fs.promises.mkdir(tempRoot, { recursive: true });
    const dbPath = path.join(tempRoot, `osiris-${Date.now()}.db`);
    process.env['OSIRIS_DB_PATH'] = dbPath;

    // Мокаем notifyPush
    const pushCalls: Array<{ text: string; urgency: string }> = [];
    vi.doMock('./tools/system-tools', () => ({
      shellExec: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
      notifyPush: vi.fn().mockImplementation(
        async (text: string, urgency: string) => { pushCalls.push({ text, urgency }); },
      ),
      fileRead: vi.fn(),
      gitStatus: vi.fn(),
      gitCommitDiff: vi.fn(),
    }));

    const { migrate } = await import('../db/migrations');
    migrate();

    await import('./memory-engine');

    // Создать задачу с датой создания 5 дней назад
    const staleDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const { getDb } = await import('../db/migrations');
    getDb().prepare(
      `INSERT INTO tasks (user_id, title, status, project, created_at, updated_at)
       VALUES (?, ?, 'open', 'general', ?, ?)`,
    ).run('test-proactive-user', 'Старая задача', staleDate, staleDate);

    const { checkProactiveTriggers } = await import('./proactive-engine');
    await checkProactiveTriggers('test-proactive-user');

    const stalePush = pushCalls.find((c) => c.text.includes('Задача без активности'));
    expect(stalePush).toBeDefined();
    expect(stalePush!.urgency).toBe('low');

    const { closeDb } = await import('../db/migrations');
    closeDb();
  });
});
