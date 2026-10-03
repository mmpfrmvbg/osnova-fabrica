/**
 * КОЛЛЕКЦИИ НА `brk`: РАСТУЩИЙ МАССИВ ЗАПИСЕЙ НА ЦЕЛИ.
 *
 * # Что здесь и почему это отдельный модуль
 *
 * Первая и единственная коллекция под DF — **растущий массив записей**: массив, который пополняется и
 * не имеет фиксированной длины. Память под него берётся у `brk` (измерен, `docs/hardware-debt.md`
 * §3.94: `brk(0)` → `brk(+8192)` → запись/чтение = 43); `mmap`, создающий отображение, в шиме модели
 * виснет и в этот заход не входит (§3.94.2).
 *
 * Формат блока — **наше соглашение**, и оно названо, а не подразумевается:
 *
 * ```
 * [ёмкость: 8 байт][элемент 0: 8 байт][элемент 1: 8 байт]…
 * ```
 *
 * Ёмкость лежит В ПАМЯТИ, а не рядом с указателем: в подписи операций владельца ёмкости у `положить`
 * и `взять` нет — значит проверять индекс нечем, кроме заголовка. Слово заголовка — тот же размер,
 * что элемент (`%b[14]` = 8 рантайма массивов), поэтому `база + 8 + индекс·8` считается одной
 * арифметикой без умножения на размер заголовка.
 *
 * Отдельный модуль — по той же причине, что у остатка (`remainderRuntime.ts`) и арены
 * (`arenaRuntime.ts`): команды обязаны быть ОДНИМ источником для двух читателей. Раскладка считает по
 * ним байты (`twoPassLayout.ts`), понижение выдаёт их в образ (`e2kRealRun.ts`). Разойдись они —
 * адреса уедут молча (класс §3.35). Импортировать их из `e2kRealRun.ts` нельзя: он сам импортирует
 * `twoPassLayout`, вышел бы цикл.
 *
 * # Регистры: что занято и что берём себе
 *
 * Рантайм массивов держит `%b[10..15]` ЦЕЛИКОМ, и это замер, а не догадка (`ARRAY_REGISTERS`):
 *
 * | регистр | что держит | можно ли занять под временный |
 * |---|---|---|
 * | `%b[12]` | ноль | **нет** — но его можно ЧИТАТЬ (нулевое смещение адреса) |
 * | `%b[13]` | единица | нет |
 * | `%b[14]` | восемь | **нет** — но его можно ЧИТАТЬ (размер заголовка и элемента) |
 * | `%b[15]` | указатель кучи массивов | нет |
 * | `%b[11]`, `%b[10]` | `scratch`, `scratch2` — рантайм массивов их ПОРТИТ | **нет**: заняты, а не свободны |
 *
 * Поэтому временные берутся НЕ из рантайма массивов, а из бюджета системного вызова: окно вызываемого
 * при `wbs = 4` — это `%b[8]`, `%b[9]`, … (`SyscallFrame.base = 2·wbs`), и **эти же** регистры несёт
 * номер вызова и его первый аргумент. Держать их обязан один владелец: рантайм коллекций. Отсюда
 * {@link collectionReservedRegisters} — список, который раскладка обязана не отдавать, когда образ
 * пользуется коллекциями.
 *
 * Почему это ровно тот класс, что `%b[0]` (§3.95.5б): `brkInstructions` из `memoryRuntime.ts` кладёт
 * адрес в слот формой `adds reg(адрес), reg(0), window_(слот)` — то есть **прибавляет `%b[0]`**. В
 * своей пробе это было верно (там `%b[0]` и был нулём), но в настоящей программе `%b[0]` — регистр
 * раскладки. Здесь слагаемым идёт **регистр нуля рантайма массивов** (`ARRAY_REGISTERS.zero`), и это
 * не украшение: с `%b[0]` адрес уехал бы на значение параметра.
 *
 * # Границы этого захода (названы заранее, а не умолчаны)
 *
 * 1. Коллекции работают **в точке входа**. Регистры `%b[12]`/`%b[14]` заводит пролог ОБРАЗА, то есть
 *    у ВЫЗЫВАЕМОЙ процедуры их никто не заводил: там свои `%b[10..15]` — это `%b[2..7]`
 *    вызывающего, чужие. Граница та же, что у рантайма массивов, и она не размывается.
 * 2. `положить`/`взять`/`расширить` в этом модуле НЕТ. Оракул владельца требует их, но носитель
 *    `IR.invoke` несёт не больше ДВУХ аргументов (`src/e2k/emitterShell.ts#MAX_CALL_ARGS`, названо в
 *    `docs/e2k-emitter-shell.md`), а `положить(база, индекс, значение)` — три. Это отдельная работа
 *    (расширение носителя), и она не смешивается с первой операцией.
 */

