/**
 * ФАЙЛОВЫЙ ВЫЗОВ НА ЦЕЛИ: `система.файлы.читать(путь, буфер)` — чтение файла в СПИСОК.
 *
 * # Почему новая последовательность, а не `openInstructions` + `readInstructions` + `closeInstructions`
 *
 * Эти три построителя (`src/self-host/fileRuntime.ts`) отдают ответ ядра в **базовую** клетку
 * (`movts %b[frame.base], %b[result]`), а конвейер вызывает понижение ПОСЛЕ раскладки регистров:
 * свободных базовых клеток, за которые можно поручиться, у носителя нет — их бюджет занят
 * значениями программы и рантаймом (`RESERVED_FROM = 10`). Поэтому весь вызов собран **оконными**
 * регистрами кадра (`%r8..%r11`) и не занимает ни одной базовой клетки:
 *
 * | шаг | команды | зачем |
 * |---|---|---|
 * | `open(путь, O_RDONLY)` | `setwd`, `movts`, `movtd`, `sdisp`, `call`, `setwd` | дескриптор приходит в `%r8` |
 * | `read(fd, буфер+8, count)` | `movts`, `adds`, `sdisp`, `call`, `setwd` | `%r9` несёт fd, `%r10` — адрес ячеек |
 * | возврат блока рантайма | `movts`, `movts`, `movtd` | системный вызов зануляет `%b[12..15]` (D12) |
 *
 * # ПОЧЕМУ НЕТ `close` — ИЗМЕРЕНО, А НЕ ЗАБЫТО
 *
 * Дескриптор нужен ДВУМ вызовам подряд (`read`, затем `close`), а хранить его между ними негде:
 * `%b[12..15]` вызывающего ядро зануляет (замер D12, железо), а окно вызываемого — это его
 * аргументы. Сохранить fd в памяти списка можно, но вернуть вместе с ним прочитанные байты уже
 * некуда: обе величины пришлось бы держать в базовых клетках, которых у носителя нет. Поэтому MVP
 * читает один раз и НЕ закрывает дескриптор: процесс завершается сразу после разбора, и ядро
 * закрывает его само. Закрытие (и `argv[1]`, и потоковое чтение) — следующий атом.
 *
 * # ГРАНИЦЫ, НАЗВАННЫЕ ЧИСЛАМИ
 *
 * • **одна** операция чтения: `count = 1 МиБ` ({@link FILE_READ_COUNT}) — литералом `movtd`. Прежняя
 *   граница MVP (65535) измерена как недостаточная: собственная лента программы — 749 304 байта;
 * • `read` проверяет ВЕСЬ запрошенный диапазон, поэтому сегмент данных обязан отображать
 *   `ячейки + 1 МиБ` — это цена, а не мелочь (замер: `count` больше отображённого → `EFAULT`);
 * • буфер — ячейки списка, адрес `указатель + 8`: заголовок длины не трогается, файл обязан
 *   начинаться с ЯЧЕЙКИ 0 ленты;
 * • в вызываемой процедуре вызов отказывает: её окно своё, а блок рантайма и `%b[12..15]` —
 *   клетки вызывающего (закон окна).
 */
import type { AsmInstruction, Operand } from './backend';
import { ARRAY_WINDOW_RSZ, arrayBlockRestore } from './arrayRuntime';
import { ENTRY_SYSCALL_FRAME, SYSCALL_TRAP, syscallCallClose, syscallCallOpen, syscallWindowOf } from './syscallRuntime';

const imm = (value: number): Operand => ({ kind: 'imm', value });
const reg = (index: number): Operand => ({ kind: 'reg', index });
const literal = (value: number): Operand => ({ kind: 'imm64', value: BigInt(value) } as unknown as Operand);
const window_ = (index: number): Operand => ({ kind: 'reg', index, file: 'window' });
const a = (mnemonic: string, operands: readonly Operand[], channel = 0): AsmInstruction => ({
  mnemonic,
  channel,
  operands,
});

