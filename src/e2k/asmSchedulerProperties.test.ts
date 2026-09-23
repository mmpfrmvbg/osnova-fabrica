/**
 * UNIT-ТЕСТЫ НА СВОЙСТВА ПЛАНИРОВЩИКА — задачи 1 и 2.
 *
 * # Зачем синтетика, а не фрагмент ядра
 *
 * Фикстура из 16 команд реального `fir` (`src/e2k/asmSchedulerFixture.test.ts`) негативным
 * контролем поймала только два дефекта из четырёх: WAR/WAW в предусловии выдачи и предел поиска
 * такта сквозь неё **не проявились** — в коротком фрагменте конфликт не доходит до одного такта
 * (нехватка каналов разводит команды и без запрета), а 16 команд укладываются в восемь попыток.
 *
 * Правильный ответ — не удлинять интеграционную фикстуру, а проверять **свойство точечно**:
 *
 * | свойство | как проверяется |
 * |---|---|
 * | WAR: читатель и последующая запись не в одном такте | две команды, у которых **единственная** связь — WAR |
 * | WAW: две записи одного регистра не в одном такте | две команды, у которых **единственная** связь — WAW |
 * | нет произвольного предела поиска такта | команд больше, чем вмещают каналы за 8 тактов |
 *
 * Первые два теста построены так, что связь между командами **ровно одна** и она WAR или WAW:
 * если планировщик перестанет их учитывать, команды неизбежно окажутся в одном такте (разные
 * каналы, нет RAW — ничто другое их не разведёт).
 */

import { describe, it, expect } from 'vitest';
import { scheduleAsm } from './asmScheduler';
import { registersOf } from './widePacker';
import { realOpcode } from './e2k-real';
import type { AsmInstruction, Operand } from './backend';

const reg = (index: number): Operand => ({ kind: 'reg', index });
/** `adds` — форма ALF1, операнды `[src1, src2, dst]`, каналы 0–5. */
const add = (dst: number, a: number, b: number): AsmInstruction => ({
  mnemonic: 'adds',
  channel: 0,
  operands: [reg(a), reg(b), reg(dst)],
});

describe('свойство: WAR не допускает совместной упаковки', () => {
  // A читает r1 и пишет r5; B пишет r1. RAW нет (B не читает r5), единственная связь — WAR по r1.
  //
  // ВАЖНО, почему `muls`, а не `adds`: при короткой латентности (1 такт) тест не различает
  // «WAR в запрете упаковки» и «WAR в порядке выдачи» — в обоих случаях команды окажутся в разных
  // тактах, и подмена проходит незамеченной (это измерено негативным контролем). WAR — не
  // зависимость по данным: потребитель **не обязан** ждать готовности результата производителя.
  // Поэтому проверяется не «разные такты», а «B выдан РАНЬШЕ готовности A».
  const A: AsmInstruction = { mnemonic: 'muls', channel: 0, operands: [reg(1), reg(2), reg(5)] };
  const B = add(1, 7, 8);

  it('связь ровно одна и она WAR — предпосылка теста проверена, а не предположена', () => {
    const a = registersOf(A);
    const b = registersOf(B);
    expect(a.writes, 'A пишет').toEqual(['base:5']);
    expect(b.writes, 'B пишет').toEqual(['base:1']);
    // WAR: A читает то, что B пишет.
    expect(a.reads.filter((key) => b.writes.includes(key)), 'WAR по r1').toEqual(['base:1']);
    // RAW отсутствует: B не читает то, что пишет A.
    expect(b.reads.filter((key) => a.writes.includes(key)), 'RAW отсутствует').toEqual([]);
    // WAW отсутствует: записи в разные регистры.
    expect(a.writes.filter((key) => b.writes.includes(key)), 'WAW отсутствует').toEqual([]);
  });

  it('WAR: команды не в одном такте И B не ждёт готовности A', () => {
    const result = scheduleAsm([A, B]);
    expect(result.issueAt.filter((at) => at < 0), 'не размещённых').toEqual([]);
    expect(result.issueAt[0], 'A в такте').not.toBe(result.issueAt[1]);
    // Латентность `muls` — 4 такта (класс fp), поэтому различитель здесь именно это неравенство:
    // при WAR в порядке выдачи B ждал бы такта 4.
    expect(result.readyAt[0]! - result.issueAt[0]!, 'латентность A').toBeGreaterThan(1);
    expect(result.issueAt[1], 'B не ждёт готовности A').toBeLessThan(result.readyAt[0]!);
  });

  it('позитивный контроль: без WAR они действительно встали бы в один такт', () => {
    // Та же пара, но B пишет регистр, которого A не читает: связь исчезает, и каналы разные —
    // значит обе обязаны попасть в один такт. Если бы это было не так, предыдущий тест ничего
    // не доказывал бы: команды разводились бы и без WAR.
    const free = add(9, 7, 8);
    const result = scheduleAsm([A, free]);
    expect(registersOf(A).reads.filter((key) => registersOf(free).writes.includes(key)), 'WAR нет').toEqual([]);
    expect(result.issueAt[0], 'обе в одном такте').toBe(result.issueAt[1]);
  });
});

