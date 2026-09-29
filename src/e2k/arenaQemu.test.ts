/**
 * АРЕНА НА ЦЕЛИ: НАЗВАННЫЙ ОТКАЗ ПРИ ИСЧЕРПАНИИ — КОД 231 И СТРОКА В STDERR.
 *
 * # Что утверждается — четырьмя опытами, и каждый различает
 *
 * | опыт | чем различает |
 * |---|---|
 * | цикл выделений с ВЛОЖЕННЫМ ВЫЗОВОМ | печатает разность соседних блоков: ровно `16` на виток — значит указатель пережил и печать, и вызов; код 0 |
 * | арена заполнена РОВНО (`8 × 512 = 4096`) | отказа НЕТ: полоса `[base, limit)` заполняется до последнего байта — граница «строго больше» |
 * | девятое выделение сверх предела | код **231** И строка отказа — оба наблюдаемых, ни одного вместо другого |
 * | канал | строка приходит в **stderr**, а stdout пуст: отказ не подменяет вывод программы |
 *
 * # Негативный контроль
 *
 * Он встроен в различающую пару: «ровно предел» даёт код 0, «сверх предела» — 231. Если бы ветвь
 * срабатывала всегда (или никогда), одна из строк таблицы покраснела бы — именно так и ловился дефект
 * заведения арены: она стояла за переходом к точке входа и не исполнялась
 * (`.tmp/arena-loop.elf`, ревизия до правки; `docs/hardware-debt.md` §3.89).
 *
 * # Границы
 *
 * Модель — не железо: числа с неё на Эльбрус без прогона на железе не переносятся
 * (`tools/e2k-hardware/`). Файл живёт в шлюзе `gate:qemu`; в полном прогоне его нет (там нет QEMU).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MINIMAL_BASE, buildElfFromCode } from './elfMinimal';
import { HEAP_OFFSET, loweredProgram } from './programImage';
import { ARENA_BASE, ARENA_BYTES, ARENA_LIMIT, ARENA_REFUSAL_CODE, ARENA_REFUSAL_TEXT } from './arenaRuntime';
import { runInQemu } from '../scripts/e2kQemuExec';

const ROOT = path.resolve(__dirname, '..', '..');

/** Цикл выделений по 16 байт; между выделениями — ВЛОЖЕННЫЙ ВЫЗОВ и печать разности. */
const LOOP = [
  'процедура шаг(значение: Число): Число',
  '  вернуть значение',
  'конец_процедуры',
  '',
  'процедура главная()',
  '  пусть предыдущий = система.память.выделить(16)',
  '  пусть индекс = 0',
  '  пока индекс < 4',
  '    пусть текущий = система.память.выделить(16)',
  '    система.лог.вывести(шаг(текущий - предыдущий))',
  '    предыдущий = текущий',
  '    индекс = индекс + 1',
  '  конец_пока',
  'конец_процедуры',
].join('\n');

/** Ровно предел: восемь блоков по 512 байт, затем маркер 7 — программа обязана дойти до него. */
const EDGE = [
  'процедура главная()',
  '  пусть индекс = 0',
  '  пока индекс < 8',
  '    пусть блок = система.память.выделить(512)',
  '    индекс = индекс + 1',
  '  конец_пока',
  '  система.лог.вывести(7)',
  'конец_процедуры',
].join('\n');

/** Сверх предела: двенадцатое выделение обязано стать названным отказом. */
const OVERFLOW = [
  'процедура главная()',
  '  пусть индекс = 0',
  '  пока индекс < 12',
  '    пусть блок = система.память.выделить(512)',
  '    индекс = индекс + 1',
  '  конец_пока',
  'конец_процедуры',
].join('\n');

interface ArenaRun {
  readonly status: number | null | undefined;
  readonly stdout: string;
  readonly stderr: string;
}

/** Прогон с ТЕМ ЖЕ `extraMemory`, что назвал образ: арена лежит выше отображённых 8 КиБ. */
function runArena(source: string, name: string): ArenaRun {
  const image = loweredProgram(source);
  expect(image.refused.map((item) => item.reason).join(' | '), `${name}: отказов понижения быть не должно`).toBe('');
  expect(image.arena.used, `${name}: образ обязан пользоваться ареной`).toBe(true);
  const elf = path.join(ROOT, '.tmp', `arena-${name}.elf`);
  fs.writeFileSync(
    elf,
    buildElfFromCode(image.bytes, MINIMAL_BASE, { writable: true, extraMemory: image.arena.extraMemory }).bytes,
  );
  const result = runInQemu(elf, { shim: true, timeoutMs: 20_000 });
  expect(result, `${name}: модель обязана ответить`).toBeDefined();
  return { status: result!.status, stdout: result!.stdout, stderr: result!.stderr };
}

describe('АРЕНА НА ЦЕЛИ: выделение переживает печать и вызов, исчерпание — названный отказ', () => {
  it('цикл с вложенным вызовом: разность соседних блоков ровно 16, код 0', () => {
    const run = runArena(LOOP, 'loop');
    expect(run.stdout, 'байты вывода: четыре выделения по 16 — ни одного лишнего').toBe('16\n16\n16\n16\n');
    expect(run.status, 'код возврата: программа дошла до конца').toBe(0);
  });

  it('арена, заполненная РОВНО: отказа нет — полоса [base, limit) заполняется до конца', () => {
    const run = runArena(EDGE, 'edge');
    expect(run.stdout, 'маркер после восьми выделений — значит девятого не потребовалось').toBe('7\n');
    expect(run.status).toBe(0);
  });

  it('ИСЧЕРПАНИЕ: код 231 И строка, оба наблюдаемых', () => {
    const run = runArena(OVERFLOW, 'overflow');
    expect(run.status, 'код возврата отказа').toBe(ARENA_REFUSAL_CODE);
    expect(run.stderr, 'строка отказа — в stderr').toContain(ARENA_REFUSAL_TEXT);
    expect(run.stdout, 'отказ не подменяет вывод программы: stdout пуст').toBe('');
  });

  it('числа арены названы и лежат там, где решено', () => {
    expect([ARENA_BASE, ARENA_LIMIT, ARENA_BYTES]).toEqual([0x102000, 0x103000, 0x1000]);
    expect(ARENA_REFUSAL_CODE).toBe(231);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: без арены регистры не резервируются и extraMemory прежний', () => {
    // Сторож закреплённых чисел: расширение НЕ имеет права менять обычные программы.
    const plain = loweredProgram('процедура главная()\n  система.лог.вывести(7)\nконец_процедуры');
    expect(plain.arena.used).toBe(false);
    expect(plain.arena.extraMemory).toBe(HEAP_OFFSET);
  });
});
