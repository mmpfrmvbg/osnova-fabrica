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
 * # ЧЕТЫРЕ ОПЕРАЦИИ, А САЙТОВ — ТРИ (и почему так)
 *
 * | операция | чем разворачивается | что в ней трудного |
 * |---|---|---|
 * | `выделить(ёмкость) → адрес` | сайт из 4 носителей | **ответ `brk` сравнивается с запрошенной границей** — иначе отказ ядра неотличим от успеха |
 * | `положить(база, индекс, значение)` | сайт из 7 носителей | проверка границы по заголовку |
 * | `взять(база, индекс) → значение` | тот же сайт, последний шаг — чтение | то же |
 * | `расширить(база, новая_ёмкость) → адрес` | сайт из 15 носителей + **цикл копирования** (8) в конце потока | переезд: новый блок, копия старых элементов, заголовок с НОВОЙ ёмкостью |
 *
 * Сайт — не «серия команд в понижении», а **носители**: переходы внутри сайта обязаны быть видны
 * раскладке, а она работает ДО понижения. Поэтому сайт собирается здесь картой групп, а индексы и
 * цели переходов пересчитывает `src/e2k/procedureCall.ts#expandCarriers` — свой счётчик разошёлся бы
 * с ним (класс §3.35).
 *
 * # ГДЕ ЖИВЁТ ЦИКЛ КОПИРОВАНИЯ И ПОЧЕМУ ИМЕННО ТАМ
 *
 * Цикл — это ОБРАТНЫЙ переход, а цель обратного перехода внутри группы носителей невыразима: у
 * группы нет «своих» индексов, `expandCarriers` знает только индекс носителя, который группа
 * ЗАМЕНИЛА. Поэтому цикл стоит НЕ в сайте, а В КОНЦЕ ПОТОКА (там же, где блоки отказа): его
 * абсолютный индекс больше длины потока, и пересчёт его не трогает. Сайт заканчивается переходом на
 * цикл, а из цикла ведёт переход на следующий носитель ЗА вызовом — уже по ИСХОДНОМУ индексу, чтобы
 * пересчёт сдвинул его вместе с потоком.
 *
 * # ТРИ ПРИЧИНЫ ОТКАЗА — ТРИ ТЕКСТА
 *
 * Блок отказа — ОБЩАЯ машинерия (`src/e2k/refusalBlock.ts`), но текст у каждой причины СВОЙ
 * (случай 34 реестра проверяемости: программа с ареной И коллекциями печатала текст арены на отказе
 * коллекции). Причин у коллекций три, и путать их нельзя — «индекс вне ёмкости» на отказе `brk`
 * уводит отладку не туда:
 *
 * | причина | текст |
 * |---|---|
 * | индекс вне ёмкости блока | `коллекция: индекс вне ёмкости блока` |
 * | новая ёмкость не больше текущей | `коллекция: новая ёмкость не больше текущей` |
 * | `brk` не дал запрошенную границу | `коллекция: куча не выросла — brk не дал запрошенную границу` |
 *
 * # Регистры: что занято и что берём себе
 *
 * Рантайм массивов держит `%b[10..15]` ЦЕЛИКОМ, и это замер, а не догадка (`ARRAY_REGISTERS`):
 *
 * | регистр | что держит | можно ли занять под временный |
 * |---|---|---|
 * | `%b[12]` | ноль | **нет** — но его можно ЧИТАТЬ (нулевое смещение адреса) |
 * | `%b[13]` | единица | нет по значению, но он же — КЛЮЧ ПРЕДИКАТА сравнений (файл предикатов отдельный) |
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
 * 1. Коллекции работают **в точке входа**. Регистры `%b[12]`/`%b[13]`/`%b[14]` заводит пролог ОБРАЗА,
 *    то есть у ВЫЗЫВАЕМОЙ процедуры их никто не заводил: там свои `%b[8..15]` — это `%b[8..15]`
 *    вызываемой, а `%b[2..7]` — `%b[10..15]` вызывающего. Граница та же, что у рантайма массивов, и
 *    она не размывается: вызов коллекции в вызываемой — НАЗВАННЫЙ ОТКАЗ
 *    ({@link collectionGroups}, поле `problems`), а не тихая порча чужого состояния.
 * 2. Обращения к памяти коллекций идут `ldd`/`std` — то есть **32-битной адресацией** при 64-битном
 *    адресе: это названный долг (§3.98.7), а не умолчание. Цена сегодняшняя: куча живёт ниже 2 ГиБ.
 */

import type { AsmInstruction, Operand } from './backend';
import { ARRAY_REGISTERS, ARRAY_WINDOW_RSZ, RESERVED_FROM } from './arrayRuntime';
import { SYS_BRK } from './memoryRuntime';
import { LOWERING_CODES, LoweringRefusalError } from './loweringRefusal';
import {
  ENTRY_SYSCALL_FRAME,
  SYSCALL_TRAP,
  syscallCallClose,
  syscallCallOpen,
  syscallReplyRegister,
  syscallWindowOf,
  type SyscallFrame,
} from './syscallRuntime';
import { COLLECTION_ARITY } from '../runtime/vm/collectionCalls';
import { callArgumentOperands } from './shell';
import { LOAD_CARRIER, STORE_CARRIER } from './memoryAccess';
import { REFUSAL_BLOCK_SIZE, refusalCarriers, type RefusalBlob } from './refusalBlock';

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

/** Отказ рантайма коллекций: причина называется, а не замалчивается. */
export class CollectionRuntimeRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CollectionRuntimeRefusal';
  }
}

/** Имена операций — ОДНИМ источником: по ним и признак «образ пользуется коллекциями», и диспетчер. */
export const COLLECTION_CALLS = {
  allocate: 'система.коллекция.выделить',
  put: 'система.коллекция.положить',
  take: 'система.коллекция.взять',
  resize: 'система.коллекция.расширить',
} as const;

/** Имя операции коллекций — из подписи владельца (§3.95.3), четыре штуки. */
export type CollectionCallName = (typeof COLLECTION_CALLS)[keyof typeof COLLECTION_CALLS];

/**
 * ВСЕ имена коллекций, известные языку, — а не только развёрнутые.
 *
 * Различие существенно для диагностики: пока диспетчер узнавал только развёрнутые имена,
 * `система.коллекция.взять` уходил в рантайм МАССИВОВ, и отказ говорил «у рантайма массивов нет такой
 * операции» — верное по букве и ЛОЖНОЕ по существу. Второй источник здесь не заводится: список
 * берётся у арности, которую читает и эталон (`src/runtime/vm/collectionCalls.ts`).
 */
export const COLLECTION_CALL_NAMES: readonly string[] = Object.keys(COLLECTION_ARITY);

