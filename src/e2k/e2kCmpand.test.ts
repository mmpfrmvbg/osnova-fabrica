/**
 * ОРАКУЛ СЛИТОЙ ФОРМЫ `CMPAND*` — СЛИЯНИЕ ЛОГИЧЕСКОГО И С СРАВНЕНИЕМ.
 *
 * # Что это за форма (замер, а не пересказ)
 *
 * `CMPAND*` — **не отдельная раскладка слога**, а та же `ALF7` с другим кодом операции:
 * `0x22` — одиночные источники (`ARGS_SS`), `0x23` — двойные (`ARGS_DD`). Условие сравнения
 * остаётся в `cmpopce[7:5]`, приёмник — в `pdst[4:0]`. Измерено ассемблером МЦСТ
 * (`as-new -mcpu=elbrus-v5`, канал 0, `%b[1], %b[2], %pred0`):
 *
 * | текст МЦСТ | байты |
 * |---|---|
 * | `cmpesb,0 %b[1], %b[2], %pred0` | `01 01 00 04 40 02 01 20` |
 * | `cmpandesb,0 %b[1], %b[2], %pred0` | `01 01 00 04 40 02 01 22` |
 * | `cmpandssb,0 %b[1], %b[2], %pred0` | `01 01 00 04 80 02 01 22` |
 * | `cmpandpsb,0 %b[1], %b[2], %pred0` | `01 01 00 04 a0 02 01 22` |
 * | `cmpandlesb,0 %b[1], %b[2], %pred0` | `01 01 00 04 e0 02 01 22` |
 * | `cmpandedb,0 %db[1], %db[2], %pred0` | `01 01 00 04 40 02 01 23` |
 *
 * # Что этот оракул ОТМЕНЯЕТ в чтении реестра долга (§3.25)
 *
 * 1. **Код операции — `0x22`/`0x23`, а не `0x16`/`0x17`.** В §3.25 записано «`CMPANDSB`/`CMPANDDB` —
 *    номера 22/23 (0x16/0x17)»: это десятичные номера семейств, переписанные как шестнадцатеричные.
 *    Настоящее поле кода операции — `0x22`/`0x23` (`opcodes/e2k-opc.h:1069,1089`), и оно стоит
 *    в том же байте, что `0x20` у обычных `cmp*`.
 * 2. **Предиката-источника в команде НЕТ, и SS-слога у неё тоже нет.** Команда занимает **восемь**
 *    байт (`HS.s = 0`), а «И» делает сама команда над **двумя регистровыми источниками**:
 *    `res = zf = (src1 & src2) == 0` (`qemu/target/e2k/tcg/translate-al-c2.c:683-720`). Опрошено
 *    ассемблером: четвёртый операнд `%pred1` в `cmpandesb,0 %b[1], %b[2], %pred0, %pred1`
 *    отвергается — «unrecognized arguments». То есть предикат-источник полю `SS.ctcond.psrc`
 *    **не принадлежит**; поле `psrc` — код условия управляющих слогов (`ct`), а не операнд CMPAND.
 * 3. **Набор условий усечён**: у CMPAND есть только `2` (равно), `4` (знак), `5` (чётность) и
 *    `7` (меньше-или-равно); записи `0`, `1`, `3` — `UNDEF`, а «меньше» (`6`) отсутствует вовсе
 *    (`qemu/target/e2k/opcode-tables.c:1320-1341`). Поэтому `cmplsb` слитой формы **не имеет**:
 *    этим путём заменяются `cmpesb` и `cmplesb`, но не `cmplsb`.
 *
 * # Что этот оракул доказывает и чего НЕ доказывает
 *
 * Доказывает: наши байты принимает **внешний** ассемблер побайтово и читает **внешний**
 * дизассемблер по своему адресу — семейством `cmpand*`, а не `nop` и не мусором.
 *
 * НЕ доказывает: что команда **исполнится**. Порт МЦСТ на этой форме падает своим утверждением
 * (`op_descr->is_al`, `qemu/target/e2k/tcg/translate-lookahead.c:318`) — измерено в §3.25.
 * Исполнение остаётся долгом до железа, и это записано, а не выдано за проверенное.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { getEncoder, sameInstruction, toHex, type AsmInstruction, type Operand } from './backend';
import { REAL_OPCODES, realOpcode } from './e2k-real';
import { assembleAll, type AsSample } from '../scripts/e2kExternalAs';
import { buildE2kElf, disassembleElf, findExternalTool, parseObjdumpOutput } from '../scripts/e2kExternalObjdump';
import type { E2kSample } from '../scripts/extractE2kSamples';
import type { RealForm } from './e2k-real';

const ROOT = path.resolve(__dirname, '..', '..');
const encoder = getEncoder('e2k');

const reg = (index: number): Operand => ({ kind: 'reg', index });
/** Предикат — ОТДЕЛЬНЫЙ вид операнда: `%pred0` и `%b[0]` лежат в разных файлах. */
const pred = (index: number): Operand => ({ kind: 'pred', index }) as unknown as Operand;
const asm = (mnemonic: string, operands: readonly Operand[]): AsmInstruction => ({
  mnemonic,
  channel: 0,
  operands,
});

