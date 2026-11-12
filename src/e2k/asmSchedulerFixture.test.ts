/**
 * ФИКСТУРА ИЗ РЕАЛЬНОГО ЯДРА `fir` — задача 1 шага 2.4.
 *
 * # Зачем
 *
 * Три дефекта планировщика (`e127689`) прошли сквозь фикстуры из трёх команд и были найдены только
 * прогоном пяти ядер: WAR/WAW в предусловии выдачи (цикл), предел поиска такта и индексация карты
 * тактов индексом команды, отсутствие обработки управляющих команд. Это тот же класс, что случай 17
 * реестра проверяемости: проверка была корректна для своего входа и слепа для реального.
 *
 * Поэтому фикстура берётся **из потока настоящего ядра**, а не сочиняется: фрагмент содержит
 * одновременно WAR/WAW-пару и управляющую команду (`disp`), и проверка требует, чтобы фрагмент
 * действительно их содержал — иначе она была бы пустой.
 */

import { describe, it, expect } from 'vitest';
import { scheduleAsm } from './asmScheduler';
import { registersOf } from './widePacker';
import { realOpcode } from './e2k-real';
import { kernelStreamOf } from './e2kWideFir.test';
import type { AsmInstruction } from './backend';

/** Длина фрагмента: 10–20 команд, как требует задание. */
export const FRAGMENT_LENGTH = 16;

/** Все команды ядра `fir` — из того же стенда, что замер пяти ядер. */
export const FIR_COMMANDS: readonly AsmInstruction[] = kernelStreamOf('fir', 'A5').commands;

/** Пара WAR/WAW: первая читает то, что вторая пишет, либо обе пишут один регистр. */
export function warWawPair(
  commands: readonly AsmInstruction[],
): { readonly a: number; readonly b: number; readonly kind: string } | undefined {
  for (let a = 0; a < commands.length; a++) {
    for (let b = a + 1; b < commands.length; b++) {
      const first = registersOf(commands[a]!);
      const second = registersOf(commands[b]!);
      const writes = new Set(second.writes);
      const war = first.reads.filter((key) => writes.has(key));
      if (war.length > 0) return { a, b, kind: `WAR по ${war.join(',')}` };
      const waw = first.writes.filter((key) => new Set(second.writes).has(key));
      if (waw.length > 0) return { a, b, kind: `WAW по ${waw.join(',')}` };
    }
  }
  return undefined;
}

/**
 * Вырезать фрагмент, содержащий и WAR/WAW-пару, и управляющую команду.
 *
 * Вырезается из **реального** потока: начало выбирается так, чтобы обе особенности попали внутрь.
 * Если такого места нет — функция отвечает `undefined`, и проверка ниже это называет.
 */
export function firFragment(): readonly AsmInstruction[] | undefined {
  const commands = FIR_COMMANDS;
  const isControl = (command: AsmInstruction): boolean =>
    (realOpcode(command.mnemonic)?.channels.length ?? 0) === 0;
  for (let start = 0; start + FRAGMENT_LENGTH <= commands.length; start++) {
    const slice = commands.slice(start, start + FRAGMENT_LENGTH);
    if (!slice.some(isControl)) continue;
    if (warWawPair(slice) === undefined) continue;
    return slice;
  }
  return undefined;
}

describe('фикстура из fir: настоящий фрагмент с WAR/WAW и управляющей командой', () => {
  const fragment = firFragment();

  it('1.1 фрагмент взят из потока fir, длина 10–20, содержит disp и WAR/WAW', () => {
    expect(fragment, 'фрагмент найден в реальном потоке').toBeDefined();
    const slice = fragment!;
    expect(slice.length, 'длина').toBe(FRAGMENT_LENGTH);
    expect(slice.length, 'в диапазоне 10–20').toBeGreaterThanOrEqual(10);
    expect(slice.length).toBeLessThanOrEqual(20);
    // Обе особенности обязаны быть внутри — иначе проверка была бы пустой.
    const control = slice.filter((command) => (realOpcode(command.mnemonic)?.channels.length ?? 0) === 0);
    expect(control.length, 'управляющих команд').toBeGreaterThan(0);
    expect(control.map((command) => command.mnemonic), 'среди них disp').toContain('disp');
    expect(warWawPair(slice), 'WAR/WAW-пара').toBeDefined();
  });

  it('1.2 расписание строится: все команды размещены', () => {
    const slice = fragment!;
    const result = scheduleAsm(slice);
    expect(result.issueAt.length, 'issueAt').toBe(slice.length);
    expect(result.issueAt.filter((at) => at < 0), 'не размещённых').toEqual([]);
    expect(result.order.length, 'order').toBe(slice.length);
  });

  it('1.3 управляющая команда занимает отдельный такт', () => {
    const slice = fragment!;
    const result = scheduleAsm(slice);
    const control = slice
      .map((command, index) => ({ command, index }))
      .filter(({ command }) => (realOpcode(command.mnemonic)?.channels.length ?? 0) === 0);
    const problems: string[] = [];
    for (const { index } of control) {
      const at = result.issueAt[index]!;
      const packet = result.packets.find((slots) => slots.includes(index)) ?? [];
      if (packet.length !== 1) {
        problems.push(`#${index} ${slice[index]!.mnemonic}: в такте ${at} вместе с ${packet.length - 1} командами`);
      }
      if (result.channels[index] !== -1) problems.push(`#${index}: ALS-канал ${result.channels[index]} занят`);
    }
    expect(problems, 'управляющая команда не в отдельном такте').toEqual([]);
  });

  it('1.4 WAR/WAW не нарушены: конфликтующие команды не в одном такте', () => {
    const slice = fragment!;
    const result = scheduleAsm(slice);
    const problems: string[] = [];
    for (let a = 0; a < slice.length; a++) {
      for (let b = a + 1; b < slice.length; b++) {
        const first = registersOf(slice[a]!);
        const second = registersOf(slice[b]!);
        const secondWrites = new Set(second.writes);
        const war = first.reads.some((key) => secondWrites.has(key));
        const waw = first.writes.some((key) => secondWrites.has(key));
        if (!war && !waw) continue;
        if (result.issueAt[a] === result.issueAt[b]) {
          problems.push(`#${a} и #${b}: один такт ${result.issueAt[a]}`);
        }
      }
    }
    expect(problems, 'нарушение WAR/WAW').toEqual([]);
  });

  it('1.5 порядок эффектов сохранён: управляющие не переставлены между собой', () => {
    const slice = fragment!;
    const result = scheduleAsm(slice);
    const controlOrder = slice
      .map((command, index) => ({ command, index }))
      .filter(({ command }) => (realOpcode(command.mnemonic)?.channels.length ?? 0) === 0)
      .map(({ index }) => index);
    const issued = controlOrder.map((index) => result.issueAt[index]!);
    const sorted = [...issued].sort((a, b) => a - b);
    expect(issued, 'управляющие выданы в порядке программы').toEqual(sorted);
  });
});

describe('оракул собран и проверяет непустое множество', () => {
  it('поток fir непуст и фрагмент из него действительно вырезан', () => {
    expect(FIR_COMMANDS.length, 'команд в fir').toBeGreaterThan(FRAGMENT_LENGTH);
    expect(firFragment(), 'фрагмент').toBeDefined();
  });
});
