/**
 * Граф зависимостей по **регистрам** для VLIW-планировщика.
 *
 * Зачем отдельный граф: стековый `dependencyGraph.ts` выводит зависимости из
 * симуляции стека (producer → вершина → consumer). В регистровой форме это
 * не нужно и даже вредно: инструкция `add d, a, b` уже говорит, что она читает
 * `a` и `b` и пишет `d`, поэтому рёбра строятся по номерам — а значит, две
 * независимые цепочки больше не сериализуются через «вершину стека».
 *
 * ## Какие рёбра ставятся
 *
 * 1. **RAW** — от последней записи в каждый читаемый регистр.
 * 2. **WAR** — от последнего чтения каждого записываемого регистра: значение
 *    должно быть прочитано прежним потребителем до перезаписи.
 * 3. **WAW** — от последней записи в тот же регистр (порядок записей значим).
 * 4. **Эффекты** — цепочка в порядке программы: `invoke` без чистоты, `call`,
 *    `obj.set`, `throw`, `try_begin`, `try_end`. Хост-вызовы исполняются
 *    планировщиком в исходном порядке, как их исполняла бы VM без пакетов.
 * 5. **Управление** — `jmp`/`jmp_if`/`jmp_if_not`/`ret` не переставляются
 *    относительно участка (они закрывают блок, см. `scheduleRegBlock`).
 *
 * Чистые системные вызовы (`система.массив.получить`, `система.массив.длина`,
 * `система.итератор.из`, `система.объект.получить`, `система.объект.ключи`,
 * `система.строка.*`) порядка не требуют — именно на них и держится ILP
 * перебора массива.
 */

import type { RegInstruction } from "../runtime/vm/regcode";

/** Read-only системные вызовы: без побочных эффектов, переставляются свободно. */
export const PURE_REG_INVOKES: ReadonlySet<string> = new Set<string>([
  "система.массив.получить",
  "система.массив.длина",
  "система.итератор.из",
  "система.объект.получить",
  "система.объект.ключи",
  "система.строка.длина",
  "система.строка.подстрока",
  "система.строка.содержит",
  "система.строка.начинается_с",
  "система.строка.заканчивается_на",
  "система.строка.найти",
  "система.строка.в_верхний",
  "система.строка.в_нижний",
  "система.строка.обрезать",
  "система.математика.абс",
  "система.математика.пол",
  "система.математика.потолок",
  "система.математика.округлить",
  "система.математика.макс",
  "система.математика.мин",
  "система.математика.степень",
  "система.математика.корень",
]);

/**
 * Всё, что меняет наблюдаемое состояние: такие инструкции идут по порядку.
 *
 * ВАЖНО про `ret`. Возврат из процедуры **обязан** ждать завершения всех
 * предшествующих эффектов: если он выдаётся раньше `invoke`/`obj.set`, процедура
 * закончится до того, как они сработают. Формально у `ret` нет операндов от этих
 * эффектов (возвращаемое значение может быть не связано с ними), поэтому одного
 * построения рёбер по данным недостаточно — см. {@link buildRegDependencyGraph},
 * где `ret` дополнительно замыкается на цепочку эффектов.
 *
 * Дефект был найден оракулом эквивалентности на `storage_demo.osnova`: `ret`
 * получал `preds=[]`, планировщик выдавал его первым, и `система.лог.вывести`
 * не исполнялся.
 */
export function isEffectInstruction(ins: RegInstruction): boolean {
  switch (ins.op) {
    case "obj.set":
    case "throw":
    case "try_begin":
    case "try_end":
      return true;
    case "invoke":
      return !PURE_REG_INVOKES.has(ins.name);
    case "call":
      // Чистоту процедуры знает вызывающий (см. options.callPure).
      return true;
    case "ret":
      // Возврат наблюдает всё, что произошло до него.
      return true;
    default:
      return false;
  }
}

export interface RegGraphOptions {
  /** Процедура объявлена `чистый` — вызов не создаёт порядок с эффектами. */
  callPure?: (fi: number) => boolean;
}

