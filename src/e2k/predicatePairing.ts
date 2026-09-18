/**
 * СОПОСТАВЛЕНИЕ ПАРЫ «СРАВНЕНИЕ → УСЛОВНЫЙ ПЕРЕХОД».
 *
 * # Зачем отдельный проход
 *
 * `IR.jmp_if_not` несёт условие **регистром-значением**, а `ct` читает **предикат**
 * (`SS.ctcond.psrc[4:0]`). Значение предикатом не является — предикат даёт только сравнение
 * (`cmp*`, форма ALF7: `pdst[4:0]`). Значит понижение возможно лишь тогда, когда сравнение и
 * переход стоят в потоке **парой**: сравнение кладёт результат в предикат, переход его читает.
 *
 * # Предпосылка проверяется здесь, а не предполагается
 *
 * Измерено на пяти ядрах: результат каждого из 14 сравнений читает **только** следующий за ним
 * условный переход, лишних читателей — 0 из 14. Но это факт про **этот** корпус, а не свойство
 * IR. Поэтому проход проверяет живость и **отказывает с причиной**, когда предпосылка не
 * выполняется:
 *
 * | случай | что делает проход |
 * |---|---|
 * | у результата есть другой читатель | отказ: значение обязано жить в регистре |
 * | читателей нет вовсе | отказ: предикат некуда деть |
 * | читателей несколько (в том числе два перехода) | отказ: предикат один |
 * | условие перехода пришло не из сравнения | отказ: предикат взять неоткуда |
 * | в промежутке операции с неизвестными операндами | отказ: живость не доказана |
 *
 * # Полярность: вывод, а не подбор
 *
 * `ct` передаёт управление, когда предикат **истинен**: `? %predN` — `CTCOND_PRED = 0x40`,
 * `? ~%predN` — `CTCOND_NEG_PRED = 0x60` (`gas/config/tc-e2k.c:4589-4591`,
 * `opcodes/e2k-dis.c:1584-1640`). Предикат — результат **самого сравнения**, поэтому
 * `jmp_if_not` инвертирует его, а `ge`/`gt`/`ne` — ещё раз: условий «больше» и «больше или равно»
 * в наборе `cmp*` **нет** (`opcodes/e2k-opc.h:989-1064`, набор `o,b,e,be,s,p,l,le`).
 *
 * ```
 * inverted = (переход — jmp_if_not) XOR (сравнение — ge/gt/ne)
 * condition = (inverted ? 0x60 : 0x40) | predicate
 * ```
 *
 * Проверка на пяти ядрах: 13 пар дают `0x60` и **одна** (`ge` в `convolution`) — `0x40`.
 */

import type { AsmInstruction } from "./backend";

/** Номер предиката, отданный парам: пары не переплетаются, поэтому одного достаточно. */
export const PREDICATE_FOR_PAIRS = 0;

/** Код условия «по предикату» (`CTC OND_PRED`): передать, когда предикат истинен. */
export const CTCOND_PRED = 0x40;

/** Код условия «по инверсному предикату» (`CTCOND_NEG_PRED`). */
export const CTCOND_NEG_PRED = 0x60;

/** Источник кодов условий — для отчётов и ссылок. */
export const CTCOND_SOURCE =
  "gas/config/tc-e2k.c:4589-4591 (CTCOND_PRED = 64, CTCOND_NEG_PRED = 96); " +
  "opcodes/e2k-dis.c:1584-1640 (cond_type); qemu/target/e2k/syllab-format.h:196 (SS_CTCOND.psrc[4:0])";

/**
 * Мнемоника сравнения e2k по операции IR — и «переворачивает» ли она предикат.
 *
 * `flipped: true` означает, что IR-условие есть **отрицание** условия таблицы: `ge` — не «меньше»
 * (`cmplsb`), `gt` — не «не больше» (`cmplesb`), `ne` — не «равно» (`cmpesb`). Условий
 * «больше»/«больше или равно» в наборе `cmp*` нет, поэтому иначе их не выразить.
 */
