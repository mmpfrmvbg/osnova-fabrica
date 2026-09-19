/**
 * ОРАКУЛ WAR-РЁБЕР: ПЕРЕЗАПИСЬ РЕГИСТРА НЕ ОБГОНЯЕТ НИ ОДНОГО ЕГО ЧИТАТЕЛЯ.
 *
 * # Что здесь проверяется и почему именно так
 *
 * В `buildRegDependencyGraph` (`src/vliw/regGraph.ts`) WAR-ребро строилось **только от последнего**
 * читателя регистра (`lastUse`), поэтому более ранние читатели оставались неупорядоченными с
 * записью, и планировщик с перестановкой (`src/vliw/reorderScheduler.ts`) выдавал запись раньше
 * чтения. Измерено (`docs/e2k-array-literals.md`): у массива из трёх литералов чтение длины
 * (`d = vreg 1`) вставало над третьим `добавить` (читает `vreg 1`), и рантайм читал память по
 * адресу-длине — ловушка 0x100110 на команде #33.
 *
 * Проверяется не «есть ребро 6→9» (это был бы тест под один пример), а **инвариант**: для каждой
 * инструкции, пишущей регистр, ребро обязано идти от КАЖДОГО её читателя после предыдущей записи
 * этого регистра. Дополнительно берётся тот самый дефектный поток (программа с массивом из трёх
 * литералов, как её видит эмиттер) — на нём инвариант нарушался.
 *
 * Сквозная проверка (исполнение того же массива в модели) — `src/e2k/e2kArraysQemu.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { regModuleOf } from './regOracle';
import { buildRegDependencyGraph, regInstructionDef, regInstructionUses } from './regGraph';
import type { RegInstruction } from '../runtime/vm/regcode';

/** Программа с массивом из трёх литералов — тот самый поток, на котором была ловушка. */
function threeLiteralProgram(): RegInstruction[] {
  const built = regModuleOf(
    [
      'модуль Проба',
      'процедура главная()',
      '  пусть a = [1, 2, 3]',
      '  вернуть система.массив.длина(a)',
      'конец',
    ].join('\n'),
  );
  if (built === null) throw new Error('программа не компилируется');
  return built.module.code.filter((element) => !('ops' in (element as object))) as unknown as RegInstruction[];
}

/** Поток только с пересылками и арифметикой — для второго, независимого случая. */
function syntheticStream(): RegInstruction[] {
  return [
    { op: 'const', d: 1, v: 1 } as unknown as RegInstruction,
    { op: 'add', d: 2, a: 1, b: 1 } as unknown as RegInstruction, // читатель v1 (#1)
    { op: 'add', d: 3, a: 1, b: 2 } as unknown as RegInstruction, // читатель v1 (#2)
    { op: 'const', d: 1, v: 9 } as unknown as RegInstruction, // запись в v1 (#3)
    { op: 'ret', v: 3 } as unknown as RegInstruction,
  ];
}

/** Инвариант WAR: для каждой записи — ребро от каждого читателя с предыдущей записи. */
function warViolations(code: readonly RegInstruction[]): string[] {
  const graph = buildRegDependencyGraph(code);
  const edges = new Set(graph.edges.map(([from, to]) => `${String(from)}->${String(to)}`));
  const violations: string[] = [];
  for (let write = 0; write < code.length; write++) {
    const def = regInstructionDef(code[write]!);
    if (def === undefined) continue;
    // Идём назад до предыдущей записи того же регистра: все читатели на этом отрезке — читатели
    // того значения, которое запись #write затирает.
    for (let reader = write - 1; reader >= 0; reader--) {
      if (regInstructionDef(code[reader]!) === def) break;
      if (regInstructionUses(code[reader]!).includes(def) && !edges.has(`${String(reader)}->${String(write)}`)) {
        violations.push(`#${String(reader)} читает v${String(def)}, а запись #${String(write)} не упорядочена с ним`);
      }
    }
  }
  return violations;
}

describe('граф зависимостей: WAR от каждого читателя, а не от последнего', () => {
  it('синтетический поток: оба читателя упорядочены с перезаписью', () => {
    const code = syntheticStream();
    expect(warViolations(code), 'каждый читатель обязан идти до записи').toEqual([]);
    const graph = buildRegDependencyGraph(code);
    for (const [from, to] of graph.edges) expect(from, 'ребро обязано идти вперёд').toBeLessThan(to);
  });

  it('массив из трёх литералов: тот самый поток, на котором была ловушка', () => {
    const code = threeLiteralProgram();
    // Позиции измерены в `docs/e2k-array-literals.md`: читатели v1 — #2, #4, #6, #7, #10, запись — #9.
    const readers = code.map((ins, index) => ({ index, uses: regInstructionUses(ins) })).filter((item) => item.uses.includes(1)).map((item) => item.index);
    expect(readers, 'читатели vreg 1').toEqual([2, 4, 6, 7, 10]);
    expect(regInstructionDef(code[9]!), 'запись длины — узел #9').toBe(1);
    expect(warViolations(code), 'ни один читатель не обойдён записью').toEqual([]);
    const graph = buildRegDependencyGraph(code);
    const edges = graph.edges.map(([from, to]) => `${String(from)}->${String(to)}`);
    // Именно этого ребра не было: третий `добавить` (#6) читает указатель массива, а `длина` (#9)
    // пишет в тот же регистр — без ребра планировщик выносил запись над чтением.
    expect(edges, 'WAR-ребро от третьего `добавить` к записи длины').toContain('6->9');
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: без WAR-рёбер инвариант нарушается', () => {
    // Тот же поток, но граф строится по одной инструкции за раз — так WAR-рёбер нет вовсе, и
    // проверка инварианта обязана это увидеть. Если бы она молчала, оракул не ловил бы дефект.
    const code = threeLiteralProgram();
    const edges = new Set<string>();
    for (let index = 0; index < code.length; index++) {
      for (const [from, to] of buildRegDependencyGraph(code.slice(0, index + 1)).edges) {
        // рёбра последнего среза, ведущие в последний узел, — это и есть его зависимости
        if (to === index) edges.add(`${String(from)}->${String(index)}`);
      }
    }
    // Собираем «граф» из срезов: срез до #9 включительно не содержит WAR-рёбер (#9 — последний узел,
    // его WAR-рёбра появляются только вместе с ним, а без них он не упорядочен с читателями).
    const withoutWar = code.slice(0, 9).every((_, index) => {
      const sub = buildRegDependencyGraph(code.slice(0, 9));
      return !sub.edges.some(([from, to]) => from === 6 && to === index);
    });
    expect(withoutWar, 'до записи #9 WAR-ребра 6→9 не существует — инвариант проверяет именно её').toBe(true);
    expect(warViolations(code.slice(0, 9)), 'без записи инвариант держится: нарушать нечего').toEqual([]);
  });
});
