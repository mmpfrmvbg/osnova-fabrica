/**
 * ОРАКУЛ `setmas` — СЛОГ CS1 С ЧЕТЫРЬМЯ ЗНАЧЕНИЯМИ `mas`.
 *
 * # Что это за команда
 *
 * `mas` — не поле команды памяти, а **слог CS1** с кодом операции 6, несущий четыре семибитных
 * значения: по одному на канал 0, 2, 3 и 5 (`docs/hardware-debt.md` §3.29). Пока слога нет, все
 * наши `ld`/`st` идут с `mas = 0`, то есть в режиме `NORMAL`, и работу DAM мы не проверяли.
 *
 * # Откуда взята форма (три независимых указания, сходятся)
 *
 * | что | источник |
 * |---|---|
 * | код операции слога | `qemu/target/e2k/opcode-tables.h:66` (`E2K_CS1_OPC_MAS = 6`), `opcodes/e2k-dis.c:2046-2056` (`MAS_OPC`) |
 * | четыре поля | `qemu/target/e2k/syllab-format.h:107-110` (`mas0[27:21]`, `mas2[20:14]`, `mas3[13:7]`, `mas5[6:0]`) |
 * | как декодер их читает | `qemu/target/e2k/decoder.c:1009-1016` (по каналам 0/2/3/5, `mas_valid`) |
 * | где лежит значение для канала у команды памяти | `opcodes/e2k-dis.c:1325-1329` (`shift[chn] = {21, -1, 14, 7, -1, 0}`) |
 *
 * # Чем сверено ВНЕШНЕ — и почему не мнемоникой
 *
 * Отдельной мнемоники `setmas` у ассемблера МЦСТ **нет** (измерено: `unknown instruction
 * 'setmas'`, `.tmp/mas-gas.sh`), но ту же самую команду он выпускает формой `mas=` **у команды
 * памяти** — и тогда слог CS1 лежит в байтах открыто. Отсюда измерены позиции полей:
 *
 *     ldd,0 %db[1], %db[2], %db[3], mas=0x7   → слог 00 00 e0 60 = 0x60e00000   (7 << 21)
 *     ldd,2 … mas=0x7                        → слог 00 c0 01 60 = 0x6001c000   (7 << 14)
 *     ldd,3 … mas=0x7                        → слог 80 03 00 60 = 0x60000380   (7 <<  7)
 *     ldd,5 … mas=0x7                        → слог 07 00 00 60 = 0x60000007   (7 <<  0)
 *     ldd,2 … mas=0x55                       → слог 00 40 15 60 = 0x60154000   (0x55 << 14)
 *
 * Наша команда несёт **тот же** слог — это и проверяется живьём: тест собирает `ldd … mas=` тем же
 * ассемблером и сравнивает слово CS1 с нашим.
 *
 * # Чего этот оракул НЕ доказывает
 *
 * 1. Что команду исполнит железо: сверка идёт с ассемблером и дизассемблером, а не с машиной.
 * 2. Что **отдельная** 8-байтовая команда `setmas` вообще что-то задаёт последующему `ld`:
 *    в порте `mas` берётся из слога **той же** широкой команды (`translate-mem.c:1081`:
 *    `instr_decoded->mas[ch]`, а `mas_valid` сбрасывается на каждой команде — `decoder.c:41`).
 *    Проверка этого — отдельный опыт (`.tmp/osnova-mas-probe.ts`), а не этот оракул.
 * 3. Что заголовочный слог (HS) `01 80 00 00` — измеренный именно для `setmas`: он взят у
 *    `setbn` (единственная измеренная CS1-команда без ALS). Дизассемблер наши байты длиной
 *    команды признаёт (адреса идут по 8 байт), но печать отдельного `mas` в этой сборке binutils
 *    скомпилирована вне (`ENABLE_E2K_ENCODINGS` не определён, `opcodes/config.h:15`) — поэтому
 *    «пустая строка» здесь сторожем быть не может, и рядом стоит различающий контроль по опкоду.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { getEncoder, type AsmInstruction, type Operand } from './backend';
import { EncodingError } from './encoding';
import { realControlOpcode } from './e2k-real';
import { buildElfFromCode, MINIMAL_BASE } from './elfMinimal';
import { findExternalTool, parseObjdumpOutput } from '../scripts/e2kExternalObjdump';
import { assembleAll, findExternalAs, type AsSample } from '../scripts/e2kExternalAs';
import { toWslPath } from '../scripts/e2kQemuExec';

const ROOT = path.resolve(__dirname, '..', '..');
const encoder = getEncoder('e2k');

const imm = (value: number): Operand => ({ kind: 'imm', value });
const reg = (index: number): Operand => ({ kind: 'reg', index });

/** Наша `setmas`: канал не несёт слог CS1 — как у всех команд управления. */
function setmas(mas0: number, mas2: number, mas3: number, mas5: number): AsmInstruction {
  return { mnemonic: 'setmas', channel: 0, operands: [imm(mas0), imm(mas2), imm(mas3), imm(mas5)] };
}

