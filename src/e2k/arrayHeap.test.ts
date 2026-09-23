/**
 * ОРАКУЛ КУЧИ: ДВА МАССИВА НЕ ПЕРЕСЕКАЮТСЯ.
 *
 * # Дефект, ради которого это написано
 *
 * Измерено в QEMU (`src/e2k/e2kArraysQemu.test.ts`, `docs/e2k-regalloc-debt.md` §12): FIR даёт **177**
 * вместо 181, и остаток −4 — не планировщик. Причина в рантайме массивов: `система.массив.создать`
 * сдвигает указатель кучи (`%b[15]`) на одно слово заголовка, а `система.массив.добавить` **не
 * сдвигает его вовсе**. Значит блок ВТОРОГО массива ложится на первый элемент ПЕРВОГО: для
 * `вход = [3,1,4,1,5,9,2,6]` и `коэффициенты = [1,2,3,4]` память становится
 * `[8, 4,1,2,3,4, 9,2,6]`, и `получить(вход, i)` при i = 0…7 даёт `4,1,2,3,4,9,2,6`.
 *
 * # Что проверяется здесь
 *
 * Инвариант, а не число: **блоки двух массивов не пересекаются**. Проверка не требует QEMU: команды
 * понижения (`adds`/`std`/`ldd` из `lowerArrayCall`) исполняются на **модели памяти** этого файла —
 * регистры и адреса, — поэтому видно каждый записанный адрес и каждый прочитанный элемент.
 *
 *   пролог → `создать(a)` → `добавить(a, 5)` → `создать(b)` → `добавить(b, 7)` → `получить(a, 0)`
 *
 * Адреса, записанные при построении `a`, не должны пересекаться с адресами, записанными при
 * построении `b`; `получить(a, 0)` обязан вернуть 5, `получить(b, 0)` — 7.
 *
 * # Негативный контроль
 *
 * До правки рантайма проверка **красная** (блок `b` начинается на первом элементе `a`), после правки
 * — зелёная. Снятие правки (удаление сдвига кучи из `добавить`) снова краснит: см. `e2kArrays.test.ts`,
 * «сторож последовательности», и §11 `docs/e2k-regalloc-debt.md` о дисциплине контроля.
 *
 * # Чего оракул НЕ проверяет
 *
 * Что так поведёт себя железо: это модель команд, а не исполнение. Два массива, растущие
 * **вперемежку** (`создать(a); создать(b); добавить(a, …); добавить(b, …)`) — отдельный замер: блок
 * `a` растёт вперёд и упирается в блок `b`, потому что куча выделяет блок при `создать`, а не при
 * `добавить` (у массива нет «резерва» под будущие элементы). Это ограничение названо замером ниже.
 */

import { describe, it, expect } from 'vitest';
import { ARRAY_REGISTERS, arrayPrologue, lowerArrayCall } from './arrayRuntime';
import type { AsmInstruction, Operand } from './backend';

const reg = (index: number): Operand => ({ kind: 'reg', index });

/** Куча в модели — внешняя страница, как в прогоне (`e2kArraysQemu.test.ts`). */
const HEAP = 0x102000;

/**
 * Модель понижённых команд: регистры и память по адресам.
 *
 * Порядок операндов взят из источника и из `arrayRuntime.ts`: `adds src1, src2, dst`,
 * `ldd база, смещение, приёмник`, `std значение, база, смещение`.
 */
class Machine {
  readonly registers = new Map<number, number>();
  readonly memory = new Map<number, number>();
  /** Журнал записей: адрес, значение и что именно писалось — по нему видно наложение блоков. */
  readonly wrote: { address: number; value: number; what: string }[] = [];

  constructor() {
    this.registers.set(ARRAY_REGISTERS.zero, 0);
    this.registers.set(ARRAY_REGISTERS.one, 1);
    this.registers.set(ARRAY_REGISTERS.eight, 8);
    this.registers.set(ARRAY_REGISTERS.heap, HEAP);
    this.registers.set(ARRAY_REGISTERS.scratch, 0);
    this.registers.set(ARRAY_REGISTERS.scratch2, 0);
  }