/**
 * Операции, которые этот рантайм разворачивает в настоящие обращения к памяти.
 *
 * Все четыре, и НИ ОДНА не понижается «в одно место»: `положить`/`взять` — сайтом из 7 носителей,
 * `выделить` — сайтом из 4 (проверка ответа `brk` — это переход), `расширить` — сайтом из 15 плюс
 * цикл копирования. Поэтому имя списка означает «операции обслуживаются», а не «понижаются одной
 * серией команд» ({@link lowerCollectionCall} это и говорит, когда носитель дошёл до него).
 */
export const SUPPORTED_COLLECTION_CALLS: readonly string[] = Object.values(COLLECTION_CALLS);

/**
 * Строка отказа при выходе за границу — ОДНА на цель и на эталон, как у арены.
 *
 * Код возврата берётся у ОБЩЕГО блока отказа (`REFUSAL_CODE` = 231) НАМЕРЕННО: владелец назвал
 * приёмку «названный отказ через status+stderr (как арена, код 231)», и второй код для того же класса
 * отказа развёл бы наблюдателя на два случая там, где случай один.
 */
export const COLLECTION_REFUSAL_TEXT = 'коллекция: индекс вне ёмкости блока';

/**
 * Отказ РАСШИРЕНИЯ: новая ёмкость не больше текущей.
 *
 * Отдельный текст, а не общий с индексом: «индекс вне ёмкости» на этой причине — ЛОЖНАЯ диагностика
 * (случай 28 в одежде случая 34). Расширять некуда — это свойство ОПЕРАЦИИ, и наблюдатель обязан
 * видеть именно его.
 */
export const COLLECTION_CAPACITY_REFUSAL_TEXT = 'коллекция: новая ёмкость не больше текущей';

/**
 * Отказ ПАМЯТИ: `brk` не дал запрошенную границу (ответ ядра меньше запрошенного — в том числе
 * `-ENOMEM`).
 *
 * Здесь же живёт и ответ на вопрос «почему не молчание»: до этой проверки отказ ядра был НЕОТЛИЧИМ от
 * успеха — блок «выделялся» по адресу, которого нет, и первая же запись в заголовок уходила за
 * границу кучи.
 */
export const COLLECTION_BRK_REFUSAL_TEXT = 'коллекция: куча не выросла — brk не дал запрошенную границу';

/** Тексты по причинам — и это ОДИН источник для планирования блобов и для блоков отказа. */
export const COLLECTION_REFUSAL_TEXTS = {
  index: COLLECTION_REFUSAL_TEXT,
  capacity: COLLECTION_CAPACITY_REFUSAL_TEXT,
  memory: COLLECTION_BRK_REFUSAL_TEXT,
} as const;

/** Причина отказа коллекций: `index` — граница блока, `capacity` — переезд, `memory` — ответ `brk`. */
export type CollectionRefusalKind = keyof typeof COLLECTION_REFUSAL_TEXTS;

/**
 * Порядок причин — ОДИН на всё: по нему планируются блобы строк, по нему же раскладываются блоки
 * отказа. Второй порядок разошёлся бы с первым, и переход уехал бы в чужой текст (класс §3.35).
 */
export const COLLECTION_REFUSAL_KINDS: readonly CollectionRefusalKind[] = ['index', 'capacity', 'memory'];

/** Арность — ИЗ ОДНОГО ИСТОЧНИКА С ЭТАЛОНОМ (`src/runtime/vm/collectionCalls.ts`). */
const ARITY: Readonly<Record<string, number>> = COLLECTION_ARITY;

/** Размер слова заголовка и элемента — читается у рантайма массивов, а не заводится вторым числом. */
export const COLLECTION_WORD_REGISTER = ARRAY_REGISTERS.eight;
/** Нулевое смещение адреса — регистр рантайма массивов (читается, не заводится). */
export const COLLECTION_ZERO_REGISTER = ARRAY_REGISTERS.zero;

/**
 * Регистры, которые рантайм коллекций держит САМ, — регистры окна системного вызова.
 *
 * Берутся из кадра, а не из чисел: `%b[8]` и `%b[9]` — это `система.коллекция` лишь потому, что
 * `frame` вызова такой. Смена кадра (например, выращенное окно процедуры) обязана тянуть за собой и
 * этот список, иначе раскладка отдаст эти регистры под значение, и номер вызова затрёт чужое.
 *
 * ОТВЕТ `brk` и ЗАПРОШЕННАЯ ГРАНИЦА живут ровно здесь же: `brk` кладёт ответ в оконный ноль кадра, а
 * граница считается во втором оконном регистре — поэтому проверка ответа не требует ни одного
 * регистра сверх уже закреплённых.
 */
export function collectionReservedRegisters(frame: SyscallFrame = ENTRY_SYSCALL_FRAME): readonly number[] {
  return [syscallWindowOf(frame, 0), syscallWindowOf(frame, 1)];
}

/**
 * Регистры кадра, которые трогает РАСШИРЕНИЕ КУЧИ: ОТВЕТ `brk` и ЗАПРОШЕННАЯ ГРАНИЦА.
 *
 * Знает о них не только понижение, но и сопоставление пар (`src/e2k/predicatePairing.ts`): сравнение
 * «ответ < запрошенного» читает ИМЕННО их, и носитель без этой записи был бы барьером — пара не
 * составилась бы, и проверка ответа `brk` осталась бы без предиката (отказ `OSN-LOW-004`).
 *
 * Числа — кадра ТОЧКИ ВХОДА, и это не произвол: сайты коллекций строит `collectionGroups` именно в
 * нём (коллекции живут в точке входа, граница названа в шапке).
 */
export const COLLECTION_FRAME_REGISTERS: readonly number[] = [
  syscallWindowOf(ENTRY_SYSCALL_FRAME, 0),
  syscallWindowOf(ENTRY_SYSCALL_FRAME, 1),
];

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
    // ИМЕНА ВСЕ, А НЕ ТОЛЬКО РАЗВЁРНУТЫЕ: сайт `положить`/`взять` собирается из носителей и
    // системного вызова не делает, но резерв обязан быть взят и под него — иначе признак
    // «образ пользуется коллекциями» не сработал бы, и сайт остался бы без своих регистров.
    return (
      payload !== undefined &&
      payload.kind === 'imm' &&
      COLLECTION_CALL_NAMES.includes(invokeNames[payload.value] ?? '')
    );
  });
}

/** Какая операция у носителя — по ИМЕНИ из таблицы образа, а не по тексту программы. */
function callNameOf(carrier: AsmInstruction, invokeNames: readonly string[]): string | undefined {
  if (carrier.mnemonic !== 'IR.invoke') return undefined;
  const payload = carrier.operands[3];
  if (payload === undefined || payload.kind !== 'imm') return undefined;
  return invokeNames[payload.value];
}

