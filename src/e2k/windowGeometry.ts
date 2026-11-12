/**
 * ГЕОМЕТРИЯ ОКНА: три источника одного числа — паспорт порта, константы раскладки, живая сборка.
 *
 * Формула — из исходника порта, а не из подгонки: `call wbs` уменьшает `size_q` на `wbs` и кладёт
 * `size_d = 2*size_q`, поэтому вызываемая получает `2*(size_q − wbs)` регистров
 * (docs/hardware-debt.md §3.36).
 *
 * # Зачем отдельный модуль
 *
 * До него «окно вызываемой» жило тремя несвязанными записями: числом в паспорте модели, константой
 * `WINDOW_REGISTERS_CALLEE` (по ней раскладка решает, можно ли вызвать процедуру) и проверками
 * оракула окна, которые утверждали три конкретных регистра. Смена геометрии порта краснила оракул, но
 * **не** то число, от которого зависит вердикт «вызвать нельзя»: константа оставалась восьмёркой, и
 * раскладка продолжала отказывать ядрам, которые модель уже пускает. Здесь эти три записи сведены:
 * расхождение любой пары называется словами (`windowGeometryProblems`), а негативный контроль
 * (`windowGeometry.test.ts`) проверяет, что каждое расхождение действительно ловится.
 */
import { QEMU_MODEL } from './qemuModelPassport';
import { WINDOW_REGISTERS_CALLEE, WINDOW_REGISTERS_ENTRY } from './regAlloc';
import { ARRAY_WINDOW_RSZ } from './arrayRuntime';

/** Сколько регистров окна получает вызываемая при этой геометрии и этом `wbs`. */
export function calleeWindowRegisters(sizeQ: number, wbs: number): number {
  return 2 * (sizeQ - wbs);
}

/** Геометрия, записанная в паспорте: чем объявлены все закреплённые числа. */
export interface WindowGeometry {
  readonly callee: number;
  readonly entry: number;
  readonly caller: number;
}

/** Ожидание из паспорта: вызываемая — по формуле, вход — по прологу образа, вызывающий — `2*size_q`. */
export function passportWindow(): WindowGeometry {
  return {
    callee: calleeWindowRegisters(QEMU_MODEL.window.sizeQ, QEMU_MODEL.window.wbs),
    entry: 2 * (ARRAY_WINDOW_RSZ + 1),
    caller: 2 * QEMU_MODEL.window.sizeQ,
  };
}

/**
 * Расхождения трёх источников. Пустой список — паспорт, константы раскладки и измерение согласны.
 *
 * `measured` — порог окна, ИЗМЕРЕННЫЙ на живой сборке (первый недоступный номер у вызываемой и у
 * вызывающего); он обязателен, потому что проверка «константа равна модели» без модели тавтологична.
 * `passport` и `constants` — параметры ради негативного контроля: он подставляет расхождение.
 */
export function windowGeometryProblems(
  measured: { readonly callee: number; readonly caller: number },
  passport: WindowGeometry = passportWindow(),
  constants: { readonly callee: number; readonly entry: number } = {
    callee: WINDOW_REGISTERS_CALLEE,
    entry: WINDOW_REGISTERS_ENTRY,
  },
): string[] {
  const problems: string[] = [];
  if (constants.callee !== passport.callee) {
    problems.push(
      `константа окна вызываемой ${constants.callee}, а паспортная геометрия ` +
        `(size_q=${QEMU_MODEL.window.sizeQ}, wbs=${QEMU_MODEL.window.wbs}) даёт ${passport.callee}: ` +
        'раскладка пускает не то, что пускает модель',
    );
  }
  if (constants.entry !== passport.entry) {
    problems.push(
      `константа окна входа ${constants.entry}, а пролог образа (setbn rsz=${ARRAY_WINDOW_RSZ}) ` +
        `даёт ${passport.entry}`,
    );
  }
  if (measured.callee !== constants.callee) {
    problems.push(
      `живая модель даёт вызываемой ${measured.callee}, а константа раскладки говорит ${constants.callee}`,
    );
  }
  if (measured.caller < constants.entry) {
    problems.push(
      `живая модель даёт вызывающему ${measured.caller}, а константа входа требует ${constants.entry}`,
    );
  }
  return problems;
}
