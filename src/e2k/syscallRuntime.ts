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
 * # Почему у `sdisp` иммедиат 3 (`SYSCALL_TRAP`), а не 0
 *
 * Так в байтах, и это ИЗМЕРЕНО у внешнего дизассемблера 2026-10-09 (`.tmp/probe-sdisp.ts`): он
 * печатает `sdisp %ctpr1, 0x3`, а следом `ipd 3 call %ctpr1, wbs = 0x4`. Прежняя редакция этой
 * шапки утверждала, что измеренное значение — **ноль**; ноль был из первой редакции «hello»
 * (`docs/e2k-minimal-elf.md` §7) и с тех пор разошёлся с кодом: закреп `[0, 0]` в
 * `src/e2k/e2kSyscallRuntime.test.ts` стоял красным на HEAD и найден замером 2026-10-09.
 * Ловушку порт берёт по тегу `CTPSL` (`translate-ctp.c:174`), а иммедиат — часть формы команды.
 *
 * # Чего этот модуль НЕ делает
 *
 * Не переносит окно регистров после вызова: второй syscall (`exit`) готовится в тех же оконных
 * номерах, и если порт не восстановил окно после `write`, завершение уйдёт не туда. Это названная
 * граница, а не скрытая: проверяется прогоном (`src/e2k/e2kSyscallRuntime.test.ts`), и вывод
 * «hello» от неё не зависит — он происходит до второго вызова.
 */

import { getEncoder, type AsmInstruction, type Operand } from './backend';
import { MINIMAL_BASE, SYSCALL_TRAP, SYSCALL_WBS, SYSCALL_SETBN_RSZ } from './elfMinimal';
// Номер ловушки переэкспортируется: сайты вызова живут в модулях, знающих только этот модуль.
export { SYSCALL_TRAP };

const imm = (value: number): Operand => ({ kind: 'imm', value });
const wreg = (index: number): Operand => ({ kind: 'reg', index, file: 'window' });
const f64 = (value: bigint): Operand => ({ kind: 'imm64', value }) as unknown as Operand;

/** Номера системных вызовов ABI (`qemu/target/e2k/linux-user/e2k/syscall_nr.h`, `docs/e2k-syscalls-minimal.md`). */
export const SYS_WRITE = 4;
export const SYS_EXIT = 1;

/** Дескриптор stdout. */
export const STDOUT_FD = 1;

/**
 * Дескриптор stderr — для ОТКАЗОВ, которые обязаны быть видны человеку (исчерпание арены,
 * `docs/hardware-debt.md` §3.87). До этой правки его в дереве не было: печатать отказы было нечем,
 * и владелец назвал это «молчанием с числом».
 */
export const STDERR_FD = 2;

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

/**
 * ГЕОМЕТРИЯ СИСТЕМНОГО ВЫЗОВА: ОН ИДЁТ ПО ПРАВИЛАМ ПРОЦЕДУРНОГО ПЕРЕХОДА, А ЗНАЧИТ — ОТНОСИТЕЛЬНО ОКНА.
 *
 * Измерено и подтверждено источником:
 *
 * | свидетель | что говорит |
 * |---|---|
 * | порт, `linux-user/e2k/cpu_loop.c:161-176` | номер вызова читается `e2k_try_get_window_reg_p(env, 0)`, аргументы — `window_reg(1..8)`; это **оконные** индексы: `e2k_calc_reg_idx_window` даёт `idx = wd_base_d + i` (`target/e2k/reg-index.h:55-81`) |
 * | замер `.tmp/osnova-syscall-slot.ts` | в точке входа номер обязан лежать в оконном `%r8` — потому что `call wbs = 4` сдвигает окно на `2·4` и оконный `r0` ядра — это `%r8` вызывающего |
 * | замер `.tmp/osnova-syscall-matrix.ts` | из процедуры с выросшим окном работает **только** `wbs = 8` и номер в оконном **`%r16`**; `%r8`, `%r0`, `%r12` — утверждение порта `op_descr->is_al` либо пустой кадр ядра. Повторная `setbn` (и `15`, и `7`) исход не меняет — код 77 |
 *
 * То есть syscall — это **вызов в ядро**: номер и аргументы обязаны попасть туда, где «вызываемый»
 * (ядро) увидит их в СВОИХ оконных регистрах, а это `%r(2·wbs)`, `%r(2·wbs+1)`, … вызывающего.
 * Поэтому окно у процедуры, которая печатает, обязано быть выращено (`setwd wsz=16` + `setbn rsz=15`,
 * `IR.window_grow`), а `setbn` внутри системного вызова в таком кадре **не ставится** — окно уже
 * поставлено прологом (`setwd` + повторная `setbn` → ловушка `0x100008`, §3.56.2).
 */
