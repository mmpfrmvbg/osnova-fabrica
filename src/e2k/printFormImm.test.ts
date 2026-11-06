/**
 * ОРАКУЛ ФОРМЫ КОМАНД ПО НЕПОСРЕДСТВЕННОМУ — ПО СЛОТУ, А НЕ ПО МНЕМОНИКЕ (случай 82 реестра долгов).
 *
 * # Что сторожится
 *
 * Раскладка меряет носитель не байтами, которые выдаст кодировщик, а **объявлением** —
 * `printCommandForm` (`src/e2k/printCall.ts`) и таблицами форм (`ARRAY_COMMAND_FORMS` в
 * `src/e2k/twoPassLayout.ts`). Если объявление расходится с кодировщиком, адреса переходов и вызовов
 * уезжают на разницу, и программа исполняется «не тем» — без единого отказа. Это класс «программа
 * исполняется, а число неверное».
 *
 * # ГЛАВНАЯ МЫСЛЬ: порог задаётся СЛОТОМ, а не мнемоникой
 *
 * Первая редакция этого сторожа группировала пробы по МНЕМОНИКЕ и считала порог 15/16 общим. Это была
 * неверная посылка: у `src1` и `src2` РАЗНЫЕ поля в слоге, поэтому и пороги разные.
 *
 * | слот | поле | значения | литерал `LTS` | цена |
 * |---|---|---|---|---|
 * | `src1` | `110xxxxx` | **0…31**, расширение нулями | нет вовсе | 8 байт |
 * | `src2` | `1100xxxx` | **0…15** | нет | 8 байт |
 * | `src2` | `11010hll` и старше | 16+ | да | 16 байт |
 *
 * Источник — `vendor/relcc2/spec/isa/bundle.md`, «Operand encodings», и там же прямым текстом:
 * «In `src1` gas takes only 0–31; any other value, negative ones included, is 'Invalid argument in
 * position of SRC1', and gas never swaps the operands».
 *
 * Отсюда две разные проверки, и путать их нельзя:
 * - **src1**: 0…31 → 8 байт; 32 и больше → **названный отказ** (у `src1` нет литеральной формы, и
 *   молчаливые 16 байт с полем `0xd4` железо прочтёт как литерал 20 — это и был дефект).
 * - **src2**: 0…15 → 8 байт; 16 и больше → 16 байт с литеральным словом.
 *
 * # Замер на живой машине (Эльбрус E8C2, 2026-11-07, случай 82)
 *
 * Различающая проба — граница строки, она же спорный литерал в `src1`:
 * `пусть текст = "абвгдежзийклмнопрстуфхцчшщ"; вернуть текст[20]` (22 знака).
 *
 * | | код возврата |
 * |---|---|
 * | до правки (литерал `[22]` в src1) | **255** = −1 «вне границ»: `0xd4` прочитан как литерал 20 |
 * | после правки (5-битное поле 22) | **68** = «ф» (1092 mod 256): граница 22, `текст[20]` в ней |
 * | модель, оба раза | те же **255** и **68** |
 *
 * Три прогона из трёх на каждом образце; sha256 образа до и после совпал. Петля лексера: до правки
 * 15 → 165, 16 и 21 — зависание (137); после — **165 / 176 / 231**, и те же числа на модели.
 */

import { describe, it, expect } from 'vitest';
import { createRealE2kEncoder, IMM_SHORT_MAX, IMM_SRC1_MAX } from './e2k-real';
import type { AsmInstruction, AsmOperand } from './e2k-real';
import { printCommandForm } from './printCall';
import { ARRAY_COMMAND_FORMS } from './twoPassLayout';

const encoder = createRealE2kEncoder();

const imm = (value: number): AsmOperand => ({ kind: 'imm', value });
const reg = (index: number): AsmOperand => ({ kind: 'reg', index });

/**
 * Форма слота в пробе: каким операндом идёт непосредственное.
 *
 * `movts` — исключение по ЧИСЛУ операндов (ALF2, `ARGS_SS`: src2 + dst), а не по правилу слота:
 * у него непосредственное попадает в `src2`, поэтому порог у него 4-битный.
 */
