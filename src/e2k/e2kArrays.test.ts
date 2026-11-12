/**
 * ОРАКУЛ РАНТАЙМА МАССИВОВ: ЗАМЕНА `IR.invoke` РЕАЛЬНЫМИ ОБРАЩЕНИЯМИ К ПАМЯТИ.
 *
 * # Зачем
 *
 * Массивы в регистровом IR — это хост-вызовы (`система.массив.*`), которые эмиттер превращает в
 * носитель `IR.invoke`. Пока они не заменены настоящими `ldd`/`std`, ядро FIR не собирается: 22
 * вызова из 111 инструкций (`docs/e2k-opcodes-real.md` §7). Форма памяти извлечена и **исполнена**
 * в модели (`src/e2k/e2kMemoryQemu.test.ts`) — значит есть чем заменить.
 *
 * # Семантика (из источника, не из головы)
 *
 * | вызов | арность | семантика | источник |
 * |---|---|---|---|
 * | `система.массив.создать` | 0 | пустой массив | `src/runtime/vm/invokeRegistry.ts:44`, `src/runtime/vm/interpreter.ts:30-31` |
 * | `система.массив.добавить` | 2 | дописать элемент, результата нет | `invokeRegistry.ts:45`, `interpreter.ts:32-36` |
 * | `система.массив.длина` | 1 | число элементов | `invokeRegistry.ts:49`, `interpreter.ts:63-64` |
 * | `система.массив.получить` | 2 | элемент по индексу | `invokeRegistry.ts:50`, `interpreter.ts:65-77` |
 *
 * # Соглашение рантайма (НАШЕ решение, названное)
 *
 * Массив — указатель на блок `[длина:8][элемент0:8][элемент1:8]…`. Адрес в e2k — **сумма двух
 * регистров** (`translate-al-c11.c:26-34`), поэтому «+8» и «×8» считаются командами. Отсюда
 * зарезервированные регистры (контракт: рантайм их пишет, чужой код туда не пишет):
 *
 * | регистр | что держит |
 * |---|---|
 * | `%b[15]` | указатель кучи (растёт вверх; двигают **обе** выделяющие операции) |
 * | `%b[14]` | 8 — размер элемента и заголовка |
 * | `%b[13]` | 1 — прирост длины на элемент |
 * | `%b[12]` | 0 — нулевое смещение для адреса |
 * | `%b[11]`, `%b[10]` | временные (рантайм их **портит**) |
 *
 * Умножение на 8 сделано **удвоением** (`addd`), а не `shls`: форма `addd` уже проверена в модели
 * (`.tmp/osnova-addd-probe.ts`), а `shls` — нет. Это выбор в пользу проверенного. Адрес считает
 * именно `addd` (формат `D`, регистр целиком), а не `adds` (формат `S`, младшая половина) —
 * причина и замер: `docs/hardware-debt.md` §3.27 и §3.30.
 *
 * # Чего рантайм НЕ делает (названные границы)
 *
 * - **границы не проверяются**: `получить` за пределами длины в модели даёт `null`
 *   (`interpreter.ts:70`), а наш `ldd` прочитает соседнюю память. Для ядер DSP индексы в границах
 *   по построению; проверка границ — отдельная работа (нужны сравнение и ветвление).
 * - `установить`, `удалить`, `срез`, строки и математика — **отказ с причиной**, а не молчание.
 */

import { describe, it, expect } from 'vitest';
import { getEncoder, type AsmInstruction, type Operand } from './backend';
import {
  ARRAY_REGISTERS,
  ARRAY_SLOT_CARRIER,
  ARRAY_WINDOW_RSZ,
  ARRAY_WINDOW_WSZ,
  ENTRY_ARRAY_BASE,
  arrayPrologue,
  arraySlotPrologue,
  checkArraySequence,
  lowerArrayCall,
  SUPPORTED_ARRAY_CALLS,
} from './arrayRuntime';

const encoder = getEncoder('e2k');
const reg = (index: number): Operand => ({ kind: 'reg', index });

