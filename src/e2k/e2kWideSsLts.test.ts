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
 * Эталон — **47 форм**, собранных ассемблером МЦСТ; наш кодировщик обязан дать те же байты **той же
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
 * # Что изменилось 2026-09-27 (шаг 3): ДВА И БОЛЬШЕ БОЛЬШИХ ЛИТЕРАЛА в одной команде
 *
 * Прежде пара больших литералов была названным отказом с причиной «не измерялось». Замер
 * (`.tmp/osnova-two-lts-probe.ts`, `.tmp/osnova-share-probe.ts`, `.tmp/osnova-share2-probe.ts` —
 * сборка `as-new -mcpu=elbrus-v5` и разбор дизассемблера **по адресам**) дал правило раскладки, и
 * отказ снят: форма AA — ровно тот вход, что назван в задаче: `{ movts,0 42; movts,1 43 }` → `0x002a002b`.
 * Таблица выросла до **47** форм (27 прежних + 20 новых).
 *
 * Измеренные правила (все — в таблице ниже):
 *
 * | правило | замер |
 * |---|---|
 * | место литерала выбирает **расстановка** с наименьшей маской занятых полуслогов (как `as`) | AD, AE: hi и lo слова `lts0`, затем hi слова `lts1` |
 * | 16-битные литералы делят **одно** слово, старший полуслог — литералу младшего канала | AA, AB |
 * | **равные** значения делят одно место (32-битные — слово целиком) | AC, AM |
 * | 32-битный литерал занимает слово **целиком**, остальные уходят в другое слово | AJ, AK, AL, AO, AP, AR |
 * | 16-битный литерал делит полуслог с 32-битным, если их значения совпали | AN, AS, AT |
 * | добивка встаёт перед словами `LTS`, и её наличие зависит от **числа** этих слов | AE (два слова → добивка), AA (одно слово → нет) |
 *
 * **Чего наш интерфейс не выражает:** у `as` ширину литерала задаёт спецификатор (`_f16s`/`_f32s`),
 * у нас её выбирает **значение** (`imm` в пределах 16 бит → 16 бит, дальше 32). Поэтому форма
 * `{ movts,0 42; movts,1 _f32 42 }` (равные значения, но разной ширины) в таблицу не входит: наш
 * `imm(42)` — всегда 16-битный, и байты `as` для неё воспроизвести нечем. Это названная граница
 * представления, а не расхождение раскладки.
 *
 * # Чего этот оракул НЕ доказывает
 *
 * 1. Что так поведёт себя железо: сверка идёт с ассемблером МЦСТ, а не с машиной.
 * 2. Что кладутся **все** формы: `return` и `setwd` остаются названным отказом; `setwd` несёт
 *    литерал, и раскладка «ALS + CS1 + LTS» именно для него не проверялась.
 * 3. Что наш порядок литералов совпадает с `as` при **любом** порядке текста. Ассемблер раздаёт
 *    места литералам в порядке **текста**, мы — в порядке **слогов команды** (по каналу): измерено
 *    `{ movts,1 42; movts,0 43 }` → у `as` старшая половина слова несёт 42 (первый в тексте), тогда
 *    как наш эмиттер выдаёт инструкции по возрастанию канала, и первым для него идёт `movts,0 43`.
 *    Во всех формах таблицы порядок текста у `as` и порядок слогов у нас совпадают, поэтому байты
 *    сравнимы; само различие закреплено отдельной проверкой ниже.
 * 4. Что 64-битный литерал (`imm64`, форма `0xdc`, ДВА слова) ложится в широкую команду: его
 *    раскладка не измерялась и отвергается.
 * 5. Что выбор канала — наш: `packWide` берёт **первый свободный** канал, а ассемблер чтит
 *    записанный. Поэтому байты сравнимы только при совпадающем выборе канала (см. `CASES`).
 * 6. Что литерал ложится в **любой** канал: `movts` кодируется только в ALC0/1/3/4 — это
 *    `LONG_CHANNELS` из `opcodes/e2k-opc.h:644`, и проверено снаружи (`{ movts,2 5, %b[1] }` →
 *    «`movts' cannot be encoded in ALC2»).
 * 7. Что литерал кладётся в слот, отличный от `src2`: поле ссылки живёт в `src1`/`src2`/`dst`, но
 *    измерен только `src2` (`movts`, ALF2) — остальные слоты называются отказом.
 */
import { describe, expect, it } from 'vitest';
import { getEncoder, toHex, type AsmInstruction, type Operand } from './backend';
import { EncodingRefusedError } from './encoding';
import { wideAlsSlotOf, wideCommandBytes } from './e2k-real';
import { packWide, packetableRefusal, wideStats } from './widePacker';
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
 * Сколько в форме **больших** литералов (значение > 15, то есть со словом `LTS`).
 *
 * Оставлено как счётчик для сторожа слияния: пара больших литералов с 2026-09-27 (task-5) едет в
 * одной команде, и число литералов — то, что эта проверка называет вслух.
 */
export function bigLiteralsOf(instructions: readonly AsmInstruction[]): number {
  return instructions.reduce(
    (count, instruction) =>
      count + instruction.operands.filter((operand) => operand.kind === 'imm' && operand.value > 15).length,
    0,
  );
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
  // ── ДВА И БОЛЬШЕ БОЛЬШИХ ЛИТЕРАЛА В ОДНОЙ КОМАНДЕ (2026-09-27, `.tmp/osnova-two-lts-probe.ts`) ──
  // Место литерала в словах LTS выбирает расстановка: `as` минимизирует маску занятых полуслогов
  // (`busy_lts`, gas/config/tc-e2k.c:8266-8345). Отсюда измеренные правила: 16-битные литералы делят
  // полуслоги слов `lts0`/`lts1` (старший полуслог предпочитается младшему), 32-битный занимает слово
  // целиком, одинаковые значения переиспользуют одно место.
  {
    key: 'AA movts,0 42 + movts,1 43 (ДВА больших литерала в ОДНОМ слове LTS)',
    asText: '{ movts,0 42, %b[1]; movts,1 43, %b[2] }',
    instructions: [literal(0, 42, undefined, 1), literal(1, 43, undefined, 2)],
    hex: '12 00 00 0c 01 d4 c0 60 02 d0 c0 60 2b 00 2a 00',
  },
  {
    key: 'AB movts,0 43 + movts,1 42 (значения переставлены: место решает КАНАЛ, не значение)',
    asText: '{ movts,0 43, %b[1]; movts,1 42, %b[2] }',
    instructions: [literal(0, 43, undefined, 1), literal(1, 42, undefined, 2)],
    hex: '12 00 00 0c 01 d4 c0 60 02 d0 c0 60 2a 00 2b 00',
  },
  {
    key: 'AC movts,0 42 + movts,1 42 (РАВНЫЕ значения делят один полуслог: слово одно)',
    asText: '{ movts,0 42, %b[1]; movts,1 42, %b[2] }',
    instructions: [literal(0, 42, undefined, 1), literal(1, 42, undefined, 2)],
    hex: '12 00 00 0c 01 d4 c0 60 02 d4 c0 60 00 00 2a 00',
  },
  {
    key: 'AD movts,0 42 + movts,1 43 + movts,3 44 (ТРИ больших: hi и lo слова lts0, hi слова lts1)',
    asText: '{ movts,0 42, %b[1]; movts,1 43, %b[2]; movts,3 44, %b[3] }',
    instructions: [literal(0, 42, undefined, 1), literal(1, 43, undefined, 2), literal(3, 44, undefined, 3)],
    hex: '23 00 00 2c 01 d4 c0 60 02 d0 c0 60 03 d5 c0 60 00 00 2c 00 2b 00 2a 00',
  },
  {
    key: 'AE movts,0 42 + movts,1 43 + movts,3 44 + movts,4 45 (ЧЕТЫРЕ больших: два слова LTS + добивка)',
    asText: '{ movts,0 42, %b[1]; movts,1 43, %b[2]; movts,3 44, %b[3]; movts,4 45, %b[4] }',
    instructions: [
      literal(0, 42, undefined, 1),
      literal(1, 43, undefined, 2),
      literal(3, 44, undefined, 3),
      literal(4, 45, undefined, 4),
    ],
    hex: '34 00 00 6c 01 d4 c0 60 02 d0 c0 60 03 d5 c0 60 04 d1 c0 60 00 00 00 00 2d 00 2c 00 2b 00 2a 00',
  },
  {
    key: 'AF adds,0 + movts,1 42 + movts,3 43 (ALS + два больших)',
    asText: '{ adds,0 %b[2], %b[3], %b[4]; movts,1 42, %b[1]; movts,3 43, %b[5] }',
    instructions: [add(0, 2), literal(1, 42, undefined, 1), literal(3, 43, undefined, 5)],
    hex: '23 00 00 2c 04 03 02 10 01 d4 c0 60 05 d0 c0 60 00 00 00 00 2b 00 2a 00',
  },
  {
    key: 'AG movts,0 42 + movts,1 43 + ct (SS + два больших)',
    asText: '{ movts,0 42, %b[1]; movts,1 43, %b[2]; ct %ctpr1 }',
    instructions: [literal(0, 42, undefined, 1), { ...literal(1, 43, undefined, 2), control: ct() }],
    hex: '23 10 00 0c 20 04 00 c0 01 d4 c0 60 02 d0 c0 60 00 00 00 00 2b 00 2a 00',
  },
  {
    key: 'AH adds,0 + movts,1 42 + movts,3 43 + ct %ctpr2 (ALS + SS + два больших)',
    asText: '{ adds,0 %b[2], %b[3], %b[4]; movts,1 42, %b[1]; movts,3 43, %b[5]; ct %ctpr2 }',
    instructions: [add(0, 2), literal(1, 42, undefined, 1), { ...literal(3, 43, undefined, 5), control: ct(2) }],
    hex: '24 10 00 2c 20 08 00 c0 04 03 02 10 01 d4 c0 60 05 d0 c0 60 2b 00 2a 00',
  },
  {
    key: 'AI adds,0 + movts,1 42 + movts,3 43 + sdisp (CS0 + два больших)',
    asText: '{ adds,0 %b[2], %b[3], %b[4]; movts,1 42, %b[1]; movts,3 43, %b[5]; sdisp %ctpr1, 3 }',
    instructions: [add(0, 2), literal(1, 42, undefined, 1), { ...literal(3, 43, undefined, 5), control: sdisp() }],
    hex: '24 40 00 2c 04 03 02 10 01 d4 c0 60 05 d0 c0 60 03 00 00 60 2b 00 2a 00',
  },
  {
    key: 'AJ movts,0 42 + movts,1 _f32 0x100000 (16 + 32: слово lts0 занято 32-битным, 16-битный — в lts1 hi)',
    asText: '{ movts,0 42, %b[1]; movts,1 _f32 0x100000, %b[2] }',
    instructions: [literal(0, 42, undefined, 1), literal(1, 0x100000, undefined, 2)],
    hex: '22 00 00 0c 01 d5 c0 60 02 d8 c0 60 00 00 00 00 00 00 2a 00 00 00 10 00',
  },
  {
    key: 'AK movts,0 _f32 0x100000 + movts,1 43 (32 + 16: порядок слогов другой, раскладка та же)',
    asText: '{ movts,0 _f32 0x100000, %b[1]; movts,1 43, %b[2] }',
    instructions: [literal(0, 0x100000, undefined, 1), literal(1, 43, undefined, 2)],
    hex: '22 00 00 0c 01 d8 c0 60 02 d5 c0 60 00 00 00 00 00 00 2b 00 00 00 10 00',
  },
  {
    key: 'AL movts,0 _f32 0x100000 + movts,1 _f32 0x200000 (два 32-битных: по слову каждому)',
    asText: '{ movts,0 _f32 0x100000, %b[1]; movts,1 _f32 0x200000, %b[2] }',
    instructions: [literal(0, 0x100000, undefined, 1), literal(1, 0x200000, undefined, 2)],
    hex: '22 00 00 0c 01 d8 c0 60 02 d9 c0 60 00 00 00 00 00 00 20 00 00 00 10 00',
  },
  {
    key: 'AM movts,0 _f32 0x100000 + movts,1 _f32 0x100000 (РАВНЫЕ 32-битные делят слово)',
    asText: '{ movts,0 _f32 0x100000, %b[1]; movts,1 _f32 0x100000, %b[2] }',
    instructions: [literal(0, 0x100000, undefined, 1), literal(1, 0x100000, undefined, 2)],
    hex: '12 00 00 0c 01 d8 c0 60 02 d8 c0 60 00 00 10 00',
  },
  {
    key: 'AN movts,0 _f32 0x100000 + movts,1 16 (16-битный литерал равен СТАРШЕЙ половине 32-битного)',
    asText: '{ movts,0 _f32 0x100000, %b[1]; movts,1 16, %b[2] }',
    instructions: [literal(0, 0x100000, undefined, 1), literal(1, 16, undefined, 2)],
    hex: '12 00 00 0c 01 d8 c0 60 02 d4 c0 60 00 00 10 00',
  },
  {
    key: 'AO movts,0 _f32 0x100000 + movts,1 43 + movts,3 _f32 0x200000 (32, 16, 32: 16-битный уходит в lts1)',
    asText: '{ movts,0 _f32 0x100000, %b[1]; movts,1 43, %b[2]; movts,3 _f32 0x200000, %b[3] }',
    instructions: [
      literal(0, 0x100000, undefined, 1),
      literal(1, 43, undefined, 2),
      literal(3, 0x200000, undefined, 3),
    ],
    hex: '33 00 00 2c 01 d8 c0 60 02 d5 c0 60 03 da c0 60 00 00 00 00 00 00 20 00 00 00 2b 00 00 00 10 00',
  },
  {
    key: 'AS movts,0 42 + movts,1 _f32 0x2a0000 (16-битный литерал равен СТАРШЕЙ половине 32-битного)',
    asText: '{ movts,0 42, %b[1]; movts,1 _f32 0x2a0000, %b[2] }',
    instructions: [literal(0, 42, undefined, 1), literal(1, 0x2a0000, undefined, 2)],
    hex: '12 00 00 0c 01 d4 c0 60 02 d8 c0 60 00 00 2a 00',
  },
  {
    key: 'AT movts,0 _f32 0x10002b + movts,1 43 (16-битный литерал равен МЛАДШЕЙ половине 32-битного)',
    asText: '{ movts,0 _f32 0x10002b, %b[1]; movts,1 43, %b[2] }',
    instructions: [literal(0, 0x10002b, undefined, 1), literal(1, 43, undefined, 2)],
    hex: '12 00 00 0c 01 d8 c0 60 02 d0 c0 60 2b 00 10 00',
  },
  {
    key: 'AP movts,0 _f32 0x100000 + movts,1 _f32 0x200000 + movts,3 43 (два 32-битных и 16-битный после них)',
    asText: '{ movts,0 _f32 0x100000, %b[1]; movts,1 _f32 0x200000, %b[2]; movts,3 43, %b[3] }',
    instructions: [
      literal(0, 0x100000, undefined, 1),
      literal(1, 0x200000, undefined, 2),
      literal(3, 43, undefined, 3),
    ],
    hex: '33 00 00 2c 01 d8 c0 60 02 da c0 60 03 d5 c0 60 00 00 00 00 00 00 20 00 00 00 2b 00 00 00 10 00',
  },
  {
    key: 'AQ movts,0 42 + movts,1 _f32 0x100000 + movts,3 44 (16, 32, 16: два 16-битных делят слово lts1)',
    asText: '{ movts,0 42, %b[1]; movts,1 _f32 0x100000, %b[2]; movts,3 44, %b[3] }',
    instructions: [
      literal(0, 42, undefined, 1),
      literal(1, 0x100000, undefined, 2),
      literal(3, 44, undefined, 3),
    ],
    hex: '23 00 00 2c 01 d5 c0 60 02 d8 c0 60 03 d1 c0 60 2c 00 2a 00 00 00 10 00',
  },
  {
    key: 'AR movts,0 _f32 0x100000 + movts,1 _f32 0x200000 + movts,3 44 + movts,4 45 (ТРИ слова LTS)',
    asText:
      '{ movts,0 _f32 0x100000, %b[1]; movts,1 _f32 0x200000, %b[2]; movts,3 44, %b[3]; ' +
      'movts,4 45, %b[4] }',
    instructions: [
      literal(0, 0x100000, undefined, 1),
      literal(1, 0x200000, undefined, 2),
      literal(3, 44, undefined, 3),
      literal(4, 45, undefined, 4),
    ],
    hex: '34 00 00 6c 01 d8 c0 60 02 da c0 60 03 d5 c0 60 04 d1 c0 60 00 00 20 00 2d 00 2c 00 00 00 10 00',
  },
];

/**
 * Наши байты: **через упаковщик** — то, что действительно кодируется.
 *
 * До 2026-09-27 здесь стоял обход: одна инструкция — одиночным кодировщиком, несколько —
 * **раскладкой напрямую** (`wideCommandBytes`), потому что `packWide` литералы не брал. С включением
 * литерала обход стал вреден: он проверял бы путь, которого в проде нет. Теперь **весь** набор идёт
 * `packWide` — включая формы с двумя и более большими литералами: с 2026-09-27 (task-5) упаковщик
 * сливает их в одну команду, и обходного пути `layoutBytes` больше нет.
 */
export function ourBytes(instructions: readonly AsmInstruction[]): string {
  const packets = packWide(instructions);
  if (packets.length !== 1) {
    throw new Error(`форма собралась в ${String(packets.length)} команд, а измерялась одна`);
  }
  return toHex(packets[0]!.bytes).replace(/\s+/g, ' ').trim();
}

/** Байты формы — через упаковщик: он и есть прод-путь (`ourBytes`). */
export function bytesOf(item: WideForm): string {
  return ourBytes(item.instructions);
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
  it('таблица закреплена числом: 47 форм, сверенных с `as`', () => {
    // Число названо в шапке и в `docs/hardware-debt.md` §3.34.2: если форма добавится или уйдёт,
    // это обязано быть видно здесь, а не только расхождением шапки с таблицей.
    expect(CASES.length, 'форм в таблице').toBe(47);
  });

  it('наши байты совпадают с измеренными байтами ассемблера — вся таблица', () => {
    const problems: string[] = [];
    for (const item of CASES) {
      let ours: string;
      try {
        ours = bytesOf(item);
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

  it('литерал занимает ПОСЛЕДНЕЕ слово, а добивка — слово перед ним', () => {
    for (const item of CASES) {
      // Формы с одним большим литералом 42: последнее слово — слово этого литерала.
      const bigs = item.instructions.flatMap((instruction) =>
        instruction.operands.filter((operand) => operand.kind === 'imm' && operand.value > 15),
      );
      if (bigs.length !== 1 || bigs[0]!.kind !== 'imm' || bigs[0]!.value !== 42) continue;
      const words = item.hex.trim().split(/\s+/);
      const last = words.slice(-4).join(' ');
      expect(last, `${item.key}: последнее слово — не литерал 42`).toBe('00 00 2a 00');
    }
    // Два литерала 42 и 43 делят ПОСЛЕДНЕЕ слово: старшая половина — литерал младшего канала.
    const pair = CASES.find((item) => item.key.startsWith('AA '))!;
    expect(pair.hex.trim().split(/\s+/).slice(-4).join(' ')).toBe('2b 00 2a 00');
  });

  it('непарные формы и 64-битный литерал отвергаются С ПРИЧИНОЙ; литерал же в упаковщик включён', () => {
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
    // Два больших литерала в одной команде с 2026-09-27 КОДИРУЮТСЯ (форма AA) — отказ снят вместе
    // с замером. Проверяется, что отказ действительно снят, а не спрятан: раскладка из двух слотов
    // даёт ровно те байты, что у `as`. Приёмники разные — иначе литералы связаны по регистру.
    expect(() =>
      wideCommandBytes([wideAlsSlotOf(literal(0, 42, undefined, 1)), wideAlsSlotOf(literal(1, 43, undefined, 2))]),
    ).not.toThrow();
    expect(
      toHex(
        wideCommandBytes([wideAlsSlotOf(literal(0, 42, undefined, 1)), wideAlsSlotOf(literal(1, 43, undefined, 2))]),
      ),
    ).toBe(CASES.find((item) => item.key.startsWith('AA '))!.hex);
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
    // СЛИЯНИЕ ПАРЫ ВКЛЮЧЕНО 2026-09-27 (task-5): два больших литерала едут в ОДНОЙ команде, и это
    // проверяется через упаковщик — то есть через прод-путь, а не в обход. Байты пары сверены с `as`
    // побайтово формой AA; числа упаковки, сдвинувшиеся от слияния, перемерены отдельным коммитом
    // (пакетов пяти ядер 857 → 855, у `iir` 122 → 120, пустых слотов 4066 → 4054).
    const pairPackets = packWide([literal(0, 42, undefined, 1), literal(1, 43, undefined, 2)]);
    expect(pairPackets.length, 'пара больших литералов едет в одной команде').toBe(1);
    expect(pairPackets[0]!.slots.length, 'слогов в паре').toBe(2);
    expect(toHex(pairPackets[0]!.bytes).replace(/\s+/g, ' ').trim(), 'байты наши — байты формы AA').toBe(
      CASES.find((item) => item.key.startsWith('AA '))!.hex,
    );
    // Слияние видно и в статистике: два больших литерала — один пакет, а не два.
    expect(wideStats([literal(0, 42, undefined, 1), literal(1, 43, undefined, 2)]).packets, 'пакетов').toBe(1);
  });

  it('негативный контроль: снятие слияния, снятие литерала и подмена значения различимы', () => {
    const pair = CASES.find((item) => item.key.startsWith('AA '))!;
    const ours = ourBytes(pair.instructions);
    // (0) СНЯТИЕ СЛИЯНИЯ: если бы пара снова разошлась по пакетам (прежнее правило), байты были бы
    //     такими — каждая литеральная пересылка отдельной командой по 16 байт. Различие обязательно:
    //     иначе проверка слияния ничего не доказывала бы.
    const split = `${ourBytes([literal(0, 42, undefined, 1)])} ${ourBytes([literal(1, 43, undefined, 2)])}`;
    expect(ours).not.toBe(split);
    expect(ours.length < split.length, 'слитая пара короче двух отдельных команд').toBe(true);
    expect(packWide(pair.instructions).length, 'слитая пара — одна команда').toBe(1);
    // (1) Второй литерал снят: слово LTS остаётся одно, и младшая его половина пуста — байты
    //     обязаны разойтись (в паре младшая половина несёт 43).
    const single = ourBytes([literal(0, 42, undefined, 1), add(2, 3)]);
    expect(ours).not.toBe(single);
    expect(single.endsWith('00 00 2a 00'), 'одиночный литерал 42 — старшая половина слова').toBe(true);
    expect(ours.endsWith('2b 00 2a 00'), 'в паре младшая половина несёт 43').toBe(true);
    // (2) Значение второго литерала подменено — различимо в слове LTS.
    const changed = ourBytes([literal(0, 42, undefined, 1), literal(1, 44, undefined, 2)]);
    expect(ours).not.toBe(changed);
    // (3) ЗЕРКАЛО: если бы полуслоги раздавались наоборот (старший — старшему каналу), байты были бы
    //     такими. Замер говорит другое — значит таблица различает, а не «сходится всегда».
    const mirrored = '12 00 00 0c 01 d0 c0 60 02 d4 c0 60 2b 00 2a 00';
    expect(ours).not.toBe(mirrored);
    // (4) РАВНЫЕ значения делят полуслог: «каждому литералу своя половина» дало бы слово 0x002a002a —
    //     замер говорит 0x002a0000, и это различие закреплено (AC).
    const shared = CASES.find((item) => item.key.startsWith('AC '))!;
    expect(ourBytes(shared.instructions)).toBe(shared.hex);
    expect(shared.hex.endsWith('00 00 2a 00'), 'равные литералы — одно слово, а не две половины').toBe(true);
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

  it('различие названо: места литералов `as` раздаёт по ТЕКСТУ, а мы — по слогам (каналу)', () => {
    // Измерено (`.tmp/osnova-two-lts-probe.ts`, K5): `{ movts,1 42; movts,0 43 }` — текст идёт НЕ по
    // возрастанию канала. `as` отдаёт старшую половину слова первому литералу ТЕКСТА (42), младшую —
    // второму (43), и поле `0xd4` достаётся КАНАЛУ 1. Наш вход — тот же набор инструкций, но слоги
    // команды идут по каналу, поэтому первым литералом становится литерал канала 0 (43) — это
    // ЗЕРКАЛО байтов `as`. Различие ожидаемо и названо; эмиттер выдаёт инструкции по каналу, поэтому
    // для него значим наш порядок.
    const asByText = '12 00 00 0c 01 d0 c0 60 02 d4 c0 60 2b 00 2a 00';
    const ours = ourBytes([literal(0, 43, undefined, 1), literal(1, 42, undefined, 2)]);
    expect(ours, 'наш порядок — по каналу (форма AB)').toBe(CASES.find((item) => item.key.startsWith('AB '))!.hex);
    expect(ours, 'это зеркало байтов `as` для того же набора').not.toBe(asByText);
    // Живая сверка: тот же расклад слогов, записанный в тексте ПО КАНАЛУ, у `as` даёт наши байты, а
    // текст против канала — зеркало. Значит различие именно в порядке текста, а не в раскладке.
    const { tool } = findExternalAs();
    if (tool === undefined) return;
    const sample = (key: string, asText: string, instruction: AsmInstruction): AsSample => ({
      key,
      mnemonic: 'movts',
      channel: 0,
      form: 'ALF2',
      asText,
      instruction,
      source: 'src/e2k/e2kWideSsLts.test.ts',
    });
    const results = assembleAll([
      sample('текст по каналу', '{ movts,0 43, %b[1]; movts,1 42, %b[2] }', literal(0, 43, undefined, 1)),
      sample('текст против канала', '{ movts,1 42, %b[2]; movts,0 43, %b[1] }', literal(1, 42, undefined, 2)),
    ]);
    const hexOf = (index: number): string => {
      const result = results[index]!;
      if (!result.ok) throw new Error(`ассемблер отказал: ${result.error}`);
      return toHex(result.bytes).replace(/\s+/g, ' ').trim();
    };
    expect(hexOf(0), 'текст по каналу — наши байты').toBe(ours);
    expect(hexOf(1), 'текст против канала — зеркало').toBe(asByText);
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
      const ours = bytesOf(item);
      if (ours !== theirs) problems.push(`${item.key}: наши ${ours}, ассемблер ${theirs}`);
    });
    expect(problems, problems.join('; ')).toEqual([]);
  });
});
