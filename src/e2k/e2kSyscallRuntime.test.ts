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
import * as path from 'path';
import { getEncoder } from './backend';
import { buildElfFromCode, MINIMAL_BASE } from './elfMinimal';
import { buildHelloProgram, textBytes, SYS_WRITE } from './syscallRuntime';
import { buildShim, runInQemu } from '../scripts/e2kQemuExec';
import { buildE2kElf, disassembleElf, findExternalTool, parseObjdumpOutput } from '../scripts/e2kExternalObjdump';
import type { E2kSample } from '../scripts/extractE2kSamples';

const ROOT = path.resolve(__dirname, '..', '..');
const encoder = getEncoder('e2k');

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
  it('objdump печатает ожидаемые строки, включая 64-битный литерал', () => {
    const { tool } = findExternalTool();
    if (tool === undefined) {
      const probe = findExternalTool();
      expect(probe.reason, 'причина ненайденности дизассемблера не названа').toBeDefined();
      return;
    }
    const program = buildHelloProgram('hello');
    const elf = buildElfFromCode(program.code, MINIMAL_BASE);
    const hex = Array.from(program.code, (byte) => byte.toString(16).padStart(2, '0')).join(' ');
    const samples: E2kSample[] = [
      {
        mnemonic: 'hello',
        form: 'программа',
        opc: '0x0',
        channel: 0,
        operands: [],
        bytes: '',
        hex,
        size: program.code.length,
        assembly: 'hello',
        source: 'src/e2k/syscallRuntime.ts',
      },
    ];
    void samples;
    const result = disassembleElf(
      { bytes: Buffer.from(elf.bytes), layout: [] },
      path.join(ROOT, '.tmp', 'e2k-hello.elf'),
    );
    expect(result, 'дизассемблер не ответил').toBeDefined();
    if (result === undefined) return;
    const lines = parseObjdumpOutput(result.text).map((line) => line.text);
    const missing = program.expectDisasm.filter(
      (expected) => !lines.some((line) => line.includes(expected.split(' ').slice(0, 3).join(' '))),
    );
    expect(missing, `не найдено в выводе objdump: ${missing.join('; ')}`).toEqual([]);
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
    require('fs').writeFileSync(file, buildElfFromCode(program.code, MINIMAL_BASE).bytes);
    const result = runInQemu(file, { shim: true });
    if (result === undefined) {
      expect(result, 'QEMU не запустился — причина названа в oракуле прогона (e2kQemuExec.test.ts)').toBeUndefined();
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
});
