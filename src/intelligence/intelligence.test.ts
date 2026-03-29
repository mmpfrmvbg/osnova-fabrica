import { describe, expect, it } from 'vitest';

import { PlanAgent } from '../agents/plan-agent';
import * as intelligence from './index';
import type { IntelligenceSignal } from './index';

describe('intelligence integration (index + planner)', () => {
  it('barrel exports stable public API shape', () => {
    expect(typeof intelligence.buildLinearPlanSteps).toBe('function');
    expect(typeof intelligence.buildExecutionPlanCore).toBe('function');
    expect(typeof intelligence.runLifecycleWithStore).toBe('function');
    expect(typeof intelligence.withTimeout).toBe('function');
    expect(typeof intelligence.createDefaultPlannerSignalStoreAdapter).toBe('function');
    expect(typeof intelligence.createDefaultSummarizerPort).toBe('function');
    expect(typeof intelligence.updateRfcStatusWithStore).toBe('function');
    expect(typeof intelligence.runCollector).toBe('function');
    expect(typeof intelligence.selectTopSignals).toBe('function');
    expect(typeof intelligence.buildDigestMessage).toBe('function');
    expect(typeof intelligence.runLifecycle).toBe('function');
    expect(typeof intelligence.updateLifecycle).toBe('function');
    expect(typeof intelligence.update_rfc_status).toBe('function');
    expect(typeof intelligence.appendSignal).toBe('function');
    expect(typeof intelligence.readSignals).toBe('function');
    expect(typeof intelligence.upsertSignal).toBe('function');
    expect(typeof intelligence.writeSignals).toBe('function');
  });

  it('happy path: plan from barrel passes PlanAgent validation; lifecycle on mocked store port', async () => {
    const agent = new PlanAgent();
    const plan = intelligence.buildExecutionPlanCore(
      { planId: 'p-smoke', intentId: 'i-smoke', specId: 's-smoke' },
      { fromScratch: true, includeRepair: false },
    );
    expect(() => agent.validatePlan(plan)).not.toThrow();

    const signal: IntelligenceSignal = {
      id: 'sig-smoke',
      source: 'test',
      title: 'Smoke',
      url: 'https://example.invalid/smoke',
      raw_date: '2026-01-01T00:00:00.000Z',
      fetched_at: '2026-01-01T00:00:00.000Z',
      status: 'new',
      tags: [],
    };

    let written: IntelligenceSignal[] | null = null;
    const store = {
      readSignals: async () => [signal],
      writeSignals: async (signals: IntelligenceSignal[]) => {
        written = signals;
      },
      upsertSignal: async () => {},
    };

    const { transitions, decayed } = await intelligence.runLifecycleWithStore(store);
    expect(written).not.toBeNull();
    expect(written).toHaveLength(1);
    expect(written![0]!.id).toBe('sig-smoke');
    expect(Array.isArray(transitions)).toBe(true);
    expect(typeof decayed).toBe('number');
  });
});