import type { AsmInstruction, Operand } from './backend';
import { ARRAY_REGISTERS, ARRAY_WINDOW_RSZ, RESERVED_FROM } from './arrayRuntime';
import { SYS_BRK } from './memoryRuntime';
import { ENTRY_SYSCALL_FRAME, syscallWindowOf, type SyscallFrame } from './syscallRuntime';
import { COLLECTION_ARITY } from '../runtime/vm/collectionCalls';
import { callArgumentOperands } from './shell';
import { LOAD_CARRIER, STORE_CARRIER } from './memoryAccess';

const reg = (index: number): Operand => ({ kind: 'reg', index });
const imm = (value: number): Operand => ({ kind: 'imm', value });
const window_ = (index: number): Operand => ({ kind: 'reg', index, file: 'window' });
const a = (mnemonic: string, operands: readonly Operand[], channel = 0): AsmInstruction => ({
  mnemonic,
  channel,
  operands,
});

/** `addd` — адресная арифметика формой `D`: `adds` (`S`) пишет только младшую половину (§3.27). */
const addd = (src1: number, src2: number, dst: number): AsmInstruction => ({
  mnemonic: 'addd',
  channel: 0,
  operands: [reg(src1), reg(src2), reg(dst)],
});

/** `std значение, база, смещение` — порядок операндов текстовый (измерено: `.tmp/std-order.ts`). */
const std = (value: number, base: number, offset: number): AsmInstruction => ({
  mnemonic: 'std',
  channel: 2, // `st*` разрешены только в каналах 2 и 5 (opcodes/e2k-opc.h:969-984)
  operands: [reg(value), reg(base), reg(offset)],
});

/** Отказ рантайма коллекций: причина называется, а не замалчивается. */
export class CollectionRuntimeRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CollectionRuntimeRefusal';
  }
}

/** Операции языка, которые этот рантайм умеет заменять настоящими обращениями к памяти. */
export const SUPPORTED_COLLECTION_CALLS: readonly string[] = ['система.коллекция.выделить'];

/**
 * ВСЕ имена коллекций, известные языку, — а не только развёрнутые.
 *
 * Различие существенно для диагностики: `взять` и `расширить` развёрнуты ещё НЕТ, и отказ обязан
 * назвать ЭТУ причину. Пока диспетчер узнавал только развёрнутые имена, `система.коллекция.взять`
 * уходил в рантайм МАССИВОВ, и отказ говорил «у рантайма массивов нет такой операции» — верное по
 * букве и ЛОЖНОЕ по существу: причина не в массивах, а в том, что операция коллекций ещё не
 * развёрнута. Такую причину следующая сессия ищет заново (замер: оракул владельца, контроль 1).
 */
export const COLLECTION_CALL_NAMES: readonly string[] = Object.keys(COLLECTION_ARITY);

/**
 * Строка отказа при выходе за границу — ОДНА на цель и на эталон, как у арены.
 *
 * Код возврата берётся у арены (ARENA_REFUSAL_CODE = 231) НАМЕРЕННО: владелец назвал приёмку
 * «названный отказ через status+stderr (как арена, код 231)», и второй код для того же класса
 * отказа развёл бы наблюдателя на два случая там, где случай один.
 */
export const COLLECTION_REFUSAL_TEXT = 'коллекция: индекс вне ёмкости блока';

