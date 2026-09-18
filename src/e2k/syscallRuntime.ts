/**
 * РАНТАЙМ СИСТЕМНЫХ ВЫЗОВОВ e2k: `write` И `exit` — «hello» БЕЗ libc.
 *
 * # Зачем это
 *
 * Аргумент для письма в МЦСТ — не ссылка на справочник, а **работающий факт**: программа без libc,
 * которая пишет строку в stdout через syscall `write` и завершается. Всё, из чего она собирается,
 * уже извлечено и проверено по отдельности:
 *
 * | шаг | инструкция | откуда форма |
 * |---|---|---|
 * | 1 | `setbn rsz=5, rbs=0, rcur=0` | окно вращаемых регистров: `(rsz + 1) * 2` единиц (`target/e2k/reg-index.h:30-52`); `rsz=5` даёт 12 → хватает на `%r8`…`%r11` |
 * | 2 | `movts,0 <номер>, %r8` | оконный `r0` вызываемого при `wbs=4` — **номер вызова** (`qemu/target/e2k/cpu_loop.c:164-170`) |
 * | 3 | `movts,0 <fd>, %r9` | оконный `r1` — аргумент 1 (`fd`) |
 * | 4 | `movtd,0 _f64 <адрес>, %r10` | оконный `r2` — аргумент 2 (`buf`); **64-битный литерал** формы 0xdc — его и не хватало: адрес не влезает в 16/32 бита |
 * | 5 | `movts,0 <длина>, %r11` | оконный `r3` — аргумент 3 (`count`) |
 * | 6 | `sdisp %ctpr1, 0` | подготовка `%ctpr1` с тегом `CTPSL` — признак системного вызова (`translate-ctp.c:174`) |
 * | 7 | `call %ctpr1, wbs=4` | передача управления; с тегом `CTPSL` порт уходит в `do_syscall` |
 *
 * В таблице записано то, что пишем **мы**. Дизассемблер МЦСТ печатает приёмник 64-битного
 * литерала иначе — `%dr10` (`reg_prefix = {"", "d", "q", "qp"}` — `opcodes/e2k-dis.c:407`, печать
 * `"%%%sr%d"` — `:575`). Это обозначение чужого инструмента, и оно **измерено**: значение
 * литерала и приёмник сверяются отдельно (`disasmFacts`, `src/scripts/e2kExternalObjdump.ts`).
 *
 * # Почему именно `sdisp %ctpr1, 0`, а не 3
 *
 * Ноль — **измеренное** значение: именно с ним `exit(42)` доведён до конца (`src/e2k/elfMinimal.ts`,
 * `docs/e2k-minimal-elf.md` §7). В постановке называлось `3`; беру измеренное и говорю об этом
 * прямо, а не подгоняю одно под другое.
 *
 * # Чего этот модуль НЕ делает
 *
 * Не переносит окно регистров после вызова: второй syscall (`exit`) готовится в тех же оконных
 * номерах, и если порт не восстановил окно после `write`, завершение уйдёт не туда. Это названная
 * граница, а не скрытая: проверяется прогоном (`src/e2k/e2kSyscallRuntime.test.ts`), и вывод
 * «hello» от неё не зависит — он происходит до второго вызова.
 */

import { getEncoder, type AsmInstruction, type Operand } from './backend';
import { MINIMAL_BASE, SYSCALL_WBS, SYSCALL_SETBN_RSZ } from './elfMinimal';

const imm = (value: number): Operand => ({ kind: 'imm', value });
const wreg = (index: number): Operand => ({ kind: 'reg', index, file: 'window' });
const f64 = (value: bigint): Operand => ({ kind: 'imm64', value }) as unknown as Operand;

/** Номера системных вызовов ABI (`qemu/target/e2k/linux-user/e2k/syscall_nr.h`, `docs/e2k-syscalls-minimal.md`). */
export const SYS_WRITE = 4;
export const SYS_EXIT = 1;

/** Дескриптор stdout. */
export const STDOUT_FD = 1;

/**
 * `rsz` для `setbn`: нужно покрыть `%r8`…`%r11`, то есть 12 регистровых единиц, то есть `rsz = 5`.
 *
 * `rsz = 4` (значение, проверенное на `exit(42)`) даёт `(4 + 1) * 2 = 10` единиц — `%r0`…`%r9`,
 * чего для `buf` и `count` **не хватает**. Это вычисление по `reg-index.h:30-52`, а не замер:
 * замерено только `rsz = 4`.
 */
export const HELLO_SETBN_RSZ = 5;

/** Оконные регистры вызова при `wbs = 4`: `%r8` → `r0` вызываемого, и далее по порядку. */
export const WINDOW_NUMBER_REGISTER = 2 * SYSCALL_WBS;
export const WINDOW_FD_REGISTER = WINDOW_NUMBER_REGISTER + 1;
export const WINDOW_BUFFER_REGISTER = WINDOW_NUMBER_REGISTER + 2;
export const WINDOW_COUNT_REGISTER = WINDOW_NUMBER_REGISTER + 3;

/** Программа: инструкции, байты и текст, который обязан напечатать дизассемблер. */
export interface SyscallProgram {
  readonly instructions: readonly AsmInstruction[];
  readonly code: Uint8Array;
  /** Адрес байтов строки в гостевой памяти. */
  readonly textAddress: number;
  readonly expectDisasm: readonly string[];
  /** Что требуется от окружения, чтобы прогон состоялся. */
  readonly blockers: readonly string[];
}