export interface RegGraph {
  /** Число узлов = число инструкций. */
  nodes: number;
  /** Рёбра `[from, to]`: `from` должна быть размещена раньше `to`. */
  edges: [number, number][];
  /** Предшественники по индексу узла. */
  preds: number[][];
  /** Регистр, который пишет инструкция (`undefined` — только эффект). */
  defs: (number | undefined)[];
  /** Регистры, которые инструкция читает. */
  uses: (readonly number[])[];
}

/** Регистры, которые инструкция **читает**. */
export function regInstructionUses(ins: RegInstruction): number[] {
  switch (ins.op) {
    case "const":
    case "const.true":
    case "const.false":
    case "const.null":
    case "obj.new":
      return [];
    case "move":
      return [ins.a];
    case "not":
      return [ins.a];
    case "add":
    case "sub":
    case "mul":
    case "div":
    case "rem":
    case "eq":
    case "ne":
    case "lt":
    case "le":
    case "gt":
    case "ge":
    case "and":
    case "or":
      return [ins.a, ins.b];
    case "invoke":
    case "call":
      return [...ins.args.slice(0, ins.argc)];
    case "jmp":
      return [];
    case "jmp_if":
    case "jmp_if_not":
      return ins.cond === undefined ? [] : [ins.cond];
    case "try_begin":
      // Значение пойманного исключения кладётся в этот регистр интерпретатором,
      // это запись; чтения нет.
      return [];
    case "try_end":
      return [];
    case "throw":
      return ins.a === undefined ? [] : [ins.a];
    case "ret":
      return ins.v === undefined ? [] : [ins.v];
    case "obj.get":
      return [ins.a, ins.key];
    case "obj.set": {
      const uses = [ins.a, ins.key];
      if (ins.b !== undefined) uses.push(ins.b);
      return uses;
    }
    default:
      return [];
  }
}

/** Регистр, который инструкция **пишет** (`undefined` — только эффект). */
export function regInstructionDef(ins: RegInstruction): number | undefined {
  switch (ins.op) {
    case "try_end":
    case "throw":
    case "jmp":
    case "jmp_if":
    case "jmp_if_not":
    case "ret":
    case "obj.set":
      return undefined;
    case "try_begin":
      // Пойманное значение пишется в регистр переменной `иначе_попытка`.
      return ins.catchReg;
    case "invoke":
    case "call":
    case "obj.get":
      return ins.d;
    default: {
      const d = (ins as { d?: number }).d;
      return d;
    }
  }
}

/**
 * Граф зависимостей для линейного участка регистрового кода.
 * Индексы узлов — позиции в переданном массиве.
 */
export function buildRegDependencyGraph(
  code: readonly RegInstruction[],
  options: RegGraphOptions = {},
): RegGraph {
  const n = code.length;
  const edges: [number, number][] = [];
  const preds: number[][] = Array.from({ length: n }, () => []);
  const defs: (number | undefined)[] = new Array(n);
  const uses: number[][] = new Array(n);

  const lastDef = new Map<number, number>();
  const lastUse = new Map<number, number>();
  let lastEffect: number | undefined;

  const addEdge = (from: number, to: number): void => {
    if (from === to) return;
    edges.push([from, to]);
    preds[to]!.push(from);
  };

  for (let i = 0; i < n; i++) {
    const ins = code[i]!;
    const use = regInstructionUses(ins);
    const def = regInstructionDef(ins);
    uses[i] = use;
    defs[i] = def;

    // RAW: значение каждого читаемого регистра должно быть записано до чтения.
    for (const r of use) {
      const producer = lastDef.get(r);
      if (producer !== undefined) addEdge(producer, i);
    }
    // WAW: порядок записей в один регистр сохраняется.
    if (def !== undefined) {
      const prev = lastDef.get(def);
      if (prev !== undefined) addEdge(prev, i);
    }
    // WAR: читатели должны успеть до перезаписи.
    if (def !== undefined) {
      const reader = lastUse.get(def);
      if (reader !== undefined && lastDef.get(def) !== reader) addEdge(reader, i);
    }

    const isPureCall = ins.op === "call" && options.callPure?.(ins.fi) === true;
    if (isEffectInstruction(ins) && !isPureCall) {
      if (lastEffect !== undefined) addEdge(lastEffect, i);
      lastEffect = i;
    }

    if (def !== undefined) lastDef.set(def, i);
    for (const r of use) lastUse.set(r, i);
  }

  return { nodes: n, edges, preds, defs, uses };
}
