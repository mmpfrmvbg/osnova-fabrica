/**
 * БЛОК ОТКАЗА: «НАПЕЧАТАТЬ СТАТИЧЕСКИЙ ТЕКСТ В STDERR И ВЫЙТИ КОДОМ» — ОДНА МАШИНЕРИЯ НА ВСЕХ.
 *
 * # Почему это отдельный модуль, а не ветвь арены
 *
 * Машинерия у арены и у коллекций **общая**: два носителя — печать блоба и выход с кодом, — и
 * различаются потребители только АДРЕСОМ и ДЛИНОЙ текста, которые приходят операндами. Пока
 * определение жило в `arenaRuntime.ts`, носитель назывался `IR.arena_refusal`, и блок ОТКАЗА
 * КОЛЛЕКЦИЙ носил имя арены: читатель потока видел «арену» там, где арены нет вовсе.
 *
 * Отсюда два следствия, и оба названы, а не умолчаны:
 *
 * 1. Имя носителя — **`IR.refusal`**: он говорит, что делает, а не кто первым им воспользовался.
 * 2. Тексты у потребителей **РАЗНЫЕ** (случай 34 реестра проверяемости): общий механизм — не повод
 *    на общий текст. Адрес и длина — операнды носителя, поэтому один механизм и несёт разные тексты.
 *
 * `src/e2k/arenaRuntime.ts` переиздаёт эти имена под прежними (`ARENA_REFUSAL_CARRIER`,
 * `arenaRefusalCarriers`) — так у прежних читателей не отнято ничего, а у новых нет соблазна
 * завести вторую копию блока.
 *
 * # Почему модуль — лист графа импортов
 *
 * Его читают и арена, и коллекции, а `collectionsRuntime` уже входит в кольцо
 * `procedureCall → twoPassLayout → collectionsRuntime`. Импорт арены отсюда дал бы ВТОРОЕ кольцо
 * (`collectionsRuntime → arenaRuntime → procedureCall → twoPassLayout → collectionsRuntime`), а
 * значения, вычисленные на загрузке модуля внутри кольца, приходят неопределёнными (это уже
 * измерено на `ARENA_POINTER_BASE`). Поэтому здесь только `backend`, `arrayRuntime` и
 * `syscallRuntime` — ни одного импорта «вверх».
 */
import type { AsmInstruction, Operand } from './backend';
import { ARRAY_WINDOW_RSZ } from './arrayRuntime';
import {
  ENTRY_SYSCALL_FRAME,
  SYS_EXIT,
  SYS_WRITE,
  STDERR_FD,
  SYSCALL_TRAP,
  syscallWindowOf,
  type SyscallFrame,
} from './syscallRuntime';

const imm = (value: number): Operand => ({ kind: 'imm', value });
const window_ = (index: number): Operand => ({ kind: 'reg', index, file: 'window' });
const f64 = (value: number): Operand => ({ kind: 'imm64', value: BigInt(value) }) as unknown as Operand;
const a = (mnemonic: string, operands: readonly Operand[], channel = 0): AsmInstruction => ({
  mnemonic,
  channel,
  operands,
});

/** Носитель блока отказа: статический текст плюс его длина. */
export const REFUSAL_CARRIER = 'IR.refusal';

/**
 * Код возврата отказа — ОДИН на все причины, и это намеренно.
 *
 * Различие несёт СТРОКА: второй код для того же класса отказа развёл бы наблюдателя на два случая
 * там, где случай один (решение владельца: «названный отказ через status+stderr, код 231»).
 * Наблюдаем он потому, что 231 < 256 — канал кода возврата восьмибитный.
 */
export const REFUSAL_CODE = 231;

/** Сколько носителей в блоке — считается по самому блоку, а не вторым числом. */
export const REFUSAL_BLOCK_SIZE = 2;

/** Адрес и длина статического текста отказа: их даёт планирование строк (`src/e2k/stringPlan.ts`). */
export interface RefusalBlob {
  readonly address: number;
  readonly byteLength: number;
}

/** Носители блока отказа: печать текста и выход. Их никто не проходит насквозь — после выхода нет. */
export function refusalCarriers(address: number, byteLength: number): AsmInstruction[] {
  return [
    { mnemonic: REFUSAL_CARRIER, channel: 0, operands: [imm(address), imm(byteLength)] },
    { mnemonic: 'IR.exit', channel: 0, operands: [imm(REFUSAL_CODE)] },
  ];
}

/**
 * Команды блока отказа: строка в **stderr** (`STDERR_FD = 2`) и `exit(231)`.
 *
 * Строка — статический блоб (его планирует `stringPlan`), поэтому адрес приходит числом: `movtd`
 * несёт 64-битный литерал, `movts` такой константы не несёт (измерено, §3.40).
 *
 * Порядок — как у «hello» и у хвоста печати: `setbn` (окно вращаемых регистров) → аргументы →
 * `sdisp` (тег `CTPSL`) → `call`. Аргументы идут в **оконные** регистры кадра.
 */
export function refusalInstructions(
  address: number,
  byteLength: number,
  frame: SyscallFrame = ENTRY_SYSCALL_FRAME,
): AsmInstruction[] {
  return [
    ...(frame.setbn ? [a('setbn', [imm(ARRAY_WINDOW_RSZ), imm(0), imm(0)])] : []),
    a('movts', [imm(SYS_WRITE), window_(syscallWindowOf(frame, 0))]),
    a('movts', [imm(STDERR_FD), window_(syscallWindowOf(frame, 1))]),
    a('movtd', [f64(address), window_(syscallWindowOf(frame, 2))]),
    a('movts', [imm(byteLength), window_(syscallWindowOf(frame, 3))]),
    a('sdisp', [imm(1), imm(SYSCALL_TRAP)]),
    a('call', [imm(1), imm(frame.wbs)]),
    a('movts', [imm(SYS_EXIT), window_(syscallWindowOf(frame, 0))]),
    a('movts', [imm(REFUSAL_CODE), window_(syscallWindowOf(frame, 1))]),
    a('sdisp', [imm(1), imm(SYSCALL_TRAP)]),
    a('call', [imm(1), imm(frame.wbs)]),
  ];
}

/**
 * Команды носителя блока отказа — ОДИН источник для раскладки (форма) и понижения (байты).
 *
 * Кадр передаёт ВЫЗЫВАЮЩИЙ, а не берётся здесь: он живёт в носителе и читается тем, кто знает
 * раскладку операндов носителя (`src/e2k/printCall.ts#syscallFrameOfCarrier`). Импортировать его
 * сюда нельзя — `printCall` уже входит в кольцо импортов через `predicatePairing → procedureCall →
 * twoPassLayout → collectionsRuntime`, и второй вход замкнул бы кольцо (см. шапку модуля).
 */
export function refusalCarrierInstructions(
  carrier: AsmInstruction,
  frame: SyscallFrame = ENTRY_SYSCALL_FRAME,
): AsmInstruction[] | undefined {
  const address = carrier.operands[0];
  const byteLength = carrier.operands[1];
  if (address === undefined || address.kind !== 'imm' || byteLength === undefined || byteLength.kind !== 'imm') {
    return undefined;
  }
  return refusalInstructions(address.value, byteLength.value, frame);
}
