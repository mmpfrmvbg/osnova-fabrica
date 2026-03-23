export async function checkConnectivity(): Promise<{ online: boolean; latency?: number }> {
  const controller = new AbortController();
  const startedAt = Date.now();
  const abortTimeoutId = setTimeout(() => controller.abort(), 3000);
  let raceTimeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    raceTimeoutId = setTimeout(() => reject(new Error('connectivity timeout')), 3000);
  });

  try {
    await Promise.race([
      fetch('/api/health', {
        method: 'HEAD',
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);
    return { online: true, latency: Date.now() - startedAt };
  } catch {
    return { online: false };
  } finally {
    clearTimeout(abortTimeoutId);
    if (raceTimeoutId) clearTimeout(raceTimeoutId);
  }
}
