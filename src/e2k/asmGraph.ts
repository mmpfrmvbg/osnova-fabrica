/**
 * ГРАФ ЗАВИСИМОСТЕЙ ПО КОМАНДАМ e2k (`AsmInstruction`).
 *
 * # Откуда структура
 *
 * Адаптирован `src/vliw/regGraph.ts` — там тот же граф построен для `RegInstruction`
 * (`buildRegDependencyGraph`, `:203`; `lastDef` — `:213`, цепочка эффектов — `:229-263`).
 * Отличие одно и существенное: **ключ зависимости здесь строка**, а не число, потому что
 * `registersOf` (`src/e2k/widePacker.ts:56`) возвращает `"файл:индекс"` — `%b[3]` и `%r3` разные
 * ячейки, и склеить их в одно число значило бы разрешить неверную группировку.
 *
 * # Рёбра
 *
 * | вид | как строится |
 * |---|---|
 * | RAW | запись регистра → каждая следующая команда, которая его читает |
 * | WAW | запись регистра → следующая запись того же регистра |
 * | WAR | чтение регистра → следующая запись того же регистра |
 * | эффект | команда-эффект → следующая команда-эффект (порядок наблюдается) |
 *
 * # Кто считается эффектом
 *
 * По умолчанию — команда, которую упаковщик **не** берёт в широкую команду из-за формы
 * (`packetableRefusal`), либо пересылка с эффектом записи. Признак задаётся снаружи
 * (`options.isEffect`), потому что «чистая ли операция» — свойство программы, а не команды.
 */

import type { AsmInstruction } from './backend';
import { registersOf, packetableRefusal } from './widePacker';

/** Граф зависимостей по командам: узлы — индексы, рёбра — `[производитель, потребитель]`. */
export interface AsmGraph {
  readonly nodes: readonly number[];
  readonly edges: readonly (readonly [number, number])[];
}

/** Что считать эффектом: по умолчанию — то, что не группируется, плюс пересылки с приёмником. */
export interface AsmGraphOptions {
  readonly isEffect?: (command: AsmInstruction) => boolean;
}

/**
 * Команда с наблюдаемым эффектом **по умолчанию**: та, которую упаковщик не берёт из-за формы.
 *
 * Запись регистра эффектом **не является**: её результат наблюдается через RAW/WAW, и это
 * отдельные рёбра. Здесь стояло `writes.length > 0`, и тогда любые три независимые команды
 * связывались цепочкой эффектов — оракул это поймал (проверки `2.1.1` и `2.1.3`).
 *
 * Настоящие эффекты (память, вызов) формой не выражаются, поэтому их обязан назвать вызывающий
 * через `options.isEffect`: «чистая ли операция» — свойство программы, а не команды.
 */
export function isEffectCommand(command: AsmInstruction): boolean {
  return packetableRefusal(command) !== undefined;
}

/** Построить граф зависимостей по потоку команд. */
export function buildAsmDependencyGraph(
  commands: readonly AsmInstruction[],
  options: AsmGraphOptions = {},
): AsmGraph {
  const isEffect = options.isEffect ?? isEffectCommand;
  const edges: [number, number][] = [];
  const addEdge = (from: number, to: number): void => {
    if (from !== to) edges.push([from, to]);
  };
  /** Последняя запись каждого регистра и последняя читающая команда. */
  const lastDef = new Map<string, number>();
  const lastRead = new Map<string, number>();
  let lastEffect: number | undefined;

  commands.forEach((command, index) => {
    const { reads, writes } = registersOf(command);
    // RAW: кто записал регистр последним — тот производитель.
    for (const key of reads) {
      const producer = lastDef.get(key);
      if (producer !== undefined) addEdge(producer, index);
    }
    // WAR: читатели обязаны исполниться до этой записи.
    for (const key of writes) {
      const reader = lastRead.get(key);
      if (reader !== undefined) addEdge(reader, index);
      const previous = lastDef.get(key);
      if (previous !== undefined) addEdge(previous, index); // WAW
    }
    if (isEffect(command)) {
      if (lastEffect !== undefined) addEdge(lastEffect, index);
      lastEffect = index;
    }
    for (const key of writes) lastDef.set(key, index);
    for (const key of reads) lastRead.set(key, index);
  });

  return { nodes: commands.map((_, index) => index), edges };
}