export interface SyscallFrame {
  /** Ширина окна вызова в квадрословах: 4 в точке входа, 16 в выращенном кадре процедуры. */
  readonly wbs: number;
  /** Оконный индекс номера вызова: `2·wbs`. */
  readonly base: number;
  /** Ставить ли `setbn` перед вызовом: в выращенном кадре окно уже стоит прологом. */
  readonly setbn: boolean;
  /**
   * Размер ОКНА, в котором стоит сайт (не кадра вызова): 16 у точки входа, 32 у выращенной
   * процедуры. Из него берётся закрытие пути ① (`syscallCallClose`) — вернуть окно прежним.
   */
  readonly wsz: number;
}

/**
 * Окно точки входа: пролог образа ставит `setwd wsz = 0x10` (`src/e2k/arrayRuntime.ts`,
 * `ARRAY_WINDOW_WSZ`). ПЕРЕМЕР 2026-11-04 (ATOM-05-02-01): было 12, стало 16 — окно поднято по
 * ИЗМЕРЕННОМУ закону окна вызываемой (§3.166: клетки даёт `wsz`, а не `rsz`), и это же число
 * восстанавливает `syscallCallClose` после местного сужения. Ширина 12 была измерена у bash/lcc/as/ld
 * (§3.116), но 16 её не нарушает: это шире, а не уже.
 */
export const SYSCALL_ENTRY_WSZ = 16;

/**
 * Окно выращенной процедуры: `IR.window_grow` ставит `setwd wsz = 0x20`
 * (`src/e2k/procedureCall.ts`, `WINDOW_GROW_WSZ`). Число продублировано намеренно — импорт дал бы
 * цикл (`procedureCall` → `syscallRuntime`), а равенство стережёт оракул
 * `src/e2k/syscallLocalWindow.test.ts`.
 */
export const SYSCALL_GROWN_WSZ = 32;

/** Кадр точки входа: `wbs = 4`, окно ставится своим `setbn` (как `buildHelloProgram`). */
export const ENTRY_SYSCALL_FRAME: SyscallFrame = {
  wbs: SYSCALL_WBS,
  base: 2 * SYSCALL_WBS,
  setbn: true,
  wsz: SYSCALL_ENTRY_WSZ,
};

/**
 * Кадр процедуры с выращенным окном: `wbs = 16`, номер и аргументы — с оконного `%r32`.
 *
 * `setbn` здесь ВСЁ РАВНО ставится (и это измерено): повторная `setbn` после `setwd` в этой форме
 * не ловушка — матрица `.tmp/osnova-syscall-matrix.ts` даёт код 77 и с `setbn 15`, и с `setbn 7`.
 * Так форма раскладки и понижение считают ОДНИ команды: разошлись бы — уехали адреса (§3.58).
 */
export const GROWN_SYSCALL_FRAME: SyscallFrame = {
  wbs: 16,
  base: 32,
  setbn: true,
  wsz: SYSCALL_GROWN_WSZ,
};

/**
 * ПУТЬ ①, ОТКРЫТИЕ: `setwd wsz = wbs + 4` — ПЕРЕД `sdisp`.
 *
 * Закон железа `wsz − wbs = 4` (§3.116.4, §3.118.1: `zc-a-w8` → 42, `zc-a-w9` → 137) требует,
 * чтобы у системного вызова окно было ровно на четыре квадрослова шире кадра. Наш сайт вызова
 * исторически стоял при `wsz = 12` и `wbs = 4`, то есть закон не соблюдался и машина отвечала 137.
 * (С 2026-11-04 пролог ставит `wsz = 16`, поэтому закрытие возвращает 16, а не 12 — закон тот же,
 * изменилось только восстанавливаемое значение.)
 *
 * Годность узкого окна: `rbs + rsz + 1 ≤ wsz` (§3.118.1). У сайта в выращенном кадре область
 * вращения к этому месту уже `rsz = 7` — её ставит `setbn` носителя, — поэтому `8 ≤ 20` и местное
 * окно годно; `wsz ≥ 32` не требуется (замер `.tmp/zc-splice-write.ts` → 42).
 */
export function syscallCallOpen(frame: SyscallFrame): AsmInstruction[] {
  return [{ mnemonic: 'setwd', channel: 0, operands: [imm(frame.wbs + 4), imm(0)] }];
}

/**
 * ПУТЬ ①, ЗАКРЫТИЕ: `setwd wsz = frame.wsz` — ЗА `call`.
 *
 * `call` — ШЕСТНАДЦАТЬ байт (два слога), поэтому закрытие ставится со сдвигом +16 от начала
 * вызова. Вставка внутрь вызова — разбор мусора: модель печатает в журнале трансляции
 * `CT %ctpr1  IPD 3  SETWD wsz = 0x0` там, где эмиссия ставит `CALL %ctpr1, wbs = 0x10`
 * (§3.119.3, замер `.tmp/zc-splice-write.ts`).
 */