/** Номера файловых вызовов e2k (`linux-user/e2k/syscall_nr.h:11-14`, `docs/e2k-syscalls-minimal.md`). */
export const SYS_READ = 3;
export const SYS_OPEN = 5;
/** `O_RDONLY` (`linux-user/generic/fcntl.h`). */
export const O_RDONLY = 0;

/** Имя хост-вызова: ровно оно приходит из `invokeNames` образа оболочки. */
export const FILE_READ_CALL = 'система.файлы.читать';
/** Арность: (путь, буфер). */
export const FILE_READ_ARITY = 2;
/**
 * Первая пометка носителя. `0..5` — поля самого `IR.invoke` (`src/e2k/shell.ts#CARRIER_SLOTS`),
 * поэтому пометки начинаются с шестой, как и у строковых операций (`STRING_MARK_OPERAND`).
 */
export const FILE_MARK_OPERAND = 6;
/** Ячейки списка начинаются за словом длины: `[база]` — длина, `[база + 8]` — элемент 0. */
export const FILE_READ_BUFFER_OFFSET = 8;
/**
 * Сколько байт просит одно чтение: **1 МиБ**, литералом `movtd` (64-битная величина), а не `movts`.
 *
 * # Почему не 64 КиБ, как было задумано в MVP
 *
 * Замысел MVP — «одна страница, 65535 байт» — упёрся в ИЗМЕРЕННУЮ величину: собственная лента
 * сгенерированной B2b-программы это **93 663 ячейки / 749 304 байта** (`.tmp/l2s-tape-self.ts`), то
 * есть в 11 раз больше 65535, и при `count = 65535` саморазбор невозможен ни при каком раскладе.
 * `read` при `count` больше отображённого диапазона отвечает `EFAULT` (замер: код 242 = −14), поэтому
 * просьба — 1 МиБ, и названная цена такова: **сегмент данных обязан отображать `ячейки + 1 МиБ`**
 * (`dataSegmentBytes` у ELF; на прогонах — 0x120000). `read` пишет не больше, чем есть в файле, так
 * что для самого файла «просить много» безопасно.
 */
export const FILE_READ_COUNT = 0x100000;
/** Статический путь входа: `argv[1]` — отдельный атом (его ещё нет у языка). */
export const FILE_PATH_TEXT = '/tmp/input.osnova';

/** Отказ файлового рантайма: причина называется до прогона, а не выясняется прогоном. */
export class FileCallRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileCallRefusal';
  }
}

/** Имя вызова — файловое чтение? Проверяется ИМЯ, а не номер: номера у цели нет вовсе. */
export function isFileReadCall(name: string): boolean {
  return name === FILE_READ_CALL;
}

/** Пометки носителя (после шестой): адрес пути, сколько байт просить, адрес ячейки кучи. */
export function fileMarksOf(carrier: AsmInstruction): readonly number[] {
  const marks: number[] = [];
  for (let at = FILE_MARK_OPERAND; at < carrier.operands.length; at++) {
    const operand = carrier.operands[at];
    if (operand === undefined || operand.kind !== 'imm') break;
    marks.push(operand.value);
  }
  return marks;
}

/** Параметры последовательности: всё, что знает сборка, и ни одного числа «с потолка». */
export interface FileReadCallOptions {
  /** Адрес байтов пути в СТАТИКЕ (R|X): читать оттуда можно. */
  readonly pathAddress: number;
  /** Сколько байт просить у ядра (см. {@link FILE_READ_COUNT}). */
  readonly count: number;
  /** Регистр указателя списка-буфера: ячейки лежат по `указатель + 8`. */
  readonly buffer: number;
  /** Приёмник числа прочитанных байт; `undefined` — результат не нужен. */
  readonly destination?: number;
  /** Адрес ячейки кучи — для возврата блока рантайма массивов после системного вызова (D12). */
  readonly heapAddress: number;
}

