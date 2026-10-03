/**
 * ФАЙЛОВЫЕ СИСТЕМНЫЕ ВЫЗОВЫ НА ЦЕЛИ e2k: `open`, `read`, `write`, `close`.
 *
 * # Зачем это здесь, а не в `src/e2k/**`
 *
 * Плоскость этой сессии — `src/self-host/**`: фундамент self-host компилятора. Вопрос, на который
 * отвечает модуль, звучит так: **может ли компилятор, живущий на цели, прочитать исходник и
 * записать результат**. Носители вызовов (`write`, `exit`) уже описаны в e2k-плоскости
 * (`src/e2k/syscallRuntime.ts`), и здесь они НЕ переписываются: берётся кадр вызова
 * ({@link SyscallFrame}), правило «ответ — в оконном регистре 0» и форма `sdisp` + `call wbs`.
 * Новое здесь — три номера (`open`, `read`, `close`), которых в дереве не было ни в каком виде.
 *
 * # Номера и их источник
 *
 * | вызов | номер | источник номера | источник аргументов |
 * |---|---|---|---|
 * | `read` | 3 | `linux-user/e2k/syscall_nr.h:11` | `linux-user/syscall.c:10567-10580` |
 * | `write` | 4 | `linux-user/e2k/syscall_nr.h:12` | `linux-user/syscall.c:10581-10599` |
 * | `open` | 5 | `linux-user/e2k/syscall_nr.h:13` | `linux-user/syscall.c:10602-10610` |
 * | `close` | 6 | `linux-user/e2k/syscall_nr.h:14` | `linux-user/syscall.c:10664-10666` |
 *
 * Таблица целиком — `docs/e2k-syscalls-minimal.md` (там же статусы: `read`, `open`, `close` помечены
 * **«НЕ ПРОВЕРЕНО ИСПОЛНЕНИЕМ»**, и это ровно то, что здесь проверяется замером).
 *
 * # Три состояния ответа, а не два
 *
 * Ответ ядра приходит **64-битным словом** в оконный регистр 0. Успех и отказ различаются знаком
 * (`-errno`), и это НЕ то же самое, что «код возврата процесса»: там виден только младший байт
 * (`AGENTS.md`, §3.31). Поэтому ответ читается В РЕГИСТР, а наружу отдаётся разбор:
 * {@link FileCallOutcome} — `ok` с числом либо `error` с `-errno`. Свести их к одному числу значило
 * бы потерять различие между «прочитано 0 байт» и «файла нет».
 */
import type { AsmInstruction, Operand } from '../e2k/backend';
import { ARRAY_WINDOW_RSZ } from '../e2k/arrayRuntime';
import { ENTRY_SYSCALL_FRAME, syscallWindowOf, type SyscallFrame } from '../e2k/syscallRuntime';

const imm = (value: number): Operand => ({ kind: 'imm', value });
const reg = (index: number): Operand => ({ kind: 'reg', index });
const literal = (value: number): Operand => ({ kind: 'imm64', value: BigInt(value) } as unknown as Operand);
const window_ = (index: number): Operand => ({ kind: 'reg', index, file: 'window' });
const a = (mnemonic: string, operands: readonly Operand[], channel = 0): AsmInstruction => ({
  mnemonic,
  channel,
  operands,
});

/** Номера файловых вызовов e2k. На x86_64 другие: `read` 0, `write` 1, `open` 2, `close` 3. */
export const SYS_READ = 3;
export const SYS_WRITE_FILE = 4;
export const SYS_OPEN = 5;
export const SYS_CLOSE = 6;
export const SYS_X86_64_OPEN = 2;

/**
 * Флаги `open`. Значения — общие (`linux-user/generic/fcntl.h`), но **числовых значений `O_*` для
 * e2k в источнике порта нет** (`docs/e2k-syscalls-minimal.md`, строка `open`): порт включает общий
 * заголовок, значит числа те же, что у Linux. Здесь они названы явно, чтобы «то же, что у Linux»
 * было видно, а не подразумевалось.
 */