export function comparisonMnemonicOf(op: string): { mnemonic: string; flipped: boolean } | undefined {
  switch (op) {
    case "IR.lt":
      return { mnemonic: "cmplsb", flipped: false };
    case "IR.le":
      return { mnemonic: "cmplesb", flipped: false };
    case "IR.eq":
      return { mnemonic: "cmpesb", flipped: false };
    case "IR.ge":
      return { mnemonic: "cmplsb", flipped: true };
    case "IR.gt":
      return { mnemonic: "cmplesb", flipped: true };
    case "IR.ne":
      return { mnemonic: "cmpesb", flipped: true };
    default:
      return undefined;
  }
}

/** Условные переходы IR: только они читают предикат. */
export const CONDITIONAL_JUMPS: readonly string[] = ["IR.jmp_if", "IR.jmp_if_not"];

/** Носитель, результат которого можно положить в предикат. */
export interface PredicatePair {
  readonly comparisonIndex: number;
  readonly jumpIndex: number;
  readonly comparison: string;
  readonly jump: string;
  readonly cmpMnemonic: string;
  readonly predicate: number;
  /** Код условия `ct`: `0x40` (по предикату) или `0x60` (по инверсному). */
  readonly condition: number;
}

/** Отказ сопоставления с причиной. */
export interface PairingRefusal {
  readonly index: number;
  readonly reason: string;
}

/** Результат прохода. */
export interface PairingResult {
  readonly pairs: readonly PredicatePair[];
  readonly refusals: readonly PairingRefusal[];
}

/**
 * Что инструкция пишет и что читает — по раскладке операндов носителя.
 *
 * Раскладка наша и живёт в эмиттере оболочки (`src/e2k/emitterShell.ts`): бинарные операции и
 * сравнения несут `(dst, a, b)`, `move`/`not` — `(dst, a)`, `const` — `(dst, k, type)`,
 * `call`/`invoke` — `(flags, src1, src2, imm, dst)` (приёмник пятый), `ret` — `(флаг, значение)`,
 * `jmp_if`/`jmp_if_not` — `(cond, off)`, `jmp` — `(off)`.
 *
 * `known: false` — операция, у которой приёмник и источники нам неизвестны; такая инструкция в
 * промежутке делает живость недоказанной, и пара отвергается (отказ, а не догадка).
 */
function registersOf(instruction: AsmInstruction): { known: boolean; reads: number[]; writes: number[] } {
  const regs = (operands: readonly { kind: string; index?: number }[]): number[] =>
    operands.filter((operand) => operand.kind === "reg").map((operand) => operand.index!);
  const operands = instruction.operands;
  const known = (reads: number[], writes: number[]): { known: boolean; reads: number[]; writes: number[] } => ({
    known: true,
    reads,
    writes,
  });
  switch (instruction.mnemonic) {
    case "IR.const":
      return known([], regs([operands[0]!]));
    case "IR.move":
    case "IR.not":
      return known(regs([operands[1]!]), regs([operands[0]!]));
    case "IR.add":
    case "IR.sub":
    case "IR.mul":
    case "IR.div":
    case "IR.rem":
    case "IR.eq":
    case "IR.ne":
    case "IR.lt":
    case "IR.le":
    case "IR.gt":
    case "IR.ge":
    case "IR.and":
    case "IR.or":
      return known(regs([operands[1]!, operands[2]!]), regs([operands[0]!]));
    case "IR.jmp_if":
    case "IR.jmp_if_not":
      return known(regs([operands[0]!]), []);
    case "IR.jmp":
      return known([], []);
    case "IR.ret":
      return known(regs([operands[1]!]), []);
    case "IR.call":
    case "IR.invoke":
      return known(regs([operands[1]!, operands[2]!]), regs([operands[4]!]));
    default:
      return { known: false, reads: [], writes: [] };
  }
}

/** Номер регистра, по которому инструкция читается как условие перехода. */
function conditionRegisterOf(instruction: AsmInstruction): number | undefined {
  if (!CONDITIONAL_JUMPS.includes(instruction.mnemonic)) return undefined;
  const operand = instruction.operands[0];
  return operand !== undefined && operand.kind === "reg" ? operand.index : undefined;
}

