/**
 * ОРАКУЛ РАНТАЙМА КОЛЛЕКЦИЙ — БЕЗ МОДЕЛИ, И ЭТО НАМЕРЕННО.
 *
 * Здесь спрашивается то, что живёт **на нашем слое**: форма серии, её арифметика, отказ на операнд в
 * чужой области и совпадение ЭТАЛОНА языка с тем же правилом адресов. Прогон в QEMU спрашивает
 * другое — доходит ли это до цели (`src/e2k/collectionsBrkQemu.test.ts`, шлюз `gate:qemu`).
 *
 * Разделение не косметическое: оракул, которому нужен внешний ресурс, в полном прогоне стирает
 * различие «сломали» и «машина занята» (случай 12 реестра проверяемости).
 *
 * # Числа здесь не записаны, а ВЫВЕДЕНЫ
 *
 * Шаг блока (`8 + ёмкость·8`) берётся из тех же констант, что у понижения, а не из головы: разойдись
 * записанное число и правило — это находка, а не совпадение.
 */
import { describe, expect, it } from 'vitest';
import {
  COLLECTION_ALLOC_CARRIER,
  COLLECTION_CALLS,
  COLLECTION_FRAME_REGISTERS,
  COLLECTION_KEY_REGISTER,
  COLLECTION_REFUSAL_TEXTS,
  COLLECTION_SITE_CAUSES,
  COLLECTION_WORD_REGISTER,
  COLLECTION_ZERO_REGISTER,
  COLLECTION_REFUSAL_KINDS,
  CollectionRuntimeRefusal,
  brkInstructions,
  collectionAllocInstructions,
  collectionAllocSiteCarriers,
  collectionCauseProblems,
  collectionCopyLoopCarriers,
  collectionFormProblems,
  collectionGroups,
  collectionRefusalKinds,
  collectionReservedRegisters,
  collectionResizeSiteCarriers,
  collectionSiteCarriers,
  lowerCollectionCall,
  usesCollections,
} from './collectionsRuntime';
import { ARRAY_REGISTERS } from './arrayRuntime';
import { ENTRY_SYSCALL_FRAME, syscallWindowOf } from './syscallRuntime';
import { SYS_BRK } from './memoryRuntime';
import { createDefaultInvokeHandler, CollectionRefusal } from '../runtime/vm/interpreter';
import { COLLECTION_ARITY } from '../runtime/vm/collectionCalls';
import { isKnownInvoke } from '../runtime/vm/invokeRegistry';
import { LANGUAGE_REGISTRY } from '../compiler/language-registry';
import { expandCarriers } from './procedureCall';
import { carrierFormOf } from './twoPassLayout';
import type { AsmInstruction, Operand } from './backend';

const reg = (index: number): Operand => ({ kind: 'reg', index });
const imm = (value: number): Operand => ({ kind: 'imm', value });

/** Носитель `IR.invoke`: `[flags, arg0, arg1, payload, dst]` — раскладка оболочки, не наша выдумка. */
const invokeCarrier = (argc: number, args: readonly number[], payload: number, dst: number): AsmInstruction => ({
  mnemonic: 'IR.invoke',
  channel: 0,
  operands: [
    imm((argc << 1) | 1),
    reg(args[0] ?? 0),
    reg(args[1] ?? 0),
    imm(payload),
    reg(dst),
  ],
});

/** Индексы команд серии — по ним проверяется ПОРЯДОК, а не наличие. */
const callsOf = (instructions: readonly AsmInstruction[]): number[] =>
  instructions.map((instruction, index) => (instruction.mnemonic === 'call' ? index : -1)).filter((at) => at >= 0);

