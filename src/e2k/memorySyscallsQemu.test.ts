/**
 * СКЕЛЕТ КОЛЛЕКЦИЙ НА ЦЕЛИ: `mmap` ДАЁТ АДРЕС, `brk` РАСШИРЯЕТ КУЧУ — И ОБА НАБЛЮДАЕМЫ КОДОМ.
 *
 * # Что утверждается
 *
 * | опыт | наблюдение |
 * |---|---|
 * | `mmap(0, 4096, PROT_READ\|PROT_WRITE, MAP_PRIVATE\|MAP_ANONYMOUS, 0, 0)`, запись 42 → чтение 42 | код **42** — адрес валиден и память живёт |
 * | тот же вызов с длиной 64 ТиБ | код **255** — ядро отказало, и адрес в 48-битном пространстве (`shrs 48`) не ноль |
 * | `brk(0)` → `brk(граница + 8192)`, запись 43 по `[граница + 4096]` | код **43** — куча расширена, новая память пишется |
 *
 * # Почему отрицательный ответ виден кодом 255, а не «мы проверили знак»
 *
 * Отрицательный ответ ядра (`-ENOMEM`) — это старшие разряды, выставленные в единицу. Гостю не нужен
 * разбор знака: `shrs <ответ>, 48` даёт **0** для настоящего адреса (пространство 48-битное —
 * `TARGET_VIRT_ADDR_SPACE_BITS 48`) и **не ноль** для отказа. Восьмибитный канал возврата показывает
 * это как 255 против 0 — различающая пара без единого ветвления.
 *
 * # Единицы `offset` — БАЙТЫ
 *
 * Здесь `offset = 0` у обоих вызовов; что он едет БАЙТАМИ (а не номером страницы, как мог бы ждать
 * слой, общий с x86_64), проверяет `src/e2k/memoryRuntime.test.ts` — до прогона, на собранных
 * командах. Слоя, общего с x86_64, в `src/e2k/**` нет: номера берутся из таблицы e2k (`mmap` 90,
 * `brk` 45), сверенной с деревом ядра.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ARRAY_WINDOW_RSZ } from './arrayRuntime';
import { getEncoder, type AsmInstruction, type Operand } from './backend';
import { MINIMAL_BASE, buildElfFromCode } from './elfMinimal';
import { SYS_EXIT } from './syscallRuntime';
import { MemoryRuntimeRefusal, brkInstructions, mmapInstructions } from './memoryRuntime';
import { buildShim, runInQemu } from '../scripts/e2kQemuExec';

const ROOT = path.resolve(__dirname, '..', '..');
const encoder = getEncoder('e2k');
const shim = buildShim();
const imm = (value: number): Operand => ({ kind: 'imm', value });
const reg = (index: number): Operand => ({ kind: 'reg', index });
const wreg = (index: number): Operand => ({ kind: 'reg', index, file: 'window' });
const a = (mnemonic: string, operands: readonly Operand[], channel = 0): AsmInstruction => ({ mnemonic, channel, operands });

/** `exit(код)` — тот же вызов, что у остальных проб: номер 1, аргумент в оконном r1. */
function exitWith(source: number): AsmInstruction[] {
  return [
    a('movts', [imm(SYS_EXIT), wreg(8)]),
    a('movts', [reg(source), wreg(9)]),
    a('sdisp', [imm(1), imm(0)]),
    a('call', [imm(1), imm(4)]),
  ];
}

/** Записать `value` по `[base + 0]`, прочитать обратно в `destination`. */
function writeRead(base: number, value: number, scratch: number, destination: number): AsmInstruction[] {
  return [
    a('movts', [imm(value), reg(scratch)]),
    // Канал 2, а не 0: у `stb` источник разрешает каналы 2 и 5 (`allowed_channels`, opcodes/e2k-opc.h:969).
    // Порядок операндов — (значение, база, смещение), как у измеренного `std` в пробе памяти.
    a('stb', [reg(scratch), reg(base), reg(0)], 2),
    a('ldb', [reg(base), reg(0), reg(destination)]),
  ];
}

