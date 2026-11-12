/**
 * СКЕЛЕТ КОЛЛЕКЦИЙ: ОТКАЗЫ И ЕДИНИЦЫ — ДО ПРОГОНА (без модели).
 *
 * Прогон на цели — `src/e2k/memorySyscallsQemu.test.ts` (шлюз `gate:qemu`). Здесь то, что обязано
 * быть проверено ДО него, иначе проба будет измерять не то:
 *
 * | что | почему это сторож, а не формальность |
 * |---|---|
 * | номер вызова НЕ равен x86_64 | «похожий номер» молчит до первого вызова, а потом портит память |
 * | `offset` едет БАЙТАМИ и кратен странице | сдвиг на номер страницы увёл бы отображение в 4096 раз дальше |
 * | длина ≤ 0 и косой `offset` — НАЗВАННЫЙ отказ | отказ, который виден только ядру, стоит прогона и часов |
 */
import { describe, it, expect } from 'vitest';
import { ENTRY_SYSCALL_FRAME, GROWN_SYSCALL_FRAME, syscallWindowOf } from './syscallRuntime';
import {
  MEMORY_PAGE_BYTES,
  MemoryRuntimeRefusal,
  PROT_READ,
  PROT_WRITE,
  SYS_BRK,
  SYS_MMAP,
  SYS_MPROTECT,
  SYS_X86_64_BRK,
  SYS_X86_64_MMAP,
  brkInstructions,
  isSyscallError,
  mmapInstructions,
  mmapOffsetOperand,
} from './memoryRuntime';

describe('память от системы: номера вызовов и их источник', () => {
  it('номера — e2k, и они НЕ похожи на x86_64 (это и есть ловушка)', () => {
    expect(SYS_MMAP, 'mmap: e2k 90, x86_64 9').toBe(90);
    expect(SYS_BRK, 'brk: e2k 45, x86_64 12').toBe(45);
    expect(SYS_MPROTECT, 'mprotect: e2k 125, x86_64 10').toBe(125);
    expect(SYS_X86_64_MMAP).toBe(9);
    expect(SYS_X86_64_BRK).toBe(12);
    expect(SYS_MMAP, 'соблазн взять x86_64-номер — это дефект').not.toBe(SYS_X86_64_MMAP);
    expect(SYS_BRK).not.toBe(SYS_X86_64_BRK);
  });

  it('номер едет в оконный регистр 0 кадра, длина — регистром, ответ — из %b[2·wbs]', () => {
    const entry = mmapInstructions({ length: 3, result: 5 });
    const number = entry[1];
    expect(number?.mnemonic).toBe('movts');
    expect(number?.operands[0]).toEqual({ kind: 'imm', value: SYS_MMAP });
    expect(number?.operands[1], 'номер — в оконный слот 0 точки входа (%r8)').toEqual({
      kind: 'reg',
      index: syscallWindowOf(ENTRY_SYSCALL_FRAME, 0),
      file: 'window',
    });
    const length = entry[3];
    expect(length?.mnemonic, 'длина приходит регистром — язык знает её в рантайме').toBe('adds');
    expect(length?.operands[0]).toEqual({ kind: 'reg', index: 3 });
    const result = mmapInstructions({ length: 3, result: 5 }).at(-1);
    expect(result?.operands, 'ответ читается из %b[2·wbs] базовой формой').toEqual([
      { kind: 'reg', index: ENTRY_SYSCALL_FRAME.base },
      { kind: 'reg', index: 5 },
    ]);
    // Выращенный кадр: номер идёт в `%r32`, и ответ читается **оконной** формой — базовой `%b[32]`
    // не существует (базовых регистров 32, `E2K_RF_GLOB_IDX_MAX`), кодировщик на ней отказывает.
    // Здесь прежде стояла базовая форма с индексом 32: ожидание стерегло дефект, а не форму
    // (найдено оракулом размещения пути ① 2026-10-09, `src/e2k/syscallLocalWindow.test.ts`).
    //
    // ЗДЕСЬ ЖЕ ПОЧИНЕНА СКЛЕЙКА СТРОК: у трёх строк ниже вместо переводов строки стояли литеральные
    // `\n`, поэтому весь хвост — включая `expect` про `setbn` — лежал ВНУТРИ комментария, то есть
    // проверка была мертва (класс случая 22 реестра). Найдено 2026-10-09 при разборе падений пути ①.
    const grown = mmapInstructions({ length: 3, result: 5, frame: GROWN_SYSCALL_FRAME });
    expect(grown[1]?.operands[1]?.index).toBe(GROWN_SYSCALL_FRAME.base);
    expect(grown.at(-1)?.operands[0]).toEqual({
      kind: 'reg',
      index: GROWN_SYSCALL_FRAME.base,
      file: 'window',
    });
    // setbn в выращенном кадре СТАВИТСЯ — и это измерено (.tmp/osnova-syscall-matrix.ts: код 77 и с
    // setbn 15, и с setbn 7): так форма раскладки и понижение считают ОДНИ команды (§3.58).
    expect(grown[0]?.mnemonic, 'в выращенном кадре setbn тоже ставится — измерено').toBe('setbn');
  });
});