/** Один образец семейства: мнемоника, формат источников и измеренные ассемблером байты. */
interface CmpandSample {
  readonly mnemonic: string;
  readonly opc: number;
  readonly cmpOpce: number;
  readonly source: string;
  /** Формат источников: `S` — `%b[N]`, `D` — `%db[N]`. */
  readonly argFormat: 'S' | 'D';
  /** Текст для ассемблера МЦСТ — ровно тот, который измерялся. */
  readonly asText: string;
  /** Эталонные байты (восемь, короткая форма ALF7). */
  readonly hex: string;
}

const S = (index: number): string => `%b[${index}]`;
const D = (index: number): string => `%db[${index}]`;

function sample(
  mnemonic: string,
  opc: number,
  cmpOpce: number,
  source: string,
  argFormat: 'S' | 'D',
  hexLowByte: number,
): CmpandSample {
  const r = argFormat === 'S' ? S : D;
  return {
    mnemonic,
    opc,
    cmpOpce,
    source,
    argFormat,
    asText: `${mnemonic},0 ${r(1)}, ${r(2)}, %pred0`,
    // HS и регистровые поля у всех восьми одинаковы: 01 01 00 04 | <cmpopce|pdst> 02 01 <opc>.
    hex: `01 01 00 04 ${hexLowByte.toString(16).padStart(2, '0')} 02 01 ${opc.toString(16).padStart(2, '0')}`,
  };
}

/** Восемь мнемоник семейства — байты измерены ассемблером МЦСТ (см. шапку). */
const FAMILY: readonly CmpandSample[] = [
  sample('cmpandesb', 0x22, 2, 'opcodes/e2k-opc.h:1069', 'S', 0x40),
  sample('cmpandssb', 0x22, 4, 'opcodes/e2k-opc.h:1074', 'S', 0x80),
  sample('cmpandpsb', 0x22, 5, 'opcodes/e2k-opc.h:1079', 'S', 0xa0),
  sample('cmpandlesb', 0x22, 7, 'opcodes/e2k-opc.h:1084', 'S', 0xe0),
  sample('cmpandedb', 0x23, 2, 'opcodes/e2k-opc.h:1089', 'D', 0x40),
  sample('cmpandsdb', 0x23, 4, 'opcodes/e2k-opc.h:1094', 'D', 0x80),
  sample('cmpandpdb', 0x23, 5, 'opcodes/e2k-opc.h:1099', 'D', 0xa0),
  sample('cmpandledb', 0x23, 7, 'opcodes/e2k-opc.h:1104', 'D', 0xe0),
];

const instructionOf = (item: CmpandSample): AsmInstruction =>
  asm(item.mnemonic, [reg(1), reg(2), pred(0)]);

