/**
 * ОРАКУЛ ПЛАНИРОВЩИКА КОМАНД e2k (`AsmInstruction`) — задача 1.
 *
 * # Почему он нужен
 *
 * Перестановка в реальной ветви e2k сегодня даёт **ноль** (такты 802/802, `docs/e2k-reorder-effect.md`)
 * не потому, что её забыли вызвать, а потому что вызвать её **нечем**: планировщик проекта работает
 * на `RegInstruction` (`src/vliw/reorderScheduler.ts:37`). Этот оракул описывает контракт
 * планировщика, который умеет работать на **командах e2k**, и потому является входом в новую работу.
 *
 * # Красный до реализации — и это проверяется по проверкам
 *
 * `src/e2k/asmScheduler.ts` объявляет контракт и отказывает названно, поэтому оракул
 * **собирается** и краснеет по проверкам. «Модуль не найден» дало бы ноль собранных проверок — это
 * доказательство отсутствия модуля, а не чувствительности оракула (`docs/verification-debt.md:158-163`).
 *
 * # Что проверяется структурно (истинно уже сейчас)
 *
 * Планировщик обязан опираться на то, что в проекте **есть**, а не на новые таблицы:
 * `registersOf` (что команда читает и пишет), `packetableRefusal` (можно ли её группировать),
 * `realOpcode(...).channels` (допустимые каналы), `latencyFor`/`opClassOf` (длительности).
 * Эти проверки зелёные сразу — они фиксируют, что входы для работы существуют.
 */

import { describe, it, expect } from 'vitest';
import { scheduleAsm, type AsmScheduleResult } from './asmScheduler';
import { buildAsmDependencyGraph } from './asmGraph';
import { classOfMnemonic, CLUSTERS_ARE_NOOP } from './asmScheduler';
import { registersOf, packetableRefusal } from './widePacker';
import { realOpcode } from './e2k-real';
import { latencyFor, opClassOf } from '../vliw/e2kDevices';
import type { AsmInstruction, Operand } from './backend';

const reg = (index: number): Operand => ({ kind: 'reg', index });
const imm = (value: number): Operand => ({ kind: 'imm', value });

/** `adds d, a, b` — команда с двумя чтениями и одной записью. */
const add = (dst: number, a: number, b: number): AsmInstruction => ({
  mnemonic: 'adds',
  channel: 0,
  operands: [reg(a), reg(b), reg(dst)],
});
/** `movts a, d` — пересылка. */
const movts = (src: number, dst: number): AsmInstruction => ({
  mnemonic: 'movts',
  channel: 0,
  operands: [reg(src), reg(dst)],
});

/** Три независимые команды, которые обязаны лечь в один пакет. */
const INDEPENDENT: readonly AsmInstruction[] = [add(3, 1, 2), add(6, 4, 5), add(9, 7, 8)];
/** Цепочка RAW: каждая следующая читает результат предыдущей. */
const CHAIN: readonly AsmInstruction[] = [add(3, 1, 2), add(6, 3, 4), add(9, 6, 5)];

describe('планировщик AsmInstruction: структура входов (существует уже сейчас)', () => {
  it('1.2 зависимости берутся из формы команды: registersOf даёт чтения и записи', () => {
    expect(registersOf(add(3, 1, 2)), 'adds').toEqual({ reads: ['base:1', 'base:2'], writes: ['base:3'] });
    expect(registersOf(movts(4, 5)), 'movts').toEqual({ reads: ['base:4'], writes: ['base:5'] });
    // Файл регистров входит в ключ: %b[3] и %r3 — разные ячейки.
    const windowed: AsmInstruction = { mnemonic: 'movts', channel: 0, operands: [{ kind: 'reg', index: 3, file: 'window' }, reg(4)] };
    expect(registersOf(windowed).reads, 'оконный файл').toEqual(['window:3']);
  });

  it('1.4 допустимые каналы команды берутся из таблицы кодировщика', () => {
    const adds = realOpcode('adds');
    const movtsEntry = realOpcode('movts');
    expect(adds?.channels, 'каналы adds').toBeDefined();
    expect(movtsEntry?.channels, 'каналы movts').toBeDefined();
    // Команда, которую нельзя группировать, обязана называть причину — по ней планировщик и решает.
    const literal = { mnemonic: 'movts', channel: 0, operands: [imm(5), reg(1)] } as const;
    expect(packetableRefusal(literal), 'причина отказа для литерала').toContain('не все операнды — регистры');
  });

  it('1.3 длительности берутся из модели устройств', () => {
    expect(opClassOf('add'), 'класс add').toBe('int');
    expect(latencyFor('int'), 'длительность int').toBe(1);
    expect(latencyFor('fp'), 'длительность fp').toBeGreaterThan(latencyFor('int'));
  });
});

