/**
 * ОРАКУЛ ПОСЛЕДОВАТЕЛЬНОСТИ «ЧИСЛО → ТЕКСТ» — без модели: форма, сторож и негативные контроли.
 *
 * Что здесь проверяется и почему именно так:
 *
 * | утверждение | чем проверено |
 * |---|---|
 * | сторож зелёный на настоящей последовательности | {@link checkNumberToText} |
 * | развёртка ПРЯМАЯ: ни переходов, ни вызовов | по мнемоникам: `ct`/`disp`/`call` — ноль |
 * | каждая команда кодируется | кодировщик `e2k`, длина > 0 |
 * | разряды, знак и `\n` — БАЙТОВОЙ записью | `stb` ровно `PRINT_DIGITS + 2`, ни одного `std` по разрядам |
 * | основание и смещение памяти — РАЗНЫЕ регистры | закон адресации (`docs/hardware-debt.md` §3.30) |
 * | площадка не трогает состояние рантайма массивов | регистры `%b[12..15]` вне списка порчи |
 *
 * Негативные контроли обязательны: без них «сторож зелёный» неотличимо от «сторож ничего не
 * проверяет». Здесь их три — снятая запись разряда, снятый перевод строки и склеенное основание со
 * смещением.
 *
 * Прогон в МОДЕЛИ — отдельный файл (`printPrimitivesQemu.test.ts`, шлюз `gate:qemu`): здесь
 * ничего не исполняется, и это названо, а не замалчивается.
 */
import { describe, it, expect } from 'vitest';
import { getEncoder } from './backend';
import { MINIMAL_BASE, spillBaseOf } from './elfMinimal';
import { ARRAY_REGISTERS, ARRAY_WINDOW_RSZ } from './arrayRuntime';
import {
  ASCII_MINUS,
  ASCII_NEWLINE,
  ASCII_ZERO,
  PRINT_AREA_BYTES,
  PRINT_AREA_LAYOUT,
  PRINT_DIGITS,
  PRINT_PRIMITIVE_CLOBBERS,
  PRINT_PRIMITIVE_REGISTERS,
  checkNumberToText,
  exitPrimitives,
  numberToTextPrimitives,
  printAreaOf,
  printNumberPrimitives,
  writeTextPrimitives,
} from './printPrimitives';

const HEAP = MINIMAL_BASE + 0x2000;
const encoder = getEncoder('e2k');
const text = numberToTextPrimitives(1, HEAP);
const kinds = text.instructions.map((instruction) => instruction.mnemonic);

