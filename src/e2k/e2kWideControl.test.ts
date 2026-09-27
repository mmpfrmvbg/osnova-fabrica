/**
 * ОРАКУЛ: ШИРОКАЯ КОМАНДА «ОПЕРАЦИЯ ALS + УПРАВЛЯЮЩИЙ СЛОГ CS1».
 *
 * # Что это за форма и почему она отдельная
 *
 * Управляющие слоги и операции ALS жили в **разных** командах: `packetableRefusal` отвергал
 * управляющие слоги, и такая инструкция становилась командой из одного слота. Но `mas` у команды
 * памяти — не отдельная команда, а слог CS1 **той же** широкой команды: порт сбрасывает
 * `mas_valid` на каждой команде (`qemu/target/e2k/decoder.c:41`) и читает значение из слога той же
 * команды (`qemu/target/e2k/tcg/translate-mem.c:1081`). Ассемблер МЦСТ выражает это формой `mas=`
 * **у самой команды памяти**, то есть одной инструкцией с двумя слогами; отдельной мнемоники
 * `setmas` у него нет (`docs/hardware-debt.md` §3.32.1).
 *
 * # Главная проверка — внешняя
 *
 * Эталон получен ассемблером МЦСТ `as-new -mcpu=elbrus-v5` и повторён замером этого оракула
 * (`.tmp/osnova-wide-control-probe.ts`):
 *
 *     ldw,2 %db[14], %db[12], %db[10], mas=0x7
 *       12 80 00 10  0a 0c 0e 66  00 c0 01 60  00 00 00 00   = 16 байт
 *       HS            ALS          CS1          добивка
 *
 * Разбор HS `12 80 00 10` = `0x10008012`: `lng = 1` (16 байт), `mdl = 2` (три слова до средней
 * точки: HS, ALS, CS1), `al = 0x4` (ALS2 — канал загрузки), `cs = 2` (присутствует CS1).
 *
 * # Чего этот оракул НЕ доказывает
 *
 * 1. Что так поведёт себя железо: сверка идёт с ассемблером и дизассемблером МЦСТ, а не с машиной.
 * 2. Что путь `SPECIAL_MMU_AAU` в порте работает: он остаётся заглушкой (`translate-mem.c:1086-1089`),
 *    и проба модели — отдельный опыт (`.tmp/osnova-setmas-pair.ts`), а не этот оракул.
 * 3. Что в одной команде с ALS кладутся **другие** управляющие формы. `call`/`ct` (слог `SS`) и
 *    `disp`/`sdisp` (слог `CS0`) с 2026-09-27 **измерены и кладутся** — их оракул
 *    `src/e2k/e2kWideSsLts.test.ts`, замер — `docs/hardware-debt.md` §3.34. Здесь по-прежнему
 *    отвергаются непарные формы: `return` и `setwd` (его `wsz` живёт в литерале).
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { getEncoder, type AsmInstruction, type Operand } from './backend';
import { EncodingError, EncodingRefusedError } from './encoding';
import { packWide, wideBytes } from './widePacker';
import { buildElfFromCode, MINIMAL_BASE } from './elfMinimal';
import { findExternalTool, parseObjdumpOutput } from '../scripts/e2kExternalObjdump';
import { assembleAll, commandText, findExternalAs, type AsSample } from '../scripts/e2kExternalAs';
import { toWslPath } from '../scripts/e2kQemuExec';

const ROOT = path.resolve(__dirname, '..', '..');
const encoder = getEncoder('e2k');

const imm = (value: number): Operand => ({ kind: 'imm', value });
const reg = (index: number): Operand => ({ kind: 'reg', index });

/** `setmas` — четыре значения по каналам 0, 2, 3, 5 (`mas0`, `mas2`, `mas3`, `mas5`). */
const setmas = (mas0: number, mas2: number, mas3: number, mas5: number): AsmInstruction => ({
  mnemonic: 'setmas',
  channel: 0,
  operands: [imm(mas0), imm(mas2), imm(mas3), imm(mas5)],
});