/**
 * КАКАЯ ОПЕРАЦИЯ КАКУЮ ПРИЧИНУ ОТКАЗА ТРЕБУЕТ — ОДНА ТАБЛИЦА НА ВСЁ.
 *
 * Прежде это знание жило в ДВУХ местах: `collectionRefusalKinds` (какие тексты планировать) и
 * ветвление внутри `collectionGroups` (какие блоки дописывать). Разойдись они — переход вёл бы к
 * блоку, которого нет, либо блоб планировался бы без потребителя; и то и другое молча (класс §3.35).
 * Теперь оба читают ЭТУ таблицу, а согласованность её с текстами и порядком причин проверяет сторож
 * {@link collectionCauseProblems}.
 */
export const COLLECTION_SITE_CAUSES: Readonly<Record<CollectionSiteKind, readonly CollectionRefusalKind[]>> = {
  выделить: ['memory'],
  положить: ['index'],
  взять: ['index'],
  расширить: ['capacity', 'memory'],
};

/**
 * ИМЯ ОПЕРАЦИИ → ВИД САЙТА — тоже один источник.
 *
 * Диспетчер сборки сайтов и признак «какие причины нужны потоку» обязаны узнавать операцию
 * ОДИНАКОВО: разойдись они — сайт строился бы одной операцией, а тексты планировались под другую.
 */
const SITE_KIND_OF_CALL: Readonly<Record<string, CollectionSiteKind>> = {
  [COLLECTION_CALLS.allocate]: 'выделить',
  [COLLECTION_CALLS.put]: 'положить',
  [COLLECTION_CALLS.take]: 'взять',
  [COLLECTION_CALLS.resize]: 'расширить',
};

/**
 * СТОРОЖ ФОРМЫ: В АДРЕСНОЙ АРИФМЕТИКЕ КОЛЛЕКЦИЙ НЕТ `S`-ФОРМ.
 *
 * `adds`/`subs`/`muls`/`shls` — формы `S`: они пишут ТОЛЬКО МЛАДШУЮ половину приёмника, а старшая
 * остаётся ПРЕЖНЕЙ. Для адреса или границы кучи это младшие 32 бита вместо 64 — и не отказ, а тихая
 * ложь: адрес «верный», блок «выделен», память чужая.
 *
 * Так и было до 2026-10-03: `brkInstructions` клала и запрос, и ответ через `adds`, и спасало это
 * только поведение МОДЕЛИ (она отказывает на запросах от ~2 ГиБ, §3.101.4) — то есть соглашение
 * держалось совпадением, а не построением (случай 37 реестра проверяемости). Замер,
 * `.tmp/probe-addd-window.ts`: оконный приёмник у `addd` кодируется, форма та же ALF1 — 8 байт.
 *
 * Сторож стоит НА СБОРЩИКЕ (`brkInstructions`), а не только в тесте: нарушение обязано отказать там,
 * где последовательность собирается, — иначе оно снова уедет в образ и будет найдено замером через
 * недели. Сайты из носителей (`IR.add`) под него не попадают: у них своя, УЖЕ НАЗВАННАЯ 32-битная
 * адресация (§3.98.7), и это отдельная работа, а не эта правка.
 */
export function collectionFormProblems(instructions: readonly AsmInstruction[]): string[] {
  const problems: string[] = [];
  instructions.forEach((instruction, at) => {
    if (!['adds', 'subs', 'muls', 'shls', 'divs'].includes(instruction.mnemonic)) return;
    problems.push(
      `#${String(at)} ${instruction.mnemonic}: форма S пишет только МЛАДШУЮ половину приёмника, а ` +
        'старшая остаётся прежней — для адреса и границы кучи это младшие 32 бита вместо 64 ' +
        '(случай 37 реестра проверяемости). Адресная арифметика обязана быть формой D (`addd`)',
    );
  });
  return problems;
}

/**
 * СТОРОЖ СОГЛАСОВАННОСТИ ПРИЧИН: таблица операций, порядок причин и тексты — одно соответствие.
 *
 * Проверяется ТО, ЧТО НЕВИДИМО ГЛАЗАМИ и ломается молча:
 *
 * | что | чем ломается |
 * |---|---|
 * | у каждой причины есть текст | пропавший текст = блок отказа без строки (или чужая строка) |
 * | у каждого текста есть причина | лишний текст = блоб без потребителя (плата за ничто) |
 * | каждая причина КЕМ-ТО требуется | причина, которой не требует ни одна операция, — мёртвая ветвь |
 * | у каждой операции есть причины | операция без причины = отказ, который некуда направить |
 * | порядок причин без повторов | повтор сдвинул бы блоки: цель уехала бы в чужой текст |
 * | тексты РАЗНЫЕ | совпади они — различение причин стало бы мнимым (случай 34) |
 */
export function collectionCauseProblems(): string[] {
  const problems: string[] = [];
  const kinds = COLLECTION_REFUSAL_KINDS;
  for (const kind of kinds) {
    if (COLLECTION_REFUSAL_TEXTS[kind] === undefined) problems.push(`причина «${kind}» без текста`);
  }
  for (const kind of Object.keys(COLLECTION_REFUSAL_TEXTS) as CollectionRefusalKind[]) {
    if (!kinds.includes(kind)) problems.push(`текст причины «${kind}» есть, а в порядке причин её нет`);
  }
  if (new Set(kinds).size !== kinds.length) problems.push('в порядке причин есть повторы');
  const texts = kinds.map((kind) => COLLECTION_REFUSAL_TEXTS[kind]);
  if (new Set(texts).size !== texts.length) {
    problems.push('две причины названы ОДНИМ текстом — различение причин стало бы мнимым');
  }
  const siteKinds = Object.keys(COLLECTION_SITE_CAUSES) as CollectionSiteKind[];
  for (const site of siteKinds) {
    const causes = COLLECTION_SITE_CAUSES[site];
    if (causes === undefined || causes.length === 0) {
      problems.push(`операция «${site}» не назвала ни одной причины отказа`);
      continue;
    }
    for (const cause of causes) {
      if (!kinds.includes(cause)) problems.push(`операция «${site}» требует причину «${cause}», которой нет в порядке`);
    }
  }
  for (const kind of kinds) {
    if (!siteKinds.some((site) => COLLECTION_SITE_CAUSES[site].includes(kind))) {
      problems.push(`причину «${kind}» не требует НИ ОДНА операция — мёртвая ветвь`);
    }
  }
  return problems;
}