  /** Значение регистра; модель обязана знать адрес, иначе замер бессмыслен. */
  at(index: number): number {
    const value = this.registers.get(index);
    if (value === undefined) throw new Error(`регистр %b[${String(index)}] не определён — модель не описывает программу`);
    return value;
  }

  run(instructions: readonly AsmInstruction[], what: string): void {
    for (const instruction of instructions) {
      const operands = instruction.operands;
      const index = (slot: number): number => {
        const operand = operands[slot];
        if (operand === undefined || operand.kind !== 'reg') {
          throw new Error(`«${instruction.mnemonic}»: операнд ${String(slot)} не регистр — модель не описывает команду`);
        }
        return operand.index;
      };
      switch (instruction.mnemonic) {
        case 'adds':
          this.registers.set(index(2), this.at(index(0)) + this.at(index(1)));
          break;
        case 'ldd':
          this.registers.set(index(2), this.memory.get(this.at(index(0)) + this.at(index(1))) ?? 0);
          break;
        case 'std': {
          const address = this.at(index(1)) + this.at(index(2));
          const value = this.at(index(0));
          this.memory.set(address, value);
          this.wrote.push({ address, value, what });
          break;
        }
        case 'setbn':
          break; // окно на модель памяти не влияет
        case 'movts':
        case 'movtd': {
          const literal = operands[0];
          if (literal === undefined || (literal.kind !== 'imm' && literal.kind !== 'imm64')) {
            throw new Error(`«${instruction.mnemonic}»: источник не литерал — модель не описывает команду`);
          }
          this.registers.set(index(1), Number(literal.value));
          break;
        }
        default:
          throw new Error(`«${instruction.mnemonic}»: модель не описывает эту команду`);
      }
    }
  }
}

/** Программа: два массива, между `создать` и `получить` — ровно `добавить`. `null` — второго нет. */
function twoArrays(first: readonly number[], second: readonly number[] | null): {
  machine: Machine;
  firstPointer: number;
  secondPointer: number;
  firstElements: number[];
  secondElements: number[];
} {
  const machine = new Machine();
  machine.run(arrayPrologue(HEAP), 'пролог');
  const pointerA = 1;
  const pointerB = 3;
  const value = 2;
  const indexRegister = 5;
  const result = 6;

  machine.run(lowerArrayCall('система.массив.создать', [], pointerA), 'создать(a)');
  const firstPointer = machine.at(pointerA);
  first.forEach((element) => {
    machine.registers.set(value, element);
    machine.run(lowerArrayCall('система.массив.добавить', [reg(pointerA), reg(value)], undefined), `добавить(a, ${String(element)})`);
  });

  if (second !== null) machine.run(lowerArrayCall('система.массив.создать', [], pointerB), 'создать(b)');
  const secondPointer = second === null ? firstPointer : machine.at(pointerB);
  (second ?? []).forEach((element) => {
    machine.registers.set(value, element);
    machine.run(lowerArrayCall('система.массив.добавить', [reg(pointerB), reg(value)], undefined), `добавить(b, ${String(element)})`);
  });

  const read = (pointer: number, at: number): number => {
    machine.registers.set(indexRegister, at);
    machine.run(lowerArrayCall('система.массив.получить', [reg(pointer), reg(indexRegister)], result), 'получить');
    return machine.at(result);
  };

  return {
    machine,
    firstPointer,
    secondPointer,
    firstElements: first.map((_, at) => read(pointerA, at)),
    secondElements: (second ?? []).map((_, at) => read(pointerB, at)),
  };
}