/**
 * Арность — ИЗ ОДНОГО ИСТОЧНИКА С ЭТАЛОНОМ (`src/runtime/vm/collectionCalls.ts`).
 *
 * Второй таблицы здесь нет намеренно: разойдись арность у цели и у VM — вызов с неверным числом
 * аргументов понижался бы на одной стороне и отвергался на другой, и это не отказ, а расхождение
 * двух эталонов. Там же объяснено, ПОЧЕМУ арность едет `extraInvokes`, а не реестром языка.
 */
const ARITY: Readonly<Record<string, number>> = COLLECTION_ARITY;

/** Размер слова заголовка и элемента — читается у рантайма массивов, а не заводится вторым числом. */
export const COLLECTION_WORD_REGISTER = ARRAY_REGISTERS.eight;
/** Нулевое смещение адреса — регистр рантайма массивов (читается, не заводится). */
export const COLLECTION_ZERO_REGISTER = ARRAY_REGISTERS.zero;

/**
 * Регистры, которые рантайм коллекций держит САМ, — регистры окна системного вызова.
 *
 * Берутся из кадра, а не из чисел: `%b[8]` и `%b[9]` — это `система.коллекция` лишь потому, что
 * `fram`e` вызова такой. Смена кадра (например, выращенное окно процедуры) обязана тянуть за собой и
 * этот список, иначе раскладка отдаст эти регистры под значение, и номер вызова затрёт чужое.
 */
export function collectionReservedRegisters(frame: SyscallFrame = ENTRY_SYSCALL_FRAME): readonly number[] {
  // Номер вызова и первый аргумент — ровно те два, которыми пользуется `brk`. Больше рантайму
  // коллекций ничего не нужно: адрес считается в первом аргументе, ответ читается из нулевого.
  return [syscallWindowOf(frame, 0), syscallWindowOf(frame, 1)];
}

/** Пользуется ли образ коллекциями — по имени вызова в потоке носителей. */
export function usesCollections(
  code: readonly AsmInstruction[],
  invokeNames: readonly string[],
  frame: SyscallFrame = ENTRY_SYSCALL_FRAME,
): boolean {
  void frame;
  return code.some((carrier) => {
    if (carrier.mnemonic !== 'IR.invoke') return false;
    const payload = carrier.operands[3];
    // ИМЕНА ВСЕ, А НЕ ТОЛЬКО РАЗВЁРНУТЫЕ: сайт положить/взять собирается из носителей и
    // системного вызова не делает, но резерв обязан быть взят и под него — иначе признак
    // «образ пользуется коллекциями» не сработал бы, и сайт остался бы без своих регистров.
    return (
      payload !== undefined &&
      payload.kind === 'imm' &&
      COLLECTION_CALL_NAMES.includes(invokeNames[payload.value] ?? '')
    );
  });
}

/**
 * `brk(адрес)` — новое значение границы кучи; `brk(0)` возвращает текущее.
 *
 * Ряд — **измеренный** (§3.94): `movts` номера → `adds` аргумента → `sdisp` → `call` → чтение ответа из
 * оконного нуля. Отличие от `memoryRuntime.brkInstructions` одно и оно названо в шапке модуля:
 * слагаемым идёт регистр нуля рантайма массивов, а не `%b[0]`.
 *
 * `setbn` ставится как в измеренном образце: пролог образа даёт `rsz = 7`, и повторная та же
 * `setbn` — не сужение окна (сузила бы `rsz = 5`: `%b[11]` и `%b[12]` перестали бы адресоваться).
 */
export function brkInstructions(options: {
  readonly address: number;
  readonly result: number;
  readonly frame?: SyscallFrame;
}): AsmInstruction[] {
  const frame = options.frame ?? ENTRY_SYSCALL_FRAME;
  return [
    ...(frame.setbn ? [a('setbn', [imm(ARRAY_WINDOW_RSZ), imm(0), imm(0)])] : []),
    a('movts', [imm(SYS_BRK), window_(syscallWindowOf(frame, 0))]),
    a('adds', [reg(options.address), reg(COLLECTION_ZERO_REGISTER), window_(syscallWindowOf(frame, 1))]),
    a('sdisp', [imm(1), imm(0)]),
    a('call', [imm(1), imm(frame.wbs)]),
    // Ответ ядра лежит в оконном нуле ВЫЗЫВАЮЩЕГО (`linux-user/e2k/cpu_loop.c`), а `call` сдвигает
    // окно на `2·wbs` — значит читается он базовой формой из `%b[2·wbs]`, то есть из `frame.base`.
    a('movts', [reg(frame.base), reg(options.result)]),
  ];
}

