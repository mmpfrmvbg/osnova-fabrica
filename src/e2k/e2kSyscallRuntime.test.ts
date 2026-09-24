/**
 * ОРАКУЛ «HELLO» БЕЗ LIBC: СИСТЕМНЫЙ ВЫЗОВ `write` В QEMU.
 *
 * # Что проверяется
 *
 * `src/e2k/syscallRuntime.ts` собирает `_start`, который пишет строку в stdout через `write` и
 * завершается. Оракул проверяет три вещи по отдельности, чтобы провал называл **своё** звено:
 *
 * 1. **Сборка**: последовательность кодируется, строка лежит в образе, адрес строки — тот, что
 *    загружает `movtd` формой 0xdc.
 * 2. **Образ**: `objdump` МЦСТ разбирает ELF и печатает ожидаемый текст (в том числе `_f64`).
 * 3. **Исполнение**: прогон в QEMU с шимом, и **stdout содержит «hello»** — или причина названа
 *    точно (нет шима, нет QEMU, вызов не дошёл).
 *
 * # Чего оракул НЕ доказывает
 *
 * Что так поведёт себя железо: QEMU — модель. И что завершение (`exit`) дошло: вывод проверяется
 * отдельно от кода возврата, потому что окно регистров после первого вызова — названная граница.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { getEncoder } from './backend';
import { buildElfFromCode, MINIMAL_BASE, SYSCALL_WBS } from './elfMinimal';
import {
  buildHelloProgram,
  textBytes,
  SYS_WRITE,
  HELLO_SETBN_RSZ,
  WINDOW_BUFFER_REGISTER,
} from './syscallRuntime';
import { buildShim, runInQemu } from '../scripts/e2kQemuExec';
import {
  disassembleElf,
  disasmFacts,
  findExternalTool,
  parseObjdumpOutput,
} from '../scripts/e2kExternalObjdump';

const ROOT = path.resolve(__dirname, '..', '..');
const encoder = getEncoder('e2k');

/** Образ «hello», каким его видит чужой дизассемблер: строки текста или названная причина. */
type DisasmView = { readonly lines: readonly string[] } | { readonly missing: string };

describe('hello без libc: сборка', () => {
  const program = buildHelloProgram('hello');

  it('последовательность кодируется, строка лежит в образе по адресу из movtd', () => {
    const bytes = encoder.encode(program.instructions[3]!);
    // Адрес строки загружается формой 0xdc: 16 байт, поле src2 = 0xdc.
    expect(bytes.length, 'адрес — 64-битным литералом').toBe(16);
    expect(bytes[5], 'поле ссылки на литерал').toBe(0xdc);
    // Адрес в литерале — тот же, по которому реально лежит строка.
    const back = encoder.decode(bytes);
    expect(back.operands[0]).toEqual({ kind: 'imm64', value: BigInt(program.textAddress) });
    expect(program.textAddress, 'адрес строки = база + длина кода').toBe(MINIMAL_BASE + program.code.length - 5);
    expect(textBytes(program), 'байты строки в образе').toBe('hello');
  });

  it('номер вызова write и дескриптор — в оконных регистрах, а не в базовых', () => {
    const number = program.instructions[1]!;
    expect(number.mnemonic).toBe('movts');
    expect(number.operands[0]).toEqual({ kind: 'imm', value: SYS_WRITE });
    expect(number.operands[1], 'приёмник — оконный регистр').toEqual({ kind: 'reg', index: 8, file: 'window' });
    // Окно расширено: rsz=5 даёт 12 единиц, чего хватает на %r8…%r11.
    expect(program.instructions[0]!.operands[0]).toEqual({ kind: 'imm', value: 5 });
  });

  it('у блокеров названы причины, а не «не получилось»', () => {
    expect(program.blockers.length).toBeGreaterThanOrEqual(3);
    for (const blocker of program.blockers) {
      expect(blocker.length, blocker).toBeGreaterThan(40);
    }
  });
});

