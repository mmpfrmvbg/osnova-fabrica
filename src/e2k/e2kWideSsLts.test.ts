/**
 * ОРАКУЛ: ШИРОКАЯ КОМАНДА «ALS + SS», «ALS + CS0» И «ALS + LTS» — ПОРЯДОК ИЗМЕРЕН.
 *
 * # Что было неизвестно и почему это блокировало печать
 *
 * §3.33 измерил пару «ALS + CS1» (`mas=`) и **честно отказался** класть в ту же команду `SS`
 * (`ct`, `call`), `CS0` (`disp`, `sdisp`) и литерал `LTS`: «порядок `SS`/`LTS` относительно слогов
 * ALS ассемблером МЦСТ не измерялся». Печати (`write` вместе с арифметикой) и условным переходам
 * нужна именно эта половина: без неё арифметика и передача управления стоят в разных командах.
 *
 * # Что измерено (2026-09-27)
 *
 * `.tmp/osnova-ss-lts-probe.ts`, `-probe2.ts`, `-probe3.ts` — `as-new -mcpu=elbrus-v5`, разбор
 * **по словам**, а не по строкам дизассемблера (`nop` между командами уже давал ложный вывод).
 * Порядок слов команды:
 *
 * ```
 * HS, [SS], ALS…, [CS0|CS1], [ALES…], [добивка], [LTS]
 * ```
 *
 * | текст МЦСТ | слова | вывод |
 * |---|---|---|
 * | `{ adds,0 …; ct %ctpr1 }` | HS, **SS**, ALS, 0 | `SS` — **первым**, до слогов ALS |
 * | `{ adds,0 …; sdisp %ctpr1, 3 }` | HS, ALS, **CS0**, 0 | `CS0` — **после** слогов ALS |
 * | `{ adds,0 …; call %ctpr1, wbs=4 }` | HS(`ss=1`, `cs=2`), **SS**, ALS, **CS1** | `call` несёт **оба** слога |
 * | `{ adds,0 …; movts,1 42, %b[1] }` | HS, ALS, ALS, **LTS** | `LTS` — **последним**, добивки нет |
 * | `{ adds,0 …; adds,2 …; movts,1 42 }` | HS, ALS×3, **0**, **LTS** | добивка встаёт **перед** LTS |
 * | `{ muls,0 …; sdisp %ctpr1, 3 }` | HS, ALS, CS0, **ALES0** | `ALES0/1/3/4` — за слогом CS0 |
 *
 * Отсюда третье правило, которого не было: **литерал входит в счёт добивки**. Без него число слов
 * чётное; с ним до `LTS` число слов обязано быть **нечётным** (иначе `LTS` не встанет последним
 * словом). Это ровно те `0/16/24` байта, что даёт ассемблер.
 *
 * # Главная проверка — внешняя, побайтовая
 *
 * Эталон — **14 форм**, собранных ассемблером МЦСТ; наш кодировщик обязан дать те же байты **той же
 * длины**. Таблица закреплена ниже, живая сверка с `as` идёт отдельной проверкой.
 *
 * # Чего этот оракул НЕ доказывает
 *
 * 1. Что так поведёт себя железо: сверка идёт с ассемблером МЦСТ, а не с машиной.
 * 2. Что кладутся **все** формы: `return` и `setwd` остаются названным отказом; `setwd` несёт
 *    литерал, и раскладка «ALS + CS1 + LTS» именно для него не проверялась. **Два** литерала в
 *    одной команде тоже отказ: измерены формы с одним словом `LTS`.
 * 3. Что 64-битный литерал (`imm64`, форма `0xdc`, ДВА слова) ложится в широкую команду: его
 *    раскладка не измерялась и отвергается.
 * 4. Что литерал ложится в команду **через упаковщик**. Раскладка «ALS + LTS» измерена и
 *    кодируется (`wideCommandBytes`), но `packWide` её пока не включает: с ней литерал перестаёт
 *    быть барьером пакетов и закреплённые числа корпуса сдвигаются (пакетов 220 → 210,
 *    «литеральных с отказом» 20 → 0). По правилу проекта сдвинутое число — отдельный коммит с
 *    датой, поэтому включение — следующий шаг, а не побочный эффект этого.
 * 5. Что выбор канала — наш: `packWide` берёт **первый свободный** канал, а ассемблер чтит
 *    записанный. Поэтому байты сравнимы только при совпадающем выборе канала (см. `CASES`).
 */
