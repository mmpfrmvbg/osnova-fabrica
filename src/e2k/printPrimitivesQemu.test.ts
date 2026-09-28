/**
 * ОРАКУЛ ПЕЧАТИ НА ЦЕЛИ: ЧИСЛО → ТЕКСТ, СВЕРКА БАЙТАМИ ЭТАЛОНА, КОД ВОЗВРАТА 0.
 *
 * # Что здесь утверждается — два утверждения, и оба обязательны
 *
 * 1. **Байты вывода гостя равны эталону записи корпуса побайтово** (не `includes` и не `trim`):
 *    `39` = `31 30 0a`, `40` = `30 0a`, `41` = `2d 37 0a`, `42` = `39 37 38 0a`, `44` = `31 30 30 0a`
 *    (`docs/hardware-debt.md` §3.42.1). Нынешняя единственная проверка печати в дереве ищет
 *    подстроку `hello` и не различает «10» и «100» — эта различает, и различие берётся из эталона.
 * 2. **Код возврата = 0.** §3.39 измерено: программа без своего `exit` на цели падает (134),
 *    поэтому ноль против 134 и есть разница между «напечатала и вышла» и «напечатала и провалилась».
 *
 * # Канал наблюдения — названный, а не «как получилось»
 *
 * Читать память гостя после прогона в дереве **нечем**. Модель запускается с `-d strace` и шимом
 * (`guest_base` без шима не встаёт): гостевой текст приходит в stdout, а журнал системных вызовов —
 * в stderr, и в нём видно `write(1,<адрес>,<длина>)`. Адрес и длина сверяются с посчитанными в TS
 * ПО ЧИСЛУ — независимый свидетель арифметики адреса, а не её пересказ.
 *
 * # Границы
 *
 * Модель — не железо: числа с неё не переносятся на Эльбрус без прогона на железе
 * (`tools/e2k-hardware/`). Файл живёт в шлюзе `gate:qemu` и в полном прогоне не участвует.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getEncoder, type AsmInstruction, type Operand } from './backend';
import { buildElfFromCode, MINIMAL_BASE } from './elfMinimal';
import { ARRAY_REGISTERS, arrayPrologue } from './arrayRuntime';
import { HEAP_OFFSET, loweredProgram } from './programImage';
import {
  ASCII_NEWLINE,
  PRINT_AREA_LAYOUT,
  PRINT_DIGITS,
  PRINT_PRIMITIVE_REGISTERS,
  numberToTextPrimitives,
  writeTextPrimitives,
  exitPrimitives,
  printAreaOf,
  numberToTextLeanPrimitives,
} from './printPrimitives';
import { buildShim, toWslPath } from '../scripts/e2kQemuExec';

const ROOT = path.resolve(__dirname, '..', '..');
const encoder = getEncoder('e2k');
const HEAP = MINIMAL_BASE + HEAP_OFFSET;
const AREA = printAreaOf(HEAP);
const imm = (value: number): Operand => ({ kind: 'imm', value });
const reg = (index: number): Operand => ({ kind: 'reg', index });

/** Регистр аргумента пробы: последовательность копирует его в свой рабочий сама. */
const ARGUMENT = PRINT_PRIMITIVE_REGISTERS.input + 1;