/**
 * `выделить(ёмкость) → база`: блок из заголовка и `ёмкость` элементов.
 *
 * ПОРЯДОК ЗДЕСЬ — ЧАСТЬ СМЫСЛА, а не стиль:
 *
 * 1. `brk(0)` даёт текущую границу кучи — это и есть база блока; она едет ПРЯМО в приёмник.
 * 2. Граница блока считается как `база + 8 + ёмкость·8` **в регистре-аргументе системного вызова**:
 *    второго временного регистра не нужно, потому что `×8` идёт удвоением `addd` с приёмником в
 *    конце цепочки, а не с отдельной копией входа.
 * 3. `brk(граница)` — РАСШИРЕНИЕ, и только после него пишется заголовок: до расширения `[база]` лежит
 *    за границей кучи, и запись туда — порча чужой памяти, а не заголовок.
 * 4. Заголовок — `ёмкость` в первые 8 байт. Он пишется ПЕРВЫМ словом блока, потому что `положить` и
 *    `взять` смогут узнать ёмкость только отсюда.
 *
 * `ёмкость × 8` — тремя `addd` (удвоение), а не `shls`: `shls` в таблице МЦСТ есть, но прогоном не
 * проверен, а удвоение проверено (`arrayRuntime.ts`, шапка).
 */
export function allocateInstructions(
  capacity: number,
  destination: number,
  frame: SyscallFrame = ENTRY_SYSCALL_FRAME,
): AsmInstruction[] {
  const argument = syscallWindowOf(frame, 1);
  const answer = syscallWindowOf(frame, 0);
  return [
    // 1. База — текущая граница кучи. `brk(0)`: слагаемое — регистр нуля.
    ...brkInstructions({ address: COLLECTION_ZERO_REGISTER, result: destination, frame }),
    // 2. Граница блока = база + 8 + ёмкость·8. Требует `capacity ≠ argument`: при совпадении первое
    //    удвоение затрёт вход (то же требование, что у `timesEight` рантайма массивов), а `argument`
    //    закреплён за рантаймом и приёмником быть не может — это проверяет `checkRegister`.
    addd(capacity, capacity, argument),
    addd(argument, argument, argument),
    addd(argument, argument, argument),
    addd(argument, COLLECTION_WORD_REGISTER, argument),
    addd(argument, destination, argument),
    // 3. Расширение кучи до границы блока.
    ...brkInstructions({ address: argument, result: answer, frame }),
    // 4. Заголовок: ёмкость в первые 8 байт блока. Смещение — РЕГИСТР нуля, как у рантайма массивов
    //    (`std(scratch2, registers[0], zero)`): форма `std` берёт смещение регистром.
    std(capacity, destination, COLLECTION_ZERO_REGISTER),
  ];
}

/**
 * ТЕМПОРАЛЬНЫЕ РЕГИСТРЫ САЙТА — из полосы рантайма массивов (`%b[10..15]`).
 *
 * Почему оттуда: раскладка эту полосу **не отдаёт** (`RESERVED_REGISTERS`), значит они не стоят
 * ничего — ни одного регистра у программы не отнято. И почему это законно: полосу держит рантайм
 * МАССИВОВ, а его в программе с коллекциями нет; из шести регистров два (`%b[12]` ноль и `%b[14]`
 * восемь) здесь ЧИТАЮТСЯ как константы пролога, а четыре остальных свободны.
 *
 * | регистр | полоса массивов | здесь |
 * |---|---|---|
 * | `%b[12]` | ноль | читается (смещение формы памяти) |
 * | `%b[14]` | восемь | читается (шаг элемента и адрес заголовка) |
 * | `%b[10]` | `scratch2` | **ёмкость**, прочитанная из заголовка |
 * | `%b[11]` | `scratch` | **адрес элемента** |
 * | `%b[13]` | единица | **ключ сравнения** (предикат) |
 *
 * Сайт держит их ВНУТРИ себя: ни одно значение не переживает сайт, поэтому соседний сайт массива
 * (`scratch`/`scratch2`) их не испортит — и наоборот.
 */
