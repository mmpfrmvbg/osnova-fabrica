/**
 * ОРАКУЛ ЗАВИСИМОСТЕЙ ПО ПАМЯТИ: ЧТЕНИЕ КУЧИ УПОРЯДОЧЕНО С ЗАПИСЬЮ В НЕЁ.
 *
 * # Что здесь проверяется и почему именно это
 *
 * FIR возвращал 225 вместо 181, и причина — не в раскладке и не в регистрах: планировщик с
 * перестановкой (`src/vliw/reorderScheduler.ts`) вынес `система.массив.добавить` **после**
 * `система.массив.длина`, потому что граф зависимостей знал только регистры и цепочку эффектов, а
 * зависимостей по ПАМЯТИ в нём не было: читающие вызовы объявлены «чистыми» (`PURE_REG_INVOKES`,
 * `src/vliw/regGraph.ts:31`) и переставлялись свободно относительно записи в ту же кучу.
 *
 * Измерено (`.tmp/fir-trace.ts`, `.tmp/dump-invoke-left.ts`): длина читалась, когда элементов было
 * три, `n = 3 − 1 = 2`, внешний цикл шёл шесть витков вместо пяти → +44 (225 вместо 181). На самом
 * выражении это видно так: `длина(a) − 1` давало 2 вместо 3.
 *
 * Поэтому проверяется ИНВАРИАНТ на том самом выражении:
 *
 *   `длина(a)` (и `получить`) обязаны быть упорядочены со ВСЕМИ записями в ту же кучу
 *   (`добавить`), которые стоят раньше них в порядке программы.
 *
 * Проверяется достижимость в графе, а не конкретное ребро: цепочка может быть устроена по-разному
 * (ребро от последней записи или цепочка через предыдущие), важен порядок.
 *
 * Отдельно заморожен набор рёбер программы БЕЗ массивов: правка памяти не должна добавлять там ни
 * одного ребра (иначе она сужает планирование там, где памяти нет).
 *
 * Негативный контроль (снятие правила) — `docs/e2k-regalloc-debt.md` §9 и `.tmp/mem-negative.ts`:
 * без правила этот оракул краснеет, а FIR снова даёт 225.
 */
import { describe, it, expect } from 'vitest';
import { regModuleOf } from './regOracle';
import { buildRegDependencyGraph, regInstructionDef, regInstructionUses } from './regGraph';
import type { RegInstruction } from '../runtime/vm/regcode';

/** Код программы (носители без пакетов). */
function codeOf(source: string): RegInstruction[] {
  const built = regModuleOf(source);
  if (built === null) throw new Error('программа не компилируется');
  return built.module.code.filter((element) => !('ops' in (element as object))) as unknown as RegInstruction[];
}

/** Индексы вызовов с данным именем. */
function callsOf(code: readonly RegInstruction[], name: string): number[] {
  return code
    .map((instruction, index) => ({ instruction, index }))
    .filter((item) => item.instruction.op === 'invoke' && (item.instruction as { name?: string }).name === name)
    .map((item) => item.index);
}

/** Достижим ли узел `to` из узла `from` по рёбрам графа. */
function reaches(edges: readonly (readonly [number, number])[], from: number, to: number): boolean {
  const next = new Map<number, number[]>();
  for (const [a, b] of edges) next.set(a, [...(next.get(a) ?? []), b]);
  const seen = new Set<number>([from]);
  const queue = [from];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === to) return true;
    for (const following of next.get(current) ?? []) {
      if (seen.has(following)) continue;
      seen.add(following);
      queue.push(following);
    }
  }
  return false;
}

/** Программа из диагноза: массив из четырёх литералов, затем чтение длины. */
const LENGTH_AFTER_APPENDS = [
  'модуль Проба',
  'процедура главная()',
  '  пусть a = [1, 2, 3, 4]',
  '  пусть x = система.массив.длина(a) - 1',
  '  вернуть x',
  'конец',
].join('\n');

/** Чтение элемента после записей: та же зависимость, другой читающий вызов. */
const GET_AFTER_APPENDS = [
  'модуль Проба',
  'процедура главная()',
  '  пусть a = [1, 2, 3, 4]',
  '  вернуть система.массив.получить(a, 0)',
  'конец',
].join('\n');

/** Программа без массивов: правка памяти не должна менять её граф. */
const PLAIN = [
  'модуль Проба',
  'процедура главная()',
  '  пусть s = 0',
  '  пусть i = 0',
  '  пока i < 5',
  '    s = s + i',
  '    i = i + 1',
  '  конец',
  '  вернуть s',
  'конец',
].join('\n');