/** Загрузка на канале 2; `control` — слог CS1, который едет в той же широкой команде. */
const load = (control?: AsmInstruction): AsmInstruction => ({
  mnemonic: 'ldw',
  channel: 2,
  operands: [reg(14), reg(12), reg(10)],
  ...(control === undefined ? {} : { control }),
});

const add = (a: number, b: number, c: number, channel = 0): AsmInstruction => ({
  mnemonic: 'adds',
  channel,
  operands: [reg(a), reg(b), reg(c)],
});

const mul = (a: number, b: number, c: number): AsmInstruction => ({
  mnemonic: 'muls',
  channel: 0,
  operands: [reg(a), reg(b), reg(c)],
});

/**
 * Ожидаемый эталон (измерен ассемблером МЦСТ, повторён замером оракула). Стоит константой, чтобы
 * проверка формы не зависела от доступности внешнего инструмента, — а живая сверка ниже проверяет
 * то же самое на самом ассемблере.
 */
const REFERENCE_WITH_MAS = '12 80 00 10 0a 0c 0e 66 00 c0 01 60 00 00 00 00';
/** Та же загрузка без `mas` — 8 байт; измерено тем же ассемблером. */
const REFERENCE_WITHOUT_MAS = '01 00 00 10 0a 0c 0e 66';
/** Слог CS1 формы `setmas` для `mas2 = 7` (`opc = 6`, поле `mas2[20:14]`). */
const CS1_MAS2_7 = 0x6001c000;

const hexOf = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(' ');

const wordAt = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0);

/** Байты пары так, как их выдаёт упаковщик: одна команда на инструкцию. */
const packedBytes = (instructions: readonly AsmInstruction[]): string => hexOf(wideBytes(packWide(instructions)));

/** Канал команды памяти → позиция значения в форме `setmas` (`mas0`, `mas2`, `mas3`, `mas5`). */
const MAS_SLOT_OF_CHANNEL = new Map<number, number>([
  [0, 0],
  [2, 1],
  [3, 2],
  [5, 3],
]);

/**
 * Ассемблерный текст инструкции: `commandText` даёт мнемонику с операндами, а `mas=` дописывается
 * из слога управления — ровно так эту форму и знает ассемблер МЦСТ.
 */
function asTextOf(instruction: AsmInstruction): string {
  const text = commandText(instruction);
  if (instruction.control === undefined) return text;
  const slot = MAS_SLOT_OF_CHANNEL.get(instruction.channel);
  if (slot === undefined) throw new Error(`канал ${String(instruction.channel)} не несёт mas`);
  const operand = instruction.control.operands[slot];
  if (operand === undefined || operand.kind !== 'imm') throw new Error('значение mas обязано быть числом');
  return `${text}, mas=0x${operand.value.toString(16)}`;
}

/** Текст набора так, как его назначил упаковщик: одна инструкция — одна строка, пакет — в скобках. */
function asTextOfAll(instructions: readonly AsmInstruction[]): string {
  const lines: string[] = [];
  for (const packet of packWide(instructions)) {
    const slots = packet.slots.map((slot) => asTextOf(slot.instruction));
    lines.push(packet.slots.length === 1 ? slots[0]! : `{ ${slots.join('; ')} }`);
  }
  return lines.join('\n');
}

