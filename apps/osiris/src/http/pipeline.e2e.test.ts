import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHttpApp } from './server';

vi.mock('../osnova/client', () => ({
  runOsirisPipeline: vi.fn(),
}));

import { runOsirisPipeline } from '../osnova/client';

describe('POST /pipeline contract e2e', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('A: success -> status=ok, pipelineStatus=success', async () => {
    vi.mocked(runOsirisPipeline).mockResolvedValueOnce({
      status: 'ok',
      pipelineStatus: 'success',
      task: 'demo',
      summary: 'ok',
      raw: { status: 'success' },
    });

    const app = createHttpApp();
    const res = await request(app).post('/pipeline').send({ task: 'demo' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.pipelineStatus).toBe('success');
    expect(res.body.result).toBeDefined();
  });

  it('B: repair_exhausted -> status=error, pipelineStatus=repair_exhausted', async () => {
    vi.mocked(runOsirisPipeline).mockResolvedValueOnce({
      status: 'error',
      pipelineStatus: 'repair_exhausted',
      task: 'demo',
      summary: 'repair exhausted',
      raw: { status: 'repair_exhausted' },
    });

    const app = createHttpApp();
    const res = await request(app).post('/pipeline').send({ task: 'demo' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('error');
    expect(res.body.pipelineStatus).toBe('repair_exhausted');
    expect(res.body.result).toBeDefined();
  });

  it('C: partial -> status=ok, pipelineStatus=partial', async () => {
    vi.mocked(runOsirisPipeline).mockResolvedValueOnce({
      status: 'ok',
      pipelineStatus: 'partial',
      task: 'demo',
      summary: 'partial',
      raw: { status: 'partial' },
    });

    const app = createHttpApp();
    const res = await request(app).post('/pipeline').send({ task: 'demo' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.pipelineStatus).toBe('partial');
    expect(res.body.result).toBeDefined();
  });

  it('D: error -> status=error, pipelineStatus=error', async () => {
    vi.mocked(runOsirisPipeline).mockResolvedValueOnce({
      status: 'error',
      pipelineStatus: 'error',
      task: 'demo',
      summary: 'error',
      raw: { status: 'error' },
    });

    const app = createHttpApp();
    const res = await request(app).post('/pipeline').send({ task: 'demo' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('error');
    expect(res.body.pipelineStatus).toBe('error');
    expect(res.body.result).toBeDefined();
  });
});