describe('единицы offset: БАЙТЫ, а не страницы', () => {
  it('4096 байт уезжают как 4096, а не как 1', () => {
    const instructions = mmapInstructions({ length: 2, result: 4, offset: MEMORY_PAGE_BYTES });
    expect(mmapOffsetOperand(instructions), 'offset — ровно 4096 байт').toBe(4096);
    expect(mmapOffsetOperand(instructions), 'номер страницы (1) означал бы в 4096 раз дальше').not.toBe(1);
    expect(mmapOffsetOperand(mmapInstructions({ length: 2, result: 4, offset: 2 * MEMORY_PAGE_BYTES }))).toBe(8192);
    // Различающий контроль: ноль — это ноль байт, а не «страница 0 от другого начала».
    expect(mmapOffsetOperand(mmapInstructions({ length: 2, result: 4 }))).toBe(0);
  });

  it('косой offset — НАЗВАННЫЙ отказ с числами (ядро ответило бы -EINVAL)', () => {
    expect(() => mmapInstructions({ length: 2, result: 4, offset: 1 })).toThrow(MemoryRuntimeRefusal);
    expect(() => mmapInstructions({ length: 2, result: 4, offset: 1 })).toThrow(/БАЙТАХ/u);
    expect(() => mmapInstructions({ length: 2, result: 4, offset: 1 })).toThrow(/4096/u);
    expect(() => mmapInstructions({ length: 2, result: 4, offset: -4096 })).toThrow(MemoryRuntimeRefusal);
  });

  it('brk: один аргумент, номер 45, ответ тем же путём', () => {
    const instructions = brkInstructions({ address: 1, result: 6 });
    expect(instructions[1]?.operands[0]).toEqual({ kind: 'imm', value: SYS_BRK });
    expect(instructions[2]?.operands[0], 'адрес — регистром').toEqual({ kind: 'reg', index: 1 });
    expect(instructions.at(-1)?.operands[0]).toEqual({ kind: 'reg', index: ENTRY_SYSCALL_FRAME.base });
  });

  it('prot/flags ставятся числами Linux, а не «как получится»', () => {
    const instructions = mmapInstructions({ length: 2, result: 4, prot: PROT_READ | PROT_WRITE });
    const prot = instructions.find((instruction) => instruction.operands[1]?.kind === 'reg' && (instruction.operands[1] as { index: number }).index === syscallWindowOf(ENTRY_SYSCALL_FRAME, 3));
    expect(prot?.operands[0]).toEqual({ kind: 'imm', value: 3 });
  });

  it('отрицательный ответ ядра отличается от адреса — это и наблюдает проба', () => {
    expect(isSyscallError(-12n), '-ENOMEM').toBe(true);
    expect(isSyscallError(0x110000n), 'адрес').toBe(false);
    expect(isSyscallError(0n), 'ноль — не ошибка, а «не туда»').toBe(false);
  });
});
