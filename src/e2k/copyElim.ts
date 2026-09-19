/**
 * УСТРАНЕНИЕ КОПИЙ ПЕРЕД РАСКЛАДКОЙ РЕГИСТРОВ.
 *
 * # Зачем
 *
 * Раскладка `фильтр` FIR в десять свободных регистров (`%b[0..9]`) упиралась в пик 11 — не хватало
 * одного. Причина не в алгоритме раскладки, а в **числе живых значений**: каждая пересылка
 * `IR.move d, a` держит ДВА значения вместо одного. Пересылок в `фильтр` — 29 из 54 носителей.
 *
 * # Правило (звуковое)
 *
 * Пересылку `move d, a` можно выбросить, переименовав чтения `d` в `a`, если:
 *
 * 1. `d` **не переопределяется** до тех пор, пока живы переименованные чтения (иначе они читали бы
 *    другое значение);
 * 2. `a` **не переопределяется** между пересылкой и последним чтением `d` (иначе чтения получили бы
 *    новое значение `a`).
 *
 * Второе условие — не украшение: без него переименование «схлопывает» значения, которые на самом
 * деле разные, и живых значений становится подозрительно мало (замер без этой проверки давал пик 2
 * у `бпф4` при 15 vreg'ах — это признак **неверного** преобразования, а не выигрыша).
 *
 * # Осторожность (пик не растёт)
 *
 * Переименование удлиняет жизнь `a` (она тянется до последнего чтения `d`), поэтому оно может
 * **поднять** пик одновременной жизни. Такое слияние отклоняется: берём только те, после которых
 * пик не вырос. Это упрощённый вариант правила Бриггса.
 *
 * # Чего здесь нет
 *
 * Нет устранения копий через границы процедур и нет слияния «в обе стороны» (`a = d`): только
 * описанное правило, проверенное замером и оракулом.
 */

import type { AsmInstruction, Operand } from './backend';
import { defUseOf, liveSetsOf } from './liveness';

const reg = (index: number): Operand => ({ kind: 'reg', index });

/** Носители, у которых первый операнд — приёмник (иначе первый операнд тоже читается). */
function definesFirstOperand(mnemonic: string): boolean {
  return !['IR.jmp', 'IR.jmp_if', 'IR.jmp_if_not', 'IR.ret', 'IR.call', 'IR.invoke'].includes(mnemonic);
}

/** Пик одновременной жизни: максимум живых на выходе инструкции. */
export function livePeakOf(carriers: readonly AsmInstruction[]): number {
  return Math.max(0, ...liveSetsOf(carriers).liveOut.map((entry) => entry.length));
}

/** Попытка выбросить пересылку в позиции `at`; `undefined` — правило не позволяет. */
export function tryRemoveCopy(carriers: readonly AsmInstruction[], at: number): AsmInstruction[] | undefined {
  const carrier = carriers[at];
  if (carrier === undefined || carrier.mnemonic !== 'IR.move') return undefined;
  const destination = carrier.operands[0];
  const source = carrier.operands[1];
  if (destination?.kind !== 'reg' || source?.kind !== 'reg' || destination.index === source.index) return undefined;

  const { liveOut } = liveSetsOf(carriers);
  // Где `d` читается после пересылки и докуда вообще жив.
  const targets: number[] = [];
  for (let index = at + 1; index < carriers.length; index++) {
    const { def, use } = defUseOf(carriers[index]!);
    if (def.includes(destination.index)) break; // `d` переопределён — дальше другое значение
    if (use.includes(destination.index)) targets.push(index);
    if (targets.length > 0 && !(liveOut[index] ?? []).includes(destination.index)) break; // значение умерло
  }
  if (targets.length === 0) {
    // `d` не читается вовсе: пересылка мертва, её можно выбросить без переименований.
    return carriers.filter((_, index) => index !== at);
  }
  const last = targets[targets.length - 1]!;
  // Условие 2: источник не переопределяется, пока переименованные чтения живы.
  for (let index = at + 1; index <= last; index++) {
    if (defUseOf(carriers[index]!).def.includes(source.index)) return undefined;
  }
  return carriers
    .map((item, index) => {
      if (index === at) return undefined;
      if (!targets.includes(index)) return item;
      return {
        ...item,
        operands: item.operands.map((operand, position) =>
          operand.kind === 'reg' &&
          operand.index === destination.index &&
          !(definesFirstOperand(item.mnemonic) && position === 0)
            ? reg(source.index)
            : operand,
        ),
      };
    })
    .filter((item): item is AsmInstruction => item !== undefined);
}

/** Итог устранения копий. */
export interface CopyElimination {
  readonly carriers: readonly AsmInstruction[];
  readonly removed: number;
  /** Пик до и после — по нему видно, дало ли преобразование эффект. */
  readonly peakBefore: number;
  readonly peakAfter: number;
}

/**
 * Убрать копии во всём потоке, принимая только те слияния, после которых пик не растёт.
 *
 * Порядок обхода — по позициям слева направо, повторно по той же позиции после успешного удаления:
 * выбрасывание команды сдвигает поток, и на освободившемся месте может оказаться ещё одна копия.
 */
export function removeCopies(carriers: readonly AsmInstruction[]): CopyElimination {
  let current: AsmInstruction[] = [...carriers];
  const peakBefore = livePeakOf(current);
  let peak = peakBefore;
  let removed = 0;
  let at = 0;
  while (at < current.length) {
    const candidate = tryRemoveCopy(current, at);
    if (candidate !== undefined) {
      const candidatePeak = livePeakOf(candidate);
      if (candidatePeak <= peak) {
        current = candidate;
        peak = candidatePeak;
        removed++;
        continue;
      }
    }
    at++;
  }
  return { carriers: current, removed, peakBefore, peakAfter: peak };
}