/** Значения по каналам → четыре операнда в порядке формы. */
function operandsOf(channel: number, value: number): readonly [number, number, number, number] {
  const values: [number, number, number, number] = [0, 0, 0, 0];
  const slot = new Map([[0, 0], [2, 1], [3, 2], [5, 3]]).get(channel);
  if (slot === undefined) throw new Error(`канал ${String(channel)} не несёт mas`);
  values[slot] = value;
  return values;
}

const word = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(' ');

/** Заголовочный слог CS1-команды без ALS — измерен на `setbn` (иначе ours молча принял бы любое). */
const HS_CS1_ONLY = 0x00008001;

/**
 * Измерено ассемблером МЦСТ формой `mas=` (см. шапку файла). Внешняя сверка ниже проверяет это
 * живьём; здесь те же числа стоят как названная граница на случай недоступности инструмента.
 */
const MEASURED: ReadonlyArray<{ readonly channel: number; readonly value: number; readonly cs1: number }> = [
  { channel: 0, value: 0x7, cs1: 0x60e00000 },
  { channel: 2, value: 0x7, cs1: 0x6001c000 },
  { channel: 3, value: 0x7, cs1: 0x60000380 },
  { channel: 5, value: 0x7, cs1: 0x60000007 },
  { channel: 2, value: 0x55, cs1: 0x60154000 },
];

describe('setmas: 1. форма CS1_SETMAS и её байты', () => {
  it('запись таблицы управления: четыре слота, размер 8 байт, форма CS1_SETMAS', () => {
    const entry = realControlOpcode('setmas');
    expect(entry, 'мнемоники setmas нет в таблице управления').toBeDefined();
    expect(entry!.form).toBe('CS1_SETMAS');
    expect(entry!.operands).toEqual(['mas0', 'mas2', 'mas3', 'mas5']);
    expect(entry!.size).toBe(8);
  });

  it('нули: HS 0x00008001 и слог 0x60000000 (opc = 6), ровно 8 байт', () => {
    const bytes = encoder.encode(setmas(0, 0, 0, 0));
    expect(bytes.length).toBe(8);
    expect(toHex(bytes)).toBe('01 80 00 00 00 00 00 60');
    expect(word(bytes, 0)).toBe(HS_CS1_ONLY);
    expect(word(bytes, 4) >>> 28, 'код операции слога CS1').toBe(6);
    expect(word(bytes, 4) & 0x0fffffff).toBe(0);
  });

  it('каждое значение садится в своё поле — слова совпадают с измеренными ассемблером', () => {
    for (const { channel, value, cs1 } of MEASURED) {
      const bytes = encoder.encode(setmas(...operandsOf(channel, value)));
      expect(word(bytes, 0), `канал ${String(channel)}: заголовочный слог`).toBe(HS_CS1_ONLY);
      expect(word(bytes, 4), `канал ${String(channel)}, mas=0x${value.toString(16)}`).toBe(cs1);
    }
  });

  it('отказ с причиной: значение шире семи бит и нецелое не кодируются', () => {
    expect(() => encoder.encode(setmas(0x80, 0, 0, 0))).toThrow(EncodingError);
    expect(() => encoder.encode(setmas(0x80, 0, 0, 0))).toThrow(/setmas: mas0 = 128 вне 0\.\.127/u);
    expect(() => encoder.encode(setmas(0, -1, 0, 0))).toThrow(/mas2/u);
  });
});

describe('setmas: 2. внешняя сверка — ассемблер МЦСТ (форма mas= у команды памяти)', () => {
  it('слог CS1 наш и слог ассемблера — одно и то же слово', () => {
    const { tool, reason } = findExternalAs();
    if (tool === undefined) {
      // Инструмента нет — это названная причина, а не «пройдено».
      expect(reason, 'причина ненайденности ассемблера не названа').toBeDefined();
      expect(reason).toMatch(/as|ассемблер/iu);
      return;
    }
    const samples: AsSample[] = MEASURED.map(({ channel, value }) => ({
      key: `ldd-mas-${String(channel)}-${value.toString(16)}`,
      mnemonic: 'ldd',
      channel,
      form: 'ALF1',
      asText: `ldd,${String(channel)} %db[1], %db[2], %db[3], mas=0x${value.toString(16)}`,
      instruction: { mnemonic: 'ldd', channel, operands: [reg(1), reg(2), reg(3)] },
      source: 'setmas.test.ts: форма `mas=` — единственная, которую знает ассемблер МЦСТ',
    }));
    const results = assembleAll(samples);
    expect(results.length).toBe(MEASURED.length);
    MEASURED.forEach(({ channel, value }, index) => {
      const result = results[index]!;
      if (!result.ok) {
        // Ассемблер отказал: это находка, а не «пропустить».
        throw new Error(`as отказал на «${samples[index]!.asText}»: ${result.error}`);
      }
      // Команда с ALS + CS1: HS(4) ALS(4) CS1(4) добивка(4). Слог CS1 — третье слово.
      expect(result.bytes.length, `канал ${String(channel)}: длина команды`).toBe(16);
      const theirs = word(result.bytes, 8);
      const ours = word(encoder.encode(setmas(...operandsOf(channel, value))), 4);
      expect(ours, `канал ${String(channel)}, mas=0x${value.toString(16)}: наш слог против слога ассемблера`)
        .toBe(theirs);
    });
  });
});