describe('CMPAND*: 1. таблица семейства', () => {
  it('восемь мнемоник, форма ALF7, код операции 0x22/0x23, предикат-приёмник pdst', () => {
    for (const item of FAMILY) {
      const entry = realOpcode(item.mnemonic);
      expect(entry, `${item.mnemonic}: нет записи в таблице`).toBeDefined();
      expect(entry!.form, `${item.mnemonic}: форма`).toBe('ALF7');
      expect(entry!.opc, `${item.mnemonic}: код операции`).toBe(item.opc);
      expect(entry!.cmpOpce, `${item.mnemonic}: код условия`).toBe(item.cmpOpce);
      // Обязательное поле nop = 2 — у всех записей семейства (implicit_nops шаблона ALF7).
      expect(entry!.implicitNops, `${item.mnemonic}: поле nop`).toBe(2);
      expect(entry!.operands.at(-1), `${item.mnemonic}: приёмник последним`).toBe('pdst');
      expect(entry!.source, `${item.mnemonic}: источник`).toBe(item.source);
    }
  });

  it('код операции 0x22/0x23 у формы ALF7 занят ТОЛЬКО семейством CMPAND', () => {
    // Именно у ALF7: те же номера 0x22/0x23 носят `umulx`/`smulx` формы ALF11 — код операции
    // читается вместе с формой, поэтому проверка называется вместе с ней.
    const byOpcode = REAL_OPCODES.filter(
      (entry) => entry.form === 'ALF7' && (entry.opc === 0x22 || entry.opc === 0x23),
    );
    expect(byOpcode.map((entry) => entry.mnemonic).sort()).toEqual(FAMILY.map((item) => item.mnemonic).sort());
  });

  it('условия «меньше» (6) в семействе НЕТ — слитой формы cmplsb не существует', () => {
    const conditions = [...new Set(FAMILY.map((item) => item.cmpOpce))].sort((a, b) => a - b);
    expect(conditions).toEqual([2, 4, 5, 7]);
    expect(realOpcode('cmpandlsb'), 'условие «меньше» у CMPAND не определено источником').toBeUndefined();
    // Сверка с таблицей МЦСТ: у обычных cmp условие 6 есть (cmplsb), у CMPAND — нет.
    expect(realOpcode('cmplsb')!.cmpOpce, 'у cmplsb код условия «меньше»').toBe(6);
  });
});

describe('CMPAND*: 2. кодирование', () => {
  it('байты совпадают с измеренными ассемблером МЦСТ', () => {
    for (const item of FAMILY) {
      expect(toHex(encoder.encode(instructionOf(item))), `${item.asText}`).toBe(item.hex);
    }
  });

  it('отличие от обычного сравнения — РОВНО один байт, код операции', () => {
    // Пары с общим условием: «равно» (2) и «меньше-или-равно» (7).
    const pairs: ReadonlyArray<[CmpandSample, string]> = [
      [FAMILY[0]!, 'cmpesb'],
      [FAMILY[3]!, 'cmplesb'],
    ];
    for (const [merged, plain] of pairs) {
      const ours = encoder.encode(instructionOf(merged));
      const plainBytes = encoder.encode(asm(plain, [reg(1), reg(2), pred(0)]));
      expect(ours.length, `${merged.mnemonic}: длина`).toBe(8);
      expect(plainBytes.length, `${plain}: длина`).toBe(8);
      const differing = [...ours].map((byte, index) => (byte === plainBytes[index] ? undefined : index)).filter(
        (index): index is number => index !== undefined,
      );
      expect(differing, `${merged.mnemonic} против ${plain}: расходятся не только кодом операции`).toEqual([7]);
      expect(ours[7], `${merged.mnemonic}: байт кода операции`).toBe(merged.opc);
      expect(plainBytes[7], `${plain}: байт кода операции`).toBe(0x20);
    }
  });

  it('у слитой формы НЕТ управляющего слога: восемь байт, HS.s = 0', () => {
    for (const item of FAMILY) {
      const bytes = encoder.encode(instructionOf(item));
      const hs = bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24);
      expect(bytes.length, `${item.mnemonic}: длина`).toBe(8);
      expect((hs >>> 12) & 0x1, `${item.mnemonic}: бит s (SS-слог)`).toBe(0);
      expect((hs >>> 14) & 0x3, `${item.mnemonic}: биты c (CS-слоги)`).toBe(0);
      expect((hs >>> 16) & 0x3, `${item.mnemonic}: биты cd (CDS-слоги)`).toBe(0);
      // Длина по HS: lng = 0 → восемь байт.
      expect((hs >>> 4) & 0x7, `${item.mnemonic}: поле lng`).toBe(0);
    }
  });

  it('круг: слитая форма разбирается обратно той же мнемоникой и предикатом', () => {
    for (const item of FAMILY) {
      const instruction = instructionOf(item);
      const back = encoder.decode(encoder.encode(instruction));
      expect(back.mnemonic, `${item.mnemonic}: разобрано «${back.mnemonic}»`).toBe(item.mnemonic);
      expect(sameInstruction(back, instruction), `${item.mnemonic}: разбор разошёлся`).toBe(true);
      expect(back.operands.at(-1), `${item.mnemonic}: приёмник-предикат`).toEqual(pred(0));
    }
  });

  it('чужие числа канала и предиката отвергаются, а не подставляются', () => {
    // Каналы 2 и 5 запрещены источником (allowed_channels = {1,1,0,1,1,0}).
    expect(() => encoder.encode({ mnemonic: 'cmpandesb', channel: 2, operands: [reg(1), reg(2), pred(0)] })).toThrow(
      /канал/,
    );
    expect(() => encoder.encode(asm('cmpandesb', [reg(1), reg(2), reg(0)]))).toThrow(/предикат/);
  });
});

