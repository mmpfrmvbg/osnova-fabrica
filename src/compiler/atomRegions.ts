/**
 * Границы атомов в байткоде: разметка и её проверка.
 *
 * ## Зачем
 *
 * Флаги `optimizable` (`docs/osnova-signature-spec.md`) существуют, но планировщику не с
 * чем их сопоставить: в байткоде не отмечено, где кончается один атом и начинается
 * другой. Этот модуль добавляет такую разметку — **метаданные**, которые эмиттер и
 * планировщик будут читать (Фаза 4, шаг 1).
 *
 * ## Что где лежит
 *
 * - **каталог** (`ATOM_CATALOGUE`) — 27 атомов и их `optimizable`. Источник истины —
 *   документ `docs/osnova-signature-spec.md` §2; совпадение кода и документа проверяется
 *   тестом, чтобы они не разошлись;
 * - **разметка** (`annotateAtomRegions`) — по назначению «атом → процедуры» строит
 *   диапазоны кода `[start, end)` в абсолютных индексах и кладёт их в `module.atoms`;
 * - **проверка** (`verifyAtomRegions`) — полнота и непротиворечивость разметки.
 *
 * ## Границы применимости
 *
 * Разметка ставится **по процедурам**: атом — единица архитектуры, процедура — единица
 * байткода, и текущий конвейер планирует процедурами и линейными участками
 * (`src/vliw/vliwPipeline.ts`). Дробление внутри процедуры (несколько атомов в одной
 * процедуре) — следующий шаг, и он потребует меток в исходнике; здесь его нет, и это
 * сказано прямо, а не подразумевается.
 *
 * ## Версия формата НЕ поднята — намеренно
 *
 * Поле `atoms` **необязательное и аддитивное**: по умолчанию компилятор его не пишет,
 * поэтому ни один уже собранный артефакт не меняется (`npm run artifacts:check` это
 * проверяет). Читатель, не знающий поля, игнорирует его. Если бы поле было обязательным,
 * `REGCODE_VERSION` пришлось бы поднять и пересобрать все артефакты.
 */

import type { RegAtomRegion, RegModule, RegProcedure } from "../runtime/vm/regcode";

export type { RegAtomRegion };

/** Один атом каталога: идентификатор и признак наличия вычислительного ядра. */
export interface AtomCatalogueEntry {
  id: string;
  optimizable: boolean;
}

/**
 * Каталог 27 атомов. Значения обязаны совпадать с `docs/osnova-signature-spec.md` §2 —
 * это проверяет `atomRegions.test.ts`, чтобы код и документ не разошлись.
 */
export const ATOM_CATALOGUE: readonly AtomCatalogueEntry[] = [
  { id: "A1", optimizable: false },
  { id: "A2", optimizable: false },
  { id: "A3", optimizable: false },
  { id: "A4", optimizable: false },
  { id: "A5", optimizable: true },
  { id: "A6", optimizable: true },
  { id: "A7", optimizable: false },
  { id: "B1", optimizable: false },
  { id: "B2", optimizable: false },
  { id: "B3", optimizable: false },
  { id: "B4", optimizable: true },
  { id: "B5", optimizable: true },
  { id: "C1", optimizable: false },
  { id: "C2", optimizable: false },
  { id: "C3", optimizable: false },
  { id: "C4", optimizable: false },
  { id: "C5", optimizable: false },
  { id: "C6", optimizable: false },
  { id: "C7", optimizable: false },
  { id: "D1", optimizable: false },
  { id: "D2", optimizable: false },
  { id: "D3", optimizable: false },
  { id: "D4", optimizable: false },
  { id: "E1", optimizable: false },
  { id: "E2", optimizable: false },
  { id: "E3", optimizable: false },
  { id: "E4", optimizable: false },
];

/** Есть ли у атома вычислительное ядро (по каталогу). */
export function isOptimizableAtom(id: string): boolean {
  const entry = ATOM_CATALOGUE.find((a) => a.id === id);
  return entry?.optimizable === true;
}

/**
 * Назначение «атом → процедуры».
 *
 * Поле `optimizable` в типе отсутствует намеренно: флаг берётся из каталога, а не
 * задаётся вызывающим. Появление его здесь — тестовый случай негативного контроля.
 */
export interface AtomAssignment {
  atom: string;
  /** Имена процедур модуля, относимых к этому атому. */
  procedures: string[];
}