function pack(instructions: readonly AsmInstruction[]): Uint8Array {
  const chunks = instructions.map((instruction) => encoder.encode(instruction));
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

/** Значение — в регистр-аргумент. Отрицательное: `subs(ноль, v)` — литералом знак не кладётся. */
function valueInto(argument: number, value: number): AsmInstruction[] {
  if (value >= 0) return [{ mnemonic: 'movts', channel: 0, operands: [imm(value), reg(argument)] }];
  return [
    { mnemonic: 'movts', channel: 0, operands: [imm(-value), reg(argument)] },
    { mnemonic: 'subs', channel: 0, operands: [reg(ARRAY_REGISTERS.zero), reg(argument), reg(argument)] },
  ];
}

/** Программа печати одного числа: пролог, значение, последовательность. */
function printProgram(value: number): AsmInstruction[] {
  return [
    ...arrayPrologue(HEAP),
    ...valueInto(ARGUMENT, value),
    ...numberToTextPrimitives(ARGUMENT, HEAP).instructions,
    ...writeTextPrimitives(HEAP),
    ...exitPrimitives(0),
  ];
}

/** Программа «три вызова печати подряд»: буфер переиспользуется между вызовами (запись `43`). */
function printManyProgram(values: readonly number[]): AsmInstruction[] {
  const instructions: AsmInstruction[] = [...arrayPrologue(HEAP)];
  for (const value of values) {
    instructions.push(
      ...valueInto(ARGUMENT, value),
      ...numberToTextPrimitives(ARGUMENT, HEAP).instructions,
      ...writeTextPrimitives(HEAP),
    );
  }
  instructions.push(...exitPrimitives(0));
  return instructions;
}

/** Прогон модели с журналом системных вызовов: stdout — текст гостя, stderr — журнал. */
function runWithJournal(instructions: readonly AsmInstruction[], name: string): { stdout: Buffer; stderr: string; status: number | null } {
  const elf = path.join(ROOT, '.tmp', `print-primitives-${name}.elf`);
  fs.writeFileSync(elf, buildElfFromCode(pack(instructions), MINIMAL_BASE, { writable: true, extraMemory: HEAP_OFFSET }).bytes);
  const result = spawnSync(
    'wsl',
    ['-d', 'e2k', '--', ...(shim === undefined ? [] : ['env', `LD_PRELOAD=${toWslPath(shim)}`]),
      '/root/qemu-build/qemu-e2k', '-d', 'strace', toWslPath(elf)],
    { encoding: 'buffer', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
  );
  return { stdout: result.stdout ?? Buffer.alloc(0), stderr: (result.stderr ?? Buffer.alloc(0)).toString('latin1'), status: result.status };
}

/**
 * Ожидаемые адрес и длина `write` по числу — считаются в TS независимо от программы.
 *
 * Длина: разряды + знак + перевод строки. Адрес: старший разряд стоит по младшему адресу, значит
 * текст начинается со слота `10 − разряды` и сдвигается на байт влево у отрицательного.
 */
function expectedWrite(value: number): { address: number; length: number; bytes: string } {
  const magnitude = Math.abs(value);
  const digits = magnitude === 0 ? 1 : String(magnitude).length;
  const negative = value < 0 ? 1 : 0;
  return {
    address: AREA + PRINT_AREA_LAYOUT.digits + (PRINT_DIGITS - digits) - negative,
    length: digits + negative + 1,
    bytes: [...Buffer.from(`${value < 0 ? '-' : ''}${String(magnitude)}\n`, 'latin1')]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join(' '),
  };
}

const hex = (buffer: Buffer): string => [...buffer].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');

/** Журнал: `write(1,<адрес>,<длина>) = <сколько>` — первая запись. */
function firstWrite(journal: string): { address: number; length: number } | undefined {
  const match = /(\d+) write\(1,(0x[0-9a-f]+),(\d+)\) = (-?\d+)/i.exec(journal);
  if (match === null) return undefined;
  return { address: Number.parseInt(match[2]!, 16), length: Number.parseInt(match[3]!, 10) };
}

/** Записи эталонов корпуса: `examples/39…44`, `expected.txt` — байты целиком (§3.42.1). */
const RECORDS: readonly { readonly record: string; readonly value: number; readonly bytes: string }[] = [
  { record: '39 (эталон 31 30 0a)', value: 10, bytes: '31 30 0a' },
  { record: '40 (эталон 30 0a)', value: 0, bytes: '30 0a' },
  { record: '41 (эталон 2d 37 0a)', value: -7, bytes: '2d 37 0a' },
  { record: '42 (эталон 39 37 38 0a)', value: 978, bytes: '39 37 38 0a' },
  { record: '44 (эталон 31 30 30 0a)', value: 100, bytes: '31 30 30 0a' },
];

const shim = buildShim();

describe('печать на цели: число → текст, сверка байтами эталона', () => {
  it('шим и модель доступны — или причина названа', () => {
    if (shim === undefined) {
      expect(shim, 'шим не собран: в WSL-дистрибутиве нет компилятора C (docs/e2k-qemu-run.md §2.5)').toBeUndefined();
      return;
    }
    expect(shim.length).toBeGreaterThan(3);
  });

  for (const item of RECORDS) {
    it(`запись ${item.record}: в stdout ровно ${item.bytes}, код возврата 0`, () => {
      if (shim === undefined) return;
      const run = runWithJournal(printProgram(item.value), `rec-${String(item.value).replace('-', 'min')}`);
      const expected = expectedWrite(item.value);
      if (run.status !== 0 && run.stdout.length === 0) {
        expect(run.status, `модель не дошла до печати: ${run.stderr.slice(0, 200)}`).toBe(0);
        return;
      }
      expect(hex(run.stdout), `байты вывода обязаны совпасть с эталоном записи целиком`).toBe(item.bytes);
      expect(item.bytes).toBe(expected.bytes);
      expect(run.status, 'печатающая программа обязана завершиться СВОИМ exit(0), иначе 134 (§3.39)').toBe(0);
      const write = firstWrite(run.stderr);
      expect(write, 'журнал модели обязан назвать write(1, адрес, длина)').toBeDefined();
      expect(write?.address, 'адрес текста — независимый расчёт по числу').toBe(expected.address);
      expect(write?.length, 'длина текста — независимый расчёт по числу').toBe(expected.length);
    });
  }

  it('два вызова подряд: буфер переиспользуется, каждая печать даёт свою строку', () => {
    if (shim === undefined) return;
    const run = runWithJournal(printManyProgram([1, 2]), 'two-calls');
    expect(hex(run.stdout), 'два вызова дают две строки: 31 0a 32 0a').toBe('31 0a 32 0a');
    expect(run.status).toBe(0);
    expect(run.stderr.match(/write\(1,/g)?.length, 'в журнале обязаны быть ДВА вызова write').toBe(2);
  });

  it('ГРАНИЦА ИЗМЕРЕНА: три печати ПОДРЯД упираются в площадку — код доходит до неё', () => {
    if (shim === undefined) return;
    // Площадка стоит в хвосте образа (`spillBase − 64`). Прямая развёртка трёх печатей — 432
    // команды: код перерастает её и пишет разряды ПОВЕРХ СЕБЯ. Это не дефект последовательности,
    // а названная граница места: в корпусе запись `43` печатает в ЦИКЛЕ (код короткий), поэтому
    // её эталон `31 0a 32 0a 33 0a` достигается циклом, а не тремя развёртками подряд.
    const three = printManyProgram([1, 2, 3]);
    const codeBytes = pack(three).length;
    expect(MINIMAL_BASE + 0x1000 + codeBytes, 'код трёх печатей обязан доходить до площадки').toBeGreaterThan(AREA);
    const run = runWithJournal(three, 'three-calls');
    expect(
      hex(run.stdout),
      'граница обязана быть видна поведением: третья строка НЕ печатается молча',
    ).not.toBe('31 0a 32 0a 33 0a');
    expect(run.status, 'запись поверх своего кода обязана кончаться отказом, а не тихой ложью').not.toBe(0);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: подмена числа меняет байты вывода', () => {
    if (shim === undefined) return;
    const first = runWithJournal(printProgram(978), 'neg-978');
    const second = runWithJournal(printProgram(10), 'neg-10');
    expect(hex(first.stdout)).toBe('39 37 38 0a');
    expect(hex(second.stdout)).toBe('31 30 0a');
    expect(hex(first.stdout), 'если байты совпали, проба ничего не сторожит').not.toBe(hex(second.stdout));
    // Различается и ДЛИНА: без этого «10» и «100» неотличимы (ровно тот дефект, что назван в §3.42.1).
    const longRun = runWithJournal(printProgram(100), 'neg-100');
    expect(hex(longRun.stdout)).toBe('31 30 30 0a');
    expect(hex(longRun.stdout)).not.toBe(hex(second.stdout));
    expect(firstWrite(longRun.stderr)?.length).not.toBe(firstWrite(second.stderr)?.length);
  });

  it('перевод строки входит в длину: без него `write` отдал бы на байт меньше', () => {
    if (shim === undefined) return;
    const run = runWithJournal(printProgram(978), 'newline-length');
    const expected = expectedWrite(978);
    expect(expected.length).toBe(4); // «9», «7», «8», «\n»
    expect(expected.bytes.endsWith(ASCII_NEWLINE.toString(16).padStart(2, '0'))).toBe(true);
    expect(firstWrite(run.stderr)?.length).toBe(4);
    expect(hex(run.stdout).split(' ')).toHaveLength(4);
  });

  it('глубина знака: отрицательное печатается с минусом и без минуса у положительного', () => {
    if (shim === undefined) return;
    const negative = runWithJournal(printProgram(-42), 'sign-negative');
    const positive = runWithJournal(printProgram(42), 'sign-positive');
    expect(hex(negative.stdout)).toBe('2d 34 32 0a');
    expect(hex(positive.stdout)).toBe('34 32 0a');
    expect(negative.status).toBe(0);
    expect(positive.status).toBe(0);
  });

  it('модель доступна как модель: причина отказа видна словами, а не только кодом', () => {
    if (shim === undefined) return;
    // Сторож канала: у рабочего прогона журнал есть, у отсутствия модели — нет.
    const run = runWithJournal(printProgram(1), 'channel-guard');
    expect(run.status).toBe(0);
    expect(run.stderr).toContain('write');
  });
});

/** Прогон ГОТОВОГО образа (конвейер целиком) — тем же способом, что ручные программы выше. */
function runImage(bytes: Uint8Array, name: string): { stdout: Buffer; stderr: string; status: number | null } {
  const elf = path.join(ROOT, '.tmp', `print-image-${name}.elf`);
  fs.writeFileSync(elf, bytes);
  const result = spawnSync(
    'wsl',
    ['-d', 'e2k', '--', ...(shim === undefined ? [] : ['env', `LD_PRELOAD=${toWslPath(shim)}`]),
      '/root/qemu-build/qemu-e2k', '-d', 'strace', toWslPath(elf)],
    { maxBuffer: 8 * 1024 * 1024 },
  );
  return { stdout: result.stdout ?? Buffer.alloc(0), stderr: (result.stderr ?? Buffer.alloc(0)).toString('utf-8'), status: result.status };
}

describe('РАЗДЕЛЁННАЯ ПЕЧАТЬ: «число → текст» в листовой процедуре, `write` у вызывающего', () => {
  /** Программа с ЛИСТОВОЙ последовательностью: вход — свой `%b[0]` (окно вызываемой). */
  const leanProgram = (value: number): AsmInstruction[] => [
    ...arrayPrologue(HEAP),
    ...valueInto(PRINT_PRIMITIVE_REGISTERS.input, value),
    ...numberToTextLeanPrimitives(HEAP).instructions,
    ...writeTextPrimitives(HEAP),
    ...exitPrimitives(0),
  ];

  for (const item of RECORDS.slice(0, 4)) {
    it(`листовая последовательность (8 регистров): ${String(item.value)} → ${item.bytes}`, () => {
      if (shim === undefined) return;
      const run = runWithJournal(leanProgram(item.value), `lean-${String(item.value).replace('-', 'min')}`);
      expect(hex(run.stdout), 'листовая последовательность обязана печатать те же байты, что полная').toBe(item.bytes);
      expect(run.status).toBe(0);
    });
  }

  it('ДЕСЯТЬ ПЕЧАТЕЙ в одной программе: конвейер делит развёртку, вывод совпадает побайтово', () => {
    if (shim === undefined) return;
    const values = [0, 1, 7, 10, 42, 100, 978, -7, 12345, 999999];
    const source = `процедура главная()\n${values
      .map((value) => `  система.лог.вывести(${String(value)})`)
      .join('\n')}\nконец_процедуры\n`;
    const image = loweredProgram(source);
    expect(image.refused, 'разделённая печать обязана понижаться без отказов').toEqual([]);
    // Без разделения десять развёрток весили бы ≈14320 байт — это заведомо больше площадки (3776).
    const inline = values.length * pack(numberToTextPrimitives(PRINT_PRIMITIVE_REGISTERS.input, HEAP).instructions).length;
    expect(MINIMAL_BASE + 0x1000 + inline, 'без разделения десять печатей НЕ влезают').toBeGreaterThan(AREA);
    expect(MINIMAL_BASE + 0x1000 + image.bytes.length, 'с разделением — влезают').toBeLessThan(AREA);
    // `loweredProgram` даёт БАЙТЫ КОДА: обёртка в ELF — тем же вызовом, что у ручных программ выше.
    const run = runImage(buildElfFromCode(image.bytes, MINIMAL_BASE, { writable: true, extraMemory: HEAP_OFFSET }).bytes, 'shared-ten');
    const expected = Buffer.from(values.map((value) => `${String(value)}\n`).join(''), 'utf-8');
    expect(hex(run.stdout), 'десять печатей обязаны дать десять строк побайтово').toBe(
      [...expected].map((byte) => byte.toString(16).padStart(2, '0')).join(' '),
    );
    expect(run.status, 'печатающая программа завершается своим exit(0)').toBe(0);
    expect(run.stderr.match(/write\(1,/g)?.length, 'в журнале обязаны быть ДЕСЯТЬ вызовов write').toBe(values.length);
  });
});