/**
 * Какие тексты отказа нужны ЭТОМУ потоку — по операциям, которые в нём есть.
 *
 * Один источник и для планирования блобов, и для раскладки блоков: список причин берётся из
 * {@link COLLECTION_SITE_CAUSES}, а не из второго похожего перечня.
 */
export function collectionRefusalKinds(
  code: readonly AsmInstruction[],
  invokeNames: readonly string[],
): readonly CollectionRefusalKind[] {
  const needed = new Set<CollectionRefusalKind>();
  for (const carrier of code) {
    const name = callNameOf(carrier, invokeNames);
    if (name === undefined) continue;
    const site = SITE_KIND_OF_CALL[name];
    if (site === undefined) continue;
    for (const cause of COLLECTION_SITE_CAUSES[site]) needed.add(cause);
  }
  return COLLECTION_REFUSAL_KINDS.filter((kind) => needed.has(kind));
}

/**
 * `brk(адрес)` — новое значение границы кучи; `brk(0)` возвращает текущее.
 *
 * Ряд — **измеренный** (§3.94): `movts` номера → кладка аргумента → `sdisp` → `call` → чтение ответа
 * из оконного нуля. Отличие от `memoryRuntime.brkInstructions` одно и оно названо в шапке модуля:
 * слагаемым идёт регистр нуля рантайма массивов, а не `%b[0]`.
 *
 * И АРГУМЕНТ, И ОТВЕТ ИДУТ `addd`, А НЕ `adds` (правка 2026-10-03), и это не стиль: `adds` — форма
 * `S`, то есть пишет только МЛАДШУЮ половину приёмника, а старшая остаётся ПРЕЖНЕЙ. Для `brk(0)` это
 * значило бы мусор в старших разрядах ЗАПРОСА, если в оконном регистре до этого лежала большая
 * граница (её считает `addd`-цепочка и она же уходит в тот же регистр); для ответа — мусор в старших
 * разрядах АДРЕСА БЛОКА. `addd` пишет обе половины, а оконный приёмник у него кодируется (замер
 * `.tmp/probe-addd-window.ts`: `addd %b[9], %b[12], %r9` → 8 байт, `01 00 00 04 89 0c 09 11`).
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
  const sequence: AsmInstruction[] = [
    ...(frame.setbn ? [a('setbn', [imm(ARRAY_WINDOW_RSZ), imm(0), imm(0)])] : []),
    a('movts', [imm(SYS_BRK), window_(syscallWindowOf(frame, 0))]),
    a('addd', [reg(options.address), reg(COLLECTION_ZERO_REGISTER), window_(syscallWindowOf(frame, 1))]),
    ...syscallCallOpen(frame),
    a('sdisp', [imm(1), imm(SYSCALL_TRAP)]),
    a('call', [imm(1), imm(frame.wbs)]),
    ...syscallCallClose(frame),
    // Ответ ядра лежит в оконном нуле ВЫЗЫВАЮЩЕГО (`linux-user/e2k/cpu_loop.c`), а `call` сдвигает
    // окно на `2·wbs` — значит читается он базовой формой из `%b[2·wbs]`, то есть из `frame.base`.
    a('addd', [syscallReplyRegister(frame), reg(COLLECTION_ZERO_REGISTER), reg(options.result)]),
  ];
  // СТОРОЖ ФОРМЫ — ЗДЕСЬ, А НЕ В ТЕСТЕ: нарушение обязано отказать там, где последовательность
  // собирается. Иначе оно уедет в образ и будет найдено замером через недели — так и было (`adds`
  // вместо `addd`, случай 37).
  const problems = collectionFormProblems(sequence);
  if (problems.length > 0) {
    throw new CollectionRuntimeRefusal(`brk: ${problems.join('; ')}`);
  }
  return sequence;
}

/**
 * РАСШИРЕНИЕ КУЧИ: блок из заголовка и `ёмкость` элементов, БЕЗ записи заголовка.
 *
 * ПОРЯДОК ЗДЕСЬ — ЧАСТЬ СМЫСЛА, а не стиль:
 *
 * 1. `brk(0)` даёт текущую границу кучи — это и есть база блока; она едет ПРЯМО в приёмник.
 * 2. Граница блока считается как `база + 8 + ёмкость·8` **в регистре-аргументе системного вызова**:
 *    второго временного регистра не нужно, потому что `×8` идёт удвоением `addd` с приёмником в
 *    конце цепочки, а не с отдельной копией входа.
 * 3. `brk(граница)` — РАСШИРЕНИЕ, и его ОТВЕТ остаётся в оконном нуле кадра: его сравнивает с
 *    запрошенной границей САЙТ (`collectionAllocSiteCarriers`). Заголовок пишется только ПОСЛЕ этой
 *    проверки: до неё `[база]` лежит за границей кучи, и запись туда — порча чужой памяти, а не
 *    заголовок.
 *
 * `ёмкость × 8` — тремя `addd` (удвоение), а не `shls`: `shls` в таблице МЦСТ есть, но прогоном не
 * проверен, а удвоение проверено (`arrayRuntime.ts`, шапка).
 */
export function collectionAllocInstructions(
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
    // 3. Расширение кучи до границы блока. ОТВЕТ не перекладывается: он уже в `answer`, и оттуда его
    //    читает проверка сайта. Заголовок пишет сайт — ПОСЛЕ проверки (см. `collectionAllocSiteCarriers`).
    ...brkInstructions({ address: argument, result: answer, frame }),
  ];
}

/**
 * Носитель САЙТА ВЫДЕЛЕНИЯ: `brk`-расширение кучи как ОДИН носитель.
 *
 * Операнды: `[ёмкость, приёмник]`. Расширяется он в {@link collectionAllocInstructions} — то есть в
 * те же команды, что раньше выпускало понижение, — и это не совпадение, а требование: форму (байты)
 * раскладка берёт ОТТУДА ЖЕ (`src/e2k/twoPassLayout.ts`).
 */
export const COLLECTION_ALLOC_CARRIER = 'IR.collection_alloc';

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
 * | `%b[10]` | `scratch2` | **ёмкость**, прочитанная из заголовка; в цикле — приёмник копии |
 * | `%b[11]` | `scratch` | **адрес элемента**; в цикле — сам элемент |
 * | `%b[13]` | единица | **ключ сравнения** (предикат) |
 *
 * Сайт держит их ВНУТРИ себя: ни одно значение не переживает сайт, поэтому соседний сайт массива
 * (`scratch`/`scratch2`) их не испортит — и наоборот.
 */
export const COLLECTION_CAPACITY_REGISTER = 10;
export const COLLECTION_ADDRESS_REGISTER = 11;
export const COLLECTION_KEY_REGISTER = 13;