interface Слот {
  readonly имя: 'src1' | 'src2';
  readonly мнемоники: readonly string[];
}

/** Каналы выбраны так, чтобы кодировщик не отказывал ПО КАНАЛУ (`opcodes/e2k-opc.h:69`). */
const CHANNEL_OF: Record<string, number> = { sdivs: 5, muls: 0 };

function probe(mnemonic: string, value: number, slot: 'src1' | 'src2'): AsmInstruction {
  const channel = CHANNEL_OF[mnemonic] ?? 0;
  if (mnemonic === 'movts') return { mnemonic, channel, operands: [imm(value), reg(2)] };
  return slot === 'src1'
    ? { mnemonic, channel, operands: [imm(value), reg(1), reg(2)] }
    : { mnemonic, channel, operands: [reg(1), imm(value), reg(2)] };
}

function encoderSizeOf(mnemonic: string, value: number, slot: 'src1' | 'src2'): number | undefined {
  try {
    return encoder.encode(probe(mnemonic, value, slot)).length;
  } catch {
    return undefined; // отказ кодировщика — отказ, а не размер
  }
}

const СЛОТ_SRC1: Слот = { имя: 'src1', мнемоники: ['subs', 'sdivs', 'adds', 'shrs', 'muls'] };
const СЛОТ_SRC2: Слот = { имя: 'src2', мнемоники: ['movts', 'shrs'] };
const ТАБЛИЦА: Слот = { имя: 'src1', мнемоники: ['addd', 'smodx', 'ldd'] };

