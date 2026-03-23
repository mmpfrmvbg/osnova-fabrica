import { describe, expect, it } from 'vitest';
import { aggregatePipelineMetrics, parsePipelineEvents, runPipelineMetrics } from './pipeline-metrics';

describe('pipeline-metrics parser and aggregation', () => {
  const args = { file: './osiris.out.log', json: false } as const;

  it('parses valid pipeline_completed JSON and skips garbage', () => {
    const lines = [
      'random text',
      '{"component":"osiris_pipeline","event":"pipeline_completed","ts":"2026-03-23T10:00:00.000Z","status":"ok","pipelineStatus":"success","duration_ms":100}',
      '{"component":"osiris_pipeline","event":"pipeline_completed","ts":"2026-03-23T10:01:00.000Z","status":"error","pipelineStatus":"repair_exhausted","duration_ms":200}',
      '{"component":"other","event":"pipeline_completed","ts":"2026-03-23T10:02:00.000Z","status":"ok","pipelineStatus":"success"}',
      '{"component":"osiris_pipeline","event":"pipeline_completed","ts":"bad-date","status":"ok","pipelineStatus":"success"}',
      '{"component":"osiris_pipeline","event":"pipeline_completed","ts":"2026-03-23T10:03:00.000Z","status":"ok","pipelineStatus":"bad"}',
    ];
    const parsed = parsePipelineEvents(lines, args);
    expect(parsed).toHaveLength(2);
  });

  it('aggregates counts, rates, daily buckets and duration', () => {
    const lines = [
      '{"component":"osiris_pipeline","event":"pipeline_completed","ts":"2026-03-23T10:00:00.000Z","status":"ok","pipelineStatus":"success","duration_ms":100}',
      '{"component":"osiris_pipeline","event":"pipeline_completed","ts":"2026-03-23T10:01:00.000Z","status":"ok","pipelineStatus":"partial","duration_ms":300}',
      '{"component":"osiris_pipeline","event":"pipeline_completed","ts":"2026-03-24T10:01:00.000Z","status":"error","pipelineStatus":"repair_exhausted","duration_ms":200}',
      '{"component":"osiris_pipeline","event":"pipeline_completed","ts":"2026-03-24T10:02:00.000Z","status":"error","pipelineStatus":"error","duration_ms":400}',
    ];
    const parsed = parsePipelineEvents(lines, args);
    const report = aggregatePipelineMetrics(parsed, args);

    expect(report.totalRuns).toBe(4);
    expect(report.byStatus.success).toBe(1);
    expect(report.byStatus.partial).toBe(1);
    expect(report.byStatus.repair_exhausted).toBe(1);
    expect(report.byStatus.error).toBe(1);
    expect(report.rates.success).toBe(0.25);
    expect(report.daily).toHaveLength(2);
    expect(report.duration.min).toBe(100);
    expect(report.duration.max).toBe(400);
    expect(report.duration.avg).toBe(250);
  });

  it('supports date range filters and tolerates empty output', () => {
    const lines = [
      '{"component":"osiris_pipeline","event":"pipeline_completed","ts":"2026-03-20T10:00:00.000Z","status":"ok","pipelineStatus":"success"}',
      '{"component":"osiris_pipeline","event":"pipeline_completed","ts":"2026-03-24T10:00:00.000Z","status":"error","pipelineStatus":"error"}',
    ];
    const report = runPipelineMetrics(lines, {
      file: './osiris.out.log',
      json: true,
      from: '2026-03-24',
      to: '2026-03-24',
    });
    expect(report.totalRuns).toBe(1);
    expect(report.byStatus.error).toBe(1);
  });
});
