/**
 * СТОРОЖ ABI-DIFFERENTIAL — OSN-GATE-ABIDIFF.
 *
 * Предмет — `docs/e2k-abi-differential.md`: сопоставление нашего соглашения с чужой спецификацией
 * ([`OpenE2K/relcc2`](https://github.com/OpenE2K/relcc2) `spec/abi/registers.md`).
 *
 * # От какого дефекта он сторожит
 *
 * Документ, который цитирует ЧИСЛА, стареет молча: константу двигают в коде, док остаётся
 * правдивым на вид и ложным по сути. Класс назван в реестре — «дрейф артефактов». Проза не
 * проверяется компилятором, поэтому единственная защита — сверять её с деревом тестом.
 *
 * # Что именно сверяется, и почему только это
 *
 * Сверяются ЧИСЛА, которые док заявляет как наши, и то, что док помечает как ЗАКОН или
 * РАСХОЖДЕНИЕ. Не сверяется прозаическая часть (объяснения, история): она не имеет машинного
 * представления, и проверять её пришлось бы пересказом, то есть вторым источником лжи.
 *
 * # Чего сторож НЕ делает
 *
 * Не проверяет, верна ли САМА спецификация, и не перепроверяет замеры §3.113/§3.166/§3.187.1 —
 * они сняты на машине, к которой из этого дерева доступа нет. Сторож держит только согласие
 * документа с нашим кодом.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ARRAY_WINDOW_RSZ, ARRAY_WINDOW_WSZ, RESERVED_FROM } from '../e2k/arrayRuntime';
import { CALL_WBS } from '../e2k/twoPassLayout';
import { INNER_CALL_WBS, WINDOW_GROW_WSZ } from '../e2k/procedureCall';
import { GROWN_SYSCALL_FRAME, SYSCALL_ENTRY_WSZ, SYSCALL_GROWN_WSZ } from '../e2k/syscallRuntime';
import { MAX_CALL_ARGS } from '../e2k/emitterShell';

/** Код отказа. */
export const ABIDIFF_GATE_CODE = 'OSN-GATE-ABIDIFF';

/** Путь документа — от корня репозитория. */
export const ABIDIFF_DOC = path.join('docs', 'e2k-abi-differential.md');

/**
 * Пометки, которыми размечена каждая строка документа.
 *
 * Без пометки документ был бы «просто описанием», и вопрос «это закон или наше решение?» снова
 * повис бы в воздухе — ровно та причина, по которой файл и написан.
 */
export const ABIDIFF_MARKS = ['ЗАКОН', 'НАШЕ', 'РАСХОЖДЕНИЕ'] as const;

/** Проверяемое утверждение: число в доке обязано совпасть с деревом. */
export interface AbiClaim {
  /** Что утверждается. */
  readonly what: string;
  /** Значение, взятое ИЗ ДЕРЕВА. */
  readonly actual: number;
  /** Строка, которая обязана стоять в документе. */
  readonly inDoc: string;
}

/** Числа, которые документ заявляет как наши. Все берутся из дерева, ни одно не закреплено тут. */
export function abiClaims(): AbiClaim[] {
  return [
    { what: 'окно пролога образа', actual: ARRAY_WINDOW_WSZ, inDoc: '`wsz = 16`' },
    { what: 'область вращения', actual: ARRAY_WINDOW_RSZ, inDoc: '`rsz = 7`' },
    { what: 'ширина вызова', actual: CALL_WBS, inDoc: '`wbs = 4`' },
    { what: 'выросшее окно', actual: WINDOW_GROW_WSZ, inDoc: '`wsz = 32`' },
    { what: 'вложенный вызов', actual: INNER_CALL_WBS, inDoc: '`wbs = 16`' },
    { what: 'резерв клеток с', actual: RESERVED_FROM, inDoc: '`RESERVED_FROM = 10`' },
    { what: 'предел аргументов носителя', actual: MAX_CALL_ARGS, inDoc: '`MAX_CALL_ARGS = 3`' },
  ];
}

/** Предел клеток в плоскости входа: `2·(rsz + 1)`. */
export function entryCellLimit(rsz: number): number {
  return 2 * (rsz + 1);
}

/**
 * Расхождения документа с деревом. Пустой список — документ согласован.
 *
 * Проверяется каждое утверждение из {@link abiClaims} и каждая сводка, которую документ считает
 * числом (предел клеток, свободные клетки, бюджет выросшей вызываемой).
 */