describe('широкая команда ALS + CS1: 1. форма и байты (эталон ассемблера МЦСТ)', () => {
  it('`ldw,2 …, mas=0x7` — 16 байт и байт в байт эталон', () => {
    const packet = packWide([load(setmas(0, 7, 0, 0))]);
    expect(packet.length, 'одна инструкция — одна команда').toBe(1);
    expect(packet[0]!.bytes.length, 'длина команды: HS + ALS + CS1 + добивка').toBe(16);
    expect(hexOf(packet[0]!.bytes)).toBe(REFERENCE_WITH_MAS);
    // Тот же результат у одиночного кодировщика: раскладка одна на оба пути.
    expect(hexOf(encoder.encode(load(setmas(0, 7, 0, 0))))).toBe(REFERENCE_WITH_MAS);
  });

  it('заголовочный слог несёт lng, mdl, al и признак CS1', () => {
    const bytes = packWide([load(setmas(0, 7, 0, 0))])[0]!.bytes;
    const hs = wordAt(bytes, 0);
    expect((hs >>> 4) & 0x7, 'lng: 16 байт — это (lng + 1) * 8').toBe(1);
    expect(hs & 0xf, 'mdl: три слова до средней точки (HS, ALS, CS1) минус один').toBe(2);
    expect((hs >>> 26) & 0x3f, 'al: ALS2 — канал загрузки').toBe(0x4);
    expect((hs >>> 14) & 0x3, 'cs: присутствует CS1 (бит 15) и нет CS0').toBe(2);
    expect((hs >>> 20) & 0x3f, 'ale: полуслогов ALES нет').toBe(0);
    expect(wordAt(bytes, 4), 'слово ALS').toBe(0x660e0c0a);
    expect(wordAt(bytes, 8), 'слово CS1').toBe(CS1_MAS2_7);
    expect(wordAt(bytes, 12), 'добивка до чётного числа 4-байтовых слогов').toBe(0);
  });

  it('порядок слогов: CS1 после ALS и до полуслогов ALES (измерено на `muls`)', () => {
    // `{ muls,0 …; ldw,2 … mas=0x7 }` → HS, ALS(muls), ALS(ldw), CS1, ALES0, добивка — 24 байта.
    const bytes = wideBytes(packWide([mul(1, 2, 3), load(setmas(0, 7, 0, 0))]));
    const hs = wordAt(bytes, 0);
    expect(bytes.length).toBe(24);
    expect((hs >>> 4) & 0x7, 'lng: 24 байта').toBe(2);
    expect(hs & 0xf, 'mdl: четыре слова до средней точки (HS, ALS, ALS, CS1) минус один').toBe(3);
    expect((hs >>> 26) & 0x3f, 'al: ALS0 (muls) и ALS2 (ldw)').toBe(0x5);
    expect((hs >>> 20) & 0x3f, 'ale: полуслог ALES0 у muls').toBe(0x1);
    expect(wordAt(bytes, 12), 'слог CS1 — третье слово, до полуслога ALES').toBe(CS1_MAS2_7);
    expect(wordAt(bytes, 16) >>> 16, 'полуслог ALES0 — уже после слога управления').toBe(0x01c0);
    expect(wordAt(bytes, 16) & 0xffff).toBe(0);
    expect(wordAt(bytes, 20), 'добивка: 6 слов — чётное число').toBe(0);
  });
});