describe('куча массивов: блоки двух массивов не пересекаются', () => {
  it('два массива подряд: второй блок начинается за первым, а не в нём', () => {
    const { machine, firstPointer, secondPointer, firstElements, secondElements } = twoArrays([5, 6, 7], [9, 8]);
    // Первый массив прочитан ЦЕЛИКОМ и верно: иначе «не пересекаются» ничего не значит.
    expect(firstElements, 'элементы первого массива').toEqual([5, 6, 7]);
    expect(secondElements, 'элементы второго массива').toEqual([9, 8]);
    // Блок = [длина:8][элементы]. Первый занимает 8 + 8·3 = 32 байта от своего указателя.
    const firstBlock = [firstPointer, firstPointer + 8 * (1 + 3)] as const;
    const secondBlock = [secondPointer, secondPointer + 8 * (1 + 2)] as const;
    const overlap = Math.max(firstBlock[0], secondBlock[0]) < Math.min(firstBlock[1], secondBlock[1]);
    expect(
      overlap,
      'блоки наложились: ' +
        `первый [${String(firstBlock[0])}, ${String(firstBlock[1])}), второй [${String(secondBlock[0])}, ${String(secondBlock[1])}); ` +
        `записей сделано ${String(machine.wrote.length)}`,
    ).toBe(false);
  });

  it('записи построения второго массива не трогают слоты первого', () => {
    const { machine, firstPointer } = twoArrays([5, 6, 7], [9, 8]);
    const firstSlots = new Set([firstPointer, firstPointer + 8, firstPointer + 16, firstPointer + 24]);
    const trespassed = machine.wrote.filter(
      (record) => record.what.startsWith('добавить(b') && firstSlots.has(record.address),
    );
    expect(
      trespassed.map((record) => `${record.what} → адрес ${String(record.address)}`),
      'записи второго массива попали в слоты первого',
    ).toEqual([]);
  });

  it('ОДИН массив (второго нет) читается верно — различающий опыт', () => {
    // Различающий опыт: дефект требует ВТОРОГО `создать`. С одним массивом чтение обязано быть верным
    // и до правки — иначе проверка выше ловила бы не перекрытие блоков, а что-то другое.
    const { firstElements } = twoArrays([5, 6, 7], null);
    expect(firstElements).toEqual([5, 6, 7]);
  });

  it('два массива в ОБРАТНОМ порядке (короткий первым): блоки тоже не пересекаются', () => {
    const { firstElements, secondElements, firstPointer, secondPointer } = twoArrays([9, 8], [5, 6, 7]);
    expect(firstElements).toEqual([9, 8]);
    expect(secondElements).toEqual([5, 6, 7]);
    expect(secondPointer, 'второй блок за первым').toBeGreaterThanOrEqual(firstPointer + 8 * (1 + 2));
  });

  it('ИЗМЕРЕНО, ограничение: массивы, растущие ВПЕРЕМЕЖКУ, делят одну кучу', () => {
    // Куча выделяет блок при `создать`, а не при `добавить`: у массива нет резерва под будущие
    // элементы. Поэтому `создать(a); создать(b); добавить(a, 1); добавить(b, 2)` пишет элемент `a`
    // ровно туда, где стоит ЗАГОЛОВОК блока `b`, а `добавить(b, …)` затирает его длиной `b`.
    // Замер: `a[0] = 2` (её положил `добавить(b, 2)`), `b[0] = 0` (элемент `b` уехал в слот 1,
    // потому что длина `b` была испорчена на 1), длина `b` = 2.
    //
    // Проверка краснеет, если это поведение изменится: тогда ограничение снято и документ
    // (`docs/e2k-regalloc-debt.md` §12, `docs/hardware-debt.md` §3.22) надо переписать.
    const machine = new Machine();
    machine.run(arrayPrologue(HEAP), 'пролог');
    machine.run(lowerArrayCall('система.массив.создать', [], 1), 'создать(a)');
    machine.run(lowerArrayCall('система.массив.создать', [], 3), 'создать(b)');
    machine.registers.set(2, 1);
    machine.run(lowerArrayCall('система.массив.добавить', [reg(1), reg(2)], undefined), 'добавить(a, 1)');
    machine.registers.set(4, 2);
    machine.run(lowerArrayCall('система.массив.добавить', [reg(3), reg(4)], undefined), 'добавить(b, 2)');
    const readElement = (pointer: number, at: number): number => {
      machine.registers.set(5, at);
      machine.run(lowerArrayCall('система.массив.получить', [reg(pointer), reg(5)], 6), 'получить');
      return machine.at(6);
    };
    const a = machine.at(1);
    const b = machine.at(3);
    expect(b, 'второй блок начинается сразу за заголовком первого').toBe(a + 8);
    expect(readElement(1, 0), 'a[0]: её затёрла запись длины b').toBe(2);
    expect(readElement(3, 0), 'b[0]: элемент уехал — длина b была испорчена').toBe(0);
    expect(machine.memory.get(b), 'длина b: её переписал элемент a, потом она стала 2').toBe(2);
  });
});