describe('форма по непосредственному: объявление = кодировщик, порог задаёт СЛОТ (случай 82)', () => {
  it('src1: 0…31 — 8 байт, 32 и больше — названный отказ (5-битное поле, литерала нет)', () => {
    const problems: string[] = [];
    let checked = 0;
    for (const mnemonic of СЛОТ_SRC1.мнемоники) {
      for (let value = 0; value <= IMM_SRC1_MAX + 1; value++) {
        const size = encoderSizeOf(mnemonic, value, 'src1');
        if (value <= IMM_SRC1_MAX) {
          checked++;
          if (size !== 8) problems.push(`«${mnemonic}» src1 imm=${String(value)}: кодировщик даёт ${String(size)}, ожидалось 8`);
        } else if (size !== undefined) {
          // За 31 у src1 литеральной формы нет — это обязан быть отказ, а не 16 байт с полем 0xd4.
          // Именно молчаливые 16 байт и были дефектом: железо читало 0xd4 как литерал 20.
          problems.push(`«${mnemonic}» src1 imm=${String(value)}: ожидался ОТКАЗ, кодировщик дал ${String(size)} байт`);
        }
      }
    }
    expect(checked, 'сверено значений src1').toBeGreaterThan(150);
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('src2: 0…15 — 8 байт, 16 и больше — 16 байт с литеральным словом (4-битное поле)', () => {
    const problems: string[] = [];
    let checked = 0;
    for (const mnemonic of СЛОТ_SRC2.мнемоники) {
      for (let value = 0; value <= IMM_SHORT_MAX + 1; value++) {
        const size = encoderSizeOf(mnemonic, value, 'src2');
        if (size === undefined) continue; // отказ кодировщика по иной причине — вне порога
        checked++;
        const expected = value <= IMM_SHORT_MAX ? 8 : 16;
        if (size !== expected) {
          problems.push(
            `«${mnemonic}» src2 imm=${String(value)}: кодировщик даёт ${String(size)}, ожидалось ${String(expected)}`,
          );
        }
      }
    }
    expect(checked, 'сверено значений src2').toBeGreaterThan(25);
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('порог ровно на границе: src1 — 31/32, src2 — 15/16', () => {
    // Отдельная проверка САМОЙ границы: расхождение «на единицу» прошло бы мимо общей сверки, если бы
    // обе стороны одинаково считали неверно.
    const offenders: string[] = [];
    for (const mnemonic of СЛОТ_SRC1.мнемоники) {
      const на31 = encoderSizeOf(mnemonic, IMM_SRC1_MAX, 'src1');
      const на32 = encoderSizeOf(mnemonic, IMM_SRC1_MAX + 1, 'src1');
      if (на31 !== undefined && на31 !== 8) offenders.push(`«${mnemonic}» src1 imm=31: ${String(на31)}, ожидалось 8`);
      if (на32 !== undefined) offenders.push(`«${mnemonic}» src1 imm=32: ${String(на32)} байт вместо отказа`);
    }
    for (const mnemonic of СЛОТ_SRC2.мнемоники) {
      const на15 = encoderSizeOf(mnemonic, IMM_SHORT_MAX, 'src2');
      const на16 = encoderSizeOf(mnemonic, IMM_SHORT_MAX + 1, 'src2');
      if (на15 !== undefined && на15 !== 8) offenders.push(`«${mnemonic}» src2 imm=15: ${String(на15)}, ожидалось 8`);
      if (на16 !== undefined && на16 !== 16) offenders.push(`«${mnemonic}» src2 imm=16: ${String(на16)}, ожидалось 16`);
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('printCommandForm согласна с кодировщиком на живых размерах (src1 у всех — 8)', () => {
    const problems: string[] = [];
    for (const mnemonic of [...СЛОТ_SRC1.мнемоники, ...СЛОТ_SRC2.мнемоники]) {
      for (let value = 0; value <= IMM_SRC1_MAX; value++) {
        const slot: 'src1' | 'src2' = mnemonic === 'movts' ? 'src2' : 'src1';
        // `shrs` берёт литерал в src2, поэтому его проба идёт вторым слотом.
        const где: 'src1' | 'src2' = mnemonic === 'shrs' ? 'src2' : slot;
        const instruction = probe(mnemonic, value, где);
        const form = printCommandForm(instruction);
        expect(form, `«${mnemonic}» imm=${String(value)}: формы в таблице нет`).toBeDefined();
        const encoded = encoderSizeOf(mnemonic, value, где);
        if (encoded === undefined) continue;
        if (form!.size !== encoded) {
          problems.push(
            `«${mnemonic}» ${где} imm=${String(value)}: printCommandForm ${String(form!.size)}, кодировщик ${String(encoded)}`,
          );
        }
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('ARRAY_COMMAND_FORMS согласна с кодировщиком (addd/smodx/ldd — литерал в src1)', () => {
    const problems: string[] = [];
    let checked = 0;
    for (const mnemonic of ТАБЛИЦА.мнемоники) {
      const declared = ARRAY_COMMAND_FORMS.get(mnemonic);
      expect(declared, `«${mnemonic}»: таблицы форм нет`).toBeDefined();
      for (let value = 0; value <= IMM_SRC1_MAX + 1; value++) {
        const encoded = encoderSizeOf(mnemonic, value, 'src1');
        if (encoded === undefined) continue;
        checked++;
        if (declared!.size !== encoded) {
          problems.push(
            `«${mnemonic}» src1 imm=${String(value)}: объявлено ${String(declared!.size)}, кодировщик ${String(encoded)}`,
          );
        }
      }
    }
    expect(checked, 'сверено значений ARRAY_COMMAND_FORMS').toBeGreaterThan(60);
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: сверка краснеет от подмены порога у обоих слотов', () => {
    // Сторож обязан различать подмену в ОБЕ стороны — иначе он «проходил» бы при любых числах.
    const src1На21 = encoderSizeOf('subs', 21, 'src1');
    expect(src1На21, 'src1 imm=21 — 8 байт (5-битное поле)').toBe(8);
    expect(src1На21, 'прежнее убеждение «при 16+ длинная форма» обязано РАЗОЙТИСЬ').not.toBe(16);

    const src2На21 = encoderSizeOf('subs', 21, 'src2');
    expect(src2На21, 'src2 imm=21 — 16 байт (литеральное слово)').toBe(16);
    expect(src2На21, 'подмена «src2 тоже короткий» обязана РАЗОЙТИСЬ').not.toBe(8);
  });
});