describe('печать: последовательность «число → десятичный текст»', () => {
  it('сторож зелёный на настоящей последовательности — и его проверки не пусты', () => {
    expect(checkNumberToText(text.instructions)).toEqual([]);
    // Сторож, который ничего не требует, зелен всегда: требования называются числом.
    expect(kinds.filter((kind) => kind === 'sdivs')).toHaveLength(PRINT_DIGITS);
    expect(kinds.filter((kind) => kind === 'stb')).toHaveLength(PRINT_DIGITS + 2);
    expect(kinds.filter((kind) => kind === 'std')).toHaveLength(2);
  });

  it('развёртка ПРЯМАЯ: ни одного перехода и ни одного вызова', () => {
    expect(kinds.filter((kind) => kind === 'ct' || kind === 'disp' || kind === 'call')).toEqual([]);
  });

  it('каждая команда кодируется кодировщиком e2k', () => {
    for (const instruction of text.instructions) {
      expect(encoder.encode(instruction).length, `${instruction.mnemonic} не кодируется`).toBeGreaterThan(0);
    }
  });

  it('разряды, знак и перевод строки кладутся БАЙТОМ, а не словом', () => {
    const stores = text.instructions.filter((instruction) => instruction.mnemonic === 'stb');
    // Десять разрядов, знак и `\n` — иначе между цифрами в памяти встали бы нули, и «10» из
    // области вывода не получилось бы ни при какой длине (docs/hardware-debt.md §3.42.2, часть В).
    expect(stores).toHaveLength(PRINT_DIGITS + 2);
    for (const store of stores) {
      // Слово (`std`) пишет восемь байт разом; здесь и значение, и смещение — регистровые.
      expect(store.operands[1]?.kind).toBe('reg');
      expect(store.operands[2]?.kind).toBe('reg');
    }
    // Коды знака и перевода строки материализуются в регистр перед записью — литерал в операнде
    // кодировщик не несёт.
    const immediates = text.instructions
      .filter(
        (instruction) =>
          instruction.mnemonic === 'movts' && instruction.operands[0]?.kind === 'imm' && instruction.operands[1]?.kind === 'reg',
      )
      .map((instruction) => (instruction.operands[0] as { kind: 'imm'; value: number }).value);
    expect(immediates).toContain(ASCII_MINUS);
    expect(immediates).toContain(ASCII_NEWLINE);
    // Перевод строки — по ПОСТОЯННОМУ смещению сразу за младшим разрядом: он не зависит от длины.
    expect(immediates).toContain(PRINT_AREA_LAYOUT.newline);
    expect(PRINT_AREA_LAYOUT.newline).toBe(PRINT_AREA_LAYOUT.digits + PRINT_DIGITS);
  });

  it('основание и смещение каждой формы памяти — РАЗНЫЕ регистры (закон адресации §3.30)', () => {
    const memory = text.instructions.filter((instruction) =>
      ['ldd', 'std', 'stb'].includes(instruction.mnemonic),
    );
    expect(memory.length).toBeGreaterThan(PRINT_DIGITS);
    for (const instruction of memory) {
      const base = instruction.operands[instruction.mnemonic === 'ldd' ? 0 : 1];
      const offset = instruction.operands[instruction.mnemonic === 'ldd' ? 1 : 2];
      expect(base?.kind).toBe('reg');
      expect(offset?.kind).toBe('reg');
      expect(base?.kind === 'reg' && offset?.kind === 'reg' && base.index === offset.index).toBe(false);
    }
  });

  it('площадка стоит в хвосте образа и НЕ пересекается ни с кодом, ни с кучей', () => {
    const area = printAreaOf(HEAP);
    // Соглашение карты: MINIMAL_BASE + 0x2000 − 0x100 − 64.
    expect(area).toBe(MINIMAL_BASE + 0x2000 - 0x100 - 64);
    // Площадка кончается там, где начинается область вытеснения: перекрытия нет.
    expect(area + PRINT_AREA_BYTES).toBeLessThanOrEqual(spillBaseOf(HEAP));
    // И она ВЫШЕ начала кода (код грузится с MINIMAL_BASE + 0x1000) — то есть в хвосте образа.
    expect(area).toBeGreaterThan(MINIMAL_BASE + 0x1000);
  });

  it('регистры последовательности не задевают состояние рантайма массивов', () => {
    const runtime: number[] = [ARRAY_REGISTERS.zero, ARRAY_REGISTERS.one, ARRAY_REGISTERS.eight, ARRAY_REGISTERS.heap];
    expect(PRINT_PRIMITIVE_CLOBBERS.filter((index) => runtime.includes(index))).toEqual([]);
    // И наоборот: два временных рантайма массивов она занимает — это названо, а не случайность.
    expect(PRINT_PRIMITIVE_CLOBBERS).toContain(ARRAY_REGISTERS.scratch);
    expect(PRINT_PRIMITIVE_CLOBBERS).toContain(ARRAY_REGISTERS.scratch2);
  });

  it('константы кладутся в регистр ДО арифметики знака', () => {
    // Порядок измерен: если единицу материализовать после модуля, произведение даёт ноль
    // (`.tmp/osnova-print-area-dump.ts`: разряды выходили `30 30 …` при любом входе).
    const first = text.instructions.findIndex((instruction) => instruction.mnemonic === 'muls' && instruction.operands[0]?.kind === 'reg' && instruction.operands[0].index === PRINT_PRIMITIVE_REGISTERS.input);
    const unit = text.instructions.findIndex(
      (instruction) =>
        instruction.mnemonic === 'movts' &&
        instruction.operands[0]?.kind === 'imm' &&
        instruction.operands[0].value === 1 &&
        instruction.operands[1]?.kind === 'reg' &&
        instruction.operands[1].index === PRINT_PRIMITIVE_REGISTERS.one,
    );
    expect(unit).toBeGreaterThanOrEqual(0);
    expect(unit).toBeLessThan(first);
  });
});