describe('свойство: WAW не допускает совместной упаковки', () => {
  // A и B пишут один регистр r5; чтения не пересекаются с записями — единственная связь WAW.
  const A = add(5, 1, 2);
  const B = add(5, 7, 8);

  it('связь ровно одна и она WAW', () => {
    const a = registersOf(A);
    const b = registersOf(B);
    expect(a.writes.filter((key) => b.writes.includes(key)), 'WAW по r5').toEqual(['base:5']);
    expect(a.reads.filter((key) => b.writes.includes(key)), 'WAR отсутствует').toEqual([]);
    expect(b.reads.filter((key) => a.writes.includes(key)), 'RAW отсутствует').toEqual([]);
  });

  it('WAW: команды не в одном такте', () => {
    const result = scheduleAsm([A, B]);
    expect(result.issueAt.filter((at) => at < 0), 'не размещённых').toEqual([]);
    expect(result.issueAt[0], 'A в такте').not.toBe(result.issueAt[1]);
  });
});

describe('свойство: произвольного предела поиска такта нет', () => {
  /**
   * `std` — запись в память, форма ALF3, каналы только `[2, 5]` (`STORE_CHANNELS`).
   *
   * Все команды несут **одинаковые** операнды-регистры и ничего не пишут, поэтому зависимостей
   * между ними нет вовсе: размещение определяется исключительно нехваткой каналов. Двух каналов
   * хватает на две команды в такт, значит 24 команды требуют **12 тактов** — больше восьми,
   * которые давал предел «8 попыток».
   */
  const store = (): AsmInstruction => ({
    mnemonic: 'std',
    channel: 0,
    operands: [reg(1), reg(2), reg(0)],
  });

  it('предпосылка: у `std` два канала и зависимостей между командами нет', () => {
    const channels = realOpcode('std')?.channels ?? [];
    expect(channels.length, 'каналов у std').toBe(2);
    const first = registersOf(store());
    expect(first.writes, 'std не пишет регистр').toEqual([]);
  });

  it('24 команды с двумя каналами размещаются: тактов больше восьми', () => {
    const commands = Array.from({ length: 24 }, store);
    const result = scheduleAsm(commands);
    expect(result.issueAt.filter((at) => at < 0), 'не размещённых').toEqual([]);
    // 24 команды по два канала — не меньше 12 тактов.
    expect(result.metrics.cycles, 'тактов').toBeGreaterThanOrEqual(12);
    // И каждую команду получил свой канал из разрешённых.
    const problems = result.channels.filter((channel) => channel >= 0 && !(realOpcode('std')?.channels ?? []).includes(channel));
    expect(problems, 'канал вне разрешённых').toEqual([]);
  });

  it('веер с общим предшественником: сдвиг больше восьми тактов — искусственного предела нет', () => {
    // Здесь предыдущий тест бессилен, и это измерено негативным контролем: когда команды стартуют
    // от растущего `tick`, каждая делает одну-две попытки, и предел «8» не достигается. Глубокий
    // сдвиг возникает, только если у многих команд **общий большой `ready`**: тогда они все
    // претендуют на один и тот же такт и выстраиваются в очередь.
    //
    // `muls` (класс fp, 4 такта) пишет r5; двадцать `std` читают r5, поэтому у всех ready = 4.
    // Два канала `std` на такт → последняя команда требует такта 13, то есть сдвига на 9 тактов
    // от своего `ready`. Предел в восемь попыток обрубил бы её.
    const producer: AsmInstruction = { mnemonic: 'muls', channel: 0, operands: [reg(1), reg(2), reg(5)] };
    const readers = Array.from({ length: 20 }, (): AsmInstruction => ({
      mnemonic: 'std',
      channel: 0,
      operands: [reg(0), reg(5), reg(2)],
    }));
    const result = scheduleAsm([producer, ...readers]);
    expect(result.issueAt.filter((at) => at < 0), 'не размещённых').toEqual([]);
    // Готовность производителя — 4 такта; последняя читающая команда выдаётся заметно позже.
    expect(result.readyAt[0], 'готовность muls').toBe(4);
    const lastIssue = Math.max(...result.issueAt);
    expect(lastIssue, 'последняя команда').toBeGreaterThanOrEqual(13);
    expect(lastIssue - result.readyAt[0]!, 'сдвиг от готовности').toBeGreaterThan(8);
  });
});

describe('свойство: длинная цепочка RAW размещается', () => {
  it('20+ команд A→B→C размещаются, и каждая следующая не раньше готовности предыдущей', () => {
    // Цепочка RAW: каждая команда читает результат предыдущей.
    const commands: AsmInstruction[] = [add(3, 1, 2)];
    for (let step = 1; step < 22; step++) commands.push(add(3 + step, 2 + step, 2));
    const result = scheduleAsm(commands);
    expect(result.issueAt.filter((at) => at < 0), 'не размещённых').toEqual([]);
    expect(result.order.length, 'order').toBe(commands.length);
    const problems: string[] = [];
    for (let index = 1; index < commands.length; index++) {
      const producer = index - 1;
      if (result.readyAt[producer]! > result.issueAt[index]!) {
        problems.push(`#${index} выдан в ${result.issueAt[index]}, а результат #${producer} готов в ${result.readyAt[producer]}`);
      }
    }
    expect(problems, 'нарушение RAW').toEqual([]);
  });
});

describe('оракул собран и проверяет непустое множество', () => {
  it('все фикстуры непусты и различимы', () => {
    expect(scheduleAsm([add(5, 1, 2)]).order.length, 'одна команда').toBe(1);
    expect(realOpcode('std'), 'std в таблице опкодов').toBeDefined();
  });
});