export const O_RDONLY = 0;
export const O_WRONLY = 1;
export const O_CREAT = 0o100;
export const O_TRUNC = 0o1000;

/** Отказ рантайма файлов: причина называется до прогона, а не выясняется прогоном. */
export class FileRuntimeRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileRuntimeRefusal';
  }
}

/**
 * `open(путь, флаги, режим)` — дескриптор в `result`.
 *
 * @param pathAddress АДРЕС байтов пути в гостевой памяти (строка на цели — адрес её байтов)
 * @param result базовый регистр-приёмник
 */
export function openInstructions(options: {
  readonly pathAddress: number;
  readonly result: number;
  readonly flags?: number;
  readonly mode?: number;
  readonly frame?: SyscallFrame;
}): AsmInstruction[] {
  const frame = options.frame ?? ENTRY_SYSCALL_FRAME;
  return [
    ...(frame.setbn ? [a('setbn', [imm(ARRAY_WINDOW_RSZ), imm(0), imm(0)])] : []),
    a('movts', [imm(SYS_OPEN), window_(syscallWindowOf(frame, 0))]),
    // Путь — 64-битный адрес: форма 0xdc (как у строки «hello»), 32 бита для адреса не годятся.
    a('movtd', [literal(options.pathAddress), window_(syscallWindowOf(frame, 1))]),
    a('movts', [imm(options.flags ?? O_RDONLY), window_(syscallWindowOf(frame, 2))]),
    a('movts', [imm(options.mode ?? 0), window_(syscallWindowOf(frame, 3))]),
    a('sdisp', [imm(1), imm(0)]),
    a('call', [imm(1), imm(frame.wbs)]),
    a('movts', [reg(frame.base), reg(options.result)]),
  ];
}

/**
 * `read(fd, buf, count)` — сколько прочитано (0 на конце файла, `-errno` при отказе).
 *
 * # БУФЕР ОБЯЗАН ЛЕЖАТЬ В СЕГМЕНТЕ ДАННЫХ — измерено, не выведено
 *
 * Замер 2026-10-04 (`.tmp/osnova-read-which.ts`, журнал модели `-d strace`): буфер в сегменте КОДА
 * (`R|X`, статика сразу за командами) даёт `read(3,0x100149,4) = -1 errno=14 (Bad address)` —
 * **EFAULT**, и это НЕ дефект `read`: тот же адрес читается `write` и отдаёт наши байты. Сегмент
 * данных (`0x110000`, `R|W` — `src/e2k/elfMinimal.ts#DATA_SEGMENT_BASE`) принимает запись:
 * `read` вернул **4**, а `write` из того же адреса отдал `OK!\n`. Контроль без `read` в том же
 * адресе даёт нули — то есть байты принесла именно `read`.
 *
 * Отсюда правило для того, кто будет читать файл с цели: **буфер чтения берётся у данных**
 * (куча/арена/область записи), а не «рядом с кодом».
 *
 * @param bufferAddress АДРЕС буфера В СЕГМЕНТЕ ДАННЫХ (см. выше). Пока он известен на сборке,
 *   передаётся 64-битным литералом; когда адрес будет знать только рантайм, здесь встанет приём из
 *   `mmapInstructions`: `adds рег, ноль, оконный` — форма вызова не изменится.
 */
