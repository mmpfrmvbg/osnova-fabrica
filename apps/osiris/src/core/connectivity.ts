import { getDb, migrate } from '../db/migrations';

let _initialized = false;
function ensureInit(): void {
  if (_initialized) return;
  migrate();
  _initialized = true;
}

export async function checkConnectivity(): Promise<{ online: boolean; latency?: number }> {
  const baseUrl = process.env.OSIRIS_HEALTH_URL?.replace(/\/$/, '') ?? 'http://localhost:3000';
  const url = `${baseUrl}/api/health`;

  const controller = new AbortController();
  const startedAt = Date.now();
  const abortTimeoutId = setTimeout(() => controller.abort(), 3000);
  let raceTimeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    raceTimeoutId = setTimeout(() => reject(new Error('connectivity timeout')), 3000);
  });

  let result: { online: boolean; latency?: number };

  try {
    await Promise.race([
      fetch(url, {
        method: 'HEAD',
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);
    result = { online: true, latency: Date.now() - startedAt };
  } catch {
    result = { online: false };
  } finally {
    clearTimeout(abortTimeoutId);
    if (raceTimeoutId) clearTimeout(raceTimeoutId);
  }

  // Персистировать результат в SQLite
  try {
    ensureInit();
    const db = getDb();
    db.prepare(
      `INSERT INTO connectivity_log (timestamp, online, latency_ms) VALUES (?, ?, ?)`
    ).run(
      new Date().toISOString(),
      result.online ? 1 : 0,
      result.latency ?? null,
    );
  } catch (err) {
    console.error('[connectivity] failed to persist log:', err);
  }

  return result;
}