function pack(instructions: readonly AsmInstruction[]): Uint8Array {
  const encoder = getEncoder('e2k');
  const chunks = instructions.map((instruction) => encoder.encode(instruction));
  const code = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    code.set(chunk, offset);
    offset += chunk.length;
  }
  return code;
}

/**
 * Собрать `_start`, который пишет `text` в stdout и завершается кодом `exitCode`.
 *
 * Строка лежит **в том же загружаемом сегменте**, сразу за кодом: адрес — `MINIMAL_BASE + длина
 * кода`, и он загружается формой 0xdc (16 байт), потому что 32 бита для адреса не годятся.
 */
export function buildHelloProgram(text = 'hello', exitCode = 0): SyscallProgram {
  // Первый проход: длины известны заранее (16 байт у movtd и call, 8 у остальных), но адрес
  // строки зависит от полной длины кода — поэтому собираем дважды: сначала с нулевым адресом,
  // затем с настоящим.
  const build = (textAddress: number): AsmInstruction[] => [
    { mnemonic: 'setbn', channel: 0, operands: [imm(HELLO_SETBN_RSZ), imm(0), imm(0)] },
    // write(fd, buf, count)
    { mnemonic: 'movts', channel: 0, operands: [imm(SYS_WRITE), wreg(WINDOW_NUMBER_REGISTER)] },
    { mnemonic: 'movts', channel: 0, operands: [imm(STDOUT_FD), wreg(WINDOW_FD_REGISTER)] },
    { mnemonic: 'movtd', channel: 0, operands: [f64(BigInt(textAddress)), wreg(WINDOW_BUFFER_REGISTER)] },
    { mnemonic: 'movts', channel: 0, operands: [imm(text.length), wreg(WINDOW_COUNT_REGISTER)] },
    { mnemonic: 'sdisp', channel: 0, operands: [imm(1), imm(0)] },
    { mnemonic: 'call', channel: 0, operands: [imm(1), imm(SYSCALL_WBS)] },
    // exit(exitCode)
    { mnemonic: 'movts', channel: 0, operands: [imm(SYS_EXIT), wreg(WINDOW_NUMBER_REGISTER)] },
    { mnemonic: 'movts', channel: 0, operands: [imm(exitCode), wreg(WINDOW_FD_REGISTER)] },
    { mnemonic: 'sdisp', channel: 0, operands: [imm(1), imm(0)] },
    { mnemonic: 'call', channel: 0, operands: [imm(1), imm(SYSCALL_WBS)] },
  ];

  const instructions = build(0);
  const code = pack(instructions);
  const textAddress = MINIMAL_BASE + code.length;
  const finalInstructions = build(textAddress);
  const finalCode = new Uint8Array(code.length + text.length);
  finalCode.set(pack(finalInstructions), 0);
  finalCode.set(Buffer.from(text, 'latin1'), code.length);

  return {
    instructions: finalInstructions,
    code: finalCode,
    textAddress,
    expectDisasm: [
      'setbn rbs = 0x0, rsz = 0x5, rcur = 0x0',
      `movts,0 _f16s 0x${SYS_WRITE.toString(16)}, %r${WINDOW_NUMBER_REGISTER}`,
      `movts,0 _f16s 0x${STDOUT_FD.toString(16)}, %r${WINDOW_FD_REGISTER}`,
      // Приёмник 64-битного литерала дизассемблер печатает `%dr10`: `reg_prefix = {"", "d", …}`
      // (`opcodes/e2k-dis.c:407`), печать `"%%%sr%d"` (`:575`). Здесь стояло `%r10` — вывод из
      // наших обозначений, а не замер; исправлено по замеру (`.tmp/hello-dis.ts`).
      `movtd,0 _f64 0x${textAddress.toString(16)}, %dr${WINDOW_BUFFER_REGISTER}`,
      `movts,0 _f16s 0x${text.length.toString(16)}, %r${WINDOW_COUNT_REGISTER}`,
      'sdisp %ctpr1',
      'call %ctpr1, wbs = 0x4',
      `movts,0 _f16s 0x${SYS_EXIT.toString(16)}, %r${WINDOW_NUMBER_REGISTER}`,
      `movts,0 _f16s 0x${exitCode.toString(16)}, %r${WINDOW_FD_REGISTER}`,
      'sdisp %ctpr1',
      'call %ctpr1, wbs = 0x4',
    ],
    blockers: [
      'окружение: на WSL1 нужен шим для mmap — без него QEMU не размещает гостя ' +
        '(docs/e2k-qemu-run.md §2.5, §2.8); преграда ХОСТА, а не программы',
      'окружение: порт QEMU читает поля WD, которые сам не строит, — без правки системный вызов ' +
        'умирает на чтении номера («syscall without proper WD configuration», cpu_loop.c:164-169); ' +
        'замер и текст правки — docs/e2k-qemu-run.md §2.9',
      'окно регистров после первого вызова: если порт его не восстановил, второй вызов (exit) уйдёт ' +
        'не туда; вывод «hello» от этого не зависит — он происходит раньше',
    ],
  };
}

/** Байты строки из кода программы — для сверки того, что попало в образ. */
export function textBytes(program: SyscallProgram): string {
  return Buffer.from(program.code.subarray(program.code.length - 5)).toString('latin1');
}

/** Значение `SYSCALL_SETBN_RSZ`, с которым программа минимального ELF была измерена. */
export const MEASURED_SETBN_RSZ = SYSCALL_SETBN_RSZ;