export const COLLECTION_CAPACITY_REGISTER = 10;
export const COLLECTION_ADDRESS_REGISTER = 11;
export const COLLECTION_KEY_REGISTER = 13;

/** Размер сайта в носителях — ОДИН на обе операции, и это не совпадение, а требование счёта. */
const SITE_SIZE = 7;

/**
 * САЙТ ОПЕРАЦИИ: проверка границы и обращение по вычисленному адресу.
 *
 * Ряд — тот же приём, что у арены (`arenaSiteCarriers`): сравнение и переход идут ПАРОЙ, и цель
 * перехода считает `expandCarriers`, а не понижение. Понижение работает ПОСЛЕ раскладки и индекса
 * носителя не знает вовсе — поэтому прыжок из серии команд невыразим, и сайт обязан быть носителями.
 *
 * | шаг | носитель | что делает |
 * |---|---|---|
 * | 1 | `IR.load [база, ёмкость]` | читает ёмкость из ПЕРВЫХ 8 байт блока (соглашение §3.98) |
 * | 2 | `IR.lt [ключ, индекс, ёмкость]` | «индекс < ёмкость» — условие КАК ЕСТЬ |
 * | 3 | `IR.jmp_if_not [ключ, отказ]` | переход с ОТРИЦАНИЕМ предиката (эталон §3.80.1) |
 * | 4–6 | `IR.mul`, `IR.add`, `IR.add` | адрес = база + 8 + индекс·8 |
 * | 7 | `IR.store` / `IR.load` | запись / чтение |
 *
 * Адрес считается ПОСЛЕ проверки намеренно: при отказе он не нужен, а порядок делает отказ дешевле.
 */
export function collectionSiteCarriers(
  operation: 'положить' | 'взять',
  base: number,
  index: number,
  value: number,
  destination: number | undefined,
  refusalIndex: number,
): AsmInstruction[] {
  const zero = ARRAY_REGISTERS.zero;
  const eight = ARRAY_REGISTERS.eight;
  const capacity = COLLECTION_CAPACITY_REGISTER;
  const address = COLLECTION_ADDRESS_REGISTER;
  const key = COLLECTION_KEY_REGISTER;
  // ПЕРВЫЕ ЧЕТЫРЕ ШАГА ОДНИ НА ОБЕ ОПЕРАЦИИ — и это не «похоже», а буквально один код: разойдись
  // проверка у чтения и у записи, `взять` читал бы там, куда `положить` не пишет.
  const site: AsmInstruction[] = [
    { mnemonic: LOAD_CARRIER, channel: 0, operands: [reg(base), reg(capacity)] },
    { mnemonic: 'IR.lt', channel: 0, operands: [reg(key), reg(index), reg(capacity)] },
    { mnemonic: 'IR.jmp_if_not', channel: 0, operands: [reg(key), imm(refusalIndex)] },
    { mnemonic: 'IR.mul', channel: 0, operands: [reg(address), reg(index), reg(eight)] },
    { mnemonic: 'IR.add', channel: 0, operands: [reg(address), reg(address), reg(eight)] },
    { mnemonic: 'IR.add', channel: 0, operands: [reg(address), reg(address), reg(base)] },
  ];
  if (operation === 'положить') {
    if (value === undefined) throw new CollectionRuntimeRefusal('«положить»: нет регистра значения');
    site.push({ mnemonic: STORE_CARRIER, channel: 0, operands: [reg(value), reg(address)] });
  } else {
    if (destination === undefined) throw new CollectionRuntimeRefusal('«взять»: нет регистра-приёмника');
    site.push({ mnemonic: LOAD_CARRIER, channel: 0, operands: [reg(address), reg(destination)] });
  }
  if (site.length !== SITE_SIZE) {
    // Счёт сайта — не украшение: он входит в вычисление индекса блока отказа, и разойдись они —
    // переход уехал бы в середину чужого кода (класс §3.35).
    throw new CollectionRuntimeRefusal(
      `сайт «${operation}» длиной ${String(site.length)}, а счёт обещает ${String(SITE_SIZE)} — ` +
        'индекс блока отказа считался бы неверно',
    );
  }
  void zero;
  return site;
}