export function readInstructions(options: {
  readonly fd: number;
  readonly bufferAddress: number;
  readonly count: number;
  readonly result: number;
  readonly frame?: SyscallFrame;
}): AsmInstruction[] {
  const frame = options.frame ?? ENTRY_SYSCALL_FRAME;
  return [
    ...(frame.setbn ? [a('setbn', [imm(ARRAY_WINDOW_RSZ), imm(0), imm(0)])] : []),
    a('movts', [imm(SYS_READ), window_(syscallWindowOf(frame, 0))]),
    // Дескриптор — РЕГИСТР: он приходит из `open` и на сборке неизвестен.
    a('adds', [reg(options.fd), reg(0), window_(syscallWindowOf(frame, 1))]),
    a('movtd', [literal(options.bufferAddress), window_(syscallWindowOf(frame, 2))]),
    a('movts', [imm(options.count), window_(syscallWindowOf(frame, 3))]),
    a('sdisp', [imm(1), imm(0)]),
    a('call', [imm(1), imm(frame.wbs)]),
    a('movts', [reg(frame.base), reg(options.result)]),
  ];
}

/** `close(fd)` — 0 при успехе, `-errno` при отказе. */
export function closeInstructions(options: {
  readonly fd: number;
  readonly result: number;
  readonly frame?: SyscallFrame;
}): AsmInstruction[] {
  const frame = options.frame ?? ENTRY_SYSCALL_FRAME;
  return [
    ...(frame.setbn ? [a('setbn', [imm(ARRAY_WINDOW_RSZ), imm(0), imm(0)])] : []),
    a('movts', [imm(SYS_CLOSE), window_(syscallWindowOf(frame, 0))]),
    a('adds', [reg(options.fd), reg(0), window_(syscallWindowOf(frame, 1))]),
    a('sdisp', [imm(1), imm(0)]),
    a('call', [imm(1), imm(frame.wbs)]),
    a('movts', [reg(frame.base), reg(options.result)]),
  ];
}

/**
 * ИТОГ ФАЙЛОВОГО ВЫЗОВА — то, что видно в регистре ПОСЛЕ вызова.
 *
 * Три состояния, а не два: `0` у `read` — это конец файла, а не отказ; у `open` ноль был бы
 * законным дескриптором, и потому отказ (`-errno`) отличается ЗНАКОМ, а не нулём.
 */
export type FileCallOutcome =
  | { readonly kind: 'ok'; readonly value: number }
  | { readonly kind: 'error'; readonly errno: number };

/** Разбор ответа ядра. Знак — единственный признак отказа в этом ABI. */
export function outcomeOf(value: number): FileCallOutcome {
  if (value < 0) return { kind: 'error', errno: -value };
  return { kind: 'ok', value };
}

/**
 * СТОРОЖ ФОРМЫ: у каждого файлового вызова номер лежит в оконном регистре 0 кадра, а `sdisp`+`call`
 * стоят в конце. Проверяется форма, а не замысел: без `sdisp` тег `CTPSL` не выставлен, и порт
 * ушёл бы в обычный вызов процедуры, а не в ядро.
 */
export function fileCallProblems(instructions: readonly AsmInstruction[], frame = ENTRY_SYSCALL_FRAME): string[] {
  const problems: string[] = [];
  const numberSlot = syscallWindowOf(frame, 0);
  const hasNumber = instructions.some(
    (instruction) =>
      instruction.mnemonic === 'movts' &&
      instruction.operands[1]?.kind === 'reg' &&
      (instruction.operands[1] as { index: number; file?: string }).index === numberSlot &&
      (instruction.operands[1] as { file?: string }).file === 'window',
  );
  if (!hasNumber) problems.push(`номер вызова не полон: нет movts в оконный %r${String(numberSlot)}`);
  const sdisp = instructions.findIndex((instruction) => instruction.mnemonic === 'sdisp');
  const call = instructions.findIndex((instruction) => instruction.mnemonic === 'call');
  if (sdisp < 0) problems.push('нет sdisp: без тега CTPSL call уйдёт в процедуру, а не в ядро');
  else if (call < 0) problems.push('нет call: системный вызов не запускается');
  else if (call < sdisp) problems.push(`call стоит ДО sdisp (#${String(call)} < #${String(sdisp)}) — тег не выставлен`);
  return problems;
}
