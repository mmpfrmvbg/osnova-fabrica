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
 *    новое значение `a`);
 * 3. между пересылкой и последним чтением `d` **нет границы базового блока** (цели перехода, пути
 *    «мимо» условного перехода) и нет самого перехода.
 *
 * Второе условие — не украшение: без него переименование «схлопывает» значения, которые на самом
 * деле разные, и живых значений становится подозрительно мало (замер без этой проверки давал пик 2
 * у `бпф4` при 15 vreg'ах — это признак **неверного** преобразования, а не выигрыша).
 *
 * Третье условие добавлено позже и по замеру: правила 1–2 проверяют **линейный** порядок, а он
 * совпадает с порядком исполнения только внутри базового блока. Замер пяти ядер
 * (`.tmp/copy-cfg-soundness.ts`): из **179** кандидатов на снятие **7** снимались бы через цель
 * перехода — `fir/сумма`, `iir/фильтр`, `iir/сумма`, `convolution/сумма`, `correlation/сумма`,
 * `correlation/корреляция`, `fft/сумма`. Замер переделан: первая его редакция сопоставляла цель
 * перехода как **адрес**, хотя это **индекс** потока модуля, и дала ложный ответ «одно место».
 * Тот же класс ошибки, что в реестре проверяемости: инструмент мерил не то, а вывод выглядел
 * фактом.
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

/**
 * Начала базовых блоков по самому потоку носителей.
 *
 * Цели переходов в носителях — это **индексы**, а не адреса: `secondPass` читает их как
 * `targetIndex` (`src/e2k/twoPassLayout.ts:420`), поэтому раскладка адресов здесь не нужна, а
 * границы блоков выводятся из самих переходов.
 *
 * Почему это обязательное условие, а не улучшение: правило снятия копии проверяет порядок
 * **линейно**, а линейный порядок совпадает с порядком исполнения только внутри базового блока.
 * Измерено (`.tmp/copy-cfg-soundness.ts`): на пяти ядрах из 179 кандидатов **7** снимались бы через
 * цель перехода — на такую команду можно прийти с другой стороны, где копия ещё не исполнялась, и
 * переименованное чтение прочитало бы не то значение. Без учёта границ такое снятие — не
 * оптимизация, а порча программы.
 */
export function blockStartsOf(
  instructions: readonly AsmInstruction[],
  codeOffset = 0,
): { starts: readonly number[]; reason?: string } {
  const starts = new Set<number>([0]);
  for (const [index, instruction] of instructions.entries()) {
    if (!['IR.jmp', 'IR.jmp_if', 'IR.jmp_if_not'].includes(instruction.mnemonic)) continue;
    const targetAt = instruction.mnemonic === 'IR.jmp' ? 0 : 1;
    const operand = instruction.operands[targetAt];
    if (operand === undefined || operand.kind !== 'imm' || !Number.isInteger(operand.value)) {
      return { starts: [], reason: `«${instruction.mnemonic}» #${index}: цель перехода не выражена числом` };
    }
    // Цели переходов — индексы в потоке **всего модуля** (`IR.jmp_if_not (b4, 74)` при срезе в 23
    // носителя — измерено, `.tmp/summa-blocks.ts`), а копии снимаются по срезу процедуры. Поэтому
    // цель приводится к локальному индексу; цель вне среза границы внутри среза не создаёт: она
    // ведёт в другую процедуру, а не «внутрь» промежутка.
    const local = operand.value - codeOffset;
    if (local < 0 || local >= instructions.length) continue;
    starts.add(local);
    // У условного перехода есть ещё и путь «мимо» — следующая команда тоже начало блока.
    if (instruction.mnemonic !== 'IR.jmp' && index + 1 < instructions.length) starts.add(index + 1);
  }
  return { starts: [...starts].sort((a, b) => a - b) };
}

/** Попытка выбросить пересылку в позиции `at`; `undefined` — правило не позволяет. */
export function tryRemoveCopy(
  carriers: readonly AsmInstruction[],
  at: number,
  blockStarts: readonly number[] = [],
): AsmInstruction[] | undefined {
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
  // Граница базового блока внутри промежутка: на неё можно прийти, минуя пересылку. Строго больше
  // `at` — пересылка на самой границе исполняется на всех путях, ведущих к чтениям.
  const boundary = blockStarts.find((start) => start > at && start <= last);
  if (boundary !== undefined) return undefined;
  // Переход внутри промежутка — по той же причине: чтения после него могут не исполниться (или
  // исполниться раньше по другому пути). Отказ консервативный, замером на пяти ядрах он бесплатен.
  for (let index = at + 1; index < last; index++) {
    if (['IR.jmp', 'IR.jmp_if', 'IR.jmp_if_not'].includes(carriers[index]!.mnemonic)) return undefined;
  }
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
  /**
   * Почему устранение не делалось вовсе: границы базовых блоков не удалось установить, а без них
   * правило недействительно. Молчаливое «сняли, потому что линейно выглядит хорошо» недопустимо.
   */
  readonly refused?: string;
}

/**
 * Убрать копии во всём потоке, принимая только те слияния, после которых пик не растёт.
 *
 * Порядок обхода — по позициям слева направо, повторно по той же позиции после успешного удаления:
 * выбрасывание команды сдвигает поток, и на освободившемся месте может оказаться ещё одна копия.
 * Границы базовых блоков пересчитываются под сдвиг: иначе после первого удаления «граница» указывала
 * бы не на ту команду.
 */
export function removeCopies(
  carriers: readonly AsmInstruction[],
  options: { readonly blockStarts?: readonly number[]; readonly codeOffset?: number } = {},
): CopyElimination {
  const codeOffset = options.codeOffset ?? 0;
  let current: AsmInstruction[] = [...carriers];
  const peakBefore = livePeakOf(current);
  if (options.blockStarts === undefined) {
    const blocks = blockStartsOf(current, codeOffset);
    if (blocks.reason !== undefined) {
      return { carriers: current, removed: 0, peakBefore, peakAfter: peakBefore, refused: blocks.reason };
    }
  }
  const initialStarts = options.blockStarts ?? blockStartsOf(current, codeOffset).starts ?? [];
  let starts = new Set<number>(initialStarts);
  let peak = peakBefore;
  let removed = 0;
  let at = 0;
  while (at < current.length) {
    const candidate = tryRemoveCopy(current, at, [...starts]);
    if (candidate !== undefined) {
      const candidatePeak = livePeakOf(candidate);
      if (candidatePeak <= peak) {
        current = candidate;
        peak = candidatePeak;
        removed++;
        starts = new Set([...starts].filter((start) => start !== at).map((start) => (start > at ? start - 1 : start)));
        continue;
      }
    }
    at++;
  }
  return { carriers: current, removed, peakBefore, peakAfter: peak };
}