/**
 * Замороженный набор рёбер программы без массивов.
 *
 * Снят замером ДО правки памяти (`.tmp/edges-probe.ts`): 18 носителей, 34 ребра. Если правка
 * добавит здесь хоть одно ребро, планирование сузится там, где памяти нет, — и это будет видно.
 */
const PLAIN_EDGES = [
  '1->2', '2->4', '3->4', '4->5', '0->6', '3->6', '4->6', '1->7', '6->8', '7->8', '2->8', '4->8',
  '8->9', '0->9', '6->9', '1->10', '6->10', '8->10', '7->11', '8->11', '10->12', '11->12', '8->12',
  '9->12', '12->13', '1->13', '2->13', '7->13', '10->13', '9->15', '4->15', '5->15', '15->16', '16->17',
];

describe('граф зависимостей: память (куча) упорядочена как регистры', () => {
  it('`длина` упорядочена со ВСЕМИ `добавить`, стоящими раньше (то самое выражение с 44)', () => {
    const code = codeOf(LENGTH_AFTER_APPENDS);
    const appends = callsOf(code, 'система.массив.добавить');
    const length = callsOf(code, 'система.массив.длина');
    expect(appends.length, 'в программе четыре добавления').toBe(4);
    expect(length.length, 'и одно чтение длины').toBe(1);
    const read = length[0]!;
    const graph = buildRegDependencyGraph(code);
    for (const append of appends) {
      if (append > read) continue;
      expect(
        reaches(graph.edges, append, read),
        `добавление #${String(append)} обязано быть упорядочено с чтением длины #${String(read)}`,
      ).toBe(true);
    }
  });

  it('`получить` упорядочено с записями в ту же кучу', () => {
    const code = codeOf(GET_AFTER_APPENDS);
    const appends = callsOf(code, 'система.массив.добавить');
    const get = callsOf(code, 'система.массив.получить');
    expect(get.length, 'в программе одно чтение элемента').toBe(1);
    const read = get[0]!;
    const graph = buildRegDependencyGraph(code);
    for (const append of appends) {
      if (append > read) continue;
      expect(
        reaches(graph.edges, append, read),
        `добавление #${String(append)} обязано быть упорядочено с чтением #${String(read)}`,
      ).toBe(true);
    }
  });

  it('создание массива тоже упорядочено с чтением: куча пишется и там', () => {
    const code = codeOf(LENGTH_AFTER_APPENDS);
    const create = callsOf(code, 'система.массив.создать');
    const read = callsOf(code, 'система.массив.длина')[0]!;
    const graph = buildRegDependencyGraph(code);
    for (const call of create) {
      expect(reaches(graph.edges, call, read), `создание #${String(call)} обязано быть до чтения длины`).toBe(true);
    }
  });

  it('программа БЕЗ массивов: набор рёбер не изменился (ни одного лишнего)', () => {
    const code = codeOf(PLAIN);
    const graph = buildRegDependencyGraph(code);
    const measured = graph.edges.map(([from, to]) => `${String(from)}->${String(to)}`).sort();
    expect(measured, 'рёбра программы без массивов').toEqual([...PLAIN_EDGES].sort());
  });

  it('чтение длины после записи стоит ПОСЛЕ неё и по порядку носителей', () => {
    // Дополнительная проверка «наоборот»: если бы цепочка памяти ставила чтение перед записью,
    // планировщик получил бы право выдать чтение раньше — и это тоже дефект (порядок программы).
    const code = codeOf(LENGTH_AFTER_APPENDS);
    const lastAppend = callsOf(code, 'система.массив.добавить').at(-1)!;
    const read = callsOf(code, 'система.массив.длина')[0]!;
    expect(lastAppend, 'последнее добавление идёт раньше чтения в порядке программы').toBeLessThan(read);
    const graph = buildRegDependencyGraph(code);
    expect(reaches(graph.edges, read, lastAppend), 'обратного ребра (чтение → запись) быть не должно').toBe(false);
    // Граф остаётся ациклическим: каждое ребро идёт вперёд по порядку носителей.
    for (const [from, to] of graph.edges) expect(from, 'ребро обязано идти вперёд').toBeLessThan(to);
  });

  it('носители и их чтения/записи читаются так же, как в оракуле WAR', () => {
    // Страховка от «оракул проверяет не то»: у invoke чтения — его аргументы, у записи — приёмник.
    const code = codeOf(GET_AFTER_APPENDS);
    const appends = callsOf(code, 'система.массив.добавить');
    expect(appends.length).toBe(4);
    for (const index of appends) {
      expect(regInstructionUses(code[index]!).length, `аргументы добавления #${String(index)}`).toBe(2);
      expect(regInstructionDef(code[index]!), `у добавления нет приёмника`).toBeUndefined();
    }
  });
});