describe('коллекции на brk: серия выделения и её арифметика', () => {
  it('ПРЕДВАРИТЕЛЬНАЯ ПРОВЕРКА: заняты ВСЕ ШЕСТЬ регистров рантайма массивов, временные берутся не оттуда', () => {
    // Это тот замер, которым открывался заход. Он здесь, а не только в отчёте, потому что от него
    // зависит выбор регистров: если `%b[10]`/`%b[11]` когда-нибудь освободятся, решение можно
    // пересмотреть, и оракул об этом скажет.
    const занятые = Object.values(ARRAY_REGISTERS);
    expect([...занятые].sort((a, b) => a - b)).toEqual([10, 11, 12, 13, 14, 15]);
    // Ноль и восемь — ЧИТАЮТСЯ (нулевое смещение и размер слова), а не отбираются.
    expect(COLLECTION_ZERO_REGISTER).toBe(12);
    expect(COLLECTION_WORD_REGISTER).toBe(14);
    // Регистры рантайма коллекций — это регистры КАДРА вызова, и они обязаны лежать ВНЕ области
    // рантайма массивов (`%b[10..15]`): пересечения нет. Прежняя редакция проверяла потолок-число
    // («меньше 10»), и он вскрылся 2026-10-09, когда кадр пробовали перевезти на 16/17 (`wbs = 8`):
    // число устарело молча, а вместе с ним — и весь смысл проверки (кадр уходил ЗА потолок, оставаясь
    // верным). Теперь сравниваются САМИ регистры, и проверка переживает любой переезд кадра (§3.117).
    for (const register of collectionReservedRegisters()) {
      expect(Object.values(ARRAY_REGISTERS), `%r${String(register)} не в области рантайма массивов`).not.toContain(register);
    }
  });

  it('резерв — это регистры ОКНА СИСТЕМНОГО ВЫЗОВА, а не два числа, взятые с потолка', () => {
    expect(collectionReservedRegisters()).toEqual([
      syscallWindowOf(ENTRY_SYSCALL_FRAME, 0),
      syscallWindowOf(ENTRY_SYSCALL_FRAME, 1),
    ]);
  });

  it('`brk`: номер вызова, кладка аргумента 64-битная и чтение ответа из окна вызывающего', () => {
    const серия = brkInstructions({ address: 3, result: 5 });
    const номера = серия.filter((instruction) => instruction.mnemonic === 'movts' && instruction.operands[0]?.kind === 'imm');
    expect(номера[0]!.operands[0]).toEqual(imm(SYS_BRK));
    // СЛАГАЕМОЕ — регистр нуля рантайма массивов, а НЕ `%b[0]`: в настоящей программе `%b[0]` —
    // регистр раскладки, и адрес уехал бы на значение параметра (§3.95.5б).
    //
    // И команда — `addd`, а не `adds`: `adds` пишет только младшую половину, и старшая в приёмнике
    // осталась бы ПРЕЖНЕЙ — для `brk(0)` это мусор в старших разрядах запроса, если там до этого
    // лежала большая граница. Оконный приёмник у `addd` закодирован (замер `.tmp/probe-addd-window.ts`).
    const кладка = серия.find((instruction) => instruction.mnemonic === 'addd' && instruction.operands[0]?.kind === 'reg' && (instruction.operands[0] as { index: number }).index === 3);
    expect(кладка, 'аргумент кладётся `addd`').toBeDefined();
    expect(кладка!.operands[1], 'слагаемое — ноль рантайма').toEqual(reg(COLLECTION_ZERO_REGISTER));
    expect(кладка!.operands[1], 'и это НЕ %b[0]').not.toEqual(reg(0));
    // Последним шагом ответ читается базовой формой — после `ct` окно вернулось. Тоже `addd`:
    // `movts` оставил бы старшую половину адреса прежней.
    const последняя = серия.at(-1)!;
    expect(последняя.mnemonic).toBe('addd');
    expect(последняя.operands[0]).toEqual(reg(ENTRY_SYSCALL_FRAME.base));
    expect(последняя.operands[2], 'приёмник ответа').toEqual(reg(5));
  });

  it('ПОРЯДОК: расширение кучи идёт ДО записи заголовка — иначе [база] за границей кучи', () => {
    // ЗАГОЛОВОК ПИШЕТ САЙТ, А НЕ СЕРИЯ: до проверки ответа `brk` запись по `[база]` уходит за границу
    // кучи, поэтому серия кончается ответом ядра, а заголовок ставит ПОСЛЕДНИЙ носитель сайта.
    const серия = collectionAllocInstructions(4, 1);
    const звонки = callsOf(серия);
    expect(звонки, 'два системных вызова: brk(0) и brk(граница)').toHaveLength(2);
    expect(
      серия.some((instruction) => instruction.mnemonic === 'std'),
      'серия заголовок НЕ пишет — его ставит сайт после проверки',
    ).toBe(false);
    const сайт = collectionAllocSiteCarriers(4, 1, 42);
    expect(сайт, 'сайт выделения: расширение кучи, сравнение, переход, заголовок').toHaveLength(4);
    expect(сайт[0]!.mnemonic).toBe(COLLECTION_ALLOC_CARRIER);
    expect(сайт[1]!.mnemonic, 'сравнение ответа с запрошенной границей').toBe('IR.ne');
    expect(сайт[2]!.mnemonic, 'переход при отказе ядра').toBe('IR.jmp_if');
    expect(сайт[3]!.mnemonic, 'заголовок — ПОСЛЕДНИМ').toBe('IR.store');
    // Читаются ИМЕННО ответ `brk` и запрошенная граница — регистры кадра, а не выдуманные числа.
    expect(сайт[1]!.operands.slice(1)).toEqual(COLLECTION_FRAME_REGISTERS.map((index) => reg(index)));
    expect(сайт[1]!.operands[0], 'ключ предиката').toEqual(reg(COLLECTION_KEY_REGISTER));
    // ШОВ ПРОБЫ НЕ НУЖЕН: сторона «проверка срабатывает» достижима НАСТОЯЩЕЙ программой — замер
    // `.tmp/probe-huge-alloc.ts`: ёмкость 2^24 проходит, 2^28 даёт код 231 и текст отказа памяти.
    // Поэтому сравнение читает ровно те регистры, куда ответ и запрос кладёт сама последовательность.
    expect(сайт[1]!.operands[2], 'запрошенная граница — оконный аргумент кадра').toEqual(
      reg(COLLECTION_FRAME_REGISTERS[1]!),
    );
    // Приёмник базы — первым делом от `brk(0)`, то есть база блока известна сразу. У `addd`
    // приёмник ТРЕТИЙ (у `movts` был второй) — раскладка операндов у форм разная.
    // ЗАКРЫТИЕ ПУТИ ① (`setwd`) стоит СРАЗУ за `call`, поэтому ответ читается не «через одну команду»
    // от вызова, а через две. Ищем ПО ИМЕНИ, а не по смещению: вставка команд в кадр вызова не
    // должна ломать проверку смысла — иначе она стережёт номер строки, а не форму ответа.
    const чтениеОтвета = серия.slice(звонки[0]! + 1).find((command) => command.mnemonic === 'addd')!;
    expect(чтениеОтвета.mnemonic, 'ответ читается 64-битной формой').toBe('addd');
    expect(чтениеОтвета.operands[2]).toEqual(reg(1));
  });

  it('разность двух выделений — РОВНО 8 + ёмкость·8, и это видно в серии', () => {
    const ёмкость = 4;
    const ожидаемыйШаг = 8 + ёмкость * 8;
    const серия = collectionAllocInstructions(ёмкость, 1);
    // Прибавление слова заголовка — `addd` с регистром восьмёрки; без него шаг был бы `ёмкость·8`.
    const сЗаголовком = серия.filter(
      (instruction) =>
        instruction.mnemonic === 'addd' && instruction.operands.some((operand) => operand.kind === 'reg' && operand.index === COLLECTION_WORD_REGISTER),
    );
    expect(сЗаголовком, 'слово заголовка прибавляется ровно один раз').toHaveLength(1);
    expect(ожидаемыйШаг).toBe(40);
    // Удвоений до ×8 — три; вместе с заголовком и базой это пять `addd` — считаются МЕЖДУ двумя
    // вызовами `brk`: сами вызовы тоже кладут аргумент и читают ответ (`addd`), и в общий счёт они
    // не входят.
    const звонки = callsOf(серия);
    const междуВызовами = серия.slice(звонки[0]! + 1, звонки[1]!);
    // ЦЕПОЧКА — `addd` по БАЗОВЫМ регистрам: у кладки аргумента приёмник оконный, а чтение ответа
    // трогает `%b[frame.base]` — ни то, ни другое к арифметике адреса не относится.
    const цепочка = междуВызовами.filter(
      (instruction) =>
        instruction.mnemonic === 'addd' &&
        instruction.operands.every((operand) => operand.kind === 'reg' && operand.file === undefined) &&
        !instruction.operands.some((operand) => operand.kind === 'reg' && operand.index === ENTRY_SYSCALL_FRAME.base),
    );
    expect(цепочка, 'арифметика адреса: три удвоения, слово заголовка и база').toHaveLength(5);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: приёмник в регистре системного вызова — НАЗВАННЫЙ отказ, а не тихая порча', () => {
    // Без этой проверки номер системного вызова лёг бы ПОВЕРХ значения: не отказ, а тихая ложь.
    //
    // ЧИСЛА ЗДЕСЬ ЗАПИСАНЫ, А НЕ ВЗЯТЫ У ПРОВЕРЯЕМОЙ ФУНКЦИИ, и это исправление: первая редакция
    // шла циклом по `collectionReservedRegisters()`, и дефект 14.4 (функция возвращает пустой
    // список) делал проверку ПУСТОЙ — она зеленела, ничего не проверив. Полный стол контроля это
    // показал: запись 14.4 была поймана одной проверкой вместо двух (замер — стол, прогон 14.4).
    // Список обязан быть пришпилен числом, а его совпадение с кадром — отдельной проверкой выше.
    // ЧИСЛА 8/9 — ЭТО РЕГИСТРЫ КАДРА (`wbs = 4`), и они проверены выше сравнением с кадром.
    // 2026-10-09 кадр пробовали перевезти на 16/17 (`wbs = 8`) — тогда эта проверка покраснела, и
    // не из-за литерала: кадр оказался ВЫШЕ `RESERVED_FROM` (10), и первым срабатывал более широкий
    // отказ «приёмник в области рантайма массивов», а отдельная ветка про кадр становилась
    // недостижимой. Переезд откачен (модель ломается, §3.117.3), а находка записана — она вернётся
    // вместе с переработкой раскладки.
    for (const register of [8, 9]) {
      expect(() => lowerCollectionCall('система.коллекция.выделить', [reg(2)], register), `приёмник %b[${String(register)}]`).toThrow(
        CollectionRuntimeRefusal,
      );
      expect(() => lowerCollectionCall('система.коллекция.выделить', [reg(2)], register)).toThrow(/рантайм коллекций/u);
    }
    expect(() => lowerCollectionCall('система.коллекция.выделить', [reg(2)], 11)).toThrow(/зарезервирован|рантайм массивов/u);
    expect(() => lowerCollectionCall('система.коллекция.выделить', [reg(11)], 1)).toThrow(CollectionRuntimeRefusal);
  });

  it('СТОРОЖ ЛОЖНОГО ЗЕЛЁНОГО: текст отказа о НЕпостроенном сайте не смеет поминать границу', () => {
    // ЗАМЕР, ИЗ КОТОРОГО ЭТА ПРОВЕРКА РОДИЛАСЬ. Первая редакция отказа пересказывала подпись
    // («`положить(база, индекс, значение)` принимает три»), и оракул владельца немедленно позеленел
    // в контроле 1 — потому что тот ищет в отказах понижения `/ёмкост|индекс/`, а слово «индекс» из
    // ПЕРЕСКАЗА ПОДПИСИ этому соответствовало. Проверка границы индекса при этом НЕ существовала
    // вовсе: зелёное, ничего не проверяющее (класс случая 22).
    //
    // Сегодня отказ у ВСЕХ ЧЕТЫРЁХ операций один по существу: «носитель остался без сайта». Он не
    // имеет права звучать как отказ о ГРАНИЦЕ — иначе контроль владельца позеленеет на нём снова.
    for (const [name, argc] of [
      [COLLECTION_CALLS.allocate, 1],
      [COLLECTION_CALLS.put, 3],
      [COLLECTION_CALLS.take, 2],
      [COLLECTION_CALLS.resize, 2],
    ] as const) {
      let текст = '';
      try {
        lowerCollectionCall(name, Array.from({ length: argc }, () => reg(2)), 1);
      } catch (error) {
        текст = error instanceof Error ? error.message : String(error);
      }
      expect(текст, `${name}: отказ обязан быть назван`).not.toBe('');
      expect(текст, `${name}: отказ о сайте не смеет выглядеть как отказ о границе`).not.toMatch(/ёмкост|индекс/u);
      expect(текст, `${name}: причина — САЙТ, и она названа`).toMatch(/САЙТ/u);
    }
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: операции, которой нет, отказано С ПРИЧИНОЙ — и причина называет НАСТОЯЩЕЕ', () => {
    // `положить` принимает три аргумента, и с 2026-10-02 носитель их НЕСЁТ (`src/e2k/shell.ts#src3`).
    // Значит причина отказа — не арность: сегодня она в том, что операции нужен ПЕРЕХОД (проверка
    // границы, ответа `brk`, а у переезда — цикл копирования), а цель перехода считается до
    // раскладки, поэтому каждая операция разворачивается САЙТОМ носителей. Отказ обязан называть
    // ЭТО, иначе следующая сессия ищет причину заново.
    //
    // Первая редакция проверки требовала слов про предел носителя — и держала утверждение, которое
    // замер опроверг. Правило §2.5: замер против — утверждение снимается, а не защищается.
    for (const [name, argc] of [
      [COLLECTION_CALLS.put, 3],
      [COLLECTION_CALLS.take, 2],
      [COLLECTION_CALLS.resize, 2],
      [COLLECTION_CALLS.allocate, 1],
    ] as const) {
      expect(() => lowerCollectionCall(name, Array.from({ length: argc }, () => reg(2)), 1), `${name}: отказ обязан быть`).toThrow(
        /САЙТ/u,
      );
    }
    expect(() => lowerCollectionCall('система.массив.получить', [reg(1), reg(2)], 1)).toThrow(/нет такой операции/u);
  });

  it('СОГЛАСИЕ ФОРМЫ И ПОНИЖЕНИЯ: раскладка считает столько команд, сколько выдаст понижение', () => {
    // Разойдись они — уедут адреса после носителя, и молча (класс §3.35). Проверяется по ЧИСЛУ
    // команд, а не по байтам: байты серии — предмет отдельного сторожа (`layoutWideCrossCheck`).
    const серия = collectionAllocInstructions(4, 1);
    const форма = carrierFormOf(
      { mnemonic: COLLECTION_ALLOC_CARRIER, channel: 0, operands: [reg(2), reg(1)] },
      { invokeNames: ['система.коллекция.выделить'] },
    );
    expect(форма, 'у расширения кучи форма обязана быть — иначе носитель не размещается').toBeDefined();
    expect(форма!.commands).toHaveLength(серия.length);
    expect(форма!.commands.map((command) => command.mnemonic)).toEqual(серия.map((command) => command.mnemonic));
  });

  it('арность у ЦЕЛИ и у ЭТАЛОНА — ОДИН источник, а не две похожие таблицы', () => {
    // Разойдись они — вызов понижался бы на одной стороне и отвергался на другой, и это не отказ,
    // а расхождение двух эталонов: худший класс, потому что молчаливый.
    expect(COLLECTION_ARITY['система.коллекция.выделить']).toBe(1);
    expect(COLLECTION_ARITY['система.коллекция.положить']).toBe(3);
    expect(COLLECTION_ARITY['система.коллекция.взять']).toBe(2);
    expect(COLLECTION_ARITY['система.коллекция.расширить']).toBe(2);
    // ПРИЗНАК СТАЛ ИСТИНОЙ 2026-10-04: владелец ОБЪЯВИЛ эти четыре операции в каноне языка
    // (`SYSCALLS_V01`, `src/compiler/language-registry.ts`) — долг §3.105.5 закрыт, потому что из
    // v3 к ним не было ни одной дороги (цепочка из двух точек запрещена). Прежняя редакция этой
    // строки утверждала `false` и была ПРАВА, пока канон молчал; теперь она снята, а не подогнана
    // (§2.5) — и заменена на то, что обязано быть верным: имена ЗНАЕТ канон, и арность у канона,
    // у цели и у эталона — ОДНО число.
    expect(isKnownInvoke('система.коллекция.выделить'), 'канон языка операции объявляет').toBe(true);
    for (const имя of [COLLECTION_CALLS.allocate, COLLECTION_CALLS.put, COLLECTION_CALLS.take, COLLECTION_CALLS.resize]) {
      expect(LANGUAGE_REGISTRY.syscalls.find((с) => с.name === имя), `${имя} объявлено в каноне`).toBeDefined();
    }
  });

  it('ПРИЗНАК «образ пользуется коллекциями» — по имени вызова, а не по тексту программы', () => {
    const имена = ['система.коллекция.выделить'];
    expect(usesCollections([invokeCarrier(1, [2], 0, 1)], имена)).toBe(true);
    expect(usesCollections([invokeCarrier(1, [2], 0, 1)], ['система.массив.создать'])).toBe(false);
  });
});

