/**
 * B2a: ПЯТЬ ПРОГРАММ — ПЕР-СОБЫТИЙНЫЕ ПИСАТЕЛИ, ЭТАЛОН AST И QEMU.
 *
 * P1/P3 — оператор вызова, P2 — вложенный вызов глубины 2, P4 — вызов в выражении
 * (`пусть z = 1 + ф(х)`; `parseV01` не принимает `1 + ф(х)` как оператор-выражение),
 * P5 — глубже 2, поэтому сборка обязана отказать `OSN-PAR-031` ДО QEMU.
 *
 * Эталон считается независимо (`эталоннаяЛента` = `parseV01` + `лентаИзAst`), а не из
 * вывода пробы. Живой QEMU — внешний ресурс, поэтому файл исключён из `npm test`
 * и живёт в `npm run gate:qemu` (случай 12 реестра проверяемости).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseV3 } from '../compiler-v3';
import {
  ИСХОДНИКИ_B2A,
  программаПротоколаB2aPerEvent,
  эталоннаяЛента,
} from '../compiler-v3/parser-protocol-probe';
import { buildElfFromCode, MINIMAL_BASE, WRITE_ZONE_EXTRA_MEMORY } from './elfMinimal';
import { loweredProgram } from './lowered';
import { runInQemu } from '../scripts/e2kQemuExec';

function опустить(источник: string, файл: string): number[] {
  const разобранный = parseV3(источник, файл);
  expect(разобранный.errors, `${файл}: разбор`).toEqual([]);
  const понижен = loweredProgram(источник, {
    filename: файл,
    parse: () => ({ ast: разобранный.program ?? null, errors: разобранный.errors }),
  });
  expect(понижен.ок, `${файл}: понижение`).toBe(true);
  if (!понижен.ок) return [];

  const каталог = mkdtempSync(join(tmpdir(), 'b2a-'));
  const elf = join(каталог, 'b2a.elf');
  try {
    writeFileSync(
      elf,
      buildElfFromCode(понижен.значение.bytes, MINIMAL_BASE, {
        writable: true,
        extraMemory: WRITE_ZONE_EXTRA_MEMORY,
      }).bytes,
    );
    const прогон = runInQemu(elf, { shim: true, timeoutMs: 60_000 });
    expect(прогон, `${файл}: QEMU не ответил`).toBeDefined();
    expect(прогон?.status, `${файл}: код QEMU`).toBe(0);
    return String(прогон?.stdout ?? '')
      .split(/\r?\n/)
      .filter((строка) => строка.trim() !== '')
      .map((строка) => Number(строка.trim()));
  } finally {
    rmSync(каталог, { recursive: true, force: true });
  }
}

describe('B2a: пять программ (N=5)', () => {
  for (const [индекс, источник] of ИСХОДНИКИ_B2A.slice(0, 4).entries()) {
    const файл = `p${String(индекс + 1)}.osnova`;
    it(`P${String(индекс + 1)}: пер-событийная лента = эталон AST`, () => {
      const программа = программаПротоколаB2aPerEvent(источник, файл);
      expect(опустить(программа, файл)).toEqual(эталоннаяЛента(источник, файл));
    });
  }

  it('P5: вложенность >2 — названный отказ OSN-PAR-031, не QEMU', () => {
    const источник = ИСХОДНИКИ_B2A[4]!;
    expect(() => программаПротоколаB2aPerEvent(источник, 'p5.osnova')).toThrow(/OSN-PAR-031/u);
  });

  it('само-красный контроль: P1 и P3 различаются лентой (не жёсткий ответ)', () => {
    const p1 = программаПротоколаB2aPerEvent(ИСХОДНИКИ_B2A[0]!, 'p1.osnova');
    const p3 = программаПротоколаB2aPerEvent(ИСХОДНИКИ_B2A[2]!, 'p3.osnova');
    expect(p1).not.toBe(p3);
    expect(эталоннаяЛента(ИСХОДНИКИ_B2A[0]!, 'p1.osnova')).not.toEqual(
      эталоннаяЛента(ИСХОДНИКИ_B2A[2]!, 'p3.osnova'),
    );
  });
});