/**
 * БАЗА БЛОКА — ОБЯЗАТЕЛЬНЫЙ АРГУМЕНТ ПОНИЖЕНИЯ С §3.128, и здесь она названа явно.
 *
 * `lowerArrayCall` без базы отказывает по имени («раскладка не выдала базу блока рантайма — обращение
 * ушло бы в чужие клетки»): без базы рантайм взял бы клетки ТОЧКИ ВХОДА, а в вызываемой они чужие
 * (§3.127 — тихий путь, закрытый сторожами). Этот файл меряет ПОСЛЕДОВАТЕЛЬНОСТИ команд, а не место
 * блока, поэтому берёт измеренную базу точки входа: клетки `%b[10..14]` — ровно те, именами которых
 * (`ARRAY_REGISTERS`) записаны ожидания ниже.
 */
const низвести = (
  имя: string,
  аргументы: readonly Operand[],
  приёмник: number | undefined,
): readonly AsmInstruction[] => lowerArrayCall(имя, аргументы, приёмник, { base: ENTRY_ARRAY_BASE });

/** Мнемоники последовательности — для читаемых ожиданий. */
const mnemonics = (instructions: readonly AsmInstruction[]): string[] =>
  instructions.map((instruction) => instruction.mnemonic);

describe('рантайм массивов: последовательности команд', () => {
  it('длина: одно чтение слова длины', () => {
    const sequence = низвести('система.массив.длина', [reg(1)], 2);
    expect(mnemonics(sequence)).toEqual(['ldd']);
    // Адрес = a + 0: база — сам массив, смещение — зарезервированный ноль.
    expect(sequence[0]!.operands).toEqual([
      reg(1),
      reg(ARRAY_REGISTERS.zero),
      reg(2),
    ]);
  });

  it('создать: взять указатель кучи из ЯЧЕЙКИ, обнулить длину, сдвинуть кучу на РЕЗЕРВ', () => {
    const sequence = низвести('система.массив.создать', [], 3);
    expect(mnemonics(sequence)).toEqual(['ldd', 'std', 'movts', 'addd', 'std']);
    // С A4 (§3.136) указатель кучи живёт в ЯЧЕЙКЕ ПАМЯТИ, а `%b[15]` несёт только её адрес:
    // первая команда читает значение кучи в приёмник (он и есть адрес блока), вторая пишет нулевую
    // длину, `movts` материализует резерв (TD-0013: заголовок + ёмкость), `addd` сдвигает ВРЕМЕННЫЙ,
    // последняя кладёт сдвинутое в ячейку. Приёмник НЕ сдвигается: иначе программа получила бы
    // указатель за словом длины.
    expect(sequence[0]!.operands[0], 'база чтения — адрес ячейки кучи').toEqual(reg(ARRAY_REGISTERS.heapSlot));
    expect(sequence[0]!.operands[2], 'приёмник — адрес блока').toEqual(reg(3));
    expect(sequence[1]!.mnemonic).toBe('std');
    expect(sequence[2]!.mnemonic, 'резерв ёмкости материализуется в клетку').toBe('movts');
    expect(sequence[3]!.operands[2], 'сдвигается временный, а не приёмник').not.toEqual(reg(3));
    expect(sequence[3]!.operands[1], 'сдвиг идёт на резерв, а не на роль «восемь»').toEqual(sequence[2]!.operands[1]);
    expect(sequence[4]!.operands[1], 'в ячейку').toEqual(reg(ARRAY_REGISTERS.heapSlot));
  });

  it('получить: индекс без сдвигов — удвоением, затем адрес и чтение', () => {
    const sequence = низвести('система.массив.получить', [reg(4), reg(5)], 6);
    // Три удвоения (×2, ×4, ×8), плюс заголовок, плюс база, затем чтение.
    expect(mnemonics(sequence)).toEqual(['addd', 'addd', 'addd', 'addd', 'addd', 'ldd']);
    expect(sequence.at(-1)!.operands[2], 'приёмник чтения').toEqual(reg(6));
  });

  it('добавить: обновить длину, вычислить адрес элемента, записать значение, сдвинуть кучу', () => {
    const sequence = низвести('система.массив.добавить', [reg(7), reg(8)], undefined);
    // чтение длины, +1, запись новой длины, три удвоения, заголовок, база, запись значения и сдвиг
    // указателя кучи на элемент (последняя команда — она и разводит блоки двух массивов).
    expect(mnemonics(sequence)).toEqual([
      'ldd', 'addd', 'std', 'addd', 'addd', 'addd', 'addd', 'addd', 'std', 'ldd', 'addd', 'std',
    ]);
    expect(sequence.at(-4)!.operands[0], 'записывается значение').toEqual(reg(8));
    // Сдвиг кучи с A4 (§3.136) — ТРИ команды: прочитать значение из ячейки, сдвинуть на размер
    // элемента, положить назад. Значение и ячейка не перепутаны с адресом записи (тот лежит в
    // scratch2 и в последних трёх командах не участвует как адрес).
    expect(sequence.at(-3)!.mnemonic, 'сдвиг кучи: чтение ячейки').toBe('ldd');
    expect(sequence.at(-3)!.operands[0]).toEqual(reg(ARRAY_REGISTERS.heapSlot));
    expect(sequence.at(-2)!.operands[1], 'сдвиг кучи: на размер элемента').toEqual(reg(ARRAY_REGISTERS.eight));
    expect(sequence.at(-1)!.mnemonic, 'сдвиг кучи: запись ячейки').toBe('std');
    expect(sequence.at(-1)!.operands[1]).toEqual(reg(ARRAY_REGISTERS.heapSlot));
  });

  it('создать и добавить согласованы: обе операции двигают кучи на размер своего блока', () => {
    // «Согласованы» здесь значит: за заголовок платит `создать`, за каждый элемент — `добавить`.
    // Иначе блоки массивов накладываются друг на друга (измерено: FIR 177 вместо 181, §12
    // `docs/e2k-regalloc-debt.md`).
    const create = низвести('система.массив.создать', [], 3);
    const append = низвести('система.массив.добавить', [reg(7), reg(8)], undefined);
    const advances = (sequence: readonly AsmInstruction[]): number =>
      sequence.filter(
        (instruction) =>
          instruction.mnemonic === 'std' &&
          instruction.operands[1]?.kind === 'reg' &&
          (instruction.operands[1] as { index: number }).index === ARRAY_REGISTERS.heapSlot,
      ).length;
    expect(advances(create), 'создать двигает кучи один раз — на заголовок').toBe(1);
    expect(advances(append), 'добавить двигает кучи один раз — на элемент').toBe(1);
    // И ни одна из них не двигает кучи дважды: двойной сдвиг — это «дыра» в куче, а не запас.
    expect(advances(create) + advances(append)).toBe(2);
  });

  it('каждая команда последовательностей кодируется нашим кодировщиком', () => {
    const problems: string[] = [];
    for (const name of SUPPORTED_ARRAY_CALLS) {
      // АРНОСТЬ БЕРЁТСЯ ИЗ ОПЕРАЦИИ, а не выводится тернарником: `установить` (три аргумента)
      // стал развёрнут 2026-10-02, и прежняя лестница «0 / 1 / иначе 2» дала бы ему два —
      // проверка упала бы на самом рантайме, а не на кодировщике, и упала бы ПО ЛОЖНОЙ причине.
      const arity =
        name === 'система.массив.создать' ? 0 : name === 'система.массив.длина' ? 1 : name === 'система.массив.установить' ? 3 : 2;
      const args = Array.from({ length: arity }, (_, index) => reg(index + 1));
      // Приёмник есть у всех, кроме `установить` и `добавить`: у них результат уходит в память,
      // и обещание приёмника — названный отказ, а не тихая подстановка.
      const producesValue = name !== 'система.массив.установить' && name !== 'система.массив.добавить';
      for (const instruction of низвести(name, args, producesValue ? 9 : undefined)) {
        try {
          encoder.encode(instruction);
        } catch (error) {
          problems.push(`${name}: «${instruction.mnemonic}» — ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    expect(problems, problems.join('; ')).toEqual([]);
  });
});

describe('рантайм массивов: пролог и контракт регистров', () => {
  it('пролог задаёт ноль, единицу, размер элемента и указатель кучи', () => {
    const prologue = arrayPrologue(0x102000);
    expect(mnemonics(prologue)).toEqual([
      'setwd', 'setbn', 'movts', 'movts', 'movts', 'movtd', 'movtd', 'std',
    ]);
    // Окно ставится ДВУМЯ командами, и это измерено на железе (§3.116): без `setwd` входное окно
    // `wsz = 4`, а `setbn rsz = 7` требует `rbs + rsz + 1 = 8 ≤ wsz` — окно негодно ЦЕЛИКОМ, и
    // падает первое же обращение (`movts … %b[12]` на 0x100008, код 139) — так падали все 38
    // образов кита. `wsz = 12` не минимум годности (хватило бы восьми), а ширина, при которой
    // вызываемая получает `2·(12 − 4) = 16` единиц — бюджет раскладки (`CALLEE_REGISTERS`);
    // замер различает значения: `8` даёт на модели 9 вместо 91, `12` — 91. Ширину `0xc` железо
    // принимает: она обычна у `bash`, `lcc`, `as`, `ld` (числа — в комментарии константы).
    expect(prologue[0]!.mnemonic, 'ширина окна ставится первой').toBe('setwd');
    expect(prologue[0]!.operands[0]).toEqual({ kind: 'imm', value: ARRAY_WINDOW_WSZ });
    expect(prologue[1]!.mnemonic, 'область вращения — сразу за шириной').toBe('setbn');
    expect(prologue[1]!.operands[0]).toEqual({ kind: 'imm', value: ARRAY_WINDOW_RSZ });
    expect(prologue[2]!.operands[1]).toEqual(reg(ARRAY_REGISTERS.zero));
    expect(prologue[3]!.operands[1], 'единица: длина растёт на элемент').toEqual(reg(ARRAY_REGISTERS.one));
    expect(prologue[4]!.operands[1]).toEqual(reg(ARRAY_REGISTERS.eight));
    expect(prologue[5]!.operands[1], 'адрес ячейки кучи — в %b[15]').toEqual(reg(ARRAY_REGISTERS.heapSlot));
    // Куча — внешняя ПАМЯТЬ, а не литерал: адрес ячейки 64-битный (форма 0xdc).
    expect(prologue[5]!.operands[0]!.kind).toBe('imm64');
    // Значение кучи кладётся В ЯЧЕЙКУ отдельным `movtd` (адрес начала кучи бывает и не 21-битным).
    expect(prologue[6]!.operands[0]!.kind, 'начало кучи — 64-битный литерал').toBe('imm64');
    expect(prologue[7]!.mnemonic, 'значение кучи ложится в ячейку').toBe('std');
    expect(prologue[7]!.operands[1]).toEqual(reg(ARRAY_REGISTERS.heapSlot));
    for (const instruction of prologue) encoder.encode(instruction);
  });

  it('зарезервированные регистры не пересекаются и не задеты операндами', () => {
    // Контракт: рантайм пишет только их, чужой код в них не пишет. Пересечение невозможно.
    const reserved = Object.values(ARRAY_REGISTERS);
    expect(new Set(reserved).size).toBe(reserved.length);
    // КЛЕТКИ САМОГО БЛОКА запрещены ЛЮБОЙ операции: она затёрла бы ноль/единицу/восемь или временную.
    // Сторона отказа с §3.128 называется «попал в блок рантайма массивов» — прежний сторож пропускал
    // аргументы ниже `RESERVED_FROM`, и они терялись молча (`src/e2k/arrayRuntime.ts#checkOperand`).
    expect(() => низвести('система.массив.длина', [reg(ARRAY_REGISTERS.zero)], 2)).toThrow(
      /попал в блок рантайма массивов/,
    );
    // АДРЕС ЯЧЕЙКИ КУЧИ запрещён только ВЫДЕЛЯЮЩИМ операциям (`создать`/`добавить` — те, что её
    // двигают; `src/e2k/arrayRuntime.ts`, `reservedCells`). `длина` её не пишет, и запрещать ей —
    // шире контракта; обе стороны названы, чтобы проверка не ослабла незаметно.
    expect(() => низвести('система.массив.создать', [], ARRAY_REGISTERS.heapSlot)).toThrow(
      /попал в блок рантайма массивов/,
    );
    expect(
      низвести('система.массив.длина', [reg(ARRAY_REGISTERS.heapSlot)], 2).length,
      '«длина» кучи не двигает — аргумент в её клетке допустим',
    ).toBe(1);
  });

  it('неподдержанные вызовы — отказ с причиной, а не молчание', () => {
    const unsupported = [
      'система.массив.установить',
      'система.массив.удалить',
      'система.массив.срез',
      'система.математика.остаток',
      'система.строка.объединить',
      'чепуха.вызов',
    ];
    for (const name of unsupported) {
      let thrown: Error | undefined;
      try {
        низвести(name, [reg(1), reg(2)], 3);
      } catch (error) {
        thrown = error as Error;
      }
      expect(thrown, `${name}: отказа не было`).toBeDefined();
      expect(thrown!.message.length, `${name}: причина не названа`).toBeGreaterThan(30);
    }
  });
});

describe('рантайм массивов: сторож последовательности (негативный контроль)', () => {
  it('снятый сдвиг кучи в «создать» ловится сторожем', () => {
    const honest = низвести('система.массив.создать', [], 3);
    expect(checkArraySequence('система.массив.создать', honest)).toEqual([]);
    // Дефект: указатель кучи не сдвинут — два массива лягут на один адрес.
    const broken = honest.filter((_, index) => index !== 2);
    const problems = checkArraySequence('система.массив.создать', broken);
    expect(problems.join(' '), 'снятый сдвиг кучи не пойман').toMatch(/куч/);
  });

  it('потерянная запись длины в «добавить» ловится сторожем', () => {
    const honest = низвести('система.массив.добавить', [reg(7), reg(8)], undefined);
    expect(checkArraySequence('система.массив.добавить', honest)).toEqual([]);
    // Дефект: длину не обновляем — следующий «добавить» перезапишет тот же элемент.
    const broken = honest.filter((instruction, index) => !(index === 2 && instruction.mnemonic === 'std'));
    const problems = checkArraySequence('система.массив.добавить', broken);
    expect(problems.join(' '), 'потерянная запись длины не поймана').toMatch(/длин/);
  });

  it('снятый сдвиг кучи в «добавить» ловится сторожем', () => {
    // Это ровно тот дефект, из-за которого FIR давал 177: без сдвига блок следующего массива
    // начинается на первом элементе этого.
    const honest = низвести('система.массив.добавить', [reg(7), reg(8)], undefined);
    expect(checkArraySequence('система.массив.добавить', honest)).toEqual([]);
    const broken = honest.slice(0, -1);
    const problems = checkArraySequence('система.массив.добавить', broken);
    expect(problems.join(' '), 'снятый сдвиг кучи не пойман').toMatch(/куч/);
  });
});

/**
 * СТОРОЖ ПРОЛОГА АДРЕСА ЯЧЕЙКИ КУЧИ (A4, срез 3, §3.137) — и ГРАНИЦЫ, которые он стережёт.
 *
 * Здесь три подмены, каждая из которых «собирается» и молчит: адрес уехал в другую клетку, в `%b[15]`
 * легло ЗНАЧЕНИЕ (регистр) вместо адреса, адрес дан коротким литералом. Негативный контроль — в этом
 * же файле (подмены строятся из честного пролога), а поведение границ спрашивается у модели в
 * `src/e2k/arrayCalleeCreate.test.ts`.
 */
describe('рантайм массивов: пролог адреса ячейки кучи (негативный контроль)', () => {
  const ЧЕСТНЫЙ = arraySlotPrologue(0x202000);

  it('честный пролог: одно `movtd` с 64-битным литералом в %b[15]', () => {
    expect(checkArraySequence(ARRAY_SLOT_CARRIER, ЧЕСТНЫЙ)).toEqual([]);
    expect(ЧЕСТНЫЙ.map((instruction) => instruction.mnemonic)).toEqual(['movtd']);
    expect(ЧЕСТНЫЙ[0]!.operands[1]).toEqual(reg(ARRAY_REGISTERS.heapSlot));
  });

  it('адрес уехал в другую клетку — поймано', () => {
    const broken = [{ ...ЧЕСТНЫЙ[0]!, operands: [ЧЕСТНЫЙ[0]!.operands[0]!, reg(12)] }];
    const problems = checkArraySequence(ARRAY_SLOT_CARRIER, broken);
    expect(problems.join(' '), 'чужая клетка не поймана').toMatch(/15|другой клетке/);
  });

  it('в %b[15] положено ЗНАЧЕНИЕ (регистр), а не адрес — поймано', () => {
    // «Значение вместо адреса» дальше выглядит обычной командой: `ldd`/`std` пошли бы по мусорному
    // адресу, и это тихая порча памяти, а не отказ.
    const broken = [{ ...ЧЕСТНЫЙ[0]!, operands: [reg(3), reg(ARRAY_REGISTERS.heapSlot)] }];
    const problems = checkArraySequence(ARRAY_SLOT_CARRIER, broken);
    expect(problems.join(' '), 'значение вместо адреса не поймано').toMatch(/imm64|ЛИТЕРАЛОМ/);
  });

  it('адрес дан коротким литералом (`movts`) — поймано', () => {
    const broken: AsmInstruction[] = [
      { mnemonic: 'movts', channel: 0, operands: [{ kind: 'imm', value: 0x202000 }, reg(ARRAY_REGISTERS.heapSlot)] },
    ];
    const problems = checkArraySequence(ARRAY_SLOT_CARRIER, broken);
    expect(problems.join(' '), 'короткий литерал не пойман').toMatch(/movtd|imm64/);
  });

  it('граница: `создать` в вызываемой БЕЗ пролога адреса — отказ по имени', () => {
    // Слово «адрес закреплён» даёт конвейер (`heapSlotReady`). Без слова `создать` в вызываемой
    // обязано отказать: `%b[15]` вызываемой — ЧУЖАЯ клетка (закон окна), и куча у процедур разошлась бы.
    let без: Error | undefined;
    try {
      lowerArrayCall('система.массив.создать', [], 3, { base: 12, inCallee: true });
    } catch (error) {
      без = error as Error;
    }
    expect(без, '`создать` в вызываемой без пролога прошло молча').toBeDefined();
    expect(без!.message, 'причина не названа').toMatch(/IR\.array_slot|ячейки кучи/);

    // А со словом — понижается, и приёмник не сдвигается (урок §3.136).
    const со = lowerArrayCall('система.массив.создать', [], 3, { base: 12, inCallee: true, heapSlotReady: true });
    expect(со.map((instruction) => instruction.mnemonic)).toEqual(['ldd', 'std', 'movts', 'addd', 'std']);
    expect(со[0]!.operands[0]).toEqual(reg(ARRAY_REGISTERS.heapSlot));
  });

  it('граница: `добавить` в вызываемой — отказ РАЗМЕРНЫЙ (пяти ролям нужно пять клеток)', () => {
    let отказ: Error | undefined;
    try {
      lowerArrayCall('система.массив.добавить', [reg(8), reg(9)], undefined, {
        base: 12,
        inCallee: true,
        heapSlotReady: true,
      });
    } catch (error) {
      отказ = error as Error;
    }
    expect(отказ, '`добавить` в вызываемой прошло').toBeDefined();
    expect(отказ!.message, 'причина не названа клетками').toMatch(/ТРИ клетки|пять/);
  });
});