/**
 * САЙТЫ И ХВОСТ ПОТОКА — БЕЗ МОДЕЛИ: здесь проверяется СЧЁТ ИНДЕКСОВ.
 *
 * Именно на нём стоит вся раскладка (`docs/hardware-debt.md` §3.35): сайт заменяет ОДИН носитель
 * группой, хвост дописывается за последним, а цели переходов — частью АБСОЛЮТНЫЕ (они больше длины
 * потока, и пересчёт их не трогает), частью ИСХОДНЫЕ индексы (их пересчёт обязан сдвинуть вместе с
 * потоком). Разойдись счёт — переход уедет в середину чужого кода, и это будет молча.
 */
describe('коллекции на brk: сайты, хвост потока и счёт индексов', () => {
  /** Имена вызовов образа — те же, что у конвейера: семантику несёт имя, а не код операции. */
  const имена = [COLLECTION_CALLS.allocate, COLLECTION_CALLS.put, COLLECTION_CALLS.resize];

  /** Носитель вызова с ТРЕМЯ аргументами: третий лежит в поле `src3` (`src/e2k/shell.ts`). */
  const invoke = (argc: number, args: readonly number[], payload: number, dst?: number): AsmInstruction => ({
    mnemonic: 'IR.invoke',
    channel: 0,
    operands: [
      imm((argc << 1) | (dst === undefined ? 0 : 1)),
      reg(args[0] ?? 0),
      reg(args[1] ?? 0),
      imm(payload),
      reg(dst ?? 0),
      ...(argc >= 3 ? [reg(args[2] ?? 0)] : []),
    ],
  });

  /**
   * Поток: `выделить(2)`, `положить(база, 3, 4)`, `расширить(база, 5)` и ЗАВЕРШЕНИЕ за ними.
   *
   * Завершение здесь не украшение: продолжение цикла копирования — это следующий носитель ЗА вызовом,
   * и без него проверять было бы нечего.
   */
  const поток = (): readonly AsmInstruction[] => [
    invoke(1, [2], 0, 1),
    invoke(3, [1, 3, 4], 1),
    invoke(2, [1, 5], 2, 6),
    { mnemonic: 'IR.ret', channel: 0, operands: [imm(0)] },
  ];

  /** Тексты-заглушки: здесь важны адреса, а не содержимое (тексты — предмет `stringPlan`). */
  const отказы = {
    index: { address: 0x100, byteLength: 3 },
    capacity: { address: 0x110, byteLength: 3 },
    memory: { address: 0x120, byteLength: 3 },
  };

  /** Расширение потока сайтами: `4−1` у выделения, `7−1` у записи, `15−1` у переезда. */
  const РАСШИРЕНИЕ = 3 + 6 + 14;

  it('ПРИЧИНЫ ОТКАЗА: их три, и каждая — свой текст', () => {
    // Контроль на сам оракул: совпади тексты — проверки ниже стали бы мнимыми (случай 34 именно так
    // и выглядел: строка была одна, и она называла ЧУЖОЙ механизм).
    const тексты = COLLECTION_REFUSAL_TEXTS;
    expect(new Set(Object.values(тексты)).size, 'три причины — три разных текста').toBe(3);
    expect(тексты.index).toBe('коллекция: индекс вне ёмкости блока');
    expect(тексты.capacity).toMatch(/ёмкост/u);
    expect(тексты.memory).toMatch(/brk|куч/u);
    // Какие причины нужны потоку — по операциям, которые в нём есть.
    expect(collectionRefusalKinds(поток(), имена)).toEqual(['index', 'capacity', 'memory']);
    expect(collectionRefusalKinds([invoke(1, [2], 0, 1)], имена), 'только выделение — только память').toEqual(['memory']);
    expect(collectionRefusalKinds([invoke(2, [1, 5], 2, 6)], имена), 'переезд — ёмкость и память').toEqual([
      'capacity',
      'memory',
    ]);
  });

  it('САЙТЫ И ХВОСТ: счёт сходится, хвост стоит за последним носителем', () => {
    const code = поток();
    const plan = collectionGroups(code, имена, {
      refusals: отказы,
      entryRange: { from: 0, to: code.length },
    });
    expect(plan.problems).toEqual([]);
    expect(plan.sites, 'три сайта: выделение, запись, переезд').toBe(3);
    expect(plan.blocks, 'три блока отказа — по одному на причину').toBe(3);
    // Сайт переезда: 15 носителей, и его шаги названы ПО СМЫСЛУ, а не по счёту.
    const site = plan.groups.get(2)!;
    expect(site, 'сайт переезда').toHaveLength(15);
    expect(site[0]!.mnemonic, 'чтение текущей ёмкости из заголовка').toBe('IR.load');
    expect(site[1]!.mnemonic, 'сравнение «текущая < новая»').toBe('IR.lt');
    expect(site[2]!.mnemonic, 'переход при «не больше текущей»').toBe('IR.jmp_if_not');
    expect(site[3]!.mnemonic, 'расширение кучи').toBe(COLLECTION_ALLOC_CARRIER);
    expect(site[6]!.mnemonic, 'заголовок с новой ёмкостью').toBe('IR.store');
    expect(site[14]!.mnemonic, 'переход в цикл копирования').toBe('IR.jmp');
    // ХВОСТ: группа последнего носителя = сам носитель плюс цикл (8) и три блока (по 2).
    const trailing = plan.groups.get(code.length - 1)!;
    expect(trailing).toHaveLength(1 + 8 + 6);
    expect(trailing[0]!.mnemonic, 'сам носитель остаётся первым').toBe('IR.ret');
    // Абсолютные индексы хвоста: он начинается ТАМ, где кончается поток после расширения сайтами.
    const start = code.length + РАСШИРЕНИЕ;
    const loop = trailing.slice(1, 9);
    expect(loop[0]!.mnemonic, 'начало цикла').toBe('IR.lt');
    expect(loop[1]!.operands[1], 'выход из цикла — за его пределы, а не «провалом»').toEqual(imm(start + 7));
    expect(loop[6]!.operands[0], 'назад, на начало цикла').toEqual(imm(start));
    expect(
      loop[7]!.operands[0],
      'продолжение — ИСХОДНЫЙ индекс следующего носителя: пересчёт обязан его сдвинуть',
    ).toEqual(imm(3));
    // Блоки — ПО ПОРЯДКУ ПРИЧИН, и каждый несёт СВОЙ текст: индекс, ёмкость, память.
    const blocks = trailing.slice(9);
    expect(blocks[0]!.operands[0], 'блок границы').toEqual(imm(отказы.index.address));
    expect(blocks[2]!.operands[0], 'блок ёмкости').toEqual(imm(отказы.capacity.address));
    expect(blocks[4]!.operands[0], 'блок памяти').toEqual(imm(отказы.memory.address));
    for (const at of [1, 3, 5]) expect(blocks[at]!.mnemonic, 'блок кончается выходом').toBe('IR.exit');
  });

  it('ПЕРЕСЧЁТ ИНДЕКСОВ: после `expandCarriers` цели ведут ровно туда, куда задумано', () => {
    // Это и есть проверка того, на чём стоит §3.35: АБСОЛЮТНЫЕ цели (хвост) пересчёт не трогает,
    // ИСХОДНЫЕ (продолжение за вызовом) — сдвигает вместе с потоком.
    const code = поток();
    const plan = collectionGroups(code, имена, { refusals: отказы });
    const expanded = expandCarriers(code, plan.groups).code;
    // Сайт переезда начинается за двумя сайтами: 2 + 3 + 6 = 11.
    const resizeAt = 2 + 3 + 6;
    expect(expanded[resizeAt]!.mnemonic).toBe('IR.load');
    const start = code.length + РАСШИРЕНИЕ;
    const blockAt = { index: start + 8, capacity: start + 10, memory: start + 12 };
    expect(expanded[resizeAt + 2]!.operands[1], '«не больше текущей» → блок ёмкости').toEqual(imm(blockAt.capacity));
    expect(expanded[resizeAt + 5]!.operands[1], 'ответ `brk` меньше запрошенного → блок памяти').toEqual(
      imm(blockAt.memory),
    );
    // И тот же счёт — у сайта выделения (он стоит первым, начало потока).
    expect(expanded[2]!.operands[1], 'ответ `brk` у выделения → блок памяти').toEqual(imm(blockAt.memory));
    // Продолжение цикла: ИСХОДНЫЙ индекс 3 пересчитан в фактическую позицию — 3 + 3 + 6 + 14 = 26.
    expect(expanded[start + 7]!.operands[0], 'продолжение — за вызовом, а не в хвосте').toEqual(imm(26));
    expect(expanded[start + 6]!.operands[0], 'обратный переход ведёт на начало цикла').toEqual(imm(start));
    // Тексты на месте: у каждого блока свой адрес.
    expect(expanded[blockAt.index]!.operands[0]).toEqual(imm(отказы.index.address));
    expect(expanded[blockAt.capacity]!.operands[0]).toEqual(imm(отказы.capacity.address));
    expect(expanded[blockAt.memory]!.operands[0]).toEqual(imm(отказы.memory.address));
  });

  it('ГРАНИЦА: вызов коллекции в ВЫЗЫВАЕМОЙ — названный отказ, а не тихая порча чужого состояния', () => {
    // Пролог образа заводит `%b[12]`/`%b[13]`/`%b[14]` в ТОЧКЕ ВХОДА; у вызываемой процедуры этих
    // значений нет, а её `%b[8..15]` — свои. Значит вызов коллекции там обязан быть ОТКАЗОМ.
    //
    // Граница взята так, что точка входа — ровно первый носитель: выделение в ней, два других вызова
    // «в вызываемой». Это и есть различающая пара: правило отказало ВЫБОРОЧНО, а не «всему потоку».
    const code = поток();
    const plan = collectionGroups(code, имена, { refusals: отказы, entryRange: { from: 0, to: 1 } });
    expect(plan.sites, 'построен только сайт из точки входа').toBe(1);
    expect(plan.groups.has(0), 'сайт выделения — в точке входа').toBe(true);
    expect(plan.problems, 'два вызова вне точки входа названы').toHaveLength(2);
    for (const reason of plan.problems) expect(reason).toMatch(/ТОЧКЕ ВХОДА/u);
    // Положительный контроль рядом: тот же поток с настоящей границей отказа НЕ даёт.
    const полный = collectionGroups(code, имена, { refusals: отказы, entryRange: { from: 0, to: code.length } });
    expect(полный.problems).toEqual([]);
    expect(полный.sites).toBe(3);
  });

  it('СЧЁТ САЙТА И ЦИКЛА — ОДНИМ ИСТОЧНИКОМ: длины названы, цели посчитаны', () => {
    // Счёт входит в абсолютные индексы хвоста: разойдись он с самим сайтом — переход уехал бы в
    // середину чужого кода (класс §3.35). Обе последовательности ПРОВЕРЯЮТ свой счёт сами и отказывают,
    // если он не сошёлся (страж внутри сборщиков); здесь он спрашивается снаружи — числом.
    const site = collectionResizeSiteCarriers(1, 5, 6, { capacity: 33, memory: 35 }, 27);
    expect(site, 'сайт переезда — пятнадцать носителей').toHaveLength(15);
    expect(site[0]!.operands[0], 'первым — чтение текущей ёмкости из заголовка').toEqual(reg(1));
    expect(site[2]!.operands[1], 'переход за ёмкостью ведёт в свой блок').toEqual(imm(33));
    expect(site[14]!.operands[0], 'сайт кончается переходом в цикл').toEqual(imm(27));
    const loop = collectionCopyLoopCarriers(27, 3);
    expect(loop, 'цикл — восемь носителей').toHaveLength(8);
    expect(loop[1]!.operands[1], 'выход из цикла — на его конец').toEqual(imm(34));
    expect(loop[6]!.operands[0], 'обратный переход — на начало').toEqual(imm(27));
    expect(loop[7]!.operands[0], 'продолжение — исходным индексом').toEqual(imm(3));
  });

  it('СТОРОЖ ФОРМЫ: в адресной арифметике коллекций НЕТ S-форм — и сторож это РАЗЛИЧАЕТ', () => {
    // Класс дефекта: `adds` (форма S) пишет только младшую половину приёмника, а старшая остаётся
    // прежней — для адреса это тихая ложь. Сторож обязан стоять там, где последовательность
    // собирается, и обязан ЛОВИТЬ подмену: без второго наблюдения «нарушений нет» означало бы
    // «сторож ничего не смотрит» (класс случая 22).
    expect(collectionFormProblems(brkInstructions({ address: 3, result: 5 })), 'серия `brk` чиста').toEqual([]);
    expect(collectionFormProblems(collectionAllocInstructions(4, 1)), 'серия выделения чиста').toEqual([]);
    const подмена = collectionFormProblems([
      { mnemonic: 'adds', channel: 0, operands: [reg(9), reg(12), reg(9)] },
      { mnemonic: 'addd', channel: 0, operands: [reg(9), reg(12), reg(9)] },
    ]);
    expect(подмена, 'S-форма поймана').toHaveLength(1);
    expect(подмена[0], 'и причина названа классом, а не «что-то не так»').toMatch(/МЛАДШУЮ половину/u);
    // И СТОРОЖ СТОИТ НА СБОРЩИКЕ: подмени в `brkInstructions` форму — сборщик откажет, а не отдаст
    // последовательность. Это проверяет негативный контроль 15.8 (стол), здесь — сама связь.
    expect(() => brkInstructions({ address: 3, result: 5 })).not.toThrow();
  });

  it('СТОРОЖ СОГЛАСОВАННОСТИ ПРИЧИН: таблица операций, порядок и тексты — одно соответствие', () => {
    expect(collectionCauseProblems(), 'таблица и тексты согласованы').toEqual([]);
    // Различающая сторона: сторож обязан видеть ЛИШНИЙ текст (блоб без потребителя) и ПОВТОР текста
    // (различение причин стало бы мнимым). Обе поломки — молчаливые, поэтому и нужен сторож.
    const kinds = [...COLLECTION_REFUSAL_KINDS];
    expect(kinds, 'три причины в порядке').toEqual(['index', 'capacity', 'memory']);
    const texts = kinds.map((kind) => COLLECTION_REFUSAL_TEXTS[kind]);
    expect(new Set(texts).size, 'тексты причин разные').toBe(texts.length);
    for (const site of Object.keys(COLLECTION_SITE_CAUSES) as (keyof typeof COLLECTION_SITE_CAUSES)[]) {
      expect(COLLECTION_SITE_CAUSES[site].length, `операция «${site}» назвала причины`).toBeGreaterThan(0);
    }
    // Каждая операция обслуживается ровно одним видом сайта — и это тот же источник, что у причин.
    expect(collectionRefusalKinds([invoke(1, [2], 0, 1)], имена)).toEqual(['memory']);
    expect(collectionRefusalKinds([invoke(3, [1, 3, 4], 1)], имена)).toEqual(['index']);
    expect(collectionRefusalKinds([invoke(2, [1, 5], 2, 6)], имена)).toEqual(['capacity', 'memory']);
  });

  it('САЙТ ЧТЕНИЯ/ЗАПИСИ: первые четыре шага ОДНИ, различие — последний', () => {
    const запись = collectionSiteCarriers('положить', 1, 3, 4, undefined, 99);
    const чтение = collectionSiteCarriers('взять', 1, 3, -1, 5, 99);
    expect(запись).toHaveLength(7);
    expect(чтение).toHaveLength(7);
    expect(запись.slice(0, 6).map((carrier) => carrier.mnemonic)).toEqual(чтение.slice(0, 6).map((carrier) => carrier.mnemonic));
    expect(запись[6]!.mnemonic, 'запись пишет').toBe('IR.store');
    expect(чтение[6]!.mnemonic, 'чтение читает').toBe('IR.load');
  });
});

