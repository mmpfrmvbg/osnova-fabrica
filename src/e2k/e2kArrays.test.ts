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
 * | `%b[62]` | указатель кучи (растёт вверх) |
 * | `%b[61]` | 8 — размер элемента и заголовка |
 * | `%b[60]` | 0 — нулевое смещение для адреса |
 * | `%b[59]`, `%b[58]` | временные (рантайм их **портит**) |
 *
 * Умножение на 8 сделано **удвоением** (`adds`), а не `shls`: форма `adds` уже проверена в модели
 * (`src/e2k/e2kWideQemu.test.ts`), а `shls` — нет. Это выбор в пользу проверенного.
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
  arrayPrologue,
  checkArraySequence,
  lowerArrayCall,
  SUPPORTED_ARRAY_CALLS,
} from './arrayRuntime';

const encoder = getEncoder('e2k');
const reg = (index: number): Operand => ({ kind: 'reg', index });

/** Мнемоники последовательности — для читаемых ожиданий. */
const mnemonics = (instructions: readonly AsmInstruction[]): string[] =>
  instructions.map((instruction) => instruction.mnemonic);

describe('рантайм массивов: последовательности команд', () => {
  it('длина: одно чтение слова длины', () => {
    const sequence = lowerArrayCall('система.массив.длина', [reg(1)], 2);
    expect(mnemonics(sequence)).toEqual(['ldd']);
    // Адрес = a + 0: база — сам массив, смещение — зарезервированный ноль.
    expect(sequence[0]!.operands).toEqual([
      reg(1),
      reg(ARRAY_REGISTERS.zero),
      reg(2),
    ]);
  });

  it('создать: взять указатель кучи, обнулить длину, сдвинуть кучу на заголовок', () => {
    const sequence = lowerArrayCall('система.массив.создать', [], 3);
    expect(mnemonics(sequence)).toEqual(['adds', 'std', 'adds']);
    // Первая команда кладёт указатель кучи в приёмник, вторая пишет нулевую длину, третья
    // двигает указатель кучи на слово заголовка.
    expect(sequence[0]!.operands[0]).toEqual(reg(ARRAY_REGISTERS.heap));
    expect(sequence[1]!.mnemonic).toBe('std');
    expect(sequence[2]!.operands[2]).toEqual(reg(ARRAY_REGISTERS.heap));
  });

  it('получить: индекс без сдвигов — удвоением, затем адрес и чтение', () => {
    const sequence = lowerArrayCall('система.массив.получить', [reg(4), reg(5)], 6);
    // Три удвоения (×2, ×4, ×8), плюс заголовок, плюс база, затем чтение.
    expect(mnemonics(sequence)).toEqual(['adds', 'adds', 'adds', 'adds', 'adds', 'ldd']);
    expect(sequence.at(-1)!.operands[2], 'приёмник чтения').toEqual(reg(6));
  });

  it('добавить: обновить длину, вычислить адрес элемента, записать значение', () => {
    const sequence = lowerArrayCall('система.массив.добавить', [reg(7), reg(8)], undefined);
    // чтение длины, +1, запись новой длины, три удвоения, заголовок, база, запись значения.
    expect(mnemonics(sequence)).toEqual(['ldd', 'adds', 'std', 'adds', 'adds', 'adds', 'adds', 'adds', 'std']);
    expect(sequence.at(-1)!.operands[0], 'записывается значение').toEqual(reg(8));
  });

  it('каждая команда последовательностей кодируется нашим кодировщиком', () => {
    const problems: string[] = [];
    for (const name of SUPPORTED_ARRAY_CALLS) {
      const arity = name === 'система.массив.создать' ? 0 : name === 'система.массив.длина' ? 1 : 2;
      const args = Array.from({ length: arity }, (_, index) => reg(index + 1));
      for (const instruction of lowerArrayCall(name, args, 9)) {
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
  it('пролог задаёт ноль, размер элемента и указатель кучи', () => {
    const prologue = arrayPrologue(0x102000);
    expect(mnemonics(prologue)).toEqual(['movts', 'movts', 'movtd']);
    expect(prologue[0]!.operands[1]).toEqual(reg(ARRAY_REGISTERS.zero));
    expect(prologue[1]!.operands[1]).toEqual(reg(ARRAY_REGISTERS.eight));
    expect(prologue[2]!.operands[1]).toEqual(reg(ARRAY_REGISTERS.heap));
    // Куча — внешняя память, а не литерал: адрес 64-битный (форма 0xdc).
    expect(prologue[2]!.operands[0]!.kind).toBe('imm64');
    for (const instruction of prologue) encoder.encode(instruction);
  });

  it('зарезервированные регистры не пересекаются и не задеты операндами', () => {
    // Контракт: рантайм пишет только их, чужой код в них не пишет. Пересечение невозможно.
    const reserved = Object.values(ARRAY_REGISTERS);
    expect(new Set(reserved).size).toBe(reserved.length);
    // Операция массива не имеет права принимать операнд из зарезервированной области: иначе она
    // затрёт указатель кучи или ноль.
    expect(() => lowerArrayCall('система.массив.длина', [reg(ARRAY_REGISTERS.heap)], 2)).toThrow(
      /зарезервирован/,
    );
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
        lowerArrayCall(name, [reg(1), reg(2)], 3);
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
    const honest = lowerArrayCall('система.массив.создать', [], 3);
    expect(checkArraySequence('система.массив.создать', honest)).toEqual([]);
    // Дефект: указатель кучи не сдвинут — два массива лягут на один адрес.
    const broken = honest.filter((_, index) => index !== 2);
    const problems = checkArraySequence('система.массив.создать', broken);
    expect(problems.join(' '), 'снятый сдвиг кучи не пойман').toMatch(/куч/);
  });

  it('потерянная запись длины в «добавить» ловится сторожем', () => {
    const honest = lowerArrayCall('система.массив.добавить', [reg(7), reg(8)], undefined);
    expect(checkArraySequence('система.массив.добавить', honest)).toEqual([]);
    // Дефект: длину не обновляем — следующий «добавить» перезапишет тот же элемент.
    const broken = honest.filter((instruction, index) => !(index === 2 && instruction.mnemonic === 'std'));
    const problems = checkArraySequence('система.массив.добавить', broken);
    expect(problems.join(' '), 'потерянная запись длины не поймана').toMatch(/длин/);
  });
});
