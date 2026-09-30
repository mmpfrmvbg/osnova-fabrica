/**
 * ПАМЯТЬ ОТ СИСТЕМЫ: `mmap` И `brk` НА ЦЕЛИ — СКЕЛЕТ КОЛЛЕКЦИЙ.
 *
 * # Номера и их источник
 *
 * | вызов | номер e2k | сверено с деревом ядра (`.tmp/e2k-sources/linux-6.1.0-1.19-open`) |
 * |---|---|---|
 * | `brk` | **45** | `include/uapi/asm-generic/unistd.h`-ветка e2k: `arch/e2k/include/uapi/asm/unistd.h:69` |
 * | `mmap` | **90** | там же `:113`; обработчик — `arch/e2k/kernel/sys_e2k.c:60` (`sys_mmap`) |
 * | `mprotect` | **125** | объявлен, но скелетом не используется |
 *
 * На x86_64 те же вызовы — 12, 9 и 10. **Слоя, общего с x86_64, здесь нет и быть не должно:**
 * в `src/e2k/**` до этого модуля жили ровно два номера (`write = 4`, `exit = 1`), и каждый взят из
 * таблицы e2k. Номер, «похожий на x86_64», — это дефект, который молчит до первого вызова.
 *
 * # ЕДИНИЦЫ `offset` — БАЙТЫ, А НЕ СТРАНИЦЫ (названо явно)
 *
 * У `mmap` на e2k шестой аргумент уходит прямо в `do_mmap(addr, len, prot, flags, fd, offset)`
 * (`linux-user/syscall.c:11926`), без `<< MMAP_SHIFT`: ветка `mmap2` со сдвигом — **отдельный** вызов
 * (192), для 32-битного ABI. Поэтому здесь `offset` — **байты**, и это проверяется сторожем:
 * подстановка «номер страницы» вместо байтов дала бы адрес в 4096 раз дальше.
 *
 * # Возврат системного вызова
 *
 * Порт кладёт результат в **оконный регистр 0 вызывающего** (`linux-user/e2k/cpu_loop.c`: результат
 * пишется в `e2k_try_get_window_reg_p(env, 0)`). В точке входа это `%r8` = `%b[8]`, в выращенном
 * кадре — `%r16`. Поэтому приёмник читается **базовой** формой из `%b[2·wbs]`: после `ct` окно уже
 * вернулось, и это ровно тот регистр, куда ядро положило ответ.
 *
 * # Отказы называются ДО прогона
 *
 * Скелет отказывает там, где отказ известен статически: длина не положительна; `offset` не кратен
 * странице (ядро ответило бы `-EINVAL`); отрицательный `fd` при `MAP_ANONYMOUS`… — последнее не
 * запрет, а соглашение. Чего скелет НЕ делает: не выдумывает свой потолок размера. Слишком большой
 * запрос — это ответ **ядра** (`-ENOMEM`), и он наблюдается прогоном, а не нашей константой.
 */
import type { AsmInstruction, Operand } from './backend';
import { ARRAY_WINDOW_RSZ } from './arrayRuntime';
import { ENTRY_SYSCALL_FRAME, syscallWindowOf, type SyscallFrame } from './syscallRuntime';

const imm = (value: number): Operand => ({ kind: 'imm', value });
const reg = (index: number): Operand => ({ kind: 'reg', index });
const window_ = (index: number): Operand => ({ kind: 'reg', index, file: 'window' });
const a = (mnemonic: string, operands: readonly Operand[]): AsmInstruction => ({ mnemonic, channel: 0, operands });

/** Номера вызовов (источник — шапка модуля; на x86_64 они ДРУГИЕ). */
export const SYS_MMAP = 90;
export const SYS_BRK = 45;
export const SYS_MPROTECT = 125;
/** На x86_64: 9, 12, 10. Сравнение живёт здесь затем, чтобы «похожий номер» был виден сразу. */
export const SYS_X86_64_MMAP = 9;
export const SYS_X86_64_BRK = 12;

/** Значения `prot`/`flags` — те же числа, что у Linux: PROT_* и MAP_* не зависят от архитектуры. */
export const PROT_READ = 1;
export const PROT_WRITE = 2;
export const PROT_EXEC = 4;
export const MAP_PRIVATE = 2;
export const MAP_ANONYMOUS = 0x20;
/** «Пусть адрес выберет ядро» — нулевая подсказка. */
export const MMAP_HINT_NONE = 0;
/** «Файла нет» — для `MAP_ANONYMOUS`. */
export const MMAP_NO_FD = 0;

/** Размер страницы: подтверждён портом (`target/e2k/cpu-param.h`: `TARGET_PAGE_BITS 12`) и ядром (`page_size.h: E2K_4K_PAGE_SHIFT 12`). */
export const MEMORY_PAGE_BYTES = 0x1000;

