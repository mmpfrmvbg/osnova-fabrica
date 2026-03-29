import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./summarizer', () => ({
  summarizeItem: vi.fn(),
}));

import { PlanAgent } from '../agents/plan-agent';
import {
  buildExecutionPlanCore,
  buildLinearPlanSteps,
  createDefaultPlannerSignalStoreAdapter,
  createDefaultSummarizerPort,
  runLifecycleWithStore,
  updateRfcStatusWithStore,
  withTimeout,
} from './planner';
import * as summarizer from './summarizer';
import type { IntelligenceSignal } from './store';

describe('planner (pure core)', () => {
  const agent = new PlanAgent();

  it('buildLinearPlanSteps: fromScratch adds intake → spec_generation → g1 before codegen', () => {
    const steps = buildLinearPlanSteps({ fromScratch: true, includeRepair: false });
    expect(steps.map((s) => s.phase)).toEqual([
      'intake',
      'spec_generation',
      'g1_spec_ready',
      'codegen',
      'build',
      'golden_check',
    ]);
    steps.forEach((s, i) => {
      expect(s.order).toBe(i + 1);
    });
  });

  it('buildLinearPlanSteps: incremental starts at codegen', () => {
    const steps = buildLinearPlanSteps({ fromScratch: false, includeRepair: false });
    expect(steps.map((s) => s.phase)).toEqual(['codegen', 'build', 'golden_check']);
  });

  it('buildLinearPlanSteps: includeRepair appends single repair after golden_check', () => {
    const steps = buildLinearPlanSteps({ fromScratch: false, includeRepair: true });
    expect(steps[steps.length - 1]!.phase).toBe('repair');
  });

  it('defaults match PlanAgent (fromScratch false, includeRepair true)', () => {
    const stepsDefault = buildLinearPlanSteps({});
    expect(stepsDefault.map((s) => s.phase)).toEqual(['codegen', 'build', 'golden_check', 'repair']);
  });

  it('buildExecutionPlanCore passes PlanAgent.validatePlan', () => {
    const full = buildExecutionPlanCore(
      { planId: 'plan-1', intentId: 'intent-1', specId: 'spec-1' },
      { fromScratch: true, includeRepair: true },
    );
    expect(() => agent.validatePlan(full)).not.toThrow();

    const inc = buildExecutionPlanCore(
      { planId: 'plan-2', intentId: 'intent-2', specId: 'spec-2' },
      { fromScratch: false, includeRepair: false },
    );
    expect(() => agent.validatePlan(inc)).not.toThrow();
  });

  it('withTimeout propagates rejection from the wrapped promise', async () => {
    await expect(
      withTimeout(Promise.reject(new Error('inner fail')), 5000),
    ).rejects.toThrow(/inner fail/);
  });
});

describe('planner: empty store and single-signal lifecycle (mock store)', () => {
  it('runLifecycleWithStore: empty read yields no transitions, decayed 0, writes empty list', async () => {
    const store = {
      readSignals: vi.fn().mockResolvedValue([]),
      writeSignals: vi.fn().mockResolvedValue(undefined),
      upsertSignal: vi.fn().mockResolvedValue(undefined),
    };
    const { transitions, decayed } = await runLifecycleWithStore(store);
    expect(transitions).toEqual([]);
    expect(decayed).toBe(0);
    expect(store.writeSignals).toHaveBeenCalledWith([], undefined);
  });

  it('runLifecycleWithStore: single new signal → one new→watching transition', async () => {
    const now = new Date().toISOString();
    const row: IntelligenceSignal = {
      id: 'only',
      source: 'mock',
      title: 't',
      url: 'u',
      raw_date: now,
      fetched_at: now,
      status: 'new',
      tags: [],
    };
    const store = {
      readSignals: vi.fn().mockResolvedValue([row]),
      writeSignals: vi.fn().mockResolvedValue(undefined),
      upsertSignal: vi.fn().mockResolvedValue(undefined),
    };
    const { transitions, decayed } = await runLifecycleWithStore(store);
    expect(decayed).toBe(0);
    expect(transitions).toEqual([{ id: 'only', from: 'new', to: 'watching' }]);
    const written = store.writeSignals.mock.calls[0]![0] as IntelligenceSignal[];
    expect(written).toHaveLength(1);
    expect(written[0]?.status).toBe('watching');
  });
});

describe('planner: failure propagation (mock ports)', () => {
  it('runLifecycleWithStore: readSignals rejection surfaces', async () => {
    const store = {
      readSignals: vi.fn().mockRejectedValue(new Error('read failed')),
      writeSignals: vi.fn(),
      upsertSignal: vi.fn(),
    };
    await expect(runLifecycleWithStore(store)).rejects.toThrow(/read failed/);
    expect(store.writeSignals).not.toHaveBeenCalled();
  });

  it('runLifecycleWithStore: writeSignals rejection surfaces', async () => {
    const store = {
      readSignals: vi.fn().mockResolvedValue([]),
      writeSignals: vi.fn().mockRejectedValue(new Error('write failed')),
      upsertSignal: vi.fn(),
    };
    await expect(runLifecycleWithStore(store)).rejects.toThrow(/write failed/);
  });

  it('updateRfcStatusWithStore: readSignals rejection surfaces', async () => {
    const store = {
      readSignals: vi.fn().mockRejectedValue(new Error('read err')),
      writeSignals: vi.fn(),
      upsertSignal: vi.fn(),
    };
    await expect(updateRfcStatusWithStore(store, 'x', 'watching')).rejects.toThrow(/read err/);
  });

  it('updateRfcStatusWithStore: upsertSignal rejection surfaces', async () => {
    const sig: IntelligenceSignal = {
      id: 'x',
      source: 't',
      title: 't',
      url: 'u',
      raw_date: 'r',
      fetched_at: 'f',
      status: 'new',
      tags: [],
    };
    const store = {
      readSignals: vi.fn().mockResolvedValue([sig]),
      writeSignals: vi.fn().mockResolvedValue(undefined),
      upsertSignal: vi.fn().mockRejectedValue(new Error('upsert err')),
    };
    await expect(updateRfcStatusWithStore(store, 'x', 'watching')).rejects.toThrow(/upsert err/);
  });
});