describe('печать: хвост и завершение', () => {
  const tail = writeTextPrimitives(HEAP);

  it('хвост читает адрес и длину ИЗ ПАМЯТИ — словами площадки', () => {
    const loads = tail.filter((instruction) => instruction.mnemonic === 'ldd');
    expect(loads).toHaveLength(2);
    for (const load of loads) {
      const offset = load.operands[0];
      expect(offset?.kind).toBe('reg');
      // Адрес слова — литералом (`movtd`), а не короткой пересылкой: адрес площадки в неё не влезает.
      const address = tail.find(
        (instruction) =>
          instruction.mnemonic === 'movtd' &&
          instruction.operands[1]?.kind === 'reg' &&
          offset?.kind === 'reg' &&
          instruction.operands[1].index === offset.index,
      );
      expect(address, 'адрес слова площадки обязан быть 64-битным литералом').toBeDefined();
    }
    const literals = tail
      .filter((instruction) => instruction.mnemonic === 'movtd' && instruction.operands[0]?.kind === 'imm64')
      .map((instruction) => Number((instruction.operands[0] as { kind: 'imm64'; value: bigint }).value));
    expect(literals).toContain(printAreaOf(HEAP) + PRINT_AREA_LAYOUT.startWord);
    expect(literals).toContain(printAreaOf(HEAP) + PRINT_AREA_LAYOUT.lengthWord);
  });

  it('хвост ровно один раз ставит окно и ровно один раз делает `write`', () => {
    expect(tail.filter((instruction) => instruction.mnemonic === 'setbn')).toHaveLength(1);
    expect(tail.filter((instruction) => instruction.mnemonic === 'call')).toHaveLength(1);
    // Окно — прологовое: сужение до `rsz = 5` делает `%b[12..15]` недоступными (§3.24).
    const window = tail.find((instruction) => instruction.mnemonic === 'setbn');
    expect(window?.operands[0]).toEqual({ kind: 'imm', value: ARRAY_WINDOW_RSZ });
  });

  it('выход — своя пара `exit` и она есть: без неё программа на цели падает (§3.39)', () => {
    const exit = exitPrimitives(0);
    expect(exit.filter((instruction) => instruction.mnemonic === 'call')).toHaveLength(1);
    expect(exit.some((instruction) => instruction.mnemonic === 'movts')).toBe(true);
  });

  it('полная последовательность = текст + хвост + выход, и она кончается выходом', () => {
    const full = printNumberPrimitives(1, HEAP);
    expect(full.instructions.length).toBe(text.instructions.length + tail.length + exitPrimitives(0).length);
    expect(full.instructions.slice(-exitPrimitives(0).length)).toEqual(exitPrimitives(0));
    expect(full.instructions.filter((instruction) => instruction.mnemonic === 'call')).toHaveLength(2);
    expect(full.startWord).toBe(printAreaOf(HEAP) + PRINT_AREA_LAYOUT.startWord);
    expect(full.area).toBe(printAreaOf(HEAP));
  });
});

describe('печать: негативные контроли сторожа', () => {
  it('снятая запись разряда — сторож краснеет', () => {
    const store = text.instructions.findIndex((instruction) => instruction.mnemonic === 'stb');
    const broken = text.instructions.filter((_, index) => index !== store);
    expect(checkNumberToText(broken).length).toBeGreaterThan(0);
  });

  it('снятый перевод строки — сторож краснеет', () => {
    // Последняя байтовая запись последовательности — перевод строки (знак идёт перед ней).
    const stores = text.instructions
      .map((instruction, index) => ({ instruction, index }))
      .filter((item) => item.instruction.mnemonic === 'stb');
    const newlineAt = stores[stores.length - 1]!.index;
    const codes = text.instructions
      .slice(Math.max(0, newlineAt - 3), newlineAt)
      .filter((instruction) => instruction.mnemonic === 'movts' && instruction.operands[0]?.kind === 'imm')
      .map((instruction) => (instruction.operands[0] as { kind: 'imm'; value: number }).value);
    expect(codes, 'перед последней записью кладутся код 0x0a и его смещение').toContain(ASCII_NEWLINE);
    expect(codes).toContain(PRINT_AREA_LAYOUT.newline);
    const broken = text.instructions.filter((_, index) => index !== newlineAt);
    expect(checkNumberToText(broken).length).toBeGreaterThan(0);
  });

  it('основание и смещение в одном регистре — сторож краснеет (это валит порт)', () => {
    const store = text.instructions.findIndex((instruction) => instruction.mnemonic === 'stb');
    const original = text.instructions[store]!;
    const broken = [...text.instructions];
    broken[store] = { ...original, operands: [original.operands[0]!, original.operands[1]!, original.operands[1]!] };
    const problems = checkNumberToText(broken);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(' ')).toContain('основание и смещение');
  });

  it('снятое деление — сторож краснеет', () => {
    const division = text.instructions.findIndex((instruction) => instruction.mnemonic === 'sdivs');
    const broken = text.instructions.filter((_, index) => index !== division);
    expect(checkNumberToText(broken).length).toBeGreaterThan(0);
  });

  it('лишний вызов (цикл или подпрограмма) — сторож краснеет: развёртка обязана быть прямой', () => {
    const broken = [
      ...text.instructions,
      { mnemonic: 'call', channel: 0, operands: [{ kind: 'imm' as const, value: 1 }, { kind: 'imm' as const, value: 4 }] },
    ];
    expect(checkNumberToText(broken).length).toBeGreaterThan(0);
  });

  it('константы разрядов — те, что заявлены: 48 у нуля и 45 у минуса', () => {
    expect(ASCII_ZERO).toBe(48);
    expect(ASCII_MINUS).toBe(45);
    expect(ASCII_NEWLINE).toBe(0x0a);
  });
});
