/**
 * `getsp` — ЕДИНСТВЕННАЯ РАЗРЕШЁННАЯ КОНФИГУРАЦИЯ, БАЙТ В БАЙТ ПО ЗАМЕРУ (§3.46.1, §3.68).
 *
 * Форма живёт ТОЛЬКО в канале 0; приёмник — базовый (0x0a) или оконный (0x8a); литерал — формой d4
 * (16…32767), смещение кратно 16; минус — выделить, плюс — вернуть. Чего форма НЕ выражает (короткая
 * форма 0…15, форма d8 ≥ 32768) — ОТКАЗЫВАЕТ с причиной: подбирать байты запрещено, второй путь
 * кодирования — это тот самый класс «кусок без контекста», из-за которого линия трижды буксовала.
 */
import { describe, it, expect } from 'vitest';
import { getEncoder } from './backend';
import { realOpcode } from './e2k-real';

const encoder = getEncoder('e2k');
/** Измерено ассемблером МЦСТ и подтверждено его дизассемблером (§3.46.1). */
const MEASURED = '110010040ad4ec580000c0010000f0ff';
const hex = (bytes: Uint8Array): string => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
const getsp = (offset: number, receiver: number, channel = 0) => ({
  mnemonic: 'getsp',
  channel,
  operands: [
    { kind: 'imm' as const, value: offset },
    { kind: 'imm' as const, value: receiver },
  ],
});

describe('getsp: кодирование по замеру и отказы там, где образца нет', () => {
  it('образцовая конфигурация даёт ИЗМЕРЕННЫЕ 16 байт', () => {
    expect(hex(encoder.encode(getsp(-16, 0x0a) as never))).toBe(MEASURED);
  });

  it('форма объявлена в таблице: 16 байт, ALOPF12, канал только 0', () => {
    const entry = realOpcode('getsp');
    // `getsp` — в таблице ФОРМ УПРАВЛЕНИЯ (свой кодировщик), поэтому realOpcode её не знает:
    // это ожидаемо и зафиксировано здесь, чтобы не искать причину заново.
    expect(entry).toBeUndefined();
    expect(encoder.encode(getsp(-16, 0x0a) as never).length).toBe(16);
    expect(() => encoder.encode(getsp(-16, 0x0a, 1) as never)).toThrow(/канал/i);
  });

  it('оконный приёмник отличим от базового одним битом', () => {
    const base = hex(encoder.encode(getsp(-16, 0x0a) as never));
    const window = hex(encoder.encode(getsp(-16, 0x8a) as never));
    expect(base.slice(8, 10)).toBe('0a');
    expect(window.slice(8, 10)).toBe('8a');
    expect(window.slice(0, 8)).toBe(base.slice(0, 8));
  });

  it('НЕГАТИВНЫЕ КОНТРОЛИ: неизмеренные конфигурации ОТКАЗЫВАЮТ с причиной', () => {
    expect(() => encoder.encode(getsp(0, 0x0a) as never), 'короткая форма 0…15').toThrow(/короткую форму/);
    expect(() => encoder.encode(getsp(8, 0x0a) as never), 'короткая форма 0…15').toThrow(/короткую форму/);
    expect(() => encoder.encode(getsp(32768, 0x0a) as never), 'форма d8').toThrow(/d8/);
    expect(() => encoder.encode(getsp(17, 0x0a) as never), 'выравнивание 16').toThrow(/кратно 16/);
    expect(() => encoder.encode(getsp(-16, 0xc0) as never), 'приёмник вне поля').toThrow(/не выражается полем/);
  });
});