describe('CMPAND*: 3. НЕГАТИВНЫЙ КОНТРОЛЬ', () => {
  it('подмена байта кода операции обратно на 0x20 меняет и байты, и мнемонику разбора', () => {
    for (const pair of [
      [FAMILY[0]!, 'cmpesb'],
      [FAMILY[3]!, 'cmplesb'],
    ] as ReadonlyArray<[CmpandSample, string]>) {
      const [merged, plain] = pair;
      const bytes = encoder.encode(instructionOf(merged));
      const spoilt = Uint8Array.from(bytes);
      spoilt[7] = 0x20;
      // 1) байты обязаны разойтись — иначе код операции в тесте не сторожится;
      expect(toHex(spoilt), `${merged.mnemonic}: подмена кода операции не изменила байтов`).not.toBe(toHex(bytes));
      // 2) и разбор обязан назвать ДРУГУЮ команду: семейство читается именно из этого байта.
      const back = encoder.decode(spoilt);
      expect(back.mnemonic, `подменённый байт прочитан как «${back.mnemonic}»`).toBe(plain);
    }
  });

  it('обратная подмена: обычное сравнение с кодом 0x22 читается как CMPAND', () => {
    const plain = encoder.encode(asm('cmpesb', [reg(1), reg(2), pred(0)]));
    const spoilt = Uint8Array.from(plain);
    spoilt[7] = 0x22;
    expect(toHex(spoilt)).not.toBe(toHex(plain));
    expect(encoder.decode(spoilt).mnemonic).toBe('cmpandesb');
  });
});

describe('CMPAND*: 4. внешняя сверка — ассемблер МЦСТ (текст → байты)', () => {
  it('ассемблер собирает те же восемь байт', () => {
    const samples: AsSample[] = FAMILY.map((item) => ({
      key: item.mnemonic,
      mnemonic: item.mnemonic,
      channel: 0,
      form: 'ALF7',
      asText: item.asText,
      instruction: instructionOf(item),
      source: item.source,
    }));
    const results = assembleAll(samples);
    const problems: string[] = [];
    FAMILY.forEach((item, index) => {
      const result = results[index]!;
      if (!result.ok) {
        problems.push(`${item.mnemonic}: ассемблер отверг — ${result.error}`);
        return;
      }
      const ours = toHex(encoder.encode(instructionOf(item)));
      const theirs = toHex(result.bytes);
      if (ours !== theirs) problems.push(`${item.mnemonic}: у нас ${ours}, у as ${theirs}`);
    });
    expect(problems, `сверено ${FAMILY.length} образцов семейства`).toEqual([]);
  });
});

