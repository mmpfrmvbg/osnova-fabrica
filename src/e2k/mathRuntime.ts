/**
 * РАНТАЙМ МАТЕМАТИКИ: ЦЕЛОЧИСЛЕННЫЙ ОСТАТОК.
 *
 * # Зачем отдельный рантайм, а не понижение `/`
 *
 * Оператор `/` в Основа — **вещественное** деление (проверено прогоном: наивная запись IIR дала
 * 121.0656 вместо 119, `tests/dsp/kernels/iir.osnova`). Документированные формы деления e2k
 * (`SDIVs/d`, `UDIVs/d`) — **целочисленные**: они отсекают дробную часть и дают `exc_div` при
 * делителе 0. Поэтому `IR.div` **остаётся отказом** (`src/e2k/e2kRealRun.ts`, `REFUSALS`):
 * подставить целочисленную форму вместо точной — значит поменять смысл оператора, а это решение
 * владельца, не следствие.
 *
 * Остаток — другое дело: это **отдельная функция** (`система.математика.остаток`), она и нужна IIR,
 * и её семантика совпадает с формой: `SMODX` даёт остаток со знаком делимого (руководство МЦСТ
 * §10.3.3), то есть `7 % 3 = 1` и `-7 % 3 = -1`. Целочисленное частное IIR выражает через остаток:
 * `(a - a % b) / b` — при неотрицательных `a` это усечение вниз (`tests/dsp/kernels/iir.osnova`).
 *
 * # Форма
 *
 * `smodx` — ALF1, канал **только пятый** (`opcodes/e2k-opc.h:54`, `ARGS_DSS`, `DIVISION_CHANNELS`),
 * операнды `src1` (делимое), `src2` (делитель), `dst`. Байты формы пришпилены в
 * `src/e2k/e2kDivisionForms.test.ts`; здесь проверяется исполнение — `src/e2k/e2kMathQemu.test.ts`.
 *
 * # Чего здесь нет
 *
 * Частного: `система.математика.частное` не делается — оно потребовало бы выбора семантики деления
 * (тот же вопрос, что у `IR.div`). И нет 32-битного остатка: в таблице МЦСТ его нет вовсе, только
 * расширенные `SMODX`/`UMODX` (64/32→32) — это записано как «НЕТ В ИСТОЧНИКЕ», а не додумано.
 */

import type { AsmInstruction, Operand } from './backend';

/** Имена вызовов, которые умеет этот рантайм. */
export const SUPPORTED_MATH_CALLS: readonly string[] = ['система.математика.остаток'];

/** Мнемоника формы остатка: `SMODX` — 64/32→32, знак берётся от делимого. */
export const REMAINDER_MNEMONIC = 'smodx';

/** Канал формы: пятый — единственный разрешённый источником (`opcodes/e2k-opc.h:54`). */
export const REMAINDER_CHANNEL = 5;

const reg = (index: number): Operand => ({ kind: 'reg', index });

/**
 * Понизить вызов математики в команды e2k.
 *
 * Отказ — исключение с причиной: молча подставить другую операцию нельзя, а `IR.div` не трогается.
 */
export function lowerMathCall(
  name: string,
  args: readonly Operand[],
  destination: number | undefined,
): AsmInstruction[] {
  if (!SUPPORTED_MATH_CALLS.includes(name)) {
    throw new Error(
      `«${name}»: рантайм математики умеет только ${SUPPORTED_MATH_CALLS.join(', ')}; ` +
        'частное не делается — `/` в языке вещественное, а формы e2k целочисленные (решение владельца)',
    );
  }
  if (args.length !== 2) {
    throw new Error(`«${name}»: аргументов ${args.length}, форма ${REMAINDER_MNEMONIC} несёт два (делимое и делитель)`);
  }
  if (destination === undefined) {
    throw new Error(`«${name}»: результату некуда лечь — приёмник не передан`);
  }
  for (const [position, argument] of args.entries()) {
    if (argument.kind !== 'reg') {
      throw new Error(`«${name}»: аргумент ${position} не в регистре — в форме это поле слога`);
    }
  }
  return [
    {
      mnemonic: REMAINDER_MNEMONIC,
      channel: REMAINDER_CHANNEL,
      operands: [args[0]!, args[1]!, reg(destination)],
    },
  ];
}