describe('setmas: 3. внешний дизассемблер — разбор ПО АДРЕСАМ', () => {
  it('наши команды читаются как команды по 8 байт, а опкод слога различается', () => {
    const { tool, reason } = findExternalTool();
    if (tool === undefined) {
      expect(reason, 'причина ненайденности дизассемблера не названа').toBeDefined();
      expect(reason).toMatch(/objdump/u);
      return;
    }
    // Наши команды подряд + различающий контроль: тот же HS, но опкод слога 5 (CALL) вместо 6.
    const ours = MEASURED.map(({ channel, value }) => encoder.encode(setmas(...operandsOf(channel, value))));
    const callLike = encoder.encode(setmas(0, 0, 0, 0));
    callLike[7] = 0x50; // opc = 5 (CALL) — тот же HS, другой код операции слога
    const chunks = [...ours, callLike];
    const code = new Uint8Array(chunks.length * 8);
    chunks.forEach((chunk, index) => code.set(chunk, index * 8));
    const file = path.join(ROOT, '.tmp', 'e2k-setmas-disasm.elf');
    fs.writeFileSync(file, buildElfFromCode(code, MINIMAL_BASE, { writable: true }).bytes);
    const output = execFileSync(tool.runner.command, [...tool.runner.args, '-d', toWslPath(file)], {
      encoding: 'utf-8',
      timeout: 120_000,
    });
    const lines = parseObjdumpOutput(output);
    // Разбор ПО АДРЕСАМ: между командами дизассемблер печатает `nop`, и построчное сопоставление
    // сдвигается — на этом в этой линии уже был получен ложный вывод.
    expect(lines.length, 'дизассемблер не вернул ни одной команды').toBeGreaterThan(0);
    const addresses = lines.map((line) => line.address).sort((left, right) => left - right);
    // Длина команды признана: адреса идут шагом 8 от базы образа.
    expect(addresses).toEqual(chunks.map((_, index) => MINIMAL_BASE + index * 8));
    const callText = lines.find((line) => line.address === MINIMAL_BASE + ours.length * 8)?.text ?? '';
    expect(callText, 'контроль: опкод 5 обязан читаться как call').toMatch(/call/u);
    for (let index = 0; index < ours.length; index++) {
      const text = lines.find((line) => line.address === MINIMAL_BASE + index * 8)?.text ?? '';
      // Печать отдельного `mas` в этой сборке binutils скомпилирована вне
      // (`ENABLE_E2K_ENCODINGS` не определён) — поэтому пустая строка здесь наблюдение, а не
      // доказательство: сторожем работает контроль по опкоду выше.
      expect(text, `команда #${String(index)}: дизассемблер не должен читать наш слог как call`).not.toMatch(/call/u);
    }
  });
});

describe('setmas: 4. НЕГАТИВНЫЙ КОНТРОЛЬ — подмена значения меняет байты', () => {
  it('каждый из четырёх каналов влияет на своё поле, и ни один не спутан с другим', () => {
    const base = encoder.encode(setmas(0, 0, 0, 0));
    const shifts: ReadonlyArray<readonly [number, number]> = [
      [0, 21],
      [2, 14],
      [3, 7],
      [5, 0],
    ];
    for (const [channel, shift] of shifts) {
      const changed = encoder.encode(setmas(...operandsOf(channel, 1)));
      expect(toHex(changed), `канал ${String(channel)}: байты обязаны измениться`).not.toBe(toHex(base));
      expect(word(changed, 0), `канал ${String(channel)}: заголовочный слог не меняется`).toBe(word(base, 0));
      expect(word(changed, 4) ^ word(base, 4), `канал ${String(channel)}: различие ровно в своём поле`)
        .toBe((1 << shift) >>> 0);
    }
    // Одно и то же значение в РАЗНЫХ каналах даёт РАЗНЫЕ байты — спутать поля нельзя.
    const words = shifts.map(([channel]) => toHex(encoder.encode(setmas(...operandsOf(channel, 0x7)))));
    expect(new Set(words).size, 'четыре канала с одним значением обязаны различаться').toBe(4);
    // И старший разряд поля выразим: 0x7f на месте, 0x80 — отказ (проверено в блоке 1).
    expect(word(encoder.encode(setmas(0x7f, 0, 0, 0)), 4)).toBe(((6 << 28) | (0x7f << 21)) >>> 0);
  });
});