/**
 * Последовательность целиком. ОДНА функция на раскладку и понижение: форма и байты не могут
 * разойтись (§3.135 — форма не зависит от плоскости, а здесь ещё и от кадра).
 */
export function fileReadCallInstructions(options: FileReadCallOptions): AsmInstruction[] {
  const count = options.count;
  if (!Number.isInteger(count) || count <= 0 || count > FILE_READ_COUNT) {
    throw new FileCallRefusal(
      `«${FILE_READ_CALL}»: длина чтения ${String(count)} вне 1..${String(FILE_READ_COUNT)} — ` +
        'просьба сверх отображённого диапазона даёт `EFAULT` (замер: 242 = −14), а не «сколько есть»',
    );
  }
  if (!Number.isInteger(options.pathAddress) || options.pathAddress <= 0) {
    throw new FileCallRefusal(`«${FILE_READ_CALL}»: адрес пути ${String(options.pathAddress)} — не адрес`);
  }
  if (!Number.isInteger(options.buffer) || options.buffer < 0) {
    throw new FileCallRefusal(`«${FILE_READ_CALL}»: указатель буфера ${String(options.buffer)} — не регистр`);
  }
  const frame = ENTRY_SYSCALL_FRAME;
  const wbs = frame.wbs;
  const instructions: AsmInstruction[] = [
    // rsz = 7: аргументы занимают `%r8..%r11`, и `rbs + rsz + 1 ≤ wsz` (§3.118.1) держится.
    a('setbn', [imm(ARRAY_WINDOW_RSZ), imm(0), imm(0)]),
    // ── open(путь, O_RDONLY) ────────────────────────────────────────────────────────────────────
    ...syscallCallOpen(frame),
    a('movts', [imm(SYS_OPEN), window_(syscallWindowOf(frame, 0))]),
    a('movtd', [literal(options.pathAddress), window_(syscallWindowOf(frame, 1))]),
    a('movts', [imm(O_RDONLY), window_(syscallWindowOf(frame, 2))]),
    a('movts', [imm(0), window_(syscallWindowOf(frame, 3))]),
    a('sdisp', [imm(1), imm(SYSCALL_TRAP)]),
    a('call', [imm(1), imm(wbs)]),
    ...syscallCallClose(frame),
    // fd — в аргумент 1 следующего вызова. Читается ПОСЛЕ закрытия окна: формы `movts` оконных
    // регистров между собой проверены пробой `.tmp/l2s-file-setwd.ts`.
    a('movts', [window_(syscallWindowOf(frame, 0)), window_(syscallWindowOf(frame, 1))]),
    // ── read(fd, буфер + 8, count) ─────────────────────────────────────────────────────────────
    ...syscallCallOpen(frame),
    a('movts', [imm(SYS_READ), window_(syscallWindowOf(frame, 0))]),
    a('adds', [reg(options.buffer), imm(FILE_READ_BUFFER_OFFSET), window_(syscallWindowOf(frame, 2))]),
    a('movtd', [literal(count), window_(syscallWindowOf(frame, 3))]),
    a('sdisp', [imm(1), imm(SYSCALL_TRAP)]),
    a('call', [imm(1), imm(wbs)]),
    ...syscallCallClose(frame),
    // ── БЛОК РАНТАЙМА МАССИВОВ — ОБРАТНО (D12) ─────────────────────────────────────────────────
    //
    // `call wbs = 4` зануляет `%b[12..15]` вызывающего (замер на ЖЕЛЕЗЕ), а следующий за чтением
    // разбор работает со списком. Возвращаются три постоянные; ноль `%b[12]` уже там.
    ...arrayBlockRestore(options.heapAddress),
  ];
  if (options.destination !== undefined) {
    // Ответ ядра — в `%b[8]` (измеренная форма чтения ответа, `openInstructions`).
    instructions.push(a('movts', [reg(frame.base), reg(options.destination)]));
  }
  return instructions;
}