/** Отказ памяти: причина называется с числами, а не «не получилось». */
export class MemoryRuntimeRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryRuntimeRefusal';
  }
}

/**
 * `mmap(addr, length, prot, flags, fd, offset)` — адрес результата в `%b[2·wbs]`.
 *
 * @param length РЕГИСТР с длиной: язык знает её только в рантайме
 * @param result базовый регистр-приёмник (в него едет ответ ядра)
 * @param offset БАЙТЫ (не страницы!) и кратные странице — иначе ядро ответит `-EINVAL`
 */
export function mmapInstructions(options: {
  readonly length: number;
  readonly result: number;
  readonly frame?: SyscallFrame;
  readonly hint?: number;
  readonly prot?: number;
  readonly flags?: number;
  readonly offset?: number;
}): AsmInstruction[] {
  const frame = options.frame ?? ENTRY_SYSCALL_FRAME;
  const offset = options.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new MemoryRuntimeRefusal(`mmap: offset обязан быть неотрицательным целым, получено ${String(offset)}`);
  }
  if (offset % MEMORY_PAGE_BYTES !== 0) {
    throw new MemoryRuntimeRefusal(
      `mmap: offset передаётся В БАЙТАХ и обязан быть кратен странице (${String(MEMORY_PAGE_BYTES)}), ` +
        `получено ${String(offset)} — ядро ответило бы -EINVAL`,
    );
  }
  const prot = options.prot ?? PROT_READ | PROT_WRITE;
  const flags = options.flags ?? MAP_PRIVATE | MAP_ANONYMOUS;
  return [
    ...(frame.setbn ? [a('setbn', [imm(ARRAY_WINDOW_RSZ), imm(0), imm(0)])] : []),
    a('movts', [imm(SYS_MMAP), window_(syscallWindowOf(frame, 0))]),
    a('movts', [imm(options.hint ?? MMAP_HINT_NONE), window_(syscallWindowOf(frame, 1))]),
    // Длина приходит РЕГИСТРОМ: значение языка известно только в рантайме.
    a('adds', [reg(options.length), reg(0), window_(syscallWindowOf(frame, 2))]),
    a('movts', [imm(prot), window_(syscallWindowOf(frame, 3))]),
    a('movts', [imm(flags), window_(syscallWindowOf(frame, 4))]),
    a('movts', [imm(MMAP_NO_FD), window_(syscallWindowOf(frame, 5))]),
    a('movts', [imm(offset), window_(syscallWindowOf(frame, 6))]),
    a('sdisp', [imm(1), imm(0)]),
    a('call', [imm(1), imm(frame.wbs)]),
    // Ответ — в оконном регистре 0 ВЫЗЫВАЮЩЕГО (`%b[2·wbs]`); читаем базовой формой: после `ct` окно вернулось.
    a('movts', [reg(frame.base), reg(options.result)]),
  ];
}

/** `brk(addr)` — новое значение границы кучи; `brk(0)` возвращает текущее. */
export function brkInstructions(options: {
  readonly address: number;
  readonly result: number;
  readonly frame?: SyscallFrame;
}): AsmInstruction[] {
  const frame = options.frame ?? ENTRY_SYSCALL_FRAME;
  return [
    ...(frame.setbn ? [a('setbn', [imm(ARRAY_WINDOW_RSZ), imm(0), imm(0)])] : []),
    a('movts', [imm(SYS_BRK), window_(syscallWindowOf(frame, 0))]),
    a('adds', [reg(options.address), reg(0), window_(syscallWindowOf(frame, 1))]),
    a('sdisp', [imm(1), imm(0)]),
    a('call', [imm(1), imm(frame.wbs)]),
    a('movts', [reg(frame.base), reg(options.result)]),
  ];
}

/**
 * СТОРОЖ ЕДИНИЦ: `offset` уехал БАЙТАМИ, а не номером страницы.
 *
 * Проверяется то, на чём легко ошибиться молча: 4096 байт — это `4096` в команде, а не `1`. Иначе
 * отображение встало бы в 4096 раз дальше, и заметил бы это только прогон (если бы заметил).
 */
export function mmapOffsetOperand(instructions: readonly AsmInstruction[], frame = ENTRY_SYSCALL_FRAME): number | undefined {
  const slot = syscallWindowOf(frame, 6);
  const command = instructions.find(
    (instruction) => instruction.mnemonic === 'movts' && instruction.operands[1]?.kind === 'reg' && (instruction.operands[1] as { index: number; file?: string }).index === slot && (instruction.operands[1] as { file?: string }).file === 'window',
  );
  const value = command?.operands[0];
  return value !== undefined && value.kind === 'imm' ? value.value : undefined;
}

/** Отрицательный ответ ядра: `-errno` приходит как отрицательное число в 64-битном слове. */
export function isSyscallError(value: bigint): boolean {
  return value < 0n;
}
