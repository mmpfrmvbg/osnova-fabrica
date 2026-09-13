import { describe, it, expect } from 'vitest';
import { createResidentExecutor } from './adapters';

describe('createResidentExecutor (eval)', () => {
  it('исполняет выражение и возвращает результат', async () => {
    const exec = createResidentExecutor();
    const r = await exec.execute({ mode: 'eval', goal: '2 + 3 * 4' });
    expect(r.status).toBe('ok');
    expect(r.summary).toBe('14');
  });

  it('держит окружение между вызовами eval', async () => {
    const exec = createResidentExecutor();
    await exec.execute({ mode: 'eval', goal: 'система.оценить.установить("счёт", 40)' });
    const r = await exec.execute({ mode: 'eval', goal: 'система.оценить.получить("счёт") + 2' });
    expect(r.summary).toBe('42');
  });
});