/**
 * Регистры ЦИКЛА КОПИРОВАНИЯ — четыре, и все четыре уже наши.
 *
 * `источник` и `конец` — регистры окна системного вызова: они закреплены за рантаймом коллекций
 * ({@link collectionReservedRegisters}), а после проверки ответа `brk` в них уже нечего хранить.
 * `приёмник` и `элемент` — временные полосы массивов. Ни один регистр сверх закреплённых не нужен —
 * и это не украшение: каждый лишний пришлось бы отнимать у программы.
 */
export const COLLECTION_COPY_SOURCE_REGISTER = syscallWindowOf(ENTRY_SYSCALL_FRAME, 0);
export const COLLECTION_COPY_END_REGISTER = syscallWindowOf(ENTRY_SYSCALL_FRAME, 1);
export const COLLECTION_COPY_TARGET_REGISTER = COLLECTION_CAPACITY_REGISTER;
export const COLLECTION_COPY_ELEMENT_REGISTER = COLLECTION_ADDRESS_REGISTER;

/** Размер сайта чтения/записи в носителях — ОДИН на обе операции, и это не совпадение, а требование счёта. */
const SITE_SIZE = 7;
/** Размер сайта выделения: `brk`-носитель, сравнение, переход, заголовок. */
const ALLOC_SITE_SIZE = 4;
/** Размер сайта переезда: чтение ёмкости, две проверки, `brk`, заголовок, подготовка цикла, переход. */
const RESIZE_SITE_SIZE = 15;
/** Размер цикла копирования в носителях. */
const LOOP_SIZE = 8;

/** Операция, у которой есть САЙТ. */
export type CollectionSiteKind = 'выделить' | 'положить' | 'взять' | 'расширить';

/** Размер каждого сайта — ОДНИМ источником: по нему считаются абсолютные индексы хвоста потока. */
const SITE_SIZES: Readonly<Record<CollectionSiteKind, number>> = {
  выделить: ALLOC_SITE_SIZE,
  положить: SITE_SIZE,
  взять: SITE_SIZE,
  расширить: RESIZE_SITE_SIZE,
};

/**
 * САЙТ ВЫДЕЛЕНИЯ: `brk`-расширение, ПРОВЕРКА ОТВЕТА и заголовок.
 *
 * | шаг | носитель | что делает |
 * |---|---|---|
 * | 1 | `IR.collection_alloc` | `brk(0)` → приёмник; граница → оконный аргумент; `brk(граница)`; ответ → оконный ноль |
 * | 2 | `IR.ne [ключ, ответ, граница]` | «ответ НЕ РАВЕН запрошенной границе» — условие КАК ЕСТЬ |
 * | 3 | `IR.jmp_if [ключ, отказ]` | переход, если условие истинно (ядро не дало границу) |
 * | 4 | `IR.store [ёмкость, приёмник]` | заголовок блока: ёмкость в первые 8 байт |
 *
 * ПОЧЕМУ ПРОВЕРКА, А НЕ НАДЕЖДА: `brk` возвращает новую границу при успехе, и прежнюю (или `-ENOMEM`)
 * при отказе. Без сравнения «успех» и «отказ ядра» неотличимы: программа получает адрес, которого
 * нет, пишет в него заголовок — и падает исключением модели там, где обязан быть названный отказ.
 *
 * ПОЧЕМУ `NE`, А НЕ `LT`: успешный рост возвращает РОВНО запрошенное (измерено
 * `.tmp/probe-brk-limit.ts` на запросе `8192 + 0x1234` — сдвиг ровно на неё, без округления к
 * странице). Значит контракт — равенство, и `NE` ловит ОБЕ стороны расхождения: и `-ENOMEM`
 * (`answer < запрошенного`), и отказ на уменьшение, когда ядро оставляет прежнюю границу
 * (`answer > запрошенного`).
 *
 * ГДЕ ЭТО НАБЛЮДАЕТСЯ (замер 2026-10-03, `.tmp/probe-huge-alloc.ts`, прогон настоящих программ):
 *
 * | ёмкость | сдвиг границы | наблюдение |
 * |---|---|---|
 * | `2^24` | 128 МиБ | отказ НЕ срабатывает, программа кончается своим выходом |
 * | `2^28` | 2 ГиБ | **отказ СРАБАТЫВАЕТ**: код 231 и текст «куча не выросла — brk не дал запрошенную границу» |
 *
 * То есть сторона «проверка срабатывает» достижима НАСТОЯЩЕЙ программой, и подмены регистров для
 * этого не нужно.
 *
 * ЗАГОЛОВОК — ПОСЛЕ ПРОВЕРКИ. Это не порядок ради порядка: до неё запись по `[база]` уходит за
 * границу кучи, то есть в память, которой у программы нет.
 */
export function collectionAllocSiteCarriers(
  capacity: number,
  destination: number,
  memoryRefusal: number,
  frame: SyscallFrame = ENTRY_SYSCALL_FRAME,
): AsmInstruction[] {
  return [
    {
      mnemonic: COLLECTION_ALLOC_CARRIER,
      channel: 0,
      operands: [reg(capacity), reg(destination)],
    },
    {
      mnemonic: 'IR.ne',
      channel: 0,
      operands: [
        reg(COLLECTION_KEY_REGISTER),
        reg(syscallWindowOf(frame, 0)),
        reg(syscallWindowOf(frame, 1)),
      ],
    },
    { mnemonic: 'IR.jmp_if', channel: 0, operands: [reg(COLLECTION_KEY_REGISTER), imm(memoryRefusal)] },
    { mnemonic: STORE_CARRIER, channel: 0, operands: [reg(capacity), reg(destination)] },
  ];
}

/**
 * САЙТ ОПЕРАЦИИ ЧТЕНИЯ/ЗАПИСИ: проверка границы и обращение по вычисленному адресу.
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

/**
 * САЙТ ПЕРЕЕЗДА: `расширить(база, новая_ёмкость) → адрес`.
 *
 * | шаг | носитель | что делает |
 * |---|---|---|
 * | 1 | `IR.load [база, %b[10]]` | текущая ёмкость из заголовка СТАРОГО блока |
 * | 2–3 | `IR.lt`, `IR.jmp_if_not` | «текущая < новая» — иначе НАЗВАННЫЙ отказ (свой текст) |
 * | 4–7 | сайт выделения | новый блок, проверка ответа `brk`, заголовок = НОВАЯ ёмкость |
 * | 8–9 | `IR.add` ×2 | `источник = новая база + 8`, `приёмник = новая база + 8` |
 * | 10–13 | `IR.add` ×4 | `конец = старая база + 8 + текущая_ёмкость·8` |
 * | 14 | `IR.jmp [цикл]` | переход в цикл копирования (в конце потока) |
 *
 * ПОЧЕМУ КОНЕЦ СЧИТАЕТСЯ ОТ СТАРОЙ БАЗЫ, А НЕ ОТ ДЛИНЫ: длина копии — ТЕКУЩАЯ ЁМКОСТЬ, а она лежит в
 * заголовке и на сборке неизвестна. Указатель конца — единственный способ обойтись без счётчика:
 * сравнивать указатели (`источник < конец`) умеет `IR.lt`, а «сколько осталось» пришлось бы считать
 * ещё одним регистром.
 */