/**
 * Составить пары «сравнение → условный переход» и назвать причины, по которым пара не составилась.
 *
 * Каждая инструкция потока получает не больше одного отказа; для инструкций, к паре не
 * относящихся (например, безусловного `IR.jmp`), отказов нет вовсе.
 */
export function pairPredicates(instructions: readonly AsmInstruction[]): PairingResult {
  const pairs: PredicatePair[] = [];
  const refusals: PairingRefusal[] = [];
  const pairedJump = new Set<number>();

  instructions.forEach((instruction, index) => {
    const comparison = comparisonMnemonicOf(instruction.mnemonic);
    if (comparison === undefined) return;
    const result = registersOf(instruction).writes[0];
    if (result === undefined) {
      refusals.push({ index, reason: `«${instruction.mnemonic}» #${index}: у сравнения нет регистра-результата` });
      return;
    }
    // Конец жизни значения: следующая инструкция, которая пишет тот же регистр.
    let end = instructions.length;
    let barrier: number | undefined;
    for (let next = index + 1; next < instructions.length; next++) {
      const info = registersOf(instructions[next]!);
      if (!info.known) {
        barrier = next;
        break;
      }
      if (info.writes.includes(result)) {
        end = next;
        break;
      }
    }
    const readers: number[] = [];
    for (let next = index + 1; next < end; next++) {
      if (registersOf(instructions[next]!).reads.includes(result)) readers.push(next);
    }
    if (barrier !== undefined && readers.length === 0) {
      refusals.push({
        index,
        reason:
          `«${instruction.mnemonic}» #${index}: в промежутке (#${barrier} ${instructions[barrier]!.mnemonic}) ` +
          "операция с неизвестными операндами — живость результата не доказана",
      });
      return;
    }
    if (readers.length === 0) {
      refusals.push({
        index,
        reason: `«${instruction.mnemonic}» #${index}: результат никем не читается — предикат некуда деть`,
      });
      return;
    }
    if (readers.length > 1) {
      refusals.push({
        index,
        reason:
          `«${instruction.mnemonic}» #${index}: результат читают ${readers.length} инструкций ` +
          `(${readers.map((at) => `#${at} ${instructions[at]!.mnemonic}`).join(", ")}) — значение обязано жить в регистре`,
      });
      return;
    }
    const jumpIndex = readers[0]!;
    const jump = instructions[jumpIndex]!;
    if (conditionRegisterOf(jump) !== result) {
      refusals.push({
        index,
        reason:
          `«${instruction.mnemonic}» #${index}: единственный читатель результата — #${jumpIndex} ${jump.mnemonic}, ` +
          "и это не чтение условия перехода — предикат подставить некуда",
      });
      return;
    }
    const inverted = (jump.mnemonic === "IR.jmp_if_not") !== comparison.flipped;
    pairs.push({
      comparisonIndex: index,
      jumpIndex,
      comparison: instruction.mnemonic,
      jump: jump.mnemonic,
      cmpMnemonic: comparison.mnemonic,
      predicate: PREDICATE_FOR_PAIRS,
      condition: (inverted ? CTCOND_NEG_PRED : CTCOND_PRED) | PREDICATE_FOR_PAIRS,
    });
    pairedJump.add(jumpIndex);
  });

  // Условный переход без пары: условие пришло не из сравнения — предиката взять неоткуда.
  instructions.forEach((instruction, index) => {
    if (!CONDITIONAL_JUMPS.includes(instruction.mnemonic) || pairedJump.has(index)) return;
    const condition = conditionRegisterOf(instruction);
    refusals.push({
      index,
      reason:
        `«${instruction.mnemonic}» #${index}: условие %r${String(condition)} пришло не из сравнения ` +
        "(или сравнение отвергнуто) — предикат взять неоткуда",
    });
  });

  refusals.sort((a, b) => a.index - b.index);
  return { pairs, refusals };
}