describe('коллекции: ЭТАЛОН ЯЗЫКА (обе VM) — то же правило адресов, что у цели', () => {
  it('выделить и взять: значение читается ровно записанным, с любого места', async () => {
    const invoke = createDefaultInvokeHandler();
    const база = Number(await invoke('система.коллекция.выделить', [8]));
    await invoke('система.коллекция.положить', [база, 0, 11]);
    await invoke('система.коллекция.положить', [база, 7, 99]);
    expect(await invoke('система.коллекция.взять', [база, 0])).toBe(11);
    expect(await invoke('система.коллекция.взять', [база, 7])).toBe(99);
    // Незаписанный элемент — ноль: свежая страница кучи приходит от ядра нулевой.
    expect(await invoke('система.коллекция.взять', [база, 3])).toBe(0);
  });

  it('ШАГ АДРЕСА — ТО ЖЕ ПРАВИЛО, ЧТО У ЦЕЛИ: два выделения по 4 отстоят на 40', async () => {
    // Это и есть сверка «одно правило на двух сторонах»: у цели то же число спрашивается прогоном
    // (`src/e2k/collectionsBrkQemu.test.ts`), и здесь — у эталона. Правило записано ОДИН раз —
    // в константах блока, а не двумя похожими формулами.
    const invoke = createDefaultInvokeHandler();
    const первая = Number(await invoke('система.коллекция.выделить', [4]));
    const вторая = Number(await invoke('система.коллекция.выделить', [4]));
    expect(вторая - первая).toBe(40);
  });

  it('расширить: НОВЫЙ адрес, старые элементы целы, старая память не возвращается', async () => {
    const invoke = createDefaultInvokeHandler();
    const база = Number(await invoke('система.коллекция.выделить', [2]));
    await invoke('система.коллекция.положить', [база, 0, 5]);
    await invoke('система.коллекция.положить', [база, 1, 6]);
    const новая = Number(await invoke('система.коллекция.расширить', [база, 4]));
    expect(новая, 'переезд даёт НОВЫЙ адрес').not.toBe(база);
    expect(await invoke('система.коллекция.взять', [новая, 0])).toBe(5);
    expect(await invoke('система.коллекция.взять', [новая, 1])).toBe(6);
    await invoke('система.коллекция.положить', [новая, 3, 7]);
    expect(await invoke('система.коллекция.взять', [новая, 3])).toBe(7);
    expect(новая - база, 'новый блок встаёт сразу за старым — 8 + 2·8').toBe(24);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: индекс вне ёмкости — НАЗВАННЫЙ отказ, а НЕ null', async () => {
    const invoke = createDefaultInvokeHandler();
    const база = Number(await invoke('система.коллекция.выделить', [2]));
    await expect(invoke('система.коллекция.взять', [база, 5])).rejects.toThrow(CollectionRefusal);
    await expect(invoke('система.коллекция.взять', [база, 5])).rejects.toThrow(/ёмкост/u);
    await expect(invoke('система.коллекция.положить', [база, 2, 1])).rejects.toThrow(/индекс 2 вне ёмкости 2/u);
    // Положительный контроль обязателен: без него «отказ» не отличался бы от «сломано всё».
    expect(await invoke('система.коллекция.взять', [база, 1])).toBe(0);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: адрес не от выделения — названный отказ, а не молчание', async () => {
    const invoke = createDefaultInvokeHandler();
    await expect(invoke('система.коллекция.положить', [123456, 0, 1])).rejects.toThrow(/блока нет/u);
  });
});
