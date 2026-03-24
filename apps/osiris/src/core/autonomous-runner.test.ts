import { describe, expect, it, vi, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

describe('autonomous-runner', () => {
  const tempRoot = path.join(os.tmpdir(), 'osiris-autonomous-tests');

  afterEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    delete process.env['OSIRIS_DB_PATH'];
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });

  it('startAutonomousJob → done on first iteration', async () => {
    await fs.promises.mkdir(tempRoot, { recursive: true });
    const dbPath = path.join(tempRoot, `osiris-${Date.now()}.db`);
    process.env['OSIRIS_DB_PATH'] = dbPath;

    // Мокаем llm-router до импорта runner
    vi.mock('./llm-router', () => ({
      call: vi.fn().mockResolvedValue({
        text: '{"done":true,"result":"тест выполнен"}',
        toolCalls: [],
        tokensUsed: { prompt: 0, completion: 0 },
        model: 'mock',
      }),
    }));

    const runner = await import('./autonomous-runner');

    const jobId = await runner.startAutonomousJob('user-auto-test', 'тестовая цель');
    expect(typeof jobId).toBe('string');
    expect(jobId.startsWith('job_')).toBe(true);

    // Ждём setImmediate + async runJobLoop
    await new Promise<void>((resolve) => setTimeout(resolve, 150));

    const job = await runner.getJobStatus(jobId);
    expect(job).not.toBeNull();
    expect(job!.status).toBe('done');
    expect(job!.result).toContain('тест выполнен');

    const { closeDb } = await import('../db/migrations');
    closeDb();
  });
});
