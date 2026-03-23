import { describe, expect, it } from 'vitest';
import { buildPipelineCompletedEvent } from './pipeline-observability';

describe('pipeline_completed event builder', () => {
  it('builds canonical event with required fields', () => {
    const event = buildPipelineCompletedEvent({
      httpStatus: 200,
      status: 'ok',
      pipelineStatus: 'success',
      durationMs: 123.4,
    });

    expect(event.component).toBe('osiris_pipeline');
    expect(event.event).toBe('pipeline_completed');
    expect(event.status).toBe('ok');
    expect(event.pipelineStatus).toBe('success');
    expect(event.duration_ms).toBe(123);
    expect(typeof event.ts).toBe('string');
    expect(Date.parse(event.ts)).not.toBeNaN();
  });

  it('fills optional fields with nulls when absent', () => {
    const event = buildPipelineCompletedEvent({
      httpStatus: 500,
      status: 'error',
      pipelineStatus: 'error',
    });
    expect(event.traceId).toBeNull();
    expect(event.runId).toBeNull();
    expect(event.userId).toBeNull();
    expect(event.sessionId).toBeNull();
    expect(event.mode).toBeNull();
    expect(event.duration_ms).toBeNull();
  });
});