import { describe, expect, it } from 'vitest';
import { getEncoder, toHex, type AsmInstruction, type Operand } from './backend';
import { EncodingRefusedError } from './encoding';
import { wideAlsSlotOf, wideCommandBytes, wideSyllablesOf } from './e2k-real';
import { packWide, packetableRefusal } from './widePacker';
import { assembleAll, findExternalAs, type AsSample } from '../scripts/e2kExternalAs';

const encoder = getEncoder('e2k');
const CT_ALWAYS = 0x20;

const reg = (index: number): Operand => ({ kind: 'reg', index });
const imm = (value: number): Operand => ({ kind: 'imm', value });

const add = (channel: number, base = 1): AsmInstruction => ({
  mnemonic: 'adds',
  channel,
  operands: [reg(base), reg(base + 1), reg(base + 2)],
});
const literal = (channel: number, value: number, control?: AsmInstruction): AsmInstruction => ({
  mnemonic: 'movts',
  channel,
  operands: [imm(value), reg(1)],
  ...(control === undefined ? {} : { control }),
});
const ct = (ctpr = 1): AsmInstruction => ({ mnemonic: 'ct', channel: 0, operands: [imm(ctpr), imm(CT_ALWAYS)] });
const sdisp = (ctpr = 1, value = 3): AsmInstruction => ({
  mnemonic: 'sdisp',
  channel: 0,
  operands: [imm(ctpr), imm(value)],
});
const disp = (ctpr = 1, value = 3): AsmInstruction => ({
  mnemonic: 'disp',
  channel: 0,
  operands: [imm(ctpr), imm(value)],
});
const call = (ctpr = 1, wbs = 4): AsmInstruction => ({
  mnemonic: 'call',
  channel: 0,
  operands: [imm(ctpr), imm(wbs)],
});

/** Одна форма: наш вход, текст МЦСТ и байты, измеренные ассемблером. */
interface WideForm {
  readonly key: string;
  readonly asText: string;
  readonly instructions: readonly AsmInstruction[];
  readonly hex: string;
}

/**
 * Четырнадцать форм. Порядок инструкций у многоместных форм задан **по возрастанию канала** —
 * `packWide` берёт первый свободный канал, и при таком входе он совпадёт с записанным у `as`.
 */
