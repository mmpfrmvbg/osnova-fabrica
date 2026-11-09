/**
 * ГРАНИЦЫ `Списки.установить` НА ЦЕЛИ (D43b): проверка ДО записи, ловушка ВМЕСТО тихой записи.
 *
 * # Зачем отдельный проход, а не ветвь `lowerArrayCall`
 *
 * Сравнение на e2k пишет ПРЕДИКАТ, а носитель IR несёт значение, поэтому пара «сравнение → переход»
 * обязана быть сопоставлена (`src/e2k/predicatePairing.ts`). Значит проверка — это не одна команда, а
 * несколько НОСИТЕЛЕЙ, и раскладка обязана видеть все их регистры. Поэтому проверка вставляется в
 * поток ДО `allocateProgram`: тогда `IR.zero`/`IR.array_len`/`IR.lt`/`IR.jmp_if_not` получают
 * настоящие регистры, а не физические номера, угаданные после раскладки.
 *
 * # Почему проверка стоит У ЛЮБОГО вызова, а не только в точке входа
 *
 * Ловушка здесь — ДЕЛЕНИЕ НА НОЛЬ (`sdivs`, исключение `exc_div`), а не системный вызов. Системный
 * вызов из вызываемой в модели не завершается (вложенный `call`, `src/e2k/e2kCallWindowQemu.test.ts`),
 * поэтому блок отказа точки входа (`IR.refusal` + `IR.exit`) в вызываемой не годится. Деление на ноль
 * не зависит от плоскости окна и от карты памяти: это исключение самой команды.
 *
 * Почему не чтение по нулевому адресу: замер D43b показал, что в модели адрес 0 ЧИТАЕМ — `ldd 0+0`
 * вернул значение, и путь провала продолжился. Тихий проход вместо ловушки недопустим (D4).
 *
 * # Контракт, который она держит
 *
 * `Списки.установить(л, и, з)` требует `0 <= и < длина(л)`. Проверяются ОБА края:
 *   · `0 <= и`   — `IR.le [флаг, ноль, и]`;
 *   · `и < длина` — `IR.lt [флаг, и, длина]`.
 * Нарушение любого края уводит на `IR.array_bounds_trap` (`OSN-RT-010`), а не на запись.
 *
 * # Почему `IR.zero` — носитель, а не «ноль из блока»
 *
 * `%b[12]` — ноль ТОЧКИ ВХОДА. В плоскости вызываемой это чужая клетка (её ноль лежит по базе,
 * которую выдаёт раскладка, и до раскладки её номера нет). Поэтому ноль МАТЕРИАЛИЗУЕТСЯ в своём
 * регистре — `IR.zero` уже существует и понижается одной `movts`.
 */

import type { AsmInstruction, Operand } from './backend';
import { callArgumentOperands } from './shell';
import { ARRAY_BOUNDS_TRAP_CARRIER, ARRAY_LENGTH_CARRIER } from './arrayRuntime';
import type { ProcedureOffset } from './procedureCall';

/** Имя вызова D43b в таблице обращений. */
export const LIST_SET_CALL = 'Списки.установить';

const reg = (index: number): Operand => ({ kind: 'reg', index });
const imm = (value: number): Operand => ({ kind: 'imm', value });

/** Наибольший номер регистра в потоке: новые vreg'и обязаны быть выше него. */
function maxRegisterOf(code: readonly AsmInstruction[]): number {
  let max = -1;
  for (const instruction of code) {
    for (const operand of instruction.operands) {
      if (operand.kind === 'reg' && operand.index > max) max = operand.index;
    }
  }
  return max;
}

/** Цель перехода у носителя-перехода; `undefined` — это не переход. */
function jumpTargetAt(instruction: AsmInstruction): number {
  if (instruction.mnemonic === 'IR.jmp') return 0;
  if (instruction.mnemonic === 'IR.jmp_if' || instruction.mnemonic === 'IR.jmp_if_not') return 1;
  return -1;
}