describe('createDefaultSummarizerPort (mocked summarizer, no network)', () => {
  beforeEach(() => {
    vi.mocked(summarizer.summarizeItem).mockReset();
  });

  it('delegates to summarizeItem and returns resolved value', async () => {
    vi.mocked(summarizer.summarizeItem).mockResolvedValue({
      summary: 'ok',
      relevance_score: 0.7,
    });
    const port = createDefaultSummarizerPort({ timeoutMs: 5000 });
    const item = { title: 'a', url: 'https://example.com' };
    await expect(port.summarizeItem(item)).resolves.toEqual({
      summary: 'ok',
      relevance_score: 0.7,
    });
    expect(summarizer.summarizeItem).toHaveBeenCalledWith(item);
  });

  it('propagates summarizeItem rejection', async () => {
    vi.mocked(summarizer.summarizeItem).mockRejectedValue(new Error('llm down'));
    const port = createDefaultSummarizerPort({ timeoutMs: 5000 });
    await expect(port.summarizeItem({ title: 'a', url: 'u' })).rejects.toThrow(/llm down/);
  });

  it('rejects on timeout when summarizeItem never settles', async () => {
    vi.mocked(summarizer.summarizeItem).mockImplementation(
      () => new Promise(() => {}),
    );
    const port = createDefaultSummarizerPort({ timeoutMs: 30 });
    await expect(port.summarizeItem({ title: 'a', url: 'u' })).rejects.toThrow(
      /summarizer\.summarizeItem: timeout after 30ms/,
    );
  });
});

describe('planner IO hooks (ports + timeouts)', () => {
  it('withTimeout resolves when promise settles first', async () => {
    await expect(withTimeout(Promise.resolve(42), 5000)).resolves.toBe(42);
  });

  it('withTimeout rejects after ms', async () => {
    await expect(
      withTimeout(new Promise(() => {}), 20, 'stall'),
    ).rejects.toThrow(/stall: timeout after 20ms/);
  });

  it('runLifecycleWithStore uses injected store (decay + lifecycle)', async () => {
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    let written: IntelligenceSignal[] = [];
    const store = {
      readSignals: vi.fn().mockResolvedValue([
        {
          id: 'a',
          source: 't',
          title: 't',
          url: 'u',
          raw_date: now,
          fetched_at: old,
          status: 'watching' as const,
          tags: [],
        },
        {
          id: 'b',
          source: 't',
          title: 't2',
          url: 'u2',
          raw_date: now,
          fetched_at: now,
          status: 'new' as const,
          tags: [],
        },
      ]),
      writeSignals: vi.fn(async (s: IntelligenceSignal[]) => {
        written = [...s];
      }),
      upsertSignal: vi.fn().mockResolvedValue(undefined),
    };

    const { transitions, decayed } = await runLifecycleWithStore(store);
    expect(decayed).toBe(1);
    expect(transitions.some((t) => t.id === 'b' && t.to === 'watching')).toBe(true);
    const archived = written.find((s) => s.id === 'a');
    expect(archived?.status).toBe('archived');
  });

  it('updateRfcStatusWithStore upserts via port', async () => {
    const sig: IntelligenceSignal = {
      id: 'x',
      source: 't',
      title: 't',
      url: 'u',
      raw_date: 'r',
      fetched_at: 'f',
      status: 'new',
      tags: [],
    };
    const upsertSignal = vi.fn().mockResolvedValue(undefined);
    const store = {
      readSignals: vi.fn().mockResolvedValue([sig]),
      writeSignals: vi.fn().mockResolvedValue(undefined),
      upsertSignal,
    };
    await updateRfcStatusWithStore(store, 'x', 'watching');
    expect(upsertSignal).toHaveBeenCalledWith({ ...sig, status: 'watching' }, undefined);
  });

  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      tmpDir = undefined;
    }
  });

  it('createDefaultPlannerSignalStoreAdapter read/write roundtrip', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'planner-store-'));
    const file = join(tmpDir, 'signals.jsonl');
    const adapter = createDefaultPlannerSignalStoreAdapter({ timeoutMs: 5000 });
    const row: IntelligenceSignal = {
      id: '1',
      source: 's',
      title: 'title',
      url: 'https://x',
      raw_date: 'd',
      fetched_at: 'f',
      status: 'new',
      tags: ['t'],
    };
    await adapter.writeSignals([row], file);
    const readBack = await adapter.readSignals(file);
    expect(readBack).toEqual([row]);
  });
});