describe('широкая команда ALS + CS1: 2. живая сверка с ассемблером МЦСТ', () => {
  const CASES: ReadonlyArray<{ readonly key: string; readonly instructions: AsmInstruction[] }> = [
    { key: 'ldw+mas7', instructions: [load(setmas(0, 7, 0, 0))] },
    { key: 'ldw+mas55', instructions: [load(setmas(0, 0x55, 0, 0))] },
    { key: 'adds+ldw+mas7', instructions: [add(1, 2, 3), load(setmas(0, 7, 0, 0))] },
    {
      key: 'adds+adds+ldw+mas7',
      instructions: [add(1, 2, 3), add(4, 5, 6, 1), load(setmas(0, 7, 0, 0))],
    },
    { key: 'muls+ldw+mas7', instructions: [mul(1, 2, 3), load(setmas(0, 7, 0, 0))] },
    { key: 'ldw без mas (положительный контроль)', instructions: [load()] },
  ];

  it('наши байты совпадают с ассемблером побайтово — или причина названа', () => {
    const { tool, reason } = findExternalAs();
    if (tool === undefined) {
      // Инструмента нет — это названная причина, а не «пройдено».
      expect(reason, 'причина ненайденности ассемблера не названа').toBeDefined();
      expect(reason).toMatch(/as|ассемблер/iu);
      return;
    }
    const samples: AsSample[] = CASES.map((item) => ({
      key: item.key,
      mnemonic: item.instructions[0]!.mnemonic,
      channel: item.instructions[0]!.channel,
      form: 'ALF1',
      asText: asTextOfAll(item.instructions),
      instruction: item.instructions[0]!,
      source: 'src/e2k/e2kWideControl.test.ts: форма `mas=` у команды памяти',
    }));
    const results = assembleAll(samples);
    const problems: string[] = [];
    CASES.forEach((item, index) => {
      const result = results[index]!;
      const ours = packedBytes(item.instructions);
      if (!result.ok) {
        // Отказ ассемблера — находка, а не «пропустить».
        problems.push(`«${item.key}»: ассемблер отказал — ${result.error}`);
        return;
      }
      const theirs = hexOf(result.bytes);
      if (ours !== theirs) {
        problems.push(`«${item.key}»: наши ${ours}, ассемблер ${theirs} (текст: ${item.asText.replace(/\n/gu, ' | ')})`);
      }
    });
    expect(problems, problems.join('; ')).toEqual([]);
  });

  it('эталон задания подтверждён замером: `mas=0x7` даёт ровно 16 байт', () => {
    const { tool } = findExternalAs();
    if (tool === undefined) return; // причина названа проверкой выше
    const [result] = assembleAll([{
      key: 'reference',
      mnemonic: 'ldw',
      channel: 2,
      form: 'ALF1',
      asText: 'ldw,2 %db[14], %db[12], %db[10], mas=0x7',
      instruction: load(setmas(0, 7, 0, 0)),
      source: 'src/e2k/e2kWideControl.test.ts',
    }]);
    expect(result!.ok, result!.ok ? '' : `ассемблер отказал: ${result!.error}`).toBe(true);
    if (!result!.ok) return;
    expect(hexOf(result!.bytes)).toBe(REFERENCE_WITH_MAS);
    expect(result!.bytes.length).toBe(16);
  });
});

describe('широкая команда ALS + CS1: 3. положительный контроль — без слога прежние 8 байт', () => {
  it('та же загрузка без `mas` остаётся 8-байтовой и совпадает с ассемблером', () => {
    const packet = packWide([load()]);
    expect(packet.length).toBe(1);
    expect(packet[0]!.bytes.length, 'команда из одного слога ALS').toBe(8);
    expect(hexOf(packet[0]!.bytes)).toBe(REFERENCE_WITHOUT_MAS);
    expect(hexOf(encoder.encode(load()))).toBe(REFERENCE_WITHOUT_MAS);
  });

  it('управляющий слог без ALS по-прежнему отдельная 8-байтовая команда (аддитивность)', () => {
    const bytes = encoder.encode(setmas(0, 7, 0, 0));
    expect(hexOf(bytes), 'байты `setmas` не изменились').toBe('01 80 00 00 00 c0 01 60');
    const packets = packWide([setmas(0, 7, 0, 0)]);
    expect(packets.length).toBe(1);
    expect(hexOf(packets[0]!.bytes)).toBe('01 80 00 00 00 c0 01 60');
  });

  it('управляющий слог отдельной инструкцией остаётся границей пакета', () => {
    // Так было до правки: `setmas` — барьер, операции по её стороны не сливаются.
    const packets = packWide([add(1, 2, 3), setmas(0, 7, 0, 0), add(4, 5, 6)]);
    expect(packets.length, 'три отдельные команды').toBe(3);
    expect(packets.map((packet) => packet.bytes.length)).toEqual([8, 8, 8]);
  });

  it('широкая команда без управляющего слога собирается прежними байтами', () => {
    // Измерено ассемблером (`docs/e2k-wide-commands.md` §4.1, случай 3): HS `12 00 00 0c` —
    // lng = 1 (16 байт), mdl = 2, al = ALS0 + ALS1. Слова слогов зависят от регистров, поэтому
    // первое слово сверяется с измеренным (`adds,0 %b[1], %b[2], %b[3]` → `03 02 01 10`),
    // а вторая операция взята с другими регистрами: одинаковые дали бы WAW и не слились бы.
    const bytes = packWide([add(1, 2, 3), add(4, 5, 6, 1)])[0]!.bytes;
    expect(bytes.length).toBe(16);
    expect(hexOf(bytes)).toBe('12 00 00 0c 03 02 01 10 06 05 04 10 00 00 00 00');
  });
});

