/**
 * B2 hardware-only (D12): сборка по решению владельца, QEMU — НАЗВАННЫЙ отказ.
 *
 * Проверяется РАЗВИЛКА политики и сборка восьми форм:
 *   • без флага `allowDeepArrayWrites` запись из глубины ≥ 2 отказывает (`OSN-LOW-004`, `#180`);
 *   • с флагом формы собираются; AST на железе сверяет КИТ (`e2kHardwareKit` + `gate:hardware`).
 *
 * Замер 2026-11-12: 8/8 на E8C2, AST = `эталоннаяЛента` (0 расхождений). Причина прежнего
 * SIGFPE — не писатель, а старт `выписать_вызов` с токена `(` объявления вместо токена вызова.
 */
import { describe, expect, it } from 'vitest';
import { parseV3 } from '../compiler-v3';
import { программаПротоколаB2 } from '../compiler-v3/parser-protocol-b2';
import { loweredProgram } from './lowered';

const ПРОГРАММЫ = [
  'ф(х)',
  'ф(г(х))',
  'ф(г(ч(х)))',
  'ф(г(ч(ш(х))))',
  'ф(1)',
  'ф(1, х)',
  'ф(г(1), х)',
  'ф(г(ч(1)))',
] as const;

/** Произвольная лента: несколько операторов и вложенность в аргументах. */
const ПРОИЗВОЛЬНЫЕ = [
  'ф(х)\n  ф(г(1))',
  'ф(1)\n  ф(2, х)\n  ф(г(ч(3)))',
  'ф(г(х), ч(1))',
  'ф(г(ч(ш(2)), 3), 4)',
  'ф()\n  ф()',
] as const;

function опустить(тело: string, allowDeepArrayWrites: boolean) {
  const программа = программаПротоколаB2(`действие главная()\n  ${тело}\nконец главная\n`, 'b2h.osnova');
  const разобранный = parseV3(программа, 'b2h.osnova');
  expect(разобранный.errors, 'B2: разбор').toEqual([]);
  return loweredProgram(программа, {
    filename: 'b2h.osnova',
    allowDeepArrayWrites,
    parse: () => ({ ast: разобранный.program ?? null, errors: разобранный.errors }),
  });
}

describe('B2 hardware-only: развилка D12', () => {
  it('без флага запись из глубины ≥ 2 — названный отказ #180', () => {
    const результат = опустить('ф(г(ч(х)))', false);
    expect(результат.ок).toBe(false);
    if (результат.ок) return;
    expect(результат.отказ.причина).toContain('#180');
    expect(результат.отказ.причина).toContain('глубина');
  });

  it('с флагом (hardware-only) образ собирается', () => {
    const результат = опустить('ф(г(ч(х)))', true);
    expect(результат.ок, результат.ок ? '' : результат.отказ.причина.slice(0, 400)).toBe(true);
    if (!результат.ок) return;
    expect(результат.значение.bytes.length).toBeGreaterThan(0);
  });

  for (const тело of [...ПРОГРАММЫ, ...ПРОИЗВОЛЬНЫЕ]) {
    it(`собирается с флагом: ${тело}`, () => {
      const результат = опустить(тело, true);
      expect(результат.ок, результат.ок ? '' : результат.отказ.причина.slice(0, 400)).toBe(true);
      if (!результат.ок) return;
      expect(результат.значение.bytes.length).toBeGreaterThan(0);
    });
  }
});