export function collectionResizeSiteCarriers(
  base: number,
  newCapacity: number,
  destination: number,
  refusal: { readonly capacity: number; readonly memory: number },
  loopIndex: number,
  frame: SyscallFrame = ENTRY_SYSCALL_FRAME,
): AsmInstruction[] {
  const capacity = COLLECTION_CAPACITY_REGISTER;
  const source = COLLECTION_COPY_SOURCE_REGISTER;
  const end = COLLECTION_COPY_END_REGISTER;
  const target = COLLECTION_COPY_TARGET_REGISTER;
  const eight = COLLECTION_WORD_REGISTER;
  const key = COLLECTION_KEY_REGISTER;
  const site: AsmInstruction[] = [
    { mnemonic: LOAD_CARRIER, channel: 0, operands: [reg(base), reg(capacity)] },
    { mnemonic: 'IR.lt', channel: 0, operands: [reg(key), reg(capacity), reg(newCapacity)] },
    { mnemonic: 'IR.jmp_if_not', channel: 0, operands: [reg(key), imm(refusal.capacity)] },
    ...collectionAllocSiteCarriers(newCapacity, destination, refusal.memory, frame),
    // РАЗДЕЛЕНИЕ ТРУДА С ЦИКЛОМ: сайт готовит указатели, цикл только копирует. Так у цикла три
    // входа-регистра и ни одного лишнего вычисления на каждой итерации.
    //
    // ИСТОЧНИК ИДЁТ ОТ СТАРОЙ БАЗЫ, приёмник — от новой: перепутать их значит скопировать блок в
    // СЕБЯ (и `источник < конец` окажется ложью сразу — цикл не сделает ни одного шага, а программа
    // промолчит: адрес верный, блок новый, элементы пусты).
    { mnemonic: 'IR.add', channel: 0, operands: [reg(source), reg(base), reg(eight)] },
    { mnemonic: 'IR.add', channel: 0, operands: [reg(end), reg(capacity), reg(capacity)] },
    { mnemonic: 'IR.add', channel: 0, operands: [reg(end), reg(end), reg(end)] },
    { mnemonic: 'IR.add', channel: 0, operands: [reg(end), reg(end), reg(end)] },
    { mnemonic: 'IR.add', channel: 0, operands: [reg(end), reg(end), reg(eight)] },
    { mnemonic: 'IR.add', channel: 0, operands: [reg(end), reg(end), reg(base)] },
    { mnemonic: 'IR.add', channel: 0, operands: [reg(target), reg(destination), reg(eight)] },
    { mnemonic: 'IR.jmp', channel: 0, operands: [imm(loopIndex)] },
  ];
  if (site.length !== RESIZE_SITE_SIZE) {
    throw new CollectionRuntimeRefusal(
      `сайт «расширить» длиной ${String(site.length)}, а счёт обещает ${String(RESIZE_SITE_SIZE)} — ` +
        'абсолютные индексы хвоста потока считались бы неверно',
    );
  }
  return site;
}

/**
 * ЦИКЛ КОПИРОВАНИЯ — ВОСЕМЬ носителей, и живёт он В КОНЦЕ ПОТОКА (почему — в шапке модуля).
 *
 * | шаг | носитель | что делает |
 * |---|---|---|
 * | 0–1 | `IR.lt [ключ, источник, конец]`, `IR.jmp_if_not [ключ, выход]` | «скопировано всё?» |
 * | 2 | `IR.load [источник, элемент]` | элемент из СТАРОГО блока |
 * | 3 | `IR.store [элемент, приёмник]` | он же в НОВЫЙ блок |
 * | 4–5 | `IR.add` ×2 | оба указателя — на слово вперёд |
 * | 6 | `IR.jmp [начало]` | назад, на шаг 0 |
 * | 7 | `IR.jmp [продолжение]` | за цикл: следующий носитель ЗА ВЫЗОВОМ |
 *
 * ВЫХОД ИЗ ЦИКЛА — ПЕРЕХОДОМ, а не «провалом»: за циклом стоит область блоков отказа, и провал в неё
 * означал бы, что успешный переезд печатает отказ.
 *
 * @param loopIndex абсолютный индекс первого носителя цикла (он же — цель обратного перехода)
 * @param continuation индекс носителя, с которого программа продолжается
 */
export function collectionCopyLoopCarriers(loopIndex: number, continuation: number): AsmInstruction[] {
  const source = COLLECTION_COPY_SOURCE_REGISTER;
  const end = COLLECTION_COPY_END_REGISTER;
  const target = COLLECTION_COPY_TARGET_REGISTER;
  const element = COLLECTION_COPY_ELEMENT_REGISTER;
  const eight = COLLECTION_WORD_REGISTER;
  const key = COLLECTION_KEY_REGISTER;
  const loop: AsmInstruction[] = [
    { mnemonic: 'IR.lt', channel: 0, operands: [reg(key), reg(source), reg(end)] },
    { mnemonic: 'IR.jmp_if_not', channel: 0, operands: [reg(key), imm(loopIndex + LOOP_SIZE - 1)] },
    { mnemonic: LOAD_CARRIER, channel: 0, operands: [reg(source), reg(element)] },
    { mnemonic: STORE_CARRIER, channel: 0, operands: [reg(element), reg(target)] },
    { mnemonic: 'IR.add', channel: 0, operands: [reg(source), reg(source), reg(eight)] },
    { mnemonic: 'IR.add', channel: 0, operands: [reg(target), reg(target), reg(eight)] },
    { mnemonic: 'IR.jmp', channel: 0, operands: [imm(loopIndex)] },
    { mnemonic: 'IR.jmp', channel: 0, operands: [imm(continuation)] },
  ];
  if (loop.length !== LOOP_SIZE) {
    throw new CollectionRuntimeRefusal(
      `цикл копирования длиной ${String(loop.length)}, а счёт обещает ${String(LOOP_SIZE)} — ` +
        'цели переходов хвоста потока считались бы неверно',
    );
  }
  return loop;
}

