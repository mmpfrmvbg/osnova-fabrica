/**
 * ОРАКУЛ D43a: `Списки.*` исполняются на МОДЕЛИ e2k.
 *
 * N = 5 названо ДО правки:
 *   1. `пустой → добавить(42) → длина` = 1 (исходный оракул);
 *   2. пустой список, `длина` = 0;
 *   3. два `добавить` (7, 9), `длина` = 2;
 *   4. `добавить` возвращает ТОТ ЖЕ список: `л2 = Списки.добавить(...)`, `длина(л2)` = 1;
 *   5. `Списки.взять` — названный отказ (пара `Результат`, D49), а не тихая подмена `получить`.
 *
 * Различающие числа 1 / 0 / 2 / 1: если бы `добавить` не писал длину, №1 и №3 дали бы 0; если бы
 * возврат `Списки.добавить` был мусором, №4 не дал бы 1; если бы `пустой` не создавал блок, №2
 * упал бы, а не вернул 0. Негативный контроль №5 держит границу: `получить` без пары запрещён.
 *
 * # Чего оракул НЕ доказывает
 *
 * Что так поведёт себя железо (QEMU — модель). Железный прогон — отдельно, тем же ELF, отчёт в
 * `docs/hardware-debt.md`. И не доказывает арена-зависимую кучу: арена в D43a принимается, но
 * значение её пока не используется (названо в `docs/v3-spec.md` §7.1).
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parseV3 } from '../compiler-v3/index';
import { loweredProgram } from './lowered';
import { buildElfFromCode, MINIMAL_BASE, WRITE_ZONE_EXTRA_MEMORY } from './elfMinimal';
import { runInQemu } from '../scripts/e2kQemuExec';

const ROOT = path.resolve(__dirname, '..', '..');

function sourceOf(body: readonly string[]): string {
  return ['процедура главная() → Число', '  пусть ар = 0', ...body, 'конец', ''].join('\n');
}

function lower(source: string, name: string) {
  const parsed = parseV3(source, name);
  expect(parsed.errors, `разбор ${name}`).toEqual([]);
  return loweredProgram(source, {
    filename: name,
    parse: () => ({ ast: parsed.program ?? null, errors: parsed.errors }),
  });
}

function run(source: string, name: string): number | undefined {
  const итог = lower(source, name);
  expect(итог.ок, итог.ок ? '' : итог.отказ.причина).toBe(true);
  if (!итог.ок) return undefined;
  const file = path.join(ROOT, '.tmp', `d43a-${name}.elf`);
  fs.writeFileSync(
    file,
    buildElfFromCode(итог.значение.bytes, MINIMAL_BASE, {
      writable: true,
      extraMemory: WRITE_ZONE_EXTRA_MEMORY,
    }).bytes,
  );
  return runInQemu(file, { shim: true, timeoutMs: 20_000 })?.status;
}

describe('D43a: Списки.* на модели e2k', () => {
  it('1. пустой → добавить(42) → длина = 1', () => {
    expect(
      run(
        sourceOf([
          '  пусть л = Списки.пустой(ар)',
          '  Списки.добавить(л, 42, ар)',
          '  вернуть Списки.длина(л)',
        ]),
        'n1',
      ),
    ).toBe(1);
  });

  it('2. пустой список: длина = 0', () => {
    expect(
      run(sourceOf(['  пусть л = Списки.пустой(ар)', '  вернуть Списки.длина(л)']), 'n2'),
    ).toBe(0);
  });

  it('3. два добавить: длина = 2', () => {
    expect(
      run(
        sourceOf([
          '  пусть л = Списки.пустой(ар)',
          '  Списки.добавить(л, 7, ар)',
          '  Списки.добавить(л, 9, ар)',
          '  вернуть Списки.длина(л)',
        ]),
        'n3',
      ),
    ).toBe(2);
  });

  it('4. добавить возвращает тот же список: длина(л2) = 1', () => {
    expect(
      run(
        sourceOf([
          '  пусть л = Списки.пустой(ар)',
          '  пусть л2 = Списки.добавить(л, 42, ар)',
          '  вернуть Списки.длина(л2)',
        ]),
        'n4',
      ),
    ).toBe(1);
  });

  it('5. взять — отказ по имени (Результат, D49), не получить', () => {
    const итог = lower(
      sourceOf(['  пусть л = Списки.пустой(ар)', '  вернуть Списки.взять(л, 0)']),
      'n5',
    );
    expect(итог.ок).toBe(false);
    if (итог.ок) return;
    expect(итог.отказ.причина).toContain('Списки.взять');
    expect(итог.отказ.причина).toContain('Результат');
    expect(итог.отказ.причина).toContain('D49');
    expect(итог.отказ.причина).toContain('D4');
  });
});
