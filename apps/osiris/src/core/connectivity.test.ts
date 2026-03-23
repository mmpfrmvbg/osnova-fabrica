import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkConnectivity } from './connectivity';

describe('checkConnectivity', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('success: returns online true with latency', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(null, { status: 200 })));

    const result = await checkConnectivity();

    expect(result).toEqual({
      online: true,
      latency: expect.any(Number),
    });
  });

  it('fetch throws: returns online false', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('network error')));

    const result = await checkConnectivity();

    expect(result).toEqual({ online: false });
  });

  it('timeout: returns online false', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => new Promise(() => {})));

    const pending = checkConnectivity();
    await vi.advanceTimersByTimeAsync(3001);
    const result = await pending;

    expect(result).toEqual({ online: false });
  });
});
