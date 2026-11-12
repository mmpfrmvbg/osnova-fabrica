/**
 * B2 hardware-only (D12): сборка по решению владельца, QEMU — НАЗВАННЫЙ отказ.
 *
 * Здесь проверяется РАЗВИЛКА политики, а не успех на железе:
 *   • без флага `allowDeepArrayWrites` запись из глубины ≥ 2 отказывает (`OSN-LOW-004`, `#180`);
 *   • с флагом та же программа собирается (образ есть).
 *
 * Факт железа на 2026-11-12: образ B2 для `ф(г(ч(х)))` доходит до начала действия и
 * падает SIGFPE в первом же событии вызова, т.е. B2 ЕЩЁ НЕ РАБОТАЕТ. Тест это не прячет:
 * отдельная аппаратная проба — `.tmp/b2rec.hw*.out`, разбор — docs §34.
 */
import { describe, expect, it } from 'vitest';
import { parseV3 } from '../compiler-v3';
import { программаПротоколаB2 } from '../compiler-v3/parser-protocol-b2';
import { loweredProgram } from './lowered';

const ИСТОЧНИК = 'действие главная()\n  ф(г(ч(х)))\nконец главная\n';

function опустить(allowDeepArrayWrites: boolean) {
  const программа = программаПротоколаB2(ИСТОЧНИК, 'b2h.osnova');
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
    const результат = опустить(false);
    expect(результат.ок).toBe(false);
    if (результат.ок) return;
    expect(результат.отказ.причина).toContain('#180');
    expect(результат.отказ.причина).toContain('глубина');
  });

  it('с флагом (hardware-only) образ собирается', () => {
    const результат = опустить(true);
    expect(результат.ок, результат.ок ? '' : результат.отказ.причина.slice(0, 400)).toBe(true);
    if (!результат.ок) return;
    expect(результат.значение.bytes.length).toBeGreaterThan(0);
  });
});