describe('CMPAND*: 5. внешняя сверка — дизассемблер МЦСТ (байты → текст), ПО АДРЕСАМ', () => {
  it('по адресу каждой нашей команды дизассемблер печатает CMPAND, а не nop и не мусор', () => {
    const { tool, reason } = findExternalTool();
    if (tool === undefined) {
      // Инструмента нет — это названная причина, а не «пройдено».
      expect(reason, 'причина ненайденности дизассемблера не названа').toBeDefined();
      expect(reason).toMatch(/objdump/);
      return;
    }
    const samples: E2kSample[] = FAMILY.map((item) => ({
      mnemonic: item.mnemonic,
      form: 'ALF7' as RealForm,
      opc: `0x${item.opc.toString(16)}`,
      channel: 0,
      operands: [reg(1), reg(2), pred(0)],
      bytes: '',
      hex: toHex(encoder.encode(instructionOf(item))),
      size: 8,
      assembly: item.asText,
      source: item.source,
    }));
    const elf = buildE2kElf(samples);
    const result = disassembleElf(elf, path.join(ROOT, '.tmp', 'e2k-cmpand.elf'));
    if (result === undefined) return; // инструмент пропал между проверками — случай назван
    // Разбор — ПО АДРЕСАМ, а не по порядку строк: между командами дизассемблер печатает `nop`,
    // и построчное сопоставление сдвигается (на этом уже был получен ложный вывод).
    const byAddress = new Map(parseObjdumpOutput(result.text).map((line) => [line.address, line.text]));
    const problems: string[] = [];
    for (const entry of elf.layout) {
      const text = byAddress.get(entry.address);
      if (text === undefined) {
        problems.push(`0x${entry.address.toString(16)}: дизассемблер не напечатал строку`);
        continue;
      }
      if (!text.includes(entry.mnemonic)) {
        problems.push(`0x${entry.address.toString(16)} (${entry.mnemonic}): дизассемблер напечатал «${text}»`);
      }
      if (/\bnop\b/.test(text.replace(/^nop \d+/, '')) || /invalid|unrecognized|unknown/i.test(text)) {
        problems.push(`0x${entry.address.toString(16)} (${entry.mnemonic}): мусор вместо команды — «${text}»`);
      }
    }
    expect(problems, `сверено по адресам: ${elf.layout.length}`).toEqual([]);
  });
});

describe('CMPAND*: 6. источник семейства читается в таблице МЦСТ', () => {
  it('строки таблицы МЦСТ совпадают с нашими записями (ALOPF7, коды 0x22/0x23, условия 2/4/5/7)', () => {
    const table = path.join(ROOT, '.tmp', 'e2k-sources', 'binutils-gdb', 'opcodes', 'e2k-opc.h');
    if (!fs.existsSync(table)) {
      expect(fs.existsSync(table), 'таблицы МЦСТ под рукой нет — причина названа').toBe(false);
      return;
    }
    const text = fs.readFileSync(table, 'utf-8');
    for (const item of FAMILY) {
      const pattern = new RegExp(
        `\\{"${item.mnemonic}"[^;]*ALOPF7[^;]*0x${item.opc.toString(16)},[^;]*0x${item.cmpOpce.toString(16)}, 2, 1\\};`,
      );
      expect(pattern.test(text), `в таблице МЦСТ нет строки ${item.mnemonic} с opc 0x${item.opc.toString(16)}`).toBe(
        true,
      );
    }
    // Условий «меньше» (6) и «0/1/3» в семействе нет — это и есть причина усечённого набора.
    expect(text, 'в таблице МЦСТ нашлась запись cmpandlsb').not.toMatch(/"cmpandlsb"/);
  });
});
