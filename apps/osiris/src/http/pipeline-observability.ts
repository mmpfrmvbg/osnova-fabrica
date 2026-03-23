import type { PipelineStatus } from '../../../../src/pipeline/types';

export interface PipelineCompletedEvent {
  ts: string;
  component: 'osiris_pipeline';
  event: 'pipeline_completed';
  httpStatus: number;
  status: 'ok' | 'error';
  pipelineStatus: PipelineStatus;
  duration_ms: number | null;
  traceId: string | null;
  runId: string | null;
  userId: string | null;
  sessionId: string | null;
  mode: string | null;
}

export function buildPipelineCompletedEvent(input: {
  httpStatus: number;
  status: 'ok' | 'error';
  pipelineStatus: PipelineStatus;
  durationMs?: number;
  traceId?: string | null;
  runId?: string | null;
  userId?: string | null;
  sessionId?: string | null;
  mode?: string | null;
}): PipelineCompletedEvent {
  return {
    ts: new Date().toISOString(),
    component: 'osiris_pipeline',
    event: 'pipeline_completed',
    httpStatus: input.httpStatus,
    status: input.status,
    pipelineStatus: input.pipelineStatus,
    duration_ms: Number.isFinite(input.durationMs) ? Math.max(0, Math.round(input.durationMs!)) : null,
    traceId: input.traceId ?? null,
    runId: input.runId ?? null,
    userId: input.userId ?? null,
    sessionId: input.sessionId ?? null,
    mode: input.mode ?? null,
  };
}

export function logPipelineCompletedEvent(event: PipelineCompletedEvent): void {
  console.log(JSON.stringify(event));
}
