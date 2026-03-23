import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runOsirisPipeline, toCompatStatus } from './client';

vi.mock('../../../../src/pipeline/orchestrator', () => ({
  runPipeline: vi.fn(),
}));

import { runPipeline } from '../../../../src/pipeline/orchestrator';

describe('osiris pipeline status mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('success -> ok + pipelineStatus=success', async () => {
    vi.mocked(runPipeline).mockResolvedValueOnce({
      status: 'success',
      repairAttempts: 0,
      totalDurationMs: 1,
    });
    const result = await runOsirisPipeline('task');
    expect(result.status).toBe('ok');
    expect(result.pipelineStatus).toBe('success');
  });

  it('partial -> ok + pipelineStatus=partial', async () => {
    vi.mocked(runPipeline).mockResolvedValueOnce({
      status: 'partial',
      repairAttempts: 0,
      totalDurationMs: 1,
    });
    const result = await runOsirisPipeline('task');
    expect(result.status).toBe('ok');
    expect(result.pipelineStatus).toBe('partial');
  });

  it('repair_exhausted -> error + pipelineStatus=repair_exhausted', async () => {
    vi.mocked(runPipeline).mockResolvedValueOnce({
      status: 'repair_exhausted',
      repairAttempts: 3,
      totalDurationMs: 1,
    });
    const result = await runOsirisPipeline('task');
    expect(result.status).toBe('error');
    expect(result.pipelineStatus).toBe('repair_exhausted');
  });

  it('error -> error + pipelineStatus=error', async () => {
    vi.mocked(runPipeline).mockResolvedValueOnce({
      status: 'error',
      error: 'boom',
      repairAttempts: 0,
      totalDurationMs: 1,
    });
    const result = await runOsirisPipeline('task');
    expect(result.status).toBe('error');
    expect(result.pipelineStatus).toBe('error');
  });
});

describe('toCompatStatus', () => {
  it('maps all pipeline statuses to binary compatibility status', () => {
    expect(toCompatStatus('success')).toBe('ok');
    expect(toCompatStatus('partial')).toBe('ok');
    expect(toCompatStatus('repair_exhausted')).toBe('error');
    expect(toCompatStatus('error')).toBe('error');
  });
});
