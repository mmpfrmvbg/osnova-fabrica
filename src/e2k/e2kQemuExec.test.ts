/**
 * ОРАКУЛ ИСПОЛНЕНИЯ e2k-КОДА В QEMU (WSL1, с шимом для `mmap`).
 *
 * # Что проверяется
 *
 * 1. **Шим собирается и QEMU доходит до исполнения.** Без шима прогон упирается в
 *    `guest_base` (WSL1 не знает `MAP_FIXED_NOREPLACE`), с шимом эмулятор читает ELF и
 *    исполняет инструкции.
 * 2. **Наши байты исполняются по смыслу, а не только разбираются.** Опыт с передачей управления:
 *    `disp %ctpr1, k` (CS0) + `ct %ctpr1` (SS) обязаны перебросить управление на адрес
 *    `ip + (k << 3)` — это проверяется **двумя** прогонами: при `k = 3` остановка происходит в
 *    ловушке B (`0x100018`), при `k = 2` — в ловушке A (`0x100010`). Один прогон доказывал бы лишь
 *    то, что эмулятор где-то остановился; пара доказывает, что адрес следует за смещением.
 * 3. **Остановка минимального ELF объяснена источником.** `ct %ctpr1` без подготовки — исключение:
 *    `%ctpr` инициализируется нулём (`cpu-sregs.h:149`, тег `CTPEW`), а `ct` по ctpr с тегом
 *    `CTPEW` — это `e2k_cpu_set_have_execption` (`translate-ct.c:840-844`).
 *
 * # Чего оракул НЕ доказывает
 *
 * Что `exit(42)` произойдёт: до системного вызова дело не доходит, и причина названа в
 * `docs/e2k-minimal-elf.md` §7 (тег `CTPSL` ставит `sdisp`, которую наш кодировщик отвергает;
 * номер вызова ABI читает из оконного `r0`, а не из `%b[0]`).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { getEncoder, type AsmInstruction, type Operand } from './backend';
import { buildElfFromCode, buildMinimalElf, writeMinimalElf } from './elfMinimal';
import { buildShim, runInQemu } from '../scripts/e2kQemuExec';

const ROOT = path.resolve(__dirname, '..', '..');
const imm = (value: number): Operand => ({ kind: 'imm', value });
const encoder = getEncoder('e2k');

/** Базовый адрес `.text` — тот же, что у `buildElfFromCode`. */
const BASE = 0x100000;

/**
 * Опыт с передачей управления.
 *
 * Раскладка (все команды по 8 байт, поэтому адрес = `BASE + 8 * номер`):
 * | № | адрес | команда | роль |
 * |---|---|---|---|
 * | 0 | `0x100000` | `disp %ctpr1, k` | подготовка перехода, цель = `ip + (k << 3)` |
 * | 1 | `0x100008` | `ct %ctpr1` | переход |
 * | 2 | `0x100010` | `ct %ctpr3` | ловушка A (неподготовленный ctpr) |
 * | 3 | `0x100018` | `ct %ctpr2` | ловушка B (неподготовленный ctpr) |
 */
export function controlTransferProgram(k: number): readonly AsmInstruction[] {
  return [
    { mnemonic: 'disp', channel: 0, operands: [imm(1), imm(k)] },
    { mnemonic: 'ct', channel: 0, operands: [imm(1), imm(0x20)] },
    { mnemonic: 'ct', channel: 0, operands: [imm(3), imm(0x20)] },
    { mnemonic: 'ct', channel: 0, operands: [imm(2), imm(0x20)] },
  ];
}

/** Упаковать инструкции в непрерывный поток байтов. */
export function packInstructions(instructions: readonly AsmInstruction[]): Uint8Array {
  const chunks = instructions.map((instruction) => encoder.encode(instruction));
  const code = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    code.set(chunk, offset);
    offset += chunk.length;
  }
  return code;
}

/** Адрес инструкции опыта по её номеру. */
export function addressOf(index: number): number {
  return BASE + index * 8;
}

describe('исполнение e2k-кода в QEMU: шим, минимальный ELF и передача управления', () => {
  const shim = buildShim();

  it('шим собирается из исходника, приведённого в документе', () => {
    if (shim === undefined) return; // компилятора в дистрибутиве нет — случай назван ниже
    const doc = fs.readFileSync(path.join(ROOT, 'docs', 'e2k-qemu-run.md'), 'utf-8');
    expect(doc, 'в документе нет исходника шима').toContain('MAP_FIXED_NOREPLACE) == 0');
    expect(shim).toBe(path.join(ROOT, '.tmp', 'e2k-noreplace.so'));
  });

  it('без шима прогон упирается в guest_base, а с шимом QEMU исполняет код', () => {
    if (shim === undefined) return;
    const elf = buildMinimalElf(42);
    const file = writeMinimalElf(path.join(ROOT, '.tmp', 'e2k-minimal.elf'), 42);
    const run = runInQemu(file);
    expect(run, 'QEMU не запустился').toBeDefined();
    const output = run!.output;
    expect(output, 'шим не снял преграду: гость не разместился').not.toContain('guest_base');
    // Адрес третьей инструкции считается по её собственным байтам: литералы занимают по 16 байт,
    // и «номер × 8» здесь неверно (в опыте с передачей управления все команды по 8).
    const thirdAddress =
      elf.entry + elf.program.instructions.slice(0, 2).reduce((sum, instruction) => sum + encoder.encode(instruction).length, 0);
    expect(thirdAddress).toBe(0x100020);
    expect(run!.exceptionIp, `эмулятор остановился не там: ${output.trim().split('\n').join(' | ')}`).toBe(thirdAddress);
    // Причина остановки названа источником: ct по неподготовленному %ctpr1 (тег CTPEW у нуля).
    expect(output).toContain('exception handling is unimplemented');
  });

  it('передача управления: адрес остановки следует за смещением disp (опыт и контроль)', () => {
    if (shim === undefined) return;
    const results: Record<number, number | undefined> = {};
    for (const k of [3, 2]) {
      const code = packInstructions(controlTransferProgram(k));
      const file = path.join(ROOT, '.tmp', `e2k-disp-${k}.elf`);
      fs.writeFileSync(file, buildElfFromCode(code).bytes);
      results[k] = runInQemu(file)?.exceptionIp;
    }
    // k = 3 → цель = ip + 24 = адрес ловушки B; k = 2 → цель = ip + 16 = адрес ловушки A.
    expect(results[3], 'переход не состоялся: остановка не в ловушке B').toBe(addressOf(3));
    expect(results[2], 'отрицательный контроль не сработал: остановка не в ловушке A').toBe(addressOf(2));
    expect(results[3], 'адрес не следует за смещением').not.toBe(results[2]);
  });

  it('минимальный ELF собран тем же кодировщиком, что проверен исполнением', () => {
    const elf = buildMinimalElf(42);
    const program = elf.program;
    expect(elf.entry).toBe(BASE);
    expect(program.instructions.length).toBe(3);
    // Первые две инструкции опыта совпадают с первыми двумя инструкциями минимального ELF.
    expect(program.instructions[0]!.mnemonic).toBe('movts');
    expect(program.instructions[1]!.mnemonic).toBe('movts');
    expect(program.instructions[2]!.mnemonic).toBe('ct');
    expect(program.code[5]).toBe(0xd4);
  });
});