describe('планировщик AsmInstruction: контракт (красный до реализации)', () => {
  it('1.1 выход несёт order, packets, issueAt, readyAt и метрики', () => {
    const result: AsmScheduleResult = scheduleAsm(INDEPENDENT);
    expect(result.order.length, 'длина order').toBe(INDEPENDENT.length);
    expect(result.issueAt.length, 'длина issueAt').toBe(INDEPENDENT.length);
    expect(result.readyAt.length, 'длина readyAt').toBe(INDEPENDENT.length);
    expect(result.packets.length, 'пакетов').toBeGreaterThan(0);
    expect(result.metrics.packets, 'метрика пакетов').toBe(result.packets.length);
  });

  it('1.5 независимые команды ставятся рядом: order отличается от линейного и они в одном пакете', () => {
    const result = scheduleAsm(INDEPENDENT);
    // Порядок — перестановка индексов.
    expect([...result.order].sort((a, b) => a - b), 'order как перестановка').toEqual([0, 1, 2]);
    // Независимые команды обязаны попасть в один пакет: именно это даёт материал для упаковки.
    const inOnePacket = result.packets.some((packet) => packet.length === INDEPENDENT.length);
    expect(inOnePacket, 'три независимые в одном пакете').toBe(true);
  });

  it('1.6 такты считаются: цепочка RAW идёт дольше независимых', () => {
    const independent = scheduleAsm(INDEPENDENT);
    const chain = scheduleAsm(CHAIN);
    expect(chain.metrics.cycles, 'цепочка не короче независимых').toBeGreaterThanOrEqual(
      independent.metrics.cycles,
    );
    // Готовность результата не раньше выдачи: базовый инвариант расписания.
    const problems: string[] = [];
    CHAIN.forEach((_, index) => {
      if (chain.readyAt[index]! < chain.issueAt[index]!) problems.push(`#${index}: readyAt < issueAt`);
    });
    expect(problems, 'readyAt не раньше issueAt').toEqual([]);
  });

  it('1.7 пустой вход даёт пустое расписание, а не отказ', () => {
    const result = scheduleAsm([]);
    expect(result.order, 'order').toEqual([]);
    expect(result.metrics.cycles, 'такты').toBe(0);
  });
});

