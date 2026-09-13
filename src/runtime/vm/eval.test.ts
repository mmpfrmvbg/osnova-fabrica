import { describe, it, expect } from 'vitest';
import { createDefaultInvokeHandler } from './interpreter';

describe('система.оценить (eval)', () => {
  it('компилирует и исполняет строку кода на лету', async () => {
    const handler = createDefaultInvokeHandler();
    const code = 'модуль Внутр\nпроцедура главная()\n  вернуть 42\nконец\nконец';
    const result = await handler('система.оценить', [code]);
    expect(result).toBe(42);
  });

  it('вычисляет выражение', async () => {
    const handler = createDefaultInvokeHandler();
    const code = 'модуль Внутр\nпроцедура главная()\n  вернуть 6 * 7\nконец\nконец';
    const result = await handler('система.оценить', [code]);
    expect(result).toBe(42);
  });

  it('вычисляет голое выражение (без модуля)', async () => {
    const handler = createDefaultInvokeHandler();
    expect(await handler('система.оценить', ['2 + 3 * 4'])).toBe(14);
    expect(await handler('система.оценить', ['(10 - 4) / 2'])).toBe(3);
  });

  it('передаёт окружение в eval (читать)', async () => {
    const handler = createDefaultInvokeHandler();
    const env = { x: 10 };
    const result = await handler('система.оценить_в', ['система.оценить.получить("x") + 1', env]);
    expect(result).toBe(11);
  });

  it('eval меняет окружение (писать)', async () => {
    const handler = createDefaultInvokeHandler();
    const env = { x: 10 };
    await handler('система.оценить_в', ['система.оценить.установить("x", 99)', env]);
    expect(env.x).toBe(99);
  });

  it('бросает ошибку на невалидном коде', async () => {
    const handler = createDefaultInvokeHandler();
    await expect(handler('система.оценить', ['это не код'])).rejects.toThrow();
  });
});