describe('широкая команда ALS + CS1: 4. НЕГАТИВНЫЙ КОНТРОЛЬ — байты обязаны различаться', () => {
  it('снятие управляющего слога меняет и длину, и байты', () => {
    const withMas = packedBytes([load(setmas(0, 7, 0, 0))]);
    const without = packedBytes([load()]);
    expect(withMas).not.toBe(without);
    expect(withMas.length, '16 байт против 8').toBeGreaterThan(without.length);
  });

  it('каждое из четырёх значений `mas` садится в своё поле слога CS1', () => {
    const base = packWide([load(setmas(0, 0, 0, 0))])[0]!.bytes;
    const shifts: ReadonlyArray<readonly [number, number]> = [
      [0, 21],
      [2, 14],
      [3, 7],
      [5, 0],
    ];
    for (const [channel, shift] of shifts) {
      const values: [number, number, number, number] = [0, 0, 0, 0];
      values[MAS_SLOT_OF_CHANNEL.get(channel)!] = 0x7;
      const changed = packWide([load(setmas(...values))])[0]!.bytes;
      expect(hexOf(changed), `канал ${String(channel)}: байты обязаны измениться`).not.toBe(hexOf(base));
      expect(wordAt(changed, 0), `канал ${String(channel)}: HS не меняется`).toBe(wordAt(base, 0));
      expect(wordAt(changed, 8) ^ wordAt(base, 8), `канал ${String(channel)}: различие ровно в своём поле`)
        .toBe((0x7 << shift) >>> 0);
    }
    // Подмена значения у одного и того же канала: 0x7 против 0x55 различимы.
    expect(packedBytes([load(setmas(0, 0x7, 0, 0))])).not.toBe(packedBytes([load(setmas(0, 0x55, 0, 0))]));
  });

  it('значение шире семи бит и непарная форма управления — отказ с причиной', () => {
    expect(() => encoder.encode(load(setmas(0x80, 0, 0, 0)))).toThrow(EncodingError);
    expect(() => encoder.encode(load(setmas(0x80, 0, 0, 0)))).toThrow(/mas0 = 128 вне 0\.\.127/u);
    // `call` и `ct` в пару с ALS теперь КЛАДУТСЯ (измерено 2026-09-27, `docs/hardware-debt.md` §3.34,
    // оракул — `src/e2k/e2kWideSsLts.test.ts`). Непарными остаются `return` (измеренная форма несёт
    // CS0 без слога ALS) и `setwd` (его `wsz` живёт в литерале): их отказ назван, а не выдуман.
    expect(() => encoder.encode({ ...load(), control: { mnemonic: 'setwd', channel: 0, operands: [imm(16), imm(0)] } }))
      .toThrow(EncodingRefusedError);
    expect(() => encoder.encode({ ...load(), control: { mnemonic: 'setwd', channel: 0, operands: [imm(16), imm(0)] } }))
      .toThrow(/setwd/u);
    const refusal = packWide([
      { ...load(), control: { mnemonic: 'setwd', channel: 0, operands: [imm(16), imm(0)] } },
    ]);
    expect(refusal[0]!.refusal, 'отказ упаковки называет причину, а не молчит').toMatch(/setwd/u);
  });

  it('две инструкции с управляющим слогом не сливаются в одну команду', () => {
    // Слог управления в команде один: пара пар обязана разойтись на две команды.
    const packets = packWide([
      { mnemonic: 'ldw', channel: 2, operands: [reg(14), reg(12), reg(10)], control: setmas(0, 7, 0, 0) },
      { mnemonic: 'ldw', channel: 3, operands: [reg(14), reg(12), reg(11)], control: setmas(0, 0, 7, 0) },
    ]);
    expect(packets.length, 'два пакета, а не один').toBe(2);
    for (const packet of packets) expect(packet.bytes.length).toBe(16);
    expect(hexOf(packets[0]!.bytes)).not.toBe(hexOf(packets[1]!.bytes));
  });
});