export function syscallCallClose(frame: SyscallFrame): AsmInstruction[] {
  if (frame.wsz === frame.wbs + 4) return [];
  return [{ mnemonic: 'setwd', channel: 0, operands: [imm(frame.wsz), imm(0)] }];
}

/**
 * ФОРМА ЧТЕНИЯ ОТВЕТА ЯДРА: базовая в точке входа, оконная в выращенном кадре.
 *
 * Базовая форма `%b[N]` адресует регистры 0…31 (`E2K_RF_GLOB_IDX_MAX`, `qemu/target/e2k/cpu.h:90`),
 * а в выращенном кадре номер вызова и ответ лежат в `%r32` — базовой формой это не адресуется
 * ВООБЩЕ, и кодировщик отказывает (`%b[32] в модели не существует`), а не портит байты.
 *
 * * кадр точки входа (`base = 8`) — **базовая** форма: она ИЗМЕРЕНА, на ней стоит рантайм массивов и
 *   коллекций; менять её на оконную без замера нельзя;
 * * выращенный кадр (`base = 32`) — **оконная**, ровно та, которой номер туда и кладётся
 *   (`syscallWindowOf`). Эту ветвь корпус сегодня НЕ проходит (у семейства памяти/коллекций кадр
 *   всегда `ENTRY`: `collectionsRuntime.collectionAllocInstructions` зовётся без кадра) — она
 *   названа непромеренной и не выдаётся за проверенную.
 */
export function syscallReplyRegister(frame: SyscallFrame): Operand {
  return frame.base < 32 ? { kind: 'reg', index: frame.base } : { kind: 'reg', index: frame.base, file: 'window' };
}


/** Оконный индекс `k`-го аргумента вызова в данном кадре. */
export function syscallWindowOf(frame: SyscallFrame, k: number): number {
  return frame.base + k;
}

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
    // ПУТЬ ①: местное окно `wsz = wbs + 4 = 8` перед вызовом и возврат окна точки входа за `call`.
    ...syscallCallOpen(ENTRY_SYSCALL_FRAME),
    { mnemonic: 'sdisp', channel: 0, operands: [imm(1), imm(SYSCALL_TRAP)] },
    { mnemonic: 'call', channel: 0, operands: [imm(1), imm(SYSCALL_WBS)] },
    ...syscallCallClose(ENTRY_SYSCALL_FRAME),
    // exit(exitCode)
    { mnemonic: 'movts', channel: 0, operands: [imm(SYS_EXIT), wreg(WINDOW_NUMBER_REGISTER)] },
    { mnemonic: 'movts', channel: 0, operands: [imm(exitCode), wreg(WINDOW_FD_REGISTER)] },
    ...syscallCallOpen(ENTRY_SYSCALL_FRAME),
    { mnemonic: 'sdisp', channel: 0, operands: [imm(1), imm(SYSCALL_TRAP)] },
    { mnemonic: 'call', channel: 0, operands: [imm(1), imm(SYSCALL_WBS)] },
    ...syscallCallClose(ENTRY_SYSCALL_FRAME),
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
      // Значения 0…15 кодировщик кладёт короткой непосредственной формой (`0xc0 | N`), и внешний
      // дизассемблер печатает её **без** `_f16s`: `_f16s` — признак литерального поля LTS
      // (`src/e2k/e2k-real.ts`, `isShortImmediate`/`encodeShortImm`; замер `.tmp/measure-hello.ts`).
      `movts,0 0x${SYS_WRITE.toString(16)}, %r${WINDOW_NUMBER_REGISTER}`,
      `movts,0 0x${STDOUT_FD.toString(16)}, %r${WINDOW_FD_REGISTER}`,
      // Приёмник 64-битного литерала дизассемблер печатает `%dr10`: `reg_prefix = {"", "d", …}`
      // (`opcodes/e2k-dis.c:407`), печать `"%%%sr%d"` (`:575`). Здесь стояло `%r10` — вывод из
      // наших обозначений, а не замер; исправлено по замеру (`.tmp/hello-dis.ts`).
      `movtd,0 _f64 0x${textAddress.toString(16)}, %dr${WINDOW_BUFFER_REGISTER}`,
      `movts,0 0x${text.length.toString(16)}, %r${WINDOW_COUNT_REGISTER}`,
      `setwd wsz = 0x8, nfx = 0x0, dbl = 0x0`,
      'sdisp %ctpr1',
      'call %ctpr1, wbs = 0x4',
      `setwd wsz = 0xc, nfx = 0x0, dbl = 0x0`,
      `movts,0 0x${SYS_EXIT.toString(16)}, %r${WINDOW_NUMBER_REGISTER}`,
      `movts,0 0x${exitCode.toString(16)}, %r${WINDOW_FD_REGISTER}`,
      `setwd wsz = 0x8, nfx = 0x0, dbl = 0x0`,
      'sdisp %ctpr1',
      'call %ctpr1, wbs = 0x4',
      `setwd wsz = 0xc, nfx = 0x0, dbl = 0x0`,
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