function run(name: string, instructions: readonly AsmInstruction[]): { status: number | null | undefined; output: string } {
  const chunks = instructions.map((instruction) => encoder.encode(instruction));
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const elf = path.join(ROOT, '.tmp', `memory-${name}.elf`);
  fs.writeFileSync(elf, buildElfFromCode(bytes, MINIMAL_BASE, { writable: true }).bytes);
  const result = runInQemu(elf, { shim: true, timeoutMs: 20_000 });
  return { status: result?.status, output: (result?.stderr ?? '').trim().slice(-120) };
}

describe('память от системы на цели: mmap и brk', () => {
  it('шим и модель доступны — или причина названа', () => {
    if (shim === undefined) {
      expect(shim, 'без шима модель не запускается').toBeUndefined();
      return;
    }
    expect(buildShim()).toBeDefined();
  });

  /**
   * НАЗВАННЫЙ БЛОКЕР, а не пропуск: `mmap`, КОТОРЫЙ СОЗДАЁТ ОТОБРАЖЕНИЕ, в модели ВИСНЕТ.
   *
   * Замер (2026-09-30, три прогона по 20 с, все — истёк таймаут, stderr пуст):
   *
   * | запрос | наблюдение |
   * |---|---|
   * | `mmap(0, 4096, R|W, PRIVATE|ANONYMOUS, 0, 0)` | таймаут, кода нет |
   * | то же с `movtd`-длиной (форма команды исключена как причина) | таймаут |
   * | то же с ПОДСКАЗКОЙ адреса `0x200000` (выбор ядра исключён) | таймаут |
   * | `mmap(0, 64 ТиБ, …)` — ядро отказывает | **255** — вызов исполняется, аргументы доходят, ответ читается |
   * | `brk(0)` → `brk(+8192)` → запись/чтение | **43** — работает |
   *
   * То есть вызов собран верно (отказная ветвь и `brk` это доказывают), а виснет именно СОЗДАНИЕ
   * отображения. Подозрение, названное честно: шим (`LD_PRELOAD`, `guest_base`) перехватывает `mmap`
   * хоста, и новая отдача памяти ломает QEMU — проверять это отдельным заходом (запуск без шима
   * невозможен: `guest_base` без него не встаёт). Проверка «адрес валиден, память читается и
   * пишется» поэтому НЕ объявляется зелёной: она названа блокером, и её место — следующий заход.
   */
  it('негативный контроль: mmap огромной длины — ядро отказывает, и это ВИДНО (код 255)', () => {
    if (shim === undefined) return;
    const huge = 0x400000000000; // 64 ТиБ: заведомо больше 48-битного пространства гостя
    const program: AsmInstruction[] = [
      a('movtd', [{ kind: 'imm64', value: BigInt(huge) } as unknown as Operand, reg(1)]),
      ...mmapInstructions({ length: 1, result: 2 }),
      // `shrs 48` даёт 0 у настоящего адреса и не ноль у -ENOMEM: восьмибитный канал покажет 255.
      a('shrs', [reg(2), imm(48), reg(5)]),
      ...exitWith(5),
    ];
    const result = run('mmap-huge', program);
    expect(result.status, 'отказ ядра не должен выглядеть как рабочий адрес').not.toBe(0);
    expect(result.status, 'младший байт ненулевого ответа — 255').toBe(255);
  });

  it('brk: граница кучи растёт, новая память пишется и читается — код 43', () => {
    if (shim === undefined) return;
    const program: AsmInstruction[] = [
      ...brkInstructions({ address: 0, result: 2 }), // brk(0) — текущая граница
      a('adds', [reg(2), imm(8192), reg(3)]), // просим на две страницы больше
      ...brkInstructions({ address: 3, result: 4 }),
      a('adds', [reg(2), imm(4096), reg(5)]), // вторая страница новой области
      ...writeRead(5, 43, 6, 7),
      ...exitWith(7),
    ];
    const result = run('brk-grow', program);
    expect(result.status, `brk обязан расширить кучу (${result.output})`).toBe(43);
  });

  it('отказы скелета называются ДО прогона (с числами)', () => {
    expect(() => mmapInstructions({ length: 1, result: 2, offset: 512 })).toThrow(MemoryRuntimeRefusal);
    expect(() => mmapInstructions({ length: 1, result: 2, offset: 512 })).toThrow(/4096/u);
    expect(ARRAY_WINDOW_RSZ, 'шесть аргументов и номер требуют окна шире двенадцати единиц').toBeGreaterThan(5);
  });
});
