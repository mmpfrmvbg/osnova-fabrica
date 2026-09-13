/**
 * Тесты self-improve петли над ядром (full-file режим, mock-порты).
 * Проверяют: сходимость, остановку по лимиту, отклонение вне зоны, ошибку применения.
 */

import { describe, it, expect, vi } from 'vitest';
import { selfImprove, type PatchGenPort, type PatchPort, type GatePort } from './core';

const GOOD_EDITS = [
  '=== src/compiler/semanticKinds.ts ===',
  'export const BLOCKING_SEMANTIC_KINDS = ["unknown_syscall"];',
  'export const NON_BLOCKING_SEMANTIC_KINDS = ["break_outside_loop"];',
  'export const ALL_SEMANTIC_KINDS = [...BLOCKING_SEMANTIC_KINDS, ...NON_BLOCKING_SEMANTIC_KINDS];',
  '=== src/compiler/semanticKinds.test.ts ===',
  'import { describe, it, expect } from "vitest";',
  'import { ALL_SEMANTIC_KINDS } from "./semanticKinds";',
  'describe("ALL_SEMANTIC_KINDS", () => { it("объединяет списки", () => expect(ALL_SEMANTIC_KINDS.length).toBe(2)); });',
].join('\n');

const FORBIDDEN_EDITS = [
  '=== .qwen/oauth_creds.json ===',
  '{"secret": true}',
].join('\n');

function makeGen(returns: string): PatchGenPort {
  return { generate: vi.fn().mockResolvedValue(returns) };
}

function makePatch(opts?: { failApply?: boolean }): {
  port: PatchPort;
  apply: ReturnType<typeof vi.fn>;
  revert: ReturnType<typeof vi.fn>;
} {
  const apply = vi.fn().mockImplementation(async () => {
    if (opts?.failApply) throw new Error('write failed');
  });
  const revert = vi.fn().mockResolvedValue(undefined);
  return { port: { apply, revert }, apply, revert };
}

function makeGate(passed: boolean, output = ''): { port: GatePort; run: ReturnType<typeof vi.fn> } {
  const run = vi.fn().mockResolvedValue({ passed, output });
  return { port: { run }, run };
}

const OPTS = {
  allowedPaths: ['src/compiler'],
  forbiddenPaths: ['.qwen', 'forge', 'Fabrika2.0'],
  maxIterations: 3,
  readFile: async () => '',
  traceFile: 'runs/self-improve-traces.test.jsonl',
};

describe('selfImprove (full-file, mock ports)', () => {
  it('сходится к success при зелёном гейте', async () => {
    const gen = makeGen(GOOD_EDITS);
    const patch = makePatch();
    const gate = makeGate(true);

    const result = await selfImprove('добавить ALL_SEMANTIC_KINDS', OPTS, {
      gen: gen as unknown as PatchGenPort,
      patch: patch.port,
      gate: gate.port,
    });

    expect(result.status).toBe('success');
    expect(result.edits).toBeDefined();
    expect(Object.keys(result.edits!)).toHaveLength(2);
    const last = result.iterations[result.iterations.length - 1];
    expect(last?.status).toBe('passed');
    expect(patch.revert).not.toHaveBeenCalled();
  });

  it('откатывает и повторяет до лимита при падающем гейте', async () => {
    const gen = makeGen(GOOD_EDITS);
    const patch = makePatch();
    const gate = makeGate(false, 'test failed: expected 2');

    const result = await selfImprove('добавить ALL_SEMANTIC_KINDS', OPTS, {
      gen: gen as unknown as PatchGenPort,
      patch: patch.port,
      gate: gate.port,
    });

    expect(result.status).toBe('exhausted');
    expect(patch.apply).toHaveBeenCalledTimes(3);
    expect(patch.revert).toHaveBeenCalledTimes(3);
    const secondCall = (gen.generate as ReturnType<typeof vi.fn>).mock.calls[1]![0];
    expect(secondCall.feedback.length).toBeGreaterThan(0);
  });

  it('отклоняет правку вне разрешённой зоны', async () => {
    const gen = makeGen(FORBIDDEN_EDITS);
    const patch = makePatch();
    const gate = makeGate(true);

    const result = await selfImprove('добавить ALL_SEMANTIC_KINDS', OPTS, {
      gen: gen as unknown as PatchGenPort,
      patch: patch.port,
      gate: gate.port,
    });

    expect(result.status).toBe('exhausted');
    expect(patch.apply).not.toHaveBeenCalled();
    for (const it of result.iterations) {
      expect(it.status).toBe('rejected');
      expect(it.errorKind).toBe('invalid_edits');
    }
  });

  it('обрабатывает ошибку применения и откатывается', async () => {
    const gen = makeGen(GOOD_EDITS);
    const patch = makePatch({ failApply: true });
    const gate = makeGate(true);

    const result = await selfImprove('добавить ALL_SEMANTIC_KINDS', OPTS, {
      gen: gen as unknown as PatchGenPort,
      patch: patch.port,
      gate: gate.port,
    });

    expect(result.status).toBe('exhausted');
    expect(result.iterations.every(i => i.errorKind === 'apply')).toBe(true);
    expect(patch.revert).toHaveBeenCalledTimes(3);
  });
});