export const CASES: readonly WideForm[] = [
  {
    key: 'A adds + ct (SS)',
    asText: '{ adds,0 %b[1], %b[2], %b[3]; ct %ctpr1 }',
    instructions: [{ ...add(0), control: ct() }],
    hex: '12 10 00 04 20 04 00 c0 03 02 01 10 00 00 00 00',
  },
  {
    key: 'B adds + sdisp (CS0)',
    asText: '{ adds,0 %b[1], %b[2], %b[3]; sdisp %ctpr1, 3 }',
    instructions: [{ ...add(0), control: sdisp() }],
    hex: '12 40 00 04 03 02 01 10 03 00 00 60 00 00 00 00',
  },
  {
    key: 'C adds + disp (CS0)',
    asText: '{ adds,0 %b[1], %b[2], %b[3]; disp %ctpr1, 3 }',
    instructions: [{ ...add(0), control: disp() }],
    hex: '12 40 00 04 03 02 01 10 03 00 00 40 00 00 00 00',
  },
  {
    key: 'D adds + call (SS + CS1)',
    asText: '{ adds,0 %b[1], %b[2], %b[3]; call %ctpr1, wbs=4 }',
    instructions: [{ ...add(0), control: call() }],
    hex: '13 90 00 04 20 04 00 c0 03 02 01 10 04 00 00 50',
  },
  {
    key: 'E muls,0 + sdisp (ALES + CS0)',
    asText: '{ muls,0 %b[1], %b[2], %b[3]; sdisp %ctpr1, 3 }',
    instructions: [{ mnemonic: 'muls', channel: 0, operands: [reg(1), reg(2), reg(3)], control: sdisp() }],
    hex: '12 40 10 04 03 02 01 20 03 00 00 60 00 00 c0 01',
  },
  {
    key: 'F adds,0 + movts,1 42 (LTS)',
    asText: '{ adds,0 %b[2], %b[3], %b[4]; movts,1 42, %b[1] }',
    instructions: [add(0, 2), literal(1, 42)],
    hex: '12 00 00 0c 04 03 02 10 01 d4 c0 60 00 00 2a 00',
  },
  {
    key: 'G adds,0 + movts,1 _f32 0x100000 (LTS 32 бита)',
    asText: '{ adds,0 %b[2], %b[3], %b[4]; movts,1 _f32 0x100000, %b[1] }',
    instructions: [add(0, 2), literal(1, 0x100000)],
    hex: '12 00 00 0c 04 03 02 10 01 d8 c0 60 00 00 10 00',
  },
  {
    key: 'H adds,0 + adds,2 + movts,1 42 (три ALS + добивка + LTS)',
    asText: '{ adds,0 %b[2], %b[3], %b[4]; adds,2 %b[5], %b[6], %b[7]; movts,1 42, %b[1] }',
    instructions: [add(0, 2), literal(1, 42), add(2, 5)],
    hex: '23 00 00 1c 04 03 02 10 01 d4 c0 60 07 06 05 10 00 00 00 00 00 00 2a 00',
  },
  {
    key: 'H2 adds,0 + adds,2 + adds,3 + movts,1 42 (четыре ALS + LTS)',
    asText:
      '{ adds,0 %b[2], %b[3], %b[4]; adds,2 %b[5], %b[6], %b[7]; adds,3 %b[8], %b[9], %b[10]; ' +
      'movts,1 42, %b[1] }',
    instructions: [add(0, 2), literal(1, 42), add(2, 5), add(3, 8)],
    hex: '24 00 00 3c 04 03 02 10 01 d4 c0 60 07 06 05 10 0a 09 08 10 00 00 2a 00',
  },
  {
    key: 'I muls,0 + movts,1 42 (ALES + добивка + LTS)',
    asText: '{ muls,0 %b[2], %b[3], %b[4]; movts,1 42, %b[1] }',
    instructions: [{ mnemonic: 'muls', channel: 0, operands: [reg(2), reg(3), reg(4)] }, literal(1, 42)],
    hex: '22 00 10 0c 04 03 02 20 01 d4 c0 60 00 00 c0 01 00 00 00 00 00 00 2a 00',
  },
  {
    key: 'J adds,0 + movts,1 42 + ct (SS + ALS + добивка + LTS)',
    asText: '{ adds,0 %b[2], %b[3], %b[4]; movts,1 42, %b[1]; ct %ctpr1 }',
    instructions: [add(0, 2), literal(1, 42, ct())],
    hex: '23 10 00 0c 20 04 00 c0 04 03 02 10 01 d4 c0 60 00 00 00 00 00 00 2a 00',
  },
  {
    key: 'K adds,0 + movts,1 42 + sdisp (CS0 + ALS + LTS)',
    asText: '{ adds,0 %b[2], %b[3], %b[4]; movts,1 42, %b[1]; sdisp %ctpr1, 3 }',
    instructions: [add(0, 2), literal(1, 42, sdisp())],
    hex: '23 40 00 0c 04 03 02 10 01 d4 c0 60 03 00 00 60 00 00 00 00 00 00 2a 00',
  },
  {
    key: 'L adds,0 + movts,1 42 + call (SS + CS1 + LTS)',
    asText: '{ adds,0 %b[2], %b[3], %b[4]; movts,1 42, %b[1]; call %ctpr1, wbs=4 }',
    instructions: [add(0, 2), literal(1, 42, call())],
    hex: '24 90 00 0c 20 04 00 c0 04 03 02 10 01 d4 c0 60 04 00 00 50 00 00 2a 00',
  },
  {
    key: 'M muls,0 + movts,1 42 + ct (SS + ALES + LTS)',
    asText: '{ muls,0 %b[2], %b[3], %b[4]; movts,1 42, %b[1]; ct %ctpr1 }',
    instructions: [{ mnemonic: 'muls', channel: 0, operands: [reg(2), reg(3), reg(4)] }, literal(1, 42, ct())],
    hex: '23 10 10 0c 20 04 00 c0 04 03 02 20 01 d4 c0 60 00 00 c0 01 00 00 2a 00',
  },
];

/**
 * Наши байты: одна инструкция — одиночным кодировщиком, несколько — **раскладкой напрямую**
 * (`wideCommandBytes`).
 *
 * Почему не упаковщиком: `packWide` литералы в широкую команду **не берёт** — это названная
 * граница (`packetableRefusal`), и причина в ней: с литералом в паре закреплённые числа корпуса
 * сдвигаются (пакетов 220 → 210), а сдвинутое число по правилу проекта — отдельный коммит с датой.
 * Здесь проверяется **раскладка**, а не упаковка; упаковку пар `SS`/`CS0` проверяет ветвь с одной
 * инструкцией — она идёт через `encodeReal` и потому упаковщиком не отменяется.
 */
