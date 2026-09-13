/**
 * Тесты резидента (mock-порты): автономный цикл plan→execute→повтор.
 */

import { describe, it, expect, vi } from 'vitest';
import { resident, type PlannerPort, type ExecutorPort } from './core';

const OPTS = { maxRounds: 3, traceFile: 'runs/resident-traces.test.jsonl' };

function makeExec(): ExecutorPort {
  return {
    execute: vi.fn().mockResolvedValue({ status: 'success', summary: 'ok' }),
  };
}

describe('resident (mock ports)', () => {
  it('останавливается на done после исполнения раунда', async () => {
    const plan = vi.fn()
      .mockResolvedValueOnce({ mode: 'improve', goal: 'улучшить лексер' })
      .mockResolvedValue({ mode: 'done', goal: '' });
    const exec = makeExec();

    const result = await resident('развить язык', OPTS, {
      plan: { plan } as PlannerPort,
      exec,
    });

    expect(result.status).toBe('done');
    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[0]).toMatchObject({ mode: 'improve', status: 'success' });
    expect(result.rounds[1]).toMatchObject({ mode: 'done', status: 'done' });
    // планировщик вызван дважды: раунд + решение done
    expect(plan).toHaveBeenCalledTimes(2);
  });

  it('идёт до лимита раундов, если планировщик не говорит done', async () => {
    const plan = vi.fn().mockResolvedValue({ mode: 'loop', goal: 'сделать приложение' });
    const exec = makeExec();

    const result = await resident('развить язык', OPTS, {
      plan: { plan } as PlannerPort,
      exec,
    });

    expect(result.status).toBe('limit');
    expect(result.rounds).toHaveLength(3);
    expect(result.rounds.every(r => r.mode === 'loop')).toBe(true);
    expect(exec.execute).toHaveBeenCalledTimes(3);
  });

  it('возвращает error при сбое планировщика', async () => {
    const plan = vi.fn().mockRejectedValue(new Error('boom'));
    const exec = makeExec();

    const result = await resident('развить язык', OPTS, {
      plan: { plan } as PlannerPort,
      exec,
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('boom');
  });
});