/** Операции, у которых есть САЙТ (остальные разворачиваются прямо в понижении, как `выделить`). */
export const COLLECTION_SITE_CALLS: readonly string[] = ['система.коллекция.положить', 'система.коллекция.взять'];

/** Сколько сайтов в потоке — по именам вызовов, а не по тексту программы. */
function siteKindsOf(
  code: readonly AsmInstruction[],
  invokeNames: readonly string[],
): readonly ('положить' | 'взять')[] {
  const kinds: ('положить' | 'взять')[] = [];
  for (const carrier of code) {
    if (carrier.mnemonic !== 'IR.invoke') continue;
    const payload = carrier.operands[3];
    if (payload === undefined || payload.kind !== 'imm') continue;
    const name = invokeNames[payload.value];
    if (name === 'система.коллекция.положить') kinds.push('положить');
    if (name === 'система.коллекция.взять') kinds.push('взять');
  }
  return kinds;
}

/**
 * ГРУППЫ САЙТОВ — тем же приёмом, что у арены (`arenaGroups`): картой групп, а не готовым потоком.
 *
 * Индексы и цели переходов пересчитывает `expandCarriers` (`src/e2k/procedureCall.ts`): свой счётчик
 * разошёлся бы с ним (класс §3.35). Блок отказа дописывается СНАРУЖИ — как у арены, — и его индекс
 * равен длине потока ПОСЛЕ расширения: сайт длиной 7 заменяет один носитель, то есть +6 на сайт.
 */
export function collectionGroups(
  code: readonly AsmInstruction[],
  invokeNames: readonly string[],
): { readonly groups: ReadonlyMap<number, readonly AsmInstruction[]>; readonly sites: number; readonly refusalIndex: number } {
  const kinds = siteKindsOf(code, invokeNames);
  const refusalIndex = code.length + (SITE_SIZE - 1) * kinds.length;
  const groups = new Map<number, readonly AsmInstruction[]>();
  let site = 0;
  code.forEach((carrier, index) => {
    if (carrier.mnemonic !== 'IR.invoke') return;
    const payload = carrier.operands[3];
    if (payload === undefined || payload.kind !== 'imm') return;
    const name = invokeNames[payload.value];
    if (name === undefined || !COLLECTION_SITE_CALLS.includes(name)) return;
    const kind = kinds[site]!;
    const args = callArgumentOperands(carrier);
    const [base, index_, value] = args;
    const destination = carrier.operands[4];
    if (base === undefined || base.kind !== 'reg' || index_ === undefined || index_.kind !== 'reg') return;
    const refused = collectionSiteCarriers(
      kind,
      base.index,
      index_.index,
      value !== undefined && value.kind === 'reg' ? value.index : -1,
      destination !== undefined && destination.kind === 'reg' ? destination.index : undefined,
      refusalIndex,
    );
    groups.set(index, refused);
    site += 1;
  });
  return { groups, sites: site, refusalIndex };
}

/**
 * Сторож: операнд не смеет попасть в регистры рантайма.
 *
 * Зачем проверка, а не надежда: если раскладка не закрепила `%b[8]`/`%b[9]` (забыли добавить
 * `collectionReservedRegisters` в `reserved`), то номер системного вызова ляжет ПОВЕРХ значения — и
 * это не отказ, а тихая ложь. Отказ называется здесь, у причины.
 */
