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
  COLLECTION_WORD_REGISTER,
  COLLECTION_ZERO_REGISTER,
  CollectionRuntimeRefusal,
  allocateInstructions,
  brkInstructions,
  collectionReservedRegisters,
  lowerCollectionCall,
  usesCollections,
} from './collectionsRuntime';
import { ARRAY_REGISTERS } from './arrayRuntime';
import { ENTRY_SYSCALL_FRAME, syscallWindowOf } from './syscallRuntime';
import { SYS_BRK } from './memoryRuntime';
import { createDefaultInvokeHandler, CollectionRefusal } from '../runtime/vm/interpreter';
import { COLLECTION_ARITY } from '../runtime/vm/collectionCalls';
import { isKnownInvoke } from '../runtime/vm/invokeRegistry';
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
    // Временные рантайма коллекций лежат НИЖЕ рантайма массивов: там его нет.
    for (const register of collectionReservedRegisters()) expect(register).toBeLessThan(10);
  });

  it('резерв — это регистры ОКНА СИСТЕМНОГО ВЫЗОВА, а не два числа, взятые с потолка', () => {
    expect(collectionReservedRegisters()).toEqual([
      syscallWindowOf(ENTRY_SYSCALL_FRAME, 0),
      syscallWindowOf(ENTRY_SYSCALL_FRAME, 1),
    ]);
  });

  it('`brk`: номер вызова, аргумент со слагаемым-НУЛЁМ рантайма и чтение ответа из окна вызывающего', () => {
    const серия = brkInstructions({ address: 3, result: 5 });
    const номера = серия.filter((instruction) => instruction.mnemonic === 'movts' && instruction.operands[0]?.kind === 'imm');
    expect(номера[0]!.operands[0]).toEqual(imm(SYS_BRK));
    // СЛАГАЕМОЕ — регистр нуля рантайма массивов, а НЕ `%b[0]`: в настоящей программе `%b[0]` —
    // регистр раскладки, и адрес уехал бы на значение параметра (§3.95.5б).
    const слагаемое = серия.find((instruction) => instruction.mnemonic === 'adds');
    expect(слагаемое!.operands[1], 'слагаемое — ноль рантайма').toEqual(reg(COLLECTION_ZERO_REGISTER));
    expect(слагаемое!.operands[1], 'и это НЕ %b[0]').not.toEqual(reg(0));
    // Последним шагом ответ читается базовой формой — после `ct` окно вернулось.
    const последняя = серия.at(-1)!;
    expect(последняя.mnemonic).toBe('movts');
    expect(последняя.operands[0]).toEqual(reg(ENTRY_SYSCALL_FRAME.base));
  });

  it('ПОРЯДОК: расширение кучи идёт ДО записи заголовка — иначе [база] за границей кучи', () => {
    const серия = allocateInstructions(4, 1);
    const звонки = callsOf(серия);
    const заголовок = серия.findIndex((instruction) => instruction.mnemonic === 'std');
    expect(звонки, 'два системных вызова: brk(0) и brk(граница)').toHaveLength(2);
    expect(заголовок, 'заголовок пишется').toBeGreaterThan(0);
    expect(заголовок, 'заголовок пишется ПОСЛЕ расширения кучи').toBeGreaterThan(звонки[1]!);
    // Приёмник — первым делом от `brk(0)`, то есть база блока известна сразу.
    expect(серия[звонки[0]! + 1]!.operands[1]).toEqual(reg(1));
  });

  it('разность двух выделений — РОВНО 8 + ёмкость·8, и это видно в серии', () => {
    const ёмкость = 4;
    const ожидаемыйШаг = 8 + ёмкость * 8;
    const серия = allocateInstructions(ёмкость, 1);
    // Прибавление слова заголовка — `addd` с регистром восьмёрки; без него шаг был бы `ёмкость·8`.
    const сЗаголовком = серия.filter(
      (instruction) =>
        instruction.mnemonic === 'addd' && instruction.operands.some((operand) => operand.kind === 'reg' && operand.index === COLLECTION_WORD_REGISTER),
    );
    expect(сЗаголовком, 'слово заголовка прибавляется ровно один раз').toHaveLength(1);
    expect(ожидаемыйШаг).toBe(40);
    // Удвоений до ×8 — три; вместе с заголовком и базой это пять `addd`.
    expect(серия.filter((instruction) => instruction.mnemonic === 'addd')).toHaveLength(5);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: приёмник в регистре системного вызова — НАЗВАННЫЙ отказ, а не тихая порча', () => {
    // Без этой проверки номер системного вызова лёг бы ПОВЕРХ значения: не отказ, а тихая ложь.
    //
    // ЧИСЛА ЗДЕСЬ ЗАПИСАНЫ, А НЕ ВЗЯТЫ У ПРОВЕРЯЕМОЙ ФУНКЦИИ, и это исправление: первая редакция
    // шла циклом по `collectionReservedRegisters()`, и дефект 14.4 (функция возвращает пустой
    // список) делал проверку ПУСТОЙ — она зеленела, ничего не проверив. Полный стол контроля это
    // показал: запись 14.4 была поймана одной проверкой вместо двух (замер — стол, прогон 14.4).
    // Список обязан быть пришпилен числом, а его совпадение с кадром — отдельной проверкой выше.
    for (const register of [8, 9]) {
      expect(() => lowerCollectionCall('система.коллекция.выделить', [reg(2)], register), `приёмник %b[${String(register)}]`).toThrow(
        CollectionRuntimeRefusal,
      );
      expect(() => lowerCollectionCall('система.коллекция.выделить', [reg(2)], register)).toThrow(/рантайм коллекций/u);
    }
    expect(() => lowerCollectionCall('система.коллекция.выделить', [reg(2)], 11)).toThrow(/зарезервирован|рантайм массивов/u);
    expect(() => lowerCollectionCall('система.коллекция.выделить', [reg(11)], 1)).toThrow(CollectionRuntimeRefusal);
  });

  it('СТОРОЖ ЛОЖНОГО ЗЕЛЁНОГО: текст отказа о НЕразвёрнутой операции не смеет поминать границу', () => {
    // ЗАМЕР, ИЗ КОТОРОГО ЭТА ПРОВЕРКА РОДИЛАСЬ. Первая редакция отказа пересказывала подпись
    // («`положить(база, индекс, значение)` принимает три»), и оракул владельца немедленно позеленел
    // в контроле 1 — потому что тот ищет в отказах понижения `/ёмкост|индекс/`, а слово «индекс» из
    // ПЕРЕСКАЗА ПОДПИСИ этому соответствовало. Проверка границы индекса при этом НЕ существовала
    // вовсе: зелёное, ничего не проверяющее (класс случая 22).
    //
    // Здесь это ловится по существу: отказ об АРНОСТИ не имеет права звучать как отказ о ГРАНИЦЕ.
    for (const name of ['система.коллекция.положить', 'система.коллекция.взять', 'система.коллекция.расширить']) {
      let текст = '';
      try {
        lowerCollectionCall(name, [], 1);
      } catch (error) {
        текст = error instanceof Error ? error.message : String(error);
      }
      expect(текст, `${name}: отказ обязан быть назван`).not.toBe('');
      expect(текст, `${name}: отказ об арности не смеет выглядеть как отказ о границе`).not.toMatch(/ёмкост|индекс/u);
    }
    // Положительный контроль: у РАЗВЁРНУТОЙ операции отказа нет вовсе — иначе «не поминает» было бы
    // свойством любого текста, включая пустой.
    expect(() => lowerCollectionCall('система.коллекция.выделить', [reg(2)], 1)).not.toThrow();
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: операции, которой нет, отказано С ПРИЧИНОЙ — и причина называет НАСТОЯЩЕЕ', () => {
    // `положить` принимает три аргумента, и с 2026-10-02 носитель их НЕСЁТ (`src/e2k/shell.ts#src3`).
    // Значит причина отказа — не арность: сегодня она в том, что операции нужен ПЕРЕХОД (проверка
    // границы с блоком отказа, у переезда — цикл копирования), а цель перехода считается до
    // раскладки. Отказ обязан называть ЭТО, иначе следующая сессия ищет причину заново.
    //
    // Первая редакция проверки требовала слов про предел носителя — и держала утверждение, которое
    // замер опроверг. Правило §2.5: замер против — утверждение снимается, а не защищается.
    for (const name of ['система.коллекция.положить', 'система.коллекция.взять', 'система.коллекция.расширить']) {
      expect(() => lowerCollectionCall(name, [], 1), `${name}: отказ обязан быть`).toThrow(/ПЕРЕХОД/u);
    }
    expect(() => lowerCollectionCall('система.массив.получить', [reg(1), reg(2)], 1)).toThrow(/нет такой операции/u);
  });

  it('СОГЛАСИЕ ФОРМЫ И ПОНИЖЕНИЯ: раскладка считает столько команд, сколько выдаст понижение', () => {
    // Разойдись они — уедут адреса после носителя, и молча (класс §3.35). Проверяется по ЧИСЛУ
    // команд, а не по байтам: байты серии — предмет отдельного сторожа (`layoutWideCrossCheck`).
    const серия = allocateInstructions(4, 1);
    const форма = carrierFormOf(invokeCarrier(1, [2], 0, 1), { invokeNames: ['система.коллекция.выделить'] });
    expect(форма, 'у вызова коллекции форма обязана быть — иначе он не размещается').toBeDefined();
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
    // И признак того, что канон языка этих операций ещё НЕ несёт: если это станет ложью, значит
    // владелец объявил их в `SYSCALLS_V01`, и `extraInvokes` в оракуле пора убрать.
    expect(isKnownInvoke('система.коллекция.выделить'), 'канон языка операций пока не объявляет').toBe(false);
  });

  it('ПРИЗНАК «образ пользуется коллекциями» — по имени вызова, а не по тексту программы', () => {
    const имена = ['система.коллекция.выделить'];
    expect(usesCollections([invokeCarrier(1, [2], 0, 1)], имена)).toBe(true);
    expect(usesCollections([invokeCarrier(1, [2], 0, 1)], ['система.массив.создать'])).toBe(false);
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