/** Что построилось по потоку носителей: группы для `expandCarriers`, счёт сайтов и НАЗВАННЫЕ причины. */
export interface CollectionPlan {
  readonly groups: ReadonlyMap<number, readonly AsmInstruction[]>;
  /** Сколько сайтов построено — для отчёта и сторожей. */
  readonly sites: number;
  /** Сколько блоков отказа дописано — их число входит в длину хвоста потока. */
  readonly blocks: number;
  /**
   * Причины, по которым сайт НЕ построен: их кладёт в отказы понижения конвейер
   * (`src/e2k/programImage.ts`). Отказ здесь НАЗВАН, а не пропущен молча: пропущенный сайт оставил бы
   * вызов в потоке, и он ушёл бы в понижение как «операция не развёрнута» — верное по букве и ЛОЖНОЕ
   * по причине.
   */
  readonly problems: readonly string[];
}

/** Что нужно знать сборке сайтов, кроме самого потока. */
export interface CollectionPlanOptions {
  /** Тексты отказов по причинам: их планирует `stringPlan`, сюда приходят адрес и длина. */
  readonly refusals?: Partial<Record<CollectionRefusalKind, RefusalBlob>>;
  /**
   * ГРАНИЦА ТОЧКИ ВХОДА: диапазон носителей `[from, to)`, где сайты вообще возможны.
   *
   * Коллекции живут в точке входа, и это не удобство, а следствие регистров: пролог ОБРАЗА заводит
   * `%b[12]`/`%b[13]`/`%b[14]`, а у вызываемой процедуры этих значений нет — там свои `%b[8..15]`.
   * Вызов коллекции в вызываемой обязан быть ОТКАЗОМ, а не тихой порчей чужого состояния.
   */
  readonly entryRange?: { readonly from: number; readonly to: number };
}

/**
 * ГРУППЫ САЙТОВ — тем же приёмом, что у арены (`arenaGroups`): картой групп, а не готовым потоком.
 *
 * Индексы и цели переходов пересчитывает `expandCarriers` (`src/e2k/procedureCall.ts`): свой счётчик
 * разошёлся бы с ним (класс §3.35).
 *
 * ХВОСТ ПОТОКА (циклы копирования и блоки отказа) дописывается СНАРУЖИ — группой последнего носителя,
 * как у арены. Его абсолютные индексы БОЛЬШЕ длины потока, поэтому пересчёт их не трогает; цели же на
 * носители ВНУТРИ потока выражаются ИСХОДНЫМИ индексами, и пересчёт сдвигает их вместе с потоком.
 * Оба свойства — не совпадение, а то, на чём держится вся эта раскладка.
 */
export function collectionGroups(
  code: readonly AsmInstruction[],
  invokeNames: readonly string[],
  options: CollectionPlanOptions = {},
): CollectionPlan {
  const problems: string[] = [];
  const sites: { readonly index: number; readonly kind: CollectionSiteKind }[] = [];
  code.forEach((carrier, index) => {
    const name = callNameOf(carrier, invokeNames);
    // Вид операции — из ТОЙ ЖЕ таблицы, что у признака нужных причин: второй диспетчер разошёлся бы
    // с первым молча (сайт строился бы одной операцией, а тексты планировались под другую).
    const kind = name === undefined ? undefined : SITE_KIND_OF_CALL[name];
    if (kind === undefined) return;
    const range = options.entryRange;
    if (range !== undefined && (index < range.from || index >= range.to)) {
      problems.push(
        `#${String(index)} ${name}: коллекции работают только в ТОЧКЕ ВХОДА, а вызов стоит в ` +
          'ВЫЗЫВАЕМОЙ процедуре — там свои %b[8..15], и пролог образа её регистров не заводил ' +
          '(граница названа в шапке src/e2k/collectionsRuntime.ts)',
      );
      return;
    }
    sites.push({ index, kind });
  });
  const expansion = sites.reduce((sum, site) => sum + (SITE_SIZES[site.kind] - 1), 0);
  // ── ХВОСТ ПОТОКА: сперва циклы, затем блоки отказа ────────────────────────────────────────────
  //
  // Порядок внутри хвоста — часть счёта: индексы блоков зависят от числа циклов перед ними.
  let cursor = code.length + expansion;
  const loopAt = new Map<number, number>();
  for (const site of sites) {
    if (site.kind !== 'расширить') continue;
    loopAt.set(site.index, cursor);
    cursor += LOOP_SIZE;
  }
  const blockAt = new Map<CollectionRefusalKind, number>();
  const blockCarriers: AsmInstruction[] = [];
  for (const kind of COLLECTION_REFUSAL_KINDS) {
    // Нужна ли причина — по ТОЙ ЖЕ таблице, что у признака нужных причин (`collectionRefusalKinds`):
    // две похожие ветви разошлись бы, и блок либо не дописался, либо остался без потребителя.
    const needed = sites.some((site) => COLLECTION_SITE_CAUSES[site.kind].includes(kind));
    if (!needed) continue;
    const blob = options.refusals?.[kind];
    if (blob === undefined) {
      // Это дефект КОНВЕЙЕРА, а не программы: причины отказов считает `collectionRefusalKinds`, и
      // блоб обязан быть запланирован для каждой. Молчаливый пропуск оставил бы переход в никуда.
      throw new LoweringRefusalError(
        LOWERING_CODES.runtime,
        `коллекции: причина отказа «${kind}» нужна потоку, а статический текст для неё не запланирован — ` +
          'это дефект конвейера (src/e2k/programImage.ts: план строк и `collectionRefusalKinds` разошлись)',
      );
    }
    blockAt.set(kind, cursor);
    blockCarriers.push(...refusalCarriers(blob.address, blob.byteLength));
    cursor += REFUSAL_BLOCK_SIZE;
  }
  // ── САЙТЫ ─────────────────────────────────────────────────────────────────────────────────────
  const groups = new Map<number, readonly AsmInstruction[]>();
  let built = 0;
  code.forEach((carrier, index) => {
    const site = sites.find((item) => item.index === index);
    if (site === undefined) return;
    const args = callArgumentOperands(carrier);
    const destination = carrier.operands[4];
    const first = args[0];
    const second = args[1];
    const third = args[2];
    const registerOf = (operand: Operand | undefined): number | undefined =>
      operand !== undefined && operand.kind === 'reg' ? operand.index : undefined;
    const refusalFor = (kind: CollectionRefusalKind): number | undefined => blockAt.get(kind);
    // Операнды не той формы — сайт НЕ строится, и причина называется здесь. Иначе носитель ушёл бы в
    // понижение, и отказ говорил бы «операция не развёрнута»: верное по букве, ложное по причине.
    const badForm = (what: string): void => {
      problems.push(`#${String(index)} коллекция.${site.kind}: ${what} — сайт не построен`);
    };
    try {
      switch (site.kind) {
        case 'выделить': {
          const capacity = registerOf(first);
          const target = registerOf(destination);
          const refusal = refusalFor('memory');
          if (capacity === undefined || target === undefined || refusal === undefined) {
            badForm('нужны регистр ёмкости, регистр-приёмник и блок отказа памяти');
            return;
          }
          checkRegister(reg(capacity), site.kind, 'ёмкость');
          checkRegister(reg(target), site.kind, 'приёмник');
          groups.set(index, collectionAllocSiteCarriers(capacity, target, refusal));
          built += 1;
          return;
        }
        case 'положить':
        case 'взять': {
          const base = registerOf(first);
          const offset = registerOf(second);
          const refusal = refusalFor('index');
          if (base === undefined || offset === undefined || refusal === undefined) {
            badForm('нужны регистр базы, регистр индекса и блок отказа границы');
            return;
          }
          checkRegister(reg(base), site.kind, 'база');
          checkRegister(reg(offset), site.kind, 'индекс');
          const value = registerOf(third);
          const target = registerOf(destination);
          if (site.kind === 'положить' && value === undefined) {
            badForm('нет регистра значения');
            return;
          }
          if (site.kind === 'взять' && target === undefined) {
            badForm('нет регистра-приёмника');
            return;
          }
          if (value !== undefined) checkRegister(reg(value), site.kind, 'значение');
          if (target !== undefined) checkRegister(reg(target), site.kind, 'приёмник');
          groups.set(
            index,
            collectionSiteCarriers(site.kind, base, offset, value ?? -1, target, refusal),
          );
          built += 1;
          return;
        }
        case 'расширить': {
          const base = registerOf(first);
          const capacity = registerOf(second);
          const target = registerOf(destination);
          const capacityRefusal = refusalFor('capacity');
          const memoryRefusal = refusalFor('memory');
          const loopIndex = loopAt.get(index);
          if (
            base === undefined ||
            capacity === undefined ||
            target === undefined ||
            capacityRefusal === undefined ||
            memoryRefusal === undefined ||
            loopIndex === undefined
          ) {
            badForm('нужны регистры базы и новой ёмкости, приёмник, два блока отказа и место цикла');
            return;
          }
          checkRegister(reg(base), site.kind, 'база');
          checkRegister(reg(capacity), site.kind, 'новая ёмкость');
          checkRegister(reg(target), site.kind, 'приёмник');
          groups.set(
            index,
            collectionResizeSiteCarriers(
              base,
              capacity,
              target,
              { capacity: capacityRefusal, memory: memoryRefusal },
              loopIndex,
            ),
          );
          built += 1;
          return;
        }
        default:
          return;
      }
    } catch (error) {
      // Отказ сторожа операндов (`checkRegister`) — это причина НЕ строить сайт; она обязана дойти до
      // наблюдателя текстом, а не исключением из середины сборки образа.
      badForm(error instanceof Error ? error.message : String(error));
      return;
    }
  });
  // ── ХВОСТ: циклы копирования и блоки отказа за последним носителем потока ──────────────────────
  const trailing: AsmInstruction[] = [];
  for (const site of sites) {
    const loopIndex = loopAt.get(site.index);
    if (loopIndex === undefined) continue;
    // ПРОДОЛЖЕНИЕ — следующий носитель ЗА ВЫЗОВОМ, выраженный ИСХОДНЫМ индексом: пересчёт сдвинет
    // его вместе с потоком. Если за вызовом ничего нет (вызов — последний носитель), продолжением
    // служит то, что стоит за циклом: программа, кончающаяся вызовом, обязана завершаться своим
    // выходом — та же граница, что у сайтов чтения/записи, упирающихся в тот же блок.
    const continuation = site.index + 1 < code.length ? site.index + 1 : loopIndex + LOOP_SIZE;
    trailing.push(...collectionCopyLoopCarriers(loopIndex, continuation));
  }
  trailing.push(...blockCarriers);
  if (trailing.length > 0 && code.length > 0) {
    const last = code.length - 1;
    const existing = groups.get(last);
    groups.set(last, existing === undefined ? [code[last]!, ...trailing] : [...existing, ...trailing]);
  }
  return { groups, sites: built, blocks: blockAt.size, problems };
}