/**
 * Вставить проверку границ перед КАЖДЫМ `Списки.установить`.
 *
 * Возвращает поток и смещения процедур В НОВЫХ индексах. Цели СТАРЫХ переходов пересчитываются здесь
 * же: вставка сдвигает всё, что стоит за ней, и оставить их по-старому значило бы повторить дефект
 * §3.35 (цели не пересчитаны после сдвига) — молча.
 *
 * # Форма сайта (10 носителей вместо одного)
 *
 * ```text
 * 0  IR.zero [ноль]                     ноль текущей плоскости
 * 1  IR.zero [ноль2]                    второй ноль — делитель ловушки
 * 2  IR.array_len [длина, л, ноль]      длина(л)
 * 3  IR.lt [флаг, и, длина]             и < длина ?
 * 4  IR.jmp_if_not [флаг, 8]            нет — на ловушку
 * 5  IR.le [флаг, ноль, и]              0 <= и ?
 * 6  IR.jmp_if_not [флаг, 8]            нет — на ловушку
 * 7  IR.jmp [9]                         да — мимо ловушки, к вызову
 * 8  IR.array_bounds_trap [ноль2, ноль, ноль2]  sdivs 0 / 0 — не возвращается
 * 9  <исходный IR.invoke>               установить
 * ```
 *
 * ЛОВУШКА СТОИТ ПЕРЕД ВЫЗОВОМ, а не после: её адрес — это начало её собственной
 * формы (`sdivs`, 8 байт), и вызов за ней не может лечь на её место, даже если
 * форма вызова окажется длиннее ожидаемой. Прежняя редакция ставила ловушку за
 * вызовом и получала переход в СЕРЕДИНУ последовательности вызова (замер:
 * модель, `установить(л, 5, 42)` при длине 2 — код 7 вместо ловушки).
 *
 * Носители 0/1 стоят ДО переходов: на ловушку прыгают через них, и если бы ноль2 определялся после
 * перехода, ловушка читала бы неинициализированный регистр.
 */
export function insertListSetBounds<T extends ProcedureOffset>(
  code: readonly AsmInstruction[],
  procedures: readonly T[],
  invokeNames: readonly string[],
): { readonly code: readonly AsmInstruction[]; readonly procedures: readonly T[] } {
  const sites: number[] = [];
  code.forEach((instruction, index) => {
    if (instruction.mnemonic !== 'IR.invoke') return;
    const payload = instruction.operands[3];
    if (payload === undefined || payload.kind !== 'imm') return;
    if (invokeNames[payload.value] !== LIST_SET_CALL) return;
    sites.push(index);
  });
  if (sites.length === 0) return { code, procedures };

  const siteSet = new Set(sites);
  /**
   * Старый индекс → новый. Точка САМОГО вызова ведёт на начало сайта: переход, адресованный
   * `установить`, обязан пройти проверку, иначе он обошёл бы её.
   */
  const shift = (old: number): number => {
    if (old >= code.length) return old + sites.length * 9;
    if (siteSet.has(old)) {
      // Сколько сайтов стоит СТРОГО раньше этой точки.
      let before = 0;
      for (const site of sites) if (site < old) before++;
      return old + before * 9;
    }
    let before = 0;
    for (const site of sites) if (site < old) before++;
    return old + before * 9;
  };

  let next = maxRegisterOf(code) + 1;
  const out: AsmInstruction[] = [];
  code.forEach((instruction, index) => {
    if (!siteSet.has(index)) {
      const targetAt = jumpTargetAt(instruction);
      if (targetAt < 0) {
        out.push(instruction);
        return;
      }
      const target = instruction.operands[targetAt];
      if (target === undefined || target.kind !== 'imm') {
        out.push(instruction);
        return;
      }
      const operands = [...instruction.operands];
      operands[targetAt] = imm(shift(target.value));
      out.push({ ...instruction, operands });
      return;
    }

    const args = callArgumentOperands(instruction);
    const list = args[0];
    const indexArg = args[1];
    if (list === undefined || list.kind !== 'reg' || indexArg === undefined || indexArg.kind !== 'reg') {
      throw new Error(`«${LIST_SET_CALL}»: проверка границ требует регистров списка и индекса`);
    }
    const siteStart = out.length;
    const trapAt = siteStart + 8;
    const invokeAt = siteStart + 9;
    const zero = next++;
    const zero2 = next++;
    const length = next++;
    const flag = next++;
    out.push(
      { mnemonic: 'IR.zero', channel: 0, operands: [reg(zero)] },
      { mnemonic: 'IR.zero', channel: 0, operands: [reg(zero2)] },
      {
        mnemonic: ARRAY_LENGTH_CARRIER,
        channel: 0,
        operands: [reg(length), reg(list.index), reg(zero)],
      },
      { mnemonic: 'IR.lt', channel: 0, operands: [reg(flag), reg(indexArg.index), reg(length)] },
      { mnemonic: 'IR.jmp_if_not', channel: 0, operands: [reg(flag), imm(trapAt)] },
      { mnemonic: 'IR.le', channel: 0, operands: [reg(flag), reg(zero), reg(indexArg.index)] },
      { mnemonic: 'IR.jmp_if_not', channel: 0, operands: [reg(flag), imm(trapAt)] },
      { mnemonic: 'IR.jmp', channel: 0, operands: [imm(invokeAt)] },
      { mnemonic: ARRAY_BOUNDS_TRAP_CARRIER, channel: 0, operands: [reg(zero2), reg(zero), reg(zero2)] },
      instruction,
    );
  });

  const shiftedProcedures = procedures.map((procedure) => ({
    ...procedure,
    codeOffset: shift(procedure.codeOffset),
  }));
  return { code: out, procedures: shiftedProcedures };
}