function checkRegister(operand: Operand, name: string, role: string, frame: SyscallFrame): void {
  if (operand.kind !== 'reg') {
    throw new CollectionRuntimeRefusal(`«${name}»: ${role} обязан быть регистром, а не ${operand.kind}`);
  }
  if (operand.index >= RESERVED_FROM) {
    throw new CollectionRuntimeRefusal(
      `«${name}»: ${role} попал в %b[${String(operand.index)}] — с %b[${String(RESERVED_FROM)}] и выше ` +
        'живёт рантайм массивов (нуль, восемь, куча и его временные, src/e2k/arrayRuntime.ts)',
    );
  }
  const reserved = collectionReservedRegisters(frame);
  if (reserved.includes(operand.index)) {
    throw new CollectionRuntimeRefusal(
      `«${name}»: ${role} попал в %b[${String(operand.index)}] — этот регистр держит рантайм коллекций ` +
        '(номер и аргумент системного вызова, src/e2k/collectionsRuntime.ts#collectionReservedRegisters); ' +
        'значит раскладка его не закрепила (`src/e2k/programImage.ts#loweredProgram`, список `reserved`)',
    );
  }
}

/**
 * Понизить вызов коллекции в настоящие команды e2k.
 *
 * @param name имя хост-вызова (`система.коллекция.*`) — семантику несёт имя, а не код операции
 * @param args регистры аргументов в порядке вызова
 * @param dst регистр приёмника
 */
export function lowerCollectionCall(
  name: string,
  args: readonly Operand[],
  dst: number | undefined,
  frame: SyscallFrame = ENTRY_SYSCALL_FRAME,
): AsmInstruction[] {
  const arity = ARITY[name];
  if (arity === undefined) {
    throw new CollectionRuntimeRefusal(
      `«${name}»: у рантайма коллекций нет такой операции — он умеет ${SUPPORTED_COLLECTION_CALLS.join(', ')}`,
    );
  }
  // ПОДДЕРЖКА ПРОВЕРЯЕТСЯ ПЕРВОЙ, до арности и приёмника: иначе «положить» (три аргумента, результата
  // нет) упиралось бы в «нет приёмника» — верное по форме и НЕВЕРНОЕ по причине: причина в носителе,
  // который не может донести третий аргумент, а не в отсутствии приёмника. Отказ обязан называть
  // настоящую причину, иначе следующая сессия ищет её заново.
  if (!SUPPORTED_COLLECTION_CALLS.includes(name)) {
    // ПРИЧИНА БОЛЬШЕ НЕ В АРНОСТИ — и текст обязан это сказать. Носитель с 2026-10-02 несёт ТРИ
    // аргумента (`src/e2k/shell.ts#src3`), предел снят. Настоящая причина у всех трёх операций
    // одна: им нужен ПЕРЕХОД (проверка границы с блоком отказа, а у переезда — цикл копирования),
    // а цель перехода считает `expandCarriers` ДО раскладки, тогда как понижение работает ПОСЛЕ —
    // из серии команд прыжок не выражается. Машинерия для этого есть у арены (`arenaGroups`), и
    // следующий шаг идёт ею.
    //
    // Текст НЕ поминает ни ёмкости, ни индекса: иначе он случайно удовлетворил бы контроль
    // оракула владельца, ищущий `/ёмкост|индекс/` (замер: §3.98.10, ложное зелёное).
    throw new CollectionRuntimeRefusal(
      `«${name}»: операция ещё не развёрнута в настоящие обращения к памяти — ей нужен ПЕРЕХОД ` +
        '(проверка границы с блоком отказа, у переезда — цикл копирования), а цель перехода считается ' +
        'до раскладки, тогда как понижение работает после: из серии команд прыжок не выражается. ' +
        'Машинерия для этого есть у арены (src/e2k/arenaRuntime.ts#arenaGroups) — это следующий шаг',
    );
  }
  if (args.length !== arity) {
    throw new CollectionRuntimeRefusal(`«${name}»: аргументов ${String(args.length)}, по источнику ${String(arity)}`);
  }
  args.forEach((operand, index) => checkRegister(operand, name, `аргумент ${index}`, frame));
  if (dst === undefined) {
    throw new CollectionRuntimeRefusal(`«${name}»: без регистра-приёмника операция смысла не имеет`);
  }
  checkRegister(reg(dst), name, 'приёмник', frame);
  const registers = args.map((operand) => (operand as { index: number }).index);

  switch (name) {
    case 'система.коллекция.выделить':
      return allocateInstructions(registers[0]!, dst, frame);
    default:
      throw new CollectionRuntimeRefusal(`«${name}»: ветвь не описана`);
  }
}