describe('широкая команда ALS + CS1: 5. второй свидетель — дизассемблер МЦСТ (разбор ПО АДРЕСАМ)', () => {
  it('наши байты читаются как та же команда, а длина признана', () => {
    const { tool, reason } = findExternalTool();
    if (tool === undefined) {
      expect(reason, 'причина ненайденности дизассемблера не названа').toBeDefined();
      expect(reason).toMatch(/objdump/u);
      return;
    }
    // Пары, широкая команда с двумя слоями ALS и замыкающая 8-байтовая команда: по её адресу
    // видно, что дизассемблер признал длину широкой команды.
    const pair = packWide([load(setmas(0, 7, 0, 0))])[0]!.bytes;
    const changed = packWide([load(setmas(0, 0x55, 0, 0))])[0]!.bytes;
    const wide = packWide([add(1, 2, 3), load(setmas(0, 7, 0, 0))])[0]!.bytes;
    const chunks = [pair, wide, changed, encoder.encode(add(1, 2, 3))];
    const code = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      code.set(chunk, offset);
      offset += chunk.length;
    }
    const file = path.join(ROOT, '.tmp', 'e2k-wide-control-disasm.elf');
    fs.writeFileSync(file, buildElfFromCode(code, MINIMAL_BASE, { writable: true }).bytes);
    const output = execFileSync(tool.runner.command, [...tool.runner.args, '-d', toWslPath(file)], {
      encoding: 'utf-8',
      timeout: 120_000,
    });
    // Разбор ПО АДРЕСАМ: между командами дизассемблер печатает `nop`, и построчное сопоставление
    // сдвигается — на этом в этой линии уже был получен ложный вывод (`AGENTS.md`).
    const lines = parseObjdumpOutput(output);
    const addresses = lines.map((line) => line.address).sort((left, right) => left - right);
    expect(addresses).toEqual([
      MINIMAL_BASE,
      MINIMAL_BASE + 16,
      MINIMAL_BASE + 32,
      MINIMAL_BASE + 48,
    ]);
    const textAt = (address: number): string => lines.find((line) => line.address === address)?.text ?? '';
    expect(textAt(MINIMAL_BASE), 'пара ALS + CS1 читается целиком').toMatch(/mas\s*=\s*0x7\b/u);
    expect(textAt(MINIMAL_BASE), 'это загрузка на канале 2').toMatch(/ldw,2\b/u);
    expect(textAt(MINIMAL_BASE), 'наши байты не прочитаны как пустая команда').not.toMatch(/nop/u);
    expect(textAt(MINIMAL_BASE + 16), 'широкая команда с двумя слоями ALS').toMatch(/adds,0\b/u);
    expect(textAt(MINIMAL_BASE + 16)).toMatch(/mas\s*=\s*0x7\b/u);
    // Различающий контроль: та же форма с другим значением читается другим значением — то есть
    // совпадение выше не случайно и поле действительно наше.
    expect(textAt(MINIMAL_BASE + 32), 'другое значение mas').toMatch(/mas\s*=\s*0x55\b/u);
    expect(textAt(MINIMAL_BASE + 32)).not.toMatch(/mas\s*=\s*0x7\b/u);
  });
});