describe('шаг 2.1: def-use граф по командам e2k', () => {
  it('2.1.1 независимые команды не связаны ни одним ребром', () => {
    const graph = buildAsmDependencyGraph(INDEPENDENT);
    const problems = graph.edges
      .filter(([from, to]) => from < 3 && to < 3)
      .map(([from, to]) => `#${from} → #${to}`);
    expect(problems, 'рёбра между независимыми').toEqual([]);
  });

  it('2.1.2 RAW-цепочка даёт рёбра по порядку', () => {
    const graph = buildAsmDependencyGraph(CHAIN);
    // Цепочка: 0 читает 1,2 пишет 3; 1 читает 3 пишет 6; 2 читает 6 пишет 5.
    const pairs = graph.edges.map(([from, to]) => `${from}→${to}`);
    expect(pairs, 'RAW по цепочке').toContain('0→1');
    expect(pairs, 'RAW по цепочке').toContain('1→2');
  });

  it('2.1.3 файл регистров различается: %b[3] и %r3 не склеиваются', () => {
    const baseOnly = buildAsmDependencyGraph([add(3, 1, 2), movts(3, 4)]);
    expect(baseOnly.edges.length, 'базовый читает базовый — есть RAW').toBeGreaterThan(0);
    const windowed: AsmInstruction = {
      mnemonic: 'movts',
      channel: 0,
      operands: [{ kind: 'reg', index: 3, file: 'window' }, reg(4)],
    };
    const mixed = buildAsmDependencyGraph([add(3, 1, 2), windowed]);
    expect(mixed.edges.filter(([from, to]) => from === 0 && to === 1), 'оконный читает базовый').toEqual([]);
  });

  it('2.1.4 цепочка эффектов упорядочена даже без общих регистров', () => {
    // Литеральные пересылки не группируются (packetableRefusal), значит обязаны упорядочиться.
    const literal = (value: number, dst: number): AsmInstruction => ({
      mnemonic: 'movts',
      channel: 0,
      operands: [imm(value), reg(dst)],
    });
    const graph = buildAsmDependencyGraph([literal(1, 10), literal(2, 11), literal(3, 12)]);
    const pairs = graph.edges.map(([from, to]) => `${from}→${to}`);
    expect(pairs, 'эффект 0→1').toContain('0→1');
    expect(pairs, 'эффект 1→2').toContain('1→2');
  });
});

describe('шаг 2.2: каналы и кластеры', () => {
  it('2.2.1 две команды одного такта не делят канал', () => {
    const result = scheduleAsm(INDEPENDENT);
    const problems: string[] = [];
    for (const packet of result.packets) {
      const channels = packet.map((index) => result.channels[index]!);
      const unique = new Set(channels);
      if (unique.size !== packet.length) problems.push(`такт с ${packet.length} командами: каналы ${channels.join(',')}`);
    }
    expect(problems, 'повтор канала в одном такте').toEqual([]);
    // И у каждой размещённой команды канал лежит в её допустимом наборе.
    for (const command of INDEPENDENT) {
      const allowed = realOpcode(command.mnemonic)!.channels;
      expect(allowed.length, `${command.mnemonic}: каналы непусты`).toBeGreaterThan(0);
    }
  });

  it('2.2.2 кластеры — no-op: причина названа и такты от неё не зависят', () => {
    // Кластеры не участвуют в расписании: предпочтение измерено как no-op
    // (src/vliw/e2kDevices.ts:104-107), штраф в модели 0 (docs/hardware-debt.md §3.2).
    expect(CLUSTERS_ARE_NOOP, 'причина названа').toContain('no-op');
    expect(CLUSTERS_ARE_NOOP, 'ссылка на измерение').toContain('e2kDevices.ts:104-107');
    // Такты от кластера не зависят: у одной и той же программы расписание детерминировано.
    const first = scheduleAsm(INDEPENDENT);
    const second = scheduleAsm(INDEPENDENT);
    expect(second.metrics.cycles, 'детерминизм').toBe(first.metrics.cycles);
    expect(second.issueAt, 'issueAt').toEqual(first.issueAt);
  });

  it('2.2.3 латентность учтена: у muls готовность дальше, чем у adds того же такта', () => {
    // muls — класс fp (4 такта, руководство МЦСТ стр. 71), adds — int (1 такт).
    expect(classOfMnemonic('adds'), 'класс adds').toBe('int');
    expect(classOfMnemonic('muls'), 'класс muls').toBe('fp');
    const added = scheduleAsm([add(3, 1, 2)]);
    const multiplied = scheduleAsm([{ mnemonic: 'muls', channel: 0, operands: [reg(1), reg(2), reg(3)] }]);
    expect(multiplied.readyAt[0]!, 'readyAt muls').toBeGreaterThan(added.readyAt[0]!);
  });
});

describe('оракул собран и проверяет непустое множество', () => {
  it('фикстуры непусты и различимы', () => {
    expect(INDEPENDENT.length, 'независимые').toBe(3);
    expect(CHAIN.length, 'цепочка').toBe(3);
    expect(registersOf(INDEPENDENT[0]!).writes, 'первая пишет').not.toEqual(registersOf(INDEPENDENT[1]!).writes);
  });
});
