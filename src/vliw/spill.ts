/**
 * МИНИМАЛЬНОЕ ВЫТЕСНЕНИЕ В ПАМЯТЬ (spill).
 *
 * # Задача, которую решает модуль
 *
 * Три процедуры пяти ядер не влезают в бюджет точки входа: `fir/фильтр` — 9 живых отрезков при 8
 * свободных, `convolution/свёртка` — 9 при 8, `correlation/корреляция` — 11 при 8
 * (`docs/e2k-regalloc-debt.md` §13). Пик снижен живостью по графу потока управления (линейный 11 →
 * CFG-занятых 10 → CFG-точных 9), но отказ остался: отрезки **позиционные**, а переносимое через дугу
 * цикла значение обязано жить в одном регистре.
 *
 * Здесь — не полный аллокатор с вытеснением, а **минимальное** правило: когда регистра не хватает,
 * в память уезжает **самое дешёвое** значение, и не больше {@link MAX_SPILLS_PER_PROCEDURE} значений
 * на процедуру. Всё, что сверх, — отказ с причиной, а не тихая потеря значения.
 *
 * # Из чего состоит вытеснение
 *
 * | что | носитель | во что понижается |
 * |---|---|---|
 * | запись значения в слот | {@link SPILL_STORE} | `movtd` (адрес слота литералом) + `std` |
 * | чтение значения из слота | {@link SPILL_LOAD} | `movtd` + `ldd` |
 *
 * Почему адрес литералом: в e2k адрес — **сумма двух регистров**, поля смещения в команде нет
 * (измерено: `src/e2k/e2kMemory.test.ts`, `qemu/target/e2k/tcg/translate-al-c11.c:26-34`). Значит
 * адрес слота обязан лежать в регистре, а взять его неоткуда, кроме литерала: свободных регистров
 * ровно столько, сколько не хватает. Смещением служит `%b[12]` — ноль рантайма массивов, который
 * никто не переписывает.
 *
 * Временный регистр нужен на **две соседние** команды, поэтому он не «второй регистр на значение»,
 * а регистр, свободный **в точке сайта**; его выбирает раскладка (`src/e2k/regAlloc.ts`), а не этот
 * модуль: модуль отвечает за политику (кого вытеснять) и за форму носителей.
 *
 * # Почему не «взять регистр у рантайма»
 *
 * `%b[10..15]` заняты рантаймом массивов (`src/e2k/arrayRuntime.ts`): `%b[15]` — указатель кучи,
 * `%b[14]` — восемь, `%b[12]` — ноль, `%b[13]` — единица, `%b[10..11]` — временные, которые рантайм
 * портит. Это измеренный контракт, а не соглашение: операция массива, чей операнд попал в эту
 * область, **отказывает**.
 */

import type { AsmInstruction, Operand } from '../e2k/backend';

/** Носитель чтения вытесненного значения из слота. */
export const SPILL_LOAD = 'IR.spill_ld';

/** Носитель записи значения в слот. */
export const SPILL_STORE = 'IR.spill_st';

/**
 * Предел вытеснений на процедуру.
 *
 * Два — потому что задача названа **минимальной**: у `фильтр` не хватает одного значения, у
 * `свёртки` одного, у `корреляции` двух (`docs/e2k-regalloc-debt.md` §13). Всё, что больше, — это
 * уже полный аллокатор с вытеснением, и он должен быть отдельной работой с отдельным замером.
 */
export const MAX_SPILLS_PER_PROCEDURE = 2;

/** Размер слота: одна команда `ldd`/`std` переносит двойное слово. */
export const SPILL_SLOT_BYTES = 8;

/** Что вытеснено в этой процедуре: значение, номер слота, адрес слота и цена в обращениях к памяти. */
export interface SpilledValue {
  readonly vreg: number;
  readonly slot: number;
  readonly address: number;
  /** Сколько обращений к памяти добавило вытеснение: чтения перед чтениями плюс записи после определений. */
  readonly accesses: number;
}

/** План вытеснения: где лежат слоты и сколько их разрешено. */
export interface SpillOptions {
  /** Абсолютный адрес области слотов: `base + 8·slot`. */
  readonly base: number;
  readonly maxSlots?: number;
}

/** Адрес слота: слоты лежат подряд по 8 байт, начиная с `base`. */
export function spillAddressOf(base: number, slot: number): number {
  return base + slot * SPILL_SLOT_BYTES;
}

const reg = (index: number): Operand => ({ kind: 'reg', index });
const imm = (value: number): Operand => ({ kind: 'imm', value });

/**
 * Носитель чтения из слота: `[регистр-адреса, регистр-приёмника, адрес слота]`.
 *
 * Регистры здесь **физические**: носитель вставляется после раскладки, и vreg'ов в нём уже нет.
 */
export function spillLoadCarrier(addressRegister: number, destinationRegister: number, address: number): AsmInstruction {
  return { mnemonic: SPILL_LOAD, channel: 0, operands: [reg(addressRegister), reg(destinationRegister), imm(address)] };
}

/**
 * Носитель записи в слот: `[регистр-значения, регистр-адреса, адрес слота]`.
 *
 * Регистр адреса обязан отличаться от регистра значения: команда `std` читает оба.
 */
export function spillStoreCarrier(valueRegister: number, addressRegister: number, address: number): AsmInstruction {
  return { mnemonic: SPILL_STORE, channel: 0, operands: [reg(valueRegister), reg(addressRegister), imm(address)] };
}