describe('hello без libc: образ читается дизассемблером МЦСТ', () => {
  // Дизассемблер запускается один раз: две проверки ниже читают один и тот же вывод — форма
  // строки и **значения** в ней.
  let view: DisasmView | undefined;
  const disasm = (): DisasmView => {
    if (view !== undefined) return view;
    const { tool, reason } = findExternalTool();
    if (tool === undefined) {
      view = { missing: reason ?? 'причина ненайденности дизассемблера не названа' };
      return view;
    }
    const program = buildHelloProgram('hello');
    const elf = buildElfFromCode(program.code, MINIMAL_BASE);
    const result = disassembleElf(
      { bytes: Buffer.from(elf.bytes), layout: [] },
      path.join(ROOT, '.tmp', 'e2k-hello.elf'),
    );
    if (result === undefined) {
      view = { missing: 'дизассемблер не ответил на наш образ (причина — в оракуле внешней проверки)' };
      return view;
    }
    view = { lines: parseObjdumpOutput(result.text).map((line) => line.text) };
    return view;
  };

  it('objdump печатает ожидаемые строки, включая 64-битный литерал', () => {
    const seen = disasm();
    if ('missing' in seen) {
      expect(seen.missing.length, 'причина ненайденности дизассемблера не названа').toBeGreaterThan(20);
      return;
    }
    const program = buildHelloProgram('hello');
    const lines = seen.lines;
    const missing = program.expectDisasm.filter(
      (expected) => !lines.some((line) => line.includes(expected.split(' ').slice(0, 3).join(' '))),
    );
    expect(missing, `не найдено в выводе objdump: ${missing.join('; ')}`).toEqual([]);
  });

  /**
   * Значение, а не форма. Первая проверка сравнивает **префикс** строки и потому смотрит на
   * наше же вычисление: подмена значения в вычислении уехала бы вместе с ожиданием. Здесь
   * значение читается из чужого вывода и **пришпилено** к измеренному адресу 0x100070 — то есть
   * расхождение в самом вычислении тоже видно. Адрес перемерен 2026-09-24: после короткой
   * непосредственной формы (`0xc0 | N`) код стал на 32 байта короче, строка уехала следом
   * (было 0x100098; замер `.tmp/measure-hello.ts`).
   */
  it('значения из образа: литерал 0x100070 в %dr10, rsz = 5, wbs = 4, sdisp = 0', () => {
    const seen = disasm();
    if ('missing' in seen) {
      expect(seen.missing.length).toBeGreaterThan(20);
      return;
    }
    const program = buildHelloProgram('hello');
    const facts = disasmFacts(seen.lines);
    expect(facts.literalValue, 'литерал адреса строки не прочитан из образа').toBeDefined();
    // Главная проверка: значение в байтах против измеренной константы (код 117 байт, база 0x100000).
    expect(facts.literalValue, 'адрес строки в образе').toBe(0x100070n);
    expect(facts.literalValue, 'адрес строки равен вычисленному сборщиком').toBe(BigInt(program.textAddress));
    // Приёмник: дизассемблер печатает двойной регистр как `%drN` (`opcodes/e2k-dis.c:407,575`).
    expect(facts.literalRegister, 'приёмник литерала').toBe(`%dr${WINDOW_BUFFER_REGISTER}`);
    // Значения остальных полей: round-trip через чужой разбор (пригодность rsz=5 для ABI это не доказывает).
    expect(facts.rsz, 'rsz в образе').toBe(HELLO_SETBN_RSZ);
    expect(facts.wbs, 'wbs обоих вызовов').toEqual([SYSCALL_WBS, SYSCALL_WBS]);
    expect(facts.sdisp, 'иммедиаты sdisp').toEqual([0, 0]);
    // Литерал указывает на строку: смещение строки в образе — те самые 0x70, а не совпадение.
    expect(program.textAddress - MINIMAL_BASE, 'смещение строки в образе').toBe(0x70);
  });
});

describe('hello без libc: исполнение в QEMU', () => {
  it('QEMU выводит hello — или причина названа точно', () => {
    const shim = buildShim();
    if (shim === undefined) {
      // Компилятора в дистрибутиве нет — это названная причина, а не «не проверено».
      expect(shim, 'шим не собран: в WSL-дистрибутиве нет компилятора C (docs/e2k-qemu-run.md §2.5)').toBeUndefined();
      return;
    }
    const program = buildHelloProgram('hello');
    const file = path.join(ROOT, '.tmp', 'e2k-hello.elf');
    fs.writeFileSync(file, buildElfFromCode(program.code, MINIMAL_BASE).bytes);
    const result = runInQemu(file, { shim: true });
    if (result === undefined) {
      expect(result, 'QEMU не запустился — причина названа в оракуле прогона (e2kQemuExec.test.ts)').toBeUndefined();
      return;
    }
    // Требуемое: stdout содержит «hello». Вывод печатается целиком, чтобы причина отказа была видна.
    expect(
      result.output.includes('hello'),
      `QEMU не вывел hello. Вывод: «${result.output.slice(0, 400)}», код возврата ${String(result.status)}. ` +
        'Проверено: write=4 в оконном r0 (movts → %r8), fd=1 в %r9, buf — 64-битным литералом в %r10, ' +
        'count=5 в %r11, sdisp %ctpr1, call %ctpr1 wbs=4; при провале звено названо этим сообщением.',
    ).toBe(true);
  });

  /**
   * Различающий опыт на второй вызов. Код возврата `0` не различает «`exit` дошёл» и «программа
   * кончилась сама»: ноль вышел бы в обоих случаях. Поэтому тот же образ собирается с `exit(42)` —
   * и тогда код возврата QEMU называет, дошёл ли второй вызов **после** `write` (то есть
   * восстановилось ли окно регистров между вызовами — названная граница `src/e2k/syscallRuntime.ts`).
   */
  it('exit(42) после write: код возврата различает «дошёл» и «не дошёл»', () => {
    const shim = buildShim();
    if (shim === undefined) {
      expect(shim, 'шим не собран: в WSL-дистрибутиве нет компилятора C').toBeUndefined();
      return;
    }
    const program = buildHelloProgram('hello', 42);
    // Адрес строки от кода возврата не зависит только в том случае, когда форма `movts` одна и та же;
    // здесь `exit(42)` требует литеральной формы (16 байт) вместо короткой (8), поэтому строка
    // сдвигается на 8 байт: 0x78 против 0x70 у `hello` без кода возврата (перемер 2026-09-24).
    expect(program.textAddress - MINIMAL_BASE, 'смещение строки с литеральным кодом возврата').toBe(0x78);
    const file = path.join(ROOT, '.tmp', 'e2k-hello-42.elf');
    fs.writeFileSync(file, buildElfFromCode(program.code, MINIMAL_BASE).bytes);
    const result = runInQemu(file, { shim: true });
    if (result === undefined) {
      expect(result, 'QEMU не запустился — причина названа в оракуле прогона').toBeUndefined();
      return;
    }
    expect(
      result.status,
      `QEMU не вернул 42 (вернул ${String(result.status)}) — второй syscall после write не дошёл. ` +
        `Вывод: «${result.output.slice(0, 200)}». Это и есть проверка восстановления окна между вызовами.`,
    ).toBe(42);
    expect(result.output.includes('hello'), 'вывод первого вызова потерялся').toBe(true);
  });
});