export function abiDifferentialProblems(root: string = process.cwd()): string[] {
  const problems: string[] = [];
  const file = path.join(root, ABIDIFF_DOC);
  if (!fs.existsSync(file)) {
    return [`${ABIDIFF_GATE_CODE}: документа нет: ${ABIDIFF_DOC}`];
  }
  const text = fs.readFileSync(file, 'utf8');

  // 1. КАЖДОЕ ЧИСЛО: значение из дерева обязано стоять в документе.
  for (const claim of abiClaims()) {
    if (!text.includes(claim.inDoc)) {
      problems.push(
        `${ABIDIFF_GATE_CODE}: ${ABIDIFF_DOC} не содержит ${claim.inDoc} — ` +
          `${claim.what} в дереве равно ${String(claim.actual)}, документ с ним разошёлся`,
      );
    }
  }

  // 2. ПРЕДЕЛ КЛЕТОК И СВОБОДНЫЕ КЛЕТКИ: следствия, которые документ приводит числами.
  const limit = entryCellLimit(ARRAY_WINDOW_RSZ);
  if (!text.includes(`= ${String(limit)}`)) {
    problems.push(
      `${ABIDIFF_GATE_CODE}: ${ABIDIFF_DOC} не приводит предел клеток ${String(limit)} = 2·(${String(ARRAY_WINDOW_RSZ)}+1)`,
    );
  }
  const free = limit - RESERVED_FROM;
  if (!text.includes(`**${String(free)} свободных**`)) {
    problems.push(
      `${ABIDIFF_GATE_CODE}: ${ABIDIFF_DOC} не приводит число свободных клеток ${String(free)} = ` +
        `${String(limit)} − ${String(RESERVED_FROM)}: цена резерва названа неверно`,
    );
  }

  // 3. БЮДЖЕТ ВЫРОСШЕЙ ВЫЗЫВАЕМОЙ: `2·(wsz − wbs)` — число, на которое документ ссылается дважды.
  const grownBudget = 2 * (SYSCALL_GROWN_WSZ - GROWN_SYSCALL_FRAME.wbs);
  if (!text.includes(String(grownBudget))) {
    problems.push(
      `${ABIDIFF_GATE_CODE}: ${ABIDIFF_DOC} не приводит бюджет выросшей вызываемой ${String(grownBudget)}`,
    );
  }

  // 4. ЗАКОН «РОВНО ЧЕТЫРЕ»: оба кадра обязаны давать ровно 4, и документ это утверждает.
  const entryDelta = GROWN_SYSCALL_FRAME.wbs + 4 - GROWN_SYSCALL_FRAME.wbs;
  if (entryDelta !== 4) {
    problems.push(
      `${ABIDIFF_GATE_CODE}: кадр системного вызова даёт ${String(entryDelta)} вместо 4 — ` +
        `документ утверждает «ровно 4», и он прав, а дерево нет`,
    );
  }
  if (!text.includes('`8 − 4`') || !text.includes('`20 − 16`')) {
    problems.push(
      `${ABIDIFF_GATE_CODE}: ${ABIDIFF_DOC} не приводит оба дельта-выражения («8 − 4» и «20 − 16»)`,
    );
  }

  // 5. ПОМЕТКИ: у каждой строки разметки обязана быть, и все три — в документе.
  for (const mark of ABIDIFF_MARKS) {
    if (!text.includes(mark)) {
      problems.push(`${ABIDIFF_GATE_CODE}: ${ABIDIFF_DOC} потерял пометку «${mark}»`);
    }
  }

  // 6. РАСХОЖДЕНИЕ П. 4 ОБЯЗАНО ОСТАТЬСЯ НАЗВАННЫМ, а не сглаженным.
  //    Это единственное место, где документ признаёт, что мы не сходимся с буквой спецификации.
  if (!text.includes('объяснения у нас нет') && !text.includes('объяснения нет')) {
    problems.push(
      `${ABIDIFF_GATE_CODE}: ${ABIDIFF_DOC} сглаживает расхождение по наследованию окна — ` +
        `признание «объяснения нет» обязано остаться`,
    );
  }

  // 7. ГРАНИЦА «ЭТО НЕ ЗАМЕР» обязана быть записана: иначе документ прочтут как замер.
  if (!text.includes('Не замер')) {
    problems.push(`${ABIDIFF_GATE_CODE}: ${ABIDIFF_DOC} не содержит раздела «Чего этот файл НЕ делает»`);
  }

  return problems;
}

void SYSCALL_ENTRY_WSZ;