/**
 * Сторож: операнд не смеет попасть в регистры рантайма.
 *
 * Зачем проверка, а не надежда: если раскладка не закрепила `%b[8]`/`%b[9]` (забыли добавить
 * `collectionReservedRegisters` в `reserved`), то номер системного вызова ляжет ПОВЕРХ значения — и
 * это не отказ, а тихая ложь. Отказ называется здесь, у причины.
 */
function checkRegister(operand: Operand, name: string, role: string, frame: SyscallFrame = ENTRY_SYSCALL_FRAME): void {
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
        'значит раскладка его не закрепила (`src/e2k/guards/loweredUnchecked.ts#loweredProgramUnchecked`, список `reserved`)',
    );
  }
}

/**
 * Понизить вызов коллекции в настоящие команды e2k.
 *
 * ЗДЕСЬ БОЛЬШЕ НЕ ПОНИЖАЕТСЯ НИ ОДНА ОПЕРАЦИЯ КОЛЛЕКЦИЙ, и это не регресс, а следствие: у всех
 * четырёх есть ПЕРЕХОД (проверка границы или ответа `brk`, а у переезда — ещё и цикл), а цель
 * перехода считается ДО раскладки (`expandCarriers`), тогда как понижение работает ПОСЛЕ. Значит
 * каждая операция разворачивается САЙТОМ носителей ({@link collectionGroups}), и носитель, дошедший
 * сюда, означает одно: сайт не построился, и причина уже названа (`CollectionPlan.problems`).
 *
 * Поэтому отказ говорит ИМЕННО это, а не «операция не развёрнута»: прежняя формулировка была верна по
 * букве и уводила от причины — искать надо не «не сделано», а «почему не построился сайт».
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
  if (args.length !== arity) {
    throw new CollectionRuntimeRefusal(`«${name}»: аргументов ${String(args.length)}, по источнику ${String(arity)}`);
  }
  args.forEach((operand, index) => checkRegister(operand, name, `аргумент ${index}`, frame));
  if (dst !== undefined) checkRegister(reg(dst), name, 'приёмник', frame);
  throw new CollectionRuntimeRefusal(
    `«${name}»: носитель остался БЕЗ САЙТА — операция разворачивается сайтом носителей (проверка границы ` +
      'и ответа `brk` — это переходы, а цель перехода считается до раскладки), и причина, по которой ' +
      'сайт не построился, названа в отказах планирования коллекций ' +
      '(src/e2k/collectionsRuntime.ts#collectionGroups, поле `problems`)',
  );
}