/** Границы процедур в модуле: процедура начинается со своего `codeOffset`. */
export function procedureRanges(procedures: readonly RegProcedure[], codeLength: number): Array<{ start: number; end: number }> {
  const starts = procedures.map((p) => p.codeOffset).slice().sort((a, b) => a - b);
  return procedures.map((p) => {
    const next = starts.find((s) => s > p.codeOffset);
    return { start: p.codeOffset, end: next ?? codeLength };
  });
}

/**
 * Проставить разметку атомов.
 *
 * @param module исходный модуль; **не меняется** — возвращается копия с полем `atoms`
 * @throws если атом неизвестен каталогу или процедура отнесена дважды
 */
export function annotateAtomRegions(module: RegModule, assignment: readonly AtomAssignment[]): RegModule {
  const byName = new Map(module.procedures.map((p, index) => [p.name, index]));
  const claimed = new Map<number, string>();
  const regions: RegAtomRegion[] = [];

  for (const entry of assignment) {
    if (!ATOM_CATALOGUE.some((a) => a.id === entry.atom)) {
      throw new Error(`неизвестный атом «${entry.atom}»: его нет в каталоге 27 атомов`);
    }
    for (const name of entry.procedures) {
      const index = byName.get(name);
      if (index === undefined) {
        throw new Error(`нет процедуры «${name}» в модуле «${module.moduleName}»`);
      }
      const previous = claimed.get(index);
      if (previous !== undefined) {
        throw new Error(`процедура «${name}» отнесена к двум атомам: «${previous}» и «${entry.atom}»`);
      }
      claimed.set(index, entry.atom);
    }
  }

  const ranges = procedureRanges(module.procedures, module.code.length);
  for (const [index, atom] of [...claimed.entries()].sort((a, b) => a[0] - b[0])) {
    const range = ranges[index]!;
    regions.push({
      atom,
      optimizable: isOptimizableAtom(atom),
      procedure: index,
      start: range.start,
      end: range.end,
    });
  }

  return { ...module, atoms: regions };
}

/**
 * Проверить разметку: полнота и непротиворечивость.
 *
 * @returns список нарушений; пустой список — разметка корректна
 */
export function verifyAtomRegions(module: RegModule): string[] {
  const problems: string[] = [];
  const regions = module.atoms;
  if (regions === undefined) {
    return ["разметка атомов отсутствует: planning не сможет сопоставить код с атомом"];
  }

  const ranges = procedureRanges(module.procedures, module.code.length);
  const covered = new Map<number, string>();

  for (const region of regions) {
    if (!ATOM_CATALOGUE.some((a) => a.id === region.atom)) {
      problems.push(`регион ${region.start}..${region.end}: неизвестный атом «${region.atom}»`);
      continue;
    }
    const expected = isOptimizableAtom(region.atom);
    if (region.optimizable !== expected) {
      problems.push(
        `регион ${region.start}..${region.end}: флаг optimizable=${region.optimizable} ` +
          `расходится с каталогом (${expected}) для атома «${region.atom}»`,
      );
    }
    const range = ranges[region.procedure];
    if (range === undefined) {
      problems.push(`регион ${region.start}..${region.end}: нет процедуры #${region.procedure}`);
      continue;
    }
    if (region.start !== range.start || region.end !== range.end) {
      problems.push(
        `регион ${region.start}..${region.end}: не совпадает с границами процедуры #${region.procedure} ` +
          `${range.start}..${range.end}`,
      );
    }
    const previous = covered.get(region.procedure);
    if (previous !== undefined) {
      problems.push(`процедура #${region.procedure} размечена дважды: «${previous}» и «${region.atom}»`);
    }
    covered.set(region.procedure, region.atom);
  }

  // Полнота: каждая процедура принадлежит какому-то атому.
  for (let index = 0; index < module.procedures.length; index++) {
    if (!covered.has(index)) {
      const proc = module.procedures[index]!;
      problems.push(`процедура #${index} («${proc.name}») не размечена: не отнесена ни к одному атому`);
    }
  }

  // Пересечения диапазонов (проверяются независимо от процедур).
  const sorted = [...regions].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.start < sorted[i - 1]!.end) {
      problems.push(
        `диапазоны пересекаются: ${sorted[i - 1]!.start}..${sorted[i - 1]!.end} и ` +
          `${sorted[i]!.start}..${sorted[i]!.end}`,
      );
    }
  }

  return problems;
}
