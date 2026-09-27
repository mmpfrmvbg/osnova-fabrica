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
 * Эталон — **27 форм**, собранных ассемблером МЦСТ; наш кодировщик обязан дать те же байты **той же
 * длины**. Таблица закреплена ниже, живая сверка с `as` идёт отдельной проверкой.
 *
 * # Что изменилось 2026-09-27: литерал ВКЛЮЧЁН в упаковщик, и таблица выросла с 14 форм до 27
 *
 * До этого дня `packetableRefusal` отвергал литерал, и оракул проверял раскладку **в обход**
 * упаковщика (`wideCommandBytes` напрямую). Теперь литерал упаковщиком берётся, и `ourBytes` идёт
 * **через `packWide`** — проверяется то, что действительно кодируется.
 *
 * Перемер перед включением нашёл **дыру, из-за которой включать «как есть» было нельзя**: прежние
 * 14 форм несли литерал **42** или **0x100000**, то есть литеральную форму (`LTS`). А в пяти ядрах
 * **74 литерала из 78** имеют значение 0…15, и ассемблер кладёт их **короткой непосредственной
 * формой** — полем `0xc0 | N` прямо в слово ALS, **без слова `LTS`**. `wideAlsSlotOf` же давал
 * `LTS` для любого литерала, то есть на 74 литералах из 78 наш кодировщик разошёлся бы с `as`.
 *
 * Поэтому таблица дополнена 13 формами; каждая закрывает то, что упаковщик теперь может выдать:
 * малый литерал (N, O, P, Q, R, S), два и четыре малых в одной команде (T, V), малый вместе с
 * большим — одно слово `LTS` (U, X), и **до шести** слогов ALS вместе с `LTS` (Y, Z).
 * Замеры: `.tmp/osnova-lts-short-probe.ts`, `-multi-probe.ts`, `-multi2-probe.ts`, `-many-probe.ts`.
 *
 * # Чего этот оракул НЕ доказывает
 *
 * 1. Что так поведёт себя железо: сверка идёт с ассемблером МЦСТ, а не с машиной.
 * 2. Что кладутся **все** формы: `return` и `setwd` остаются названным отказом; `setwd` несёт
 *    литерал, и раскладка «ALS + CS1 + LTS» именно для него не проверялась.
 * 3. Что **два литеральных** (`LTS`) слова ложатся в одну команду. Ассемблер такую команду
 *    ПРИНИМАЕТ — измерено 2026-09-27: `{ movts,0 42, %b[1]; movts,1 43, %b[2] }` → одно слово
 *    `0x002a002b`, оба 16-битных литерала в нём, — но наш кодировщик её **отвергает**: слова
 *    литералов складываются по ширине, и раскладка смешанных ширин не выведена. Малый литерал слова
 *    `LTS` не несёт, поэтому запрет двух `LTS` двух малых не касается (T, V) и «малый + большой»
 *    тоже проходит (U, X).
 * 4. Что 64-битный литерал (`imm64`, форма `0xdc`, ДВА слова) ложится в широкую команду: его
 *    раскладка не измерялась и отвергается.
 * 5. Что выбор канала — наш: `packWide` берёт **первый свободный** канал, а ассемблер чтит
 *    записанный. Поэтому байты сравнимы только при совпадающем выборе канала (см. `CASES`).
 * 6. Что литерал ложится в **любой** канал: `movts` кодируется только в ALC0/1/3/4 — это
 *    `LONG_CHANNELS` из `opcodes/e2k-opc.h:644`, и проверено снаружи (`{ movts,2 5, %b[1] }` →
 *    «`movts' cannot be encoded in ALC2»).
 */
import { describe, expect, it } from 'vitest';
import { getEncoder, toHex, type AsmInstruction, type Operand } from './backend';
import { EncodingRefusedError } from './encoding';
import { wideAlsSlotOf, wideCommandBytes } from './e2k-real';
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
/**
 * Литеральная пересылка. `dst` назван параметром, потому что с 2026-09-27 в одной команде может
 * стоять **несколько** литералов, и у них обязаны быть разные приёмники — иначе RAW/WAW разведёт их
 * по разным пакетам и форма не соберётся.
 */
const literal = (channel: number, value: number, control?: AsmInstruction, dst = 1): AsmInstruction => ({
  mnemonic: 'movts',
  channel,
  operands: [imm(value), reg(dst)],
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
  // ── Дополнено 2026-09-27 вместе с включением литерала в упаковщик: малый литерал ──────────────
  // Значение 0…15 ассемблер кладёт КОРОТКОЙ формой — поле `0xc0 | N` в слове ALS, слова LTS нет.
  {
    key: 'N adds,0 + movts,1 5 (МАЛЫЙ литерал, короткая форма — без LTS)',
    asText: '{ adds,0 %b[2], %b[3], %b[4]; movts,1 5, %b[1] }',
    instructions: [add(0, 2), literal(1, 5)],
    hex: '12 00 00 0c 04 03 02 10 01 c5 c0 60 00 00 00 00',
  },
  {
    key: 'O adds,0 + adds,2 + movts,1 5 (два ALS + малый литерал)',
    asText: '{ adds,0 %b[2], %b[3], %b[4]; adds,2 %b[5], %b[6], %b[7]; movts,1 5, %b[1] }',
    instructions: [add(0, 2), literal(1, 5), add(2, 5)],
    hex: '13 00 00 1c 04 03 02 10 01 c5 c0 60 07 06 05 10',
  },
  {
    key: 'P movts,1 5 + ct (малый литерал + SS)',
    asText: '{ movts,1 5, %b[1]; ct %ctpr1 }',
    instructions: [{ ...literal(1, 5), control: ct() }],
    hex: '12 10 00 08 20 04 00 c0 01 c5 c0 60 00 00 00 00',
  },
  {
    key: 'Q adds,0 + movts,1 5 + ct (ALS + малый литерал + SS)',
    asText: '{ adds,0 %b[2], %b[3], %b[4]; movts,1 5, %b[1]; ct %ctpr1 }',
    instructions: [add(0, 2), { ...literal(1, 5), control: ct() }],
    hex: '13 10 00 0c 20 04 00 c0 04 03 02 10 01 c5 c0 60',
  },
  {
    key: 'R movts,1 5 + sdisp (малый литерал + CS0)',
    asText: '{ movts,1 5, %b[1]; sdisp %ctpr1, 3 }',
    instructions: [{ ...literal(1, 5), control: sdisp() }],
    hex: '12 40 00 08 01 c5 c0 60 03 00 00 60 00 00 00 00',
  },
  {
    key: 'S movts,1 5 + call (малый литерал + SS + CS1)',
    asText: '{ movts,1 5, %b[1]; call %ctpr1, wbs=4 }',
    instructions: [{ ...literal(1, 5), control: call() }],
    hex: '13 90 00 08 20 04 00 c0 01 c5 c0 60 04 00 00 50',
  },
  // ── Несколько литералов: малые слова LTS не несут, поэтому их может быть больше одного ────────
  {
    key: 'T movts,0 5 + movts,1 7 (ДВА малых литерала, ни одного слова LTS)',
    asText: '{ movts,0 5, %b[1]; movts,1 7, %b[2] }',
    instructions: [literal(0, 5, undefined, 1), literal(1, 7, undefined, 2)],
    hex: '12 00 00 0c 01 c5 c0 60 02 c7 c0 60 00 00 00 00',
  },
  {
    key: 'U movts,0 5 + movts,1 42 (малый + большой: слово LTS одно)',
    asText: '{ movts,0 5, %b[1]; movts,1 42, %b[2] }',
    instructions: [literal(0, 5, undefined, 1), literal(1, 42, undefined, 2)],
    hex: '12 00 00 0c 01 c5 c0 60 02 d4 c0 60 00 00 2a 00',
  },
  {
    key: 'V movts,0 5 + movts,1 7 + movts,3 9 + movts,4 11 (ЧЕТЫРЕ малых литерала)',
    asText: '{ movts,0 5, %b[1]; movts,1 7, %b[2]; movts,3 9, %b[3]; movts,4 11, %b[4] }',
    instructions: [
      literal(0, 5, undefined, 1),
      literal(1, 7, undefined, 2),
      literal(3, 9, undefined, 3),
      literal(4, 11, undefined, 4),
    ],
    hex: '24 00 00 6c 01 c5 c0 60 02 c7 c0 60 03 c9 c0 60 04 cb c0 60 00 00 00 00',
  },
  {
    key: 'W adds,2 + movts,0 5 + movts,1 7 + movts,3 9 + movts,4 11 (ALS + четыре малых)',
    asText:
      '{ adds,2 %b[2], %b[3], %b[4]; movts,0 5, %b[1]; movts,1 7, %b[5]; movts,3 9, %b[6]; ' +
      'movts,4 11, %b[7] }',
    instructions: [
      literal(0, 5, undefined, 1),
      literal(1, 7, undefined, 5),
      add(2, 2),
      literal(3, 9, undefined, 6),
      literal(4, 11, undefined, 7),
    ],
    hex: '25 00 00 7c 01 c5 c0 60 05 c7 c0 60 04 03 02 10 06 c9 c0 60 07 cb c0 60',
  },
  {
    key: 'X adds,2 + movts,0 5 + movts,1 7 + movts,3 42 (ALS + два малых + большой)',
    asText: '{ adds,2 %b[2], %b[3], %b[4]; movts,0 5, %b[1]; movts,1 7, %b[5]; movts,3 42, %b[6] }',
    instructions: [literal(0, 5, undefined, 1), literal(1, 7, undefined, 5), add(2, 2), literal(3, 42, undefined, 6)],
    hex: '24 00 00 3c 01 c5 c0 60 05 c7 c0 60 04 03 02 10 06 d4 c0 60 00 00 2a 00',
  },
  // ── Предел пачки: до ШЕСТИ слогов ALS вместе с LTS (было измерено три) ────────────────────────
  {
    key: 'Y adds,0 + movts,1 42 + adds,2 + adds,3 + adds,4 (ПЯТЬ слогов с LTS)',
    asText:
      '{ adds,0 %b[2], %b[3], %b[4]; movts,1 42, %b[1]; adds,2 %b[5], %b[6], %b[7]; ' +
      'adds,3 %b[8], %b[9], %b[10]; adds,4 %b[11], %b[12], %b[13] }',
    instructions: [add(0, 2), literal(1, 42), add(2, 5), add(3, 8), add(4, 11)],
    hex: '35 00 00 7c 04 03 02 10 01 d4 c0 60 07 06 05 10 0a 09 08 10 0d 0c 0b 10 00 00 00 00 00 00 2a 00',
  },
  {
    key: 'Z adds,0 + movts,1 42 + adds,2 + adds,3 + adds,4 + adds,5 (ШЕСТЬ слогов — предел формы)',
    asText:
      '{ adds,0 %b[2], %b[3], %b[4]; movts,1 42, %b[1]; adds,2 %b[5], %b[6], %b[7]; ' +
      'adds,3 %b[8], %b[9], %b[10]; adds,4 %b[11], %b[12], %b[13]; adds,5 %b[14], %b[15], %b[16] }',
    instructions: [add(0, 2), literal(1, 42), add(2, 5), add(3, 8), add(4, 11), add(5, 14)],
    hex: '36 00 00 fc 04 03 02 10 01 d4 c0 60 07 06 05 10 0a 09 08 10 0d 0c 0b 10 10 0f 0e 10 00 00 2a 00',
  },
];

/**
 * Наши байты: **через упаковщик** — то, что действительно кодируется.
 *
 * До 2026-09-27 здесь стоял обход: одна инструкция — одиночным кодировщиком, несколько —
 * **раскладкой напрямую** (`wideCommandBytes`), потому что `packWide` литералы не брал. С включением
 * литерала обход стал вреден: он проверял бы путь, которого в проде нет. Теперь весь набор идёт
 * `packWide`, а форма обязана собраться в **одну** команду — иначе это уже не та форма, что
 * записана у `as`.
 */
export function ourBytes(instructions: readonly AsmInstruction[]): string {
  const packets = packWide(instructions);
  if (packets.length !== 1) {
    throw new Error(`форма собралась в ${String(packets.length)} команд, а измерялась одна`);
  }
  return toHex(packets[0]!.bytes).replace(/\s+/g, ' ').trim();
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

  it('непарные формы и два слова LTS отвергаются С ПРИЧИНОЙ; литерал же в упаковщик включён', () => {
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
    // Два литеральных (LTS) слова в одной команде. Причина отказа с 2026-09-27 называет измеренное
    // честно: ассемблер МЦСТ такую команду ПРИНИМАЕТ, не реализует её наш кодировщик.
    expect(() =>
      wideCommandBytes([wideAlsSlotOf(literal(0, 42)), wideAlsSlotOf(literal(1, 43))]),
    ).toThrow(EncodingRefusedError);
    expect(() =>
      wideCommandBytes([wideAlsSlotOf(literal(0, 42)), wideAlsSlotOf(literal(1, 43))]),
    ).toThrow(/две операции с литералами/u);
    expect(() =>
      wideCommandBytes([wideAlsSlotOf(literal(0, 42)), wideAlsSlotOf(literal(1, 43))]),
    ).toThrow(/ПРИНИМАЕТ/u);
    // Литерал в упаковщике ВКЛЮЧЁН 2026-09-27: `packetableRefusal` его больше не отвергает —
    // ни большой, ни малый. Проверяется `packetableRefusal`, а не поле `refusal` пакета: отказ был
    // «по решению», а не по форме, и именно поэтому он снимается здесь, а не в `packWide`.
    expect(packetableRefusal(literal(1, 42)), 'большой литерал больше не барьер').toBeUndefined();
    expect(packetableRefusal(literal(1, 5)), 'малый литерал тоже').toBeUndefined();
    // 64-битный литерал барьером ОСТАЁТСЯ: его раскладка (два слова LTS) не измерялась.
    expect(
      packetableRefusal({ mnemonic: 'movtd', channel: 1, operands: [{ kind: 'imm64', value: 0x100000n }, reg(1)] }),
      '64-битный литерал обязан называть причину',
    ).toMatch(/64-битный литерал/u);
    // И литерал больше НЕ разделяет группу: три инструкции собираются в одну команду — ровно та
    // форма, что записана у `as` (форма H). Прежде здесь стояло «пакетов 3».
    const packets = packWide([add(0, 2), literal(1, 42), add(2, 5)]);
    expect(packets.length, 'литерал собирается вместе с соседями, а не разделяет их').toBe(1);
    expect(toHex(packets[0]!.bytes).replace(/\s+/g, ' ').trim(), 'байты наши — байты формы H').toBe(
      CASES.find((item) => item.key.startsWith('H '))!.hex,
    );
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
