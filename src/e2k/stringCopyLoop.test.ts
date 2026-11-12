/**
 * ЦИКЛ КОПИРОВАНИЯ СТРОКИ — ВОСЕМЬ НОСИТЕЛЕЙ, и он остался в дереве КОНТРОЛЕМ («восьмёрки на
 * кодпоинт»): сайт рантайм-среза переехал на вариант Г (`src/e2k/stringSliceGamma.test.ts`), а
 * сравнение «конкретные команды против носителей» живёт в `src/e2k/byteCarriers.test.ts` (случай 78).
 *
 * ПОЧЕМУ БАЙТОВЫЙ ДОСТУП ЗДЕСЬ НОСИТЕЛЯМИ. Сырая `ldb`/`stb` — НЕ носитель IR: раскладка кладёт её в
 * `unplaced` («не носитель IR»), то есть команда не имеет ни длины, ни места, и цель перехода,
 * посчитанная по числу носителей, уезжает (это и есть порча случая 78). Поэтому цикл, который
 * действительно встаёт в поток, обязан нести байтовый доступ НОСИТЕЛЯМИ (`IR.load_byte`/`IR.store_byte`),
 * а смещение у них ВПАЯНО нулевой клеткой рантайма массивов — отсюда требование к роли `zero`.
 *
 * ГРАНИЦА, КОТОРУЮ ЭТОТ ФАЙЛ НЕ ПРОВЕРЯЕТ: сам срез (`подстрока` в рантайме) — его роли, длина и
 * нормализация краёв проверяются оракулом Г на ИСПОЛНЯЕМОМ потоке, а не здесь.
 */
import { describe, expect, it } from 'vitest';
import { ARRAY_REGISTERS } from './arrayRuntime';
import { RESERVED_REGISTERS } from './regAlloc';
import { layoutOf } from './twoPassLayout';
import {
  STRING_COPY_LOOP_SIZE,
  checkStringCopyLoopCells,
  checkStringCopyLoopRoles,
  stringCopyLoopCarriers,
} from './stringRuntime';

const reg = (index: number) => ({ kind: 'reg' as const, index });
const imm = (value: number) => ({ kind: 'imm' as const, value });

/** Роли цикла — любые клетки: цикл их НЕ выбирает, владелец клеток — сайт (D24). */
const РОЛИ = {
  loopIndex: 300,
  continuation: 400,
  source: 8,
  end: 9,
  target: 10,
  byte: 11,
  one: 13,
  zero: ARRAY_REGISTERS.zero,
  key: 14,
} as const;

describe('O(n) цикл копирования строки: восемь носителей, конкретных команд нет', () => {
  it('СОСТАВ И ЦЕЛИ: вход — назад на начало цикла, выход — продолжение за вызовом', () => {
    const цикл = stringCopyLoopCarriers(РОЛИ);
    expect(цикл).toHaveLength(STRING_COPY_LOOP_SIZE);
    expect(цикл.map((носитель) => носитель.mnemonic)).toEqual([
      'IR.lt',
      'IR.jmp_if_not',
      'IR.load_byte',
      'IR.store_byte',
      'IR.add',
      'IR.add',
      'IR.jmp',
      'IR.jmp',
    ]);
    // ОБРАТНЫЙ ПЕРЕХОД — на `loopIndex`, а условный выход — на предпоследний носитель: НЕ на «первый
    // за циклом», иначе сторож ребра взятого перехода молча выключился бы (случай 78).
    expect(цикл[1]?.operands[1]).toEqual(imm(РОЛИ.loopIndex + 7));
    expect(цикл[6]?.operands[0]).toEqual(imm(РОЛИ.loopIndex));
    expect(цикл[7]?.operands[0]).toEqual(imm(РОЛИ.continuation));
  });

  it('БАЙТОВЫЙ ДОСТУП — НОСИТЕЛЯМИ, и раскладка размещает ВСЕ восемь', () => {
    const цикл = stringCopyLoopCarriers(РОЛИ);
    const раскладка = layoutOf(цикл as never);
    expect(раскладка.unplaced, 'неразмещённых нет — конкретных команд в цикле не осталось').toEqual([]);
    expect(раскладка.entries).toHaveLength(STRING_COPY_LOOP_SIZE);
    // Сырые команды — РАЗЛИЧАЮЩИЙ КОНТРОЛЬ: у них формы нет, и причина названа командой.
    const сырой = layoutOf([{ mnemonic: 'ldb', channel: 0, operands: [reg(8), reg(12), reg(11)] }] as never);
    expect(сырой.unplaced.map((item) => item.carrier)).toEqual(['ldb']);
    expect(сырой.unplaced[0]?.reason).toContain('не носитель IR');
  });

  it('РОЛИ ПРИХОДЯТ ПАРАМЕТРАМИ: нечисловая и внедиапазонная роль — НАЗВАННЫЙ отказ', () => {
    expect(() => stringCopyLoopCarriers({ ...РОЛИ, byte: -1 })).toThrowError(/байт|роль/);
    expect(() => stringCopyLoopCarriers({ ...РОЛИ, loopIndex: 1.5 })).toThrowError(/loopIndex/);
    expect(() => stringCopyLoopCarriers({ ...РОЛИ, continuation: -3 })).toThrowError(/continuation/);
  });

  it('КЛЕТКА НУЛЯ — ИМЕННО НУЛЕВАЯ КЛЕТКА РАНТАЙМА: байтовые носители адресуют смещение из неё', () => {
    expect(ARRAY_REGISTERS.zero, 'ноль байтового доступа — 12').toBe(12);
    expect(() => stringCopyLoopCarriers({ ...РОЛИ, zero: 6 })).toThrowError(/смещение/);
    expect(() => checkStringCopyLoopRoles({ ...РОЛИ, zero: 6 }, [])).toThrowError(/нул|zero/i);
  });

  it('СТОРОЖ РОЛЕЙ: полоса или reserved — иначе отказ; верные роли молчат', () => {
    const ОБЪЯВЛЕНО = [8, 9];
    expect(() => checkStringCopyLoopRoles(РОЛИ, ОБЪЯВЛЕНО)).not.toThrow();
    // Клетка ВНЕ полосы и без объявления — та самая порча D24: раскладка отдала бы её программе.
    expect(() => checkStringCopyLoopRoles(РОЛИ, [8])).toThrowError(/«end»/);
    expect(RESERVED_REGISTERS.includes(РОЛИ.target), 'приёмник в полосе %b[10..15]').toBe(true);
    expect(RESERVED_REGISTERS.includes(8), 'источник вне полосы: без объявления не закреплён').toBe(false);
  });

  it('СТОРОЖ КЛЕТОК: поток, собранный не построителем, отвергается по ИМЕНИ роли', () => {
    const цикл = stringCopyLoopCarriers(РОЛИ);
    expect(() => checkStringCopyLoopCells(цикл, РОЛИ)).not.toThrow();
    const подмена = цикл.map((носитель, номер) =>
      номер === 2 ? { ...носитель, operands: [reg(7), reg(РОЛИ.byte)] } : носитель,
    );
    expect(() => checkStringCopyLoopCells(подмена, РОЛИ)).toThrowError(/носитель 2/);
  });
});