/** Цена вытеснения значения: чем дешевле, тем охотнее его вытесняют. */
export interface SpillCost {
  readonly vreg: number;
  /** Сколько раз значение читается — столько чтений из памяти добавит вытеснение. */
  readonly uses: number;
  /** Сколько раз значение определяется — столько записей в память добавит вытеснение. */
  readonly defs: number;
  /** Переносится ли значение через обратную дугу: тогда чтения повторяются на каждом витке. */
  readonly loopCarried: boolean;
  readonly cost: number;
}

/**
 * Цена вытеснения по потоку процедуры.
 *
 * «Самое дешёвое» — это **редко читается и не в цикле** (требование владельца): считаются чтения и
 * определения значения, а перенос через дугу получает надбавку {@link LOOP_CARRIED_PENALTY}, потому
 * что там добавленные обращения к памяти исполняются на каждом витке, а не один раз.
 */
export const LOOP_CARRIED_PENALTY = 8;

export function spillCostsOf(
  instructions: readonly AsmInstruction[],
  options: {
    readonly defUse: (instruction: AsmInstruction) => { readonly def: readonly number[]; readonly use: readonly number[] };
    readonly loopCarried?: ReadonlySet<number>;
  },
): ReadonlyMap<number, SpillCost> {
  const uses = new Map<number, number>();
  const defs = new Map<number, number>();
  for (const instruction of instructions) {
    const facts = options.defUse(instruction);
    for (const vreg of facts.use) uses.set(vreg, (uses.get(vreg) ?? 0) + 1);
    for (const vreg of facts.def) defs.set(vreg, (defs.get(vreg) ?? 0) + 1);
  }
  const costs = new Map<number, SpillCost>();
  for (const vreg of new Set([...uses.keys(), ...defs.keys()])) {
    const useCount = uses.get(vreg) ?? 0;
    const defCount = defs.get(vreg) ?? 0;
    const loopCarried = options.loopCarried?.has(vreg) === true;
    costs.set(vreg, {
      vreg,
      uses: useCount,
      defs: defCount,
      loopCarried,
      cost: useCount + defCount + (loopCarried ? LOOP_CARRIED_PENALTY : 0),
    });
  }
  return costs;
}

/**
 * Выбрать жертву среди значений, которые **сейчас держат регистр**.
 *
 * Ничья разрешается меньшим номером vreg: выбор обязан быть воспроизводимым, иначе один и тот же
 * поток даёт разные раскладки, и закреплённые числа перестают что-либо значить.
 *
 * Значение без цены (в потоке не встречается) не выбирается: вытеснять то, чего нет, бессмысленно.
 * Значение, для которого `feasible` вернуло `false`, тоже не выбирается: вытеснить его некуда —
 * в точке сайта нет регистра (см. {@link siteFeasible}).
 */
export function chooseSpillVictim(
  candidates: readonly number[],
  costs: ReadonlyMap<number, SpillCost>,
  feasible?: (vreg: number) => boolean,
): number | undefined {
  let best: SpillCost | undefined;
  for (const vreg of candidates) {
    const cost = costs.get(vreg);
    if (cost === undefined) continue;
    if (feasible !== undefined && !feasible(vreg)) continue;
    if (best === undefined || cost.cost < best.cost || (cost.cost === best.cost && cost.vreg < best.vreg)) best = cost;
  }
  return best?.vreg;
}

/** Где значение определяется и где читается: по этим точкам проверяется выполнимость вытеснения. */
export interface SpillSites {
  readonly defs: readonly number[];
  readonly uses: readonly number[];
}

/** Точки определений и чтений по каждому значению потока. */
export function spillSitesOf(
  instructions: readonly AsmInstruction[],
  options: {
    readonly defUse: (instruction: AsmInstruction) => { readonly def: readonly number[]; readonly use: readonly number[] };
  },
): ReadonlyMap<number, SpillSites> {
  const defs = new Map<number, number[]>();
  const uses = new Map<number, number[]>();
  instructions.forEach((instruction, at) => {
    const facts = options.defUse(instruction);
    for (const vreg of facts.def) defs.set(vreg, [...(defs.get(vreg) ?? []), at]);
    for (const vreg of facts.use) uses.set(vreg, [...(uses.get(vreg) ?? []), at]);
  });
  const sites = new Map<number, SpillSites>();
  for (const vreg of new Set([...defs.keys(), ...uses.keys()])) {
    sites.set(vreg, { defs: defs.get(vreg) ?? [], uses: uses.get(vreg) ?? [] });
  }
  return sites;
}

/**
 * Влезает ли вытеснение значения в точки его сайтов.
 *
 * Счёт — не «на глаз», а по различию двух последовательностей:
 *
 * * **запись** в слот требует ДВУХ регистров: в одном лежит само значение, в другом — адрес слота
 *   (`std` читает оба), поэтому в точке определения нужно `занято + 2 ≤ свободных`;
 * * **чтение** из слота требует ОДНОГО: адрес кладётся в тот же регистр, куда придёт значение
 *   (`movtd` + `ldd`), поэтому в точке чтения достаточно `занято + 1 ≤ свободных`.
 *
 * `occupiedAt(at)` — сколько ЧУЖИХ значений занято в этой точке (без самого вытесняемого).
 * Значение, которое не проходит по сайтам, вытеснять нельзя: регистра под адрес в точке не
 * найдётся, и раскладка обязана отказать — но лучше не доводить до отказа, а выбрать другую жертву.
 */
export function siteFeasible(
  sites: SpillSites | undefined,
  freeRegisters: number,
  occupiedAt: (at: number) => number,
): boolean {
  if (sites === undefined) return false;
  for (const at of sites.defs) {
    if (occupiedAt(at) + 2 > freeRegisters) return false;
  }
  for (const at of sites.uses) {
    if (occupiedAt(at) + 1 > freeRegisters) return false;
  }
  return sites.defs.length > 0 || sites.uses.length > 0;
}