export function ourBytes(instructions: readonly AsmInstruction[]): string {
  if (instructions.length === 1) return toHex(encoder.encode(instructions[0]!)).replace(/\s+/g, ' ').trim();
  const slots = instructions.map((instruction) => wideAlsSlotOf(instruction));
  const control = instructions.find((instruction) => instruction.control !== undefined)?.control;
  const syllables = control === undefined ? {} : wideSyllablesOf(control);
  return toHex(wideCommandBytes(slots, syllables)).replace(/\s+/g, ' ').trim();
}

/** Разбор слова заголовка: `lng`, `mdl`, `al`, `ale`, `cs`, `ss` — по полям `HS`. */
export function headerOf(hex: string): { lng: number; mdl: number; al: number; ale: number; cs: number; ss: number } {
  const bytes = hex.trim().split(/\s+/).map((byte) => Number.parseInt(byte, 16));
  const hs = (bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24)) >>> 0;
  return {
    lng: (hs >>> 4) & 0x7,
    mdl: hs & 0xf,
    al: (hs >>> 26) & 0x3f,
    ale: (hs >>> 20) & 0x3f,
    cs: (hs >>> 14) & 0x3,
    ss: (hs >>> 12) & 0x1,
  };
}

describe('широкая команда «ALS + SS», «ALS + CS0» и «ALS + LTS»', () => {
  it('наши байты совпадают с измеренными байтами ассемблера — все 14 форм', () => {
    const problems: string[] = [];
    for (const item of CASES) {
      let ours: string;
      try {
        ours = ourBytes(item.instructions);
      } catch (error) {
        problems.push(`${item.key}: наш отказ — ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (ours !== item.hex) problems.push(`${item.key}: наши ${ours}, измерено ${item.hex}`);
    }
    expect(problems, problems.join('; ')).toEqual([]);
  });

  it('поля заголовка читаются так, как измерено: SS первым, LTS последним, добивка перед LTS', () => {
    // `{ adds,0; ct }` — SS присутствует, CS нет: `12 10 00 04` → `ss = 1`, `cs = 0`, `mdl = 2`.
    expect(headerOf('12 10 00 04 20 04 00 c0 03 02 01 10 00 00 00 00')).toMatchObject({ lng: 1, mdl: 2, cs: 0, ss: 1 });
    // `{ adds,0; sdisp }` — CS0 присутствует, SS нет: `cs = 1`.
    expect(headerOf('12 40 00 04 03 02 01 10 03 00 00 60 00 00 00 00')).toMatchObject({ lng: 1, mdl: 2, cs: 1, ss: 0 });
    // `call` несёт ОБА слога сразу: `13 90 00 04` → `ss = 1` И `cs = 2`.
    expect(headerOf('13 90 00 04 20 04 00 c0 03 02 01 10 04 00 00 50')).toMatchObject({ lng: 1, mdl: 3, cs: 2, ss: 1 });
    // С литералом добивка встаёт ПЕРЕД ним: `mdl = 2` считает HS, SS, ALS — но не добивку и не LTS.
    expect(headerOf('23 10 00 0c 20 04 00 c0 04 03 02 10 01 d4 c0 60 00 00 00 00 00 00 2a 00')).toMatchObject({
      lng: 2,
      mdl: 3,
      cs: 0,
      ss: 1,
    });
  });

  it('литерал всегда занимает ПОСЛЕДНЕЕ слово, а добивка — слово перед ним', () => {
    for (const item of CASES) {
      if (!item.hex.includes('2a 00')) continue; // формы без литерала 42 пропускаются
      const words = item.hex.trim().split(/\s+/);
      const last = words.slice(-4).join(' ');
      expect(last, `${item.key}: последнее слово — не литерал 42`).toBe('00 00 2a 00');
    }
  });

  it('непарные формы и лишние литералы отвергаются С ПРИЧИНОЙ, а не кодируются наугад', () => {
    const calls: { readonly what: string; readonly run: () => unknown; readonly match: RegExp }[] = [
      {
        what: 'return в пару с ALS',
        run: () => encoder.encode({ ...add(0), control: { mnemonic: 'return', channel: 0, operands: [imm(3)] } }),
        match: /return/u,
      },
      {
        what: 'setwd в пару с ALS',
        run: () =>
          encoder.encode({ ...add(0), control: { mnemonic: 'setwd', channel: 0, operands: [imm(16), imm(0)] } }),
        match: /setwd/u,
      },
      {
        what: '64-битный литерал вместе со слогом управления',
        run: () =>
          encoder.encode({
            mnemonic: 'movtd',
            channel: 1,
            operands: [{ kind: 'imm64', value: 0x100000n }, reg(1)],
            control: ct(),
          }),
        match: /64-битный литерал/u,
      },
    ];
    for (const item of calls) {
      expect(item.run, `${item.what}: не отвергнуто`).toThrow(EncodingRefusedError);
      expect(item.run, `${item.what}: причина не названа`).toThrow(item.match);
    }
    // Два литерала в одной команде: измерены формы с ОДНИМ словом LTS — раскладка отвергает.
    expect(() =>
      wideCommandBytes([wideAlsSlotOf(literal(0, 42)), wideAlsSlotOf(literal(1, 43))]),
    ).toThrow(EncodingRefusedError);
    expect(() =>
      wideCommandBytes([wideAlsSlotOf(literal(0, 42)), wideAlsSlotOf(literal(1, 43))]),
    ).toThrow(/два слова|одним словом|две операции с литералами/u);
    // А упаковщик литералы не берёт вовсе — причина названа и называет закреплённые числа.
    // Проверяется `packetableRefusal`, а не поле `refusal` пакета: `packWide` кладёт отказ в пакет
    // только тогда, когда и одиночный кодировщик отказал, — литерал же одиночной командой кодируется.
    const refusal = packetableRefusal(literal(1, 42));
    expect(refusal, 'упаковщик обязан назвать причину, а не молчать').toBeDefined();
    expect(refusal).toMatch(/не все операнды — регистры/u);
    expect(refusal).toMatch(/§3\.34/u);
    expect(refusal).toMatch(/220 → 210/u);
    // И как барьер пакетов литерал по-прежнему разделяет группу: он едет отдельной командой.
    const packets = packWide([add(0, 2), literal(1, 42), add(2, 5)]);
    expect(packets.length, 'литерал разделяет пакеты — прежнее поведение сохранено').toBe(3);
  });

  it('негативный контроль: подмена слога или порядка ломает байты', () => {
    // Тот же набор, но `ct` заменён на `sdisp`: `ss` гаснет, `cs` загорается — байты обязаны
    // разойтись. Иначе таблица выше ничего не различала бы.
    const withCt = ourBytes([{ ...add(0), control: ct() }]);
    const withSdisp = ourBytes([{ ...add(0), control: sdisp() }]);
    expect(withCt).not.toBe(withSdisp);
    expect(headerOf(withCt).ss).toBe(1);
    expect(headerOf(withSdisp).ss).toBe(0);
    // Разные коды условия у `ct` различимы — значит проверяется поле, а не константа.
    expect(ourBytes([{ ...add(0), control: ct(1) }])).not.toBe(
      ourBytes([{ ...add(0), control: { mnemonic: 'ct', channel: 0, operands: [imm(2), imm(CT_ALWAYS)] } }]),
    );
    // Литерал 42 против 43 различим в последнем слове.
    expect(ourBytes([add(0, 2), literal(1, 42)])).not.toBe(ourBytes([add(0, 2), literal(1, 43)]));
  });

  it('живая сверка с ассемблером МЦСТ: те же тексты, те же байты', () => {
    const { tool, reason } = findExternalAs();
    if (tool === undefined) {
      // Слабое место названо: без ассемблера эта проверка не выполнена, но таблица выше — выполнена.
      expect(reason).toBeDefined();
      return;
    }
    const samples: AsSample[] = CASES.map((item) => ({
      key: item.key,
      mnemonic: 'adds',
      channel: 0,
      form: 'ALF1',
      asText: item.asText,
      instruction: item.instructions[0]!,
      source: 'src/e2k/e2kWideSsLts.test.ts',
    }));
    const results = assembleAll(samples);
    const problems: string[] = [];
    results.forEach((result, index) => {
      const item = CASES[index]!;
      if (!result.ok) {
        problems.push(`${item.key}: ассемблер отказал — ${result.error}`);
        return;
      }
      const theirs = toHex(result.bytes).replace(/\s+/g, ' ').trim();
      if (theirs !== item.hex) problems.push(`${item.key}: ассемблер дал ${theirs}, закреплено ${item.hex}`);
      const ours = ourBytes(item.instructions);
      if (ours !== theirs) problems.push(`${item.key}: наши ${ours}, ассемблер ${theirs}`);
    });
    expect(problems, problems.join('; ')).toEqual([]);
  });
});
