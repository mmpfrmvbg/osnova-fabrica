/**
 * ОРАКУЛ ПОНИЖЕНИЯ ВЫЗОВА И ВОЗВРАТА — ПРОВЕРКА СОГЛАШЕНИЯ ПО БАЙТАМ, БЕЗ ИСПОЛНЕНИЯ.
 *
 * # Почему без исполнения
 *
 * Исполнение вызова в модели упирается в порт: `return %ctpr3` падает на утверждении транслятора, а
 * окно вызываемой было восемь регистров (измерено, `src/e2k/e2kCallWindowQemu.test.ts`). Это записано
 * долгом (`docs/hardware-debt.md` §3.17–3.18) и **не мешает** проверить соглашение: порядок команд,
 * регистры аргументов и приёмник результата видны в байтах и в дизассемблере.
 *
 * **Обновлено 2026-09-28 (§3.49):** модель пересобрана с `size_q = 12`, окно вызываемой стало
 * **шестнадцать** (`%r0..%r15`). Соглашение от этого не изменилось — сдвиг окна `2*wbs` тот же, — но
 * вложенный вызов из процедуры по-прежнему отвергает ПОРТ (не окно): `call` ставит вызываемой
 * `psize_q = size_q − wbs = 8`, а вложенный вызов обязан иметь `wbs ≥ psize_q` (измерено пробой
 * `.tmp/osnova-proc-syscall.ts`: ловушка на самой `call`).
 *
 * # Наше соглашение (и чем оно обосновано)
 *
 * | шаг | что делает | чем обосновано |
 * |---|---|---|
 * | аргументы | `movts` в `%r(2*wbs + i)` **вызывающего** | индекс окна = `base_d + idx`, `call` прибавляет `2*wbs` двоичных слов (`reg-index.h:79`, `e2k_cpu_exec_ct_CALL`); измерено опытом: вызываемая читает свои `%r0`/`%r1`, недоступны ей `%r8`-и выше |
 * | передача | `disp %ctpr1, <смещение>` + `call %ctpr1, wbs=4` | байты `call %ctpr1, wbs=4` сверены с ассемблером МЦСТ (`src/e2k/e2kSyllables.test.ts`); `wbs = 4` — минимум: модель требует `wbs >= psize_q`, а начальный `psize_q = 4` |
 * | результат | вызываемая кладёт его в свой `%r0` (`movts` перед `return`), вызывающий читает из `%r(2*wbs)` | тот же сдвиг окна; приёмник назван, а не угадан |
 * | возврат | `return %ctpr3` | форма CS0, байты сверены с `as`; адрес возврата готовит сам `call` |
 *
 * # Чего оракул НЕ доказывает
 *
 * Что соглашение заработает: регистры аргументов и приёмник проверены по байтам, а не прогоном.
 * Что окно вызываемой на **железе** тоже восемь регистров: это свойство порта (начальные
 * `psize_q = 4`, `size_q = 8` задаёт порт), и оно записано долгом перед железом.
 */

import { describe, it, expect } from 'vitest';
import { getEncoder, type AsmInstruction, type Operand } from './backend';
import { CALL_WBS, carrierFormOf, layoutOf } from './twoPassLayout';
import { lowerCarrier } from './e2kRealRun';
import { WINDOW_NUMBER_REGISTER } from './syscallRuntime';
import { REAL_SHORT_FORM_SIZE } from './e2k-real';

const encoder = getEncoder('e2k');
const imm = (value: number): Operand => ({ kind: 'imm', value });
const reg = (index: number): Operand => ({ kind: 'reg', index });
const carrier = (mnemonic: string, operands: readonly Operand[]): AsmInstruction => ({
  mnemonic,
  channel: 0,
  operands,
});

/** Носитель вызова так, как его выдаёт эмиттер: `[флаги, arg0, arg1, payload, приёмник]`. */
function callCarrier(argc: number, args: readonly number[], destination?: number, payload = 1): AsmInstruction {
  const flags = (destination === undefined ? 0 : 1) | (argc << 1);
  return carrier('IR.call', [
    imm(flags),
    reg(args[0] ?? 0),
    reg(args[1] ?? 0),
    imm(payload),
    reg(destination ?? 0),
  ]);
}

/** Операнд-регистр команды: индекс и файл. */
function regOf(instruction: AsmInstruction, at: number): { index: number; file?: string } {
  const operand = instruction.operands[at];
  if (operand === undefined || operand.kind !== 'reg') throw new Error(`${instruction.mnemonic}: операнд ${at} не регистр`);
  return { index: operand.index, ...(operand.file === undefined ? {} : { file: operand.file }) };
}

describe('понижение вызова: аргументы уходят в окно вызываемого', () => {
  it('два аргумента и приёмник: movts, movts, disp, call, movts — и все регистры названы', () => {
    const lowered = lowerCarrier(callCarrier(2, [3, 4], 5), { callDisplacement: 7 });
    expect(lowered.ok, lowered.ok ? '' : lowered.reason).toBe(true);
    if (!lowered.ok) return;
    expect(lowered.instructions.map((command) => command.mnemonic)).toEqual(['movts', 'movts', 'disp', 'call', 'movts']);
    // Аргументы — в регистры вызываемого окна: `%r(2*wbs)` и следующий за ним.
    expect(regOf(lowered.instructions[0]!, 0), 'источник аргумента 0').toEqual({ index: 3, file: 'window' });
    expect(regOf(lowered.instructions[0]!, 1), 'куда кладётся аргумент 0').toEqual({
      index: CALL_WBS * 2,
      file: 'window',
    });
    expect(regOf(lowered.instructions[1]!, 0), 'источник аргумента 1').toEqual({ index: 4, file: 'window' });
    expect(regOf(lowered.instructions[1]!, 1), 'куда кладётся аргумент 1').toEqual({
      index: CALL_WBS * 2 + 1,
      file: 'window',
    });
    // Передача управления: цель и окно.
    expect(lowered.instructions[2]!.operands, 'disp несёт смещение вызова').toEqual([imm(1), imm(7)]);
    expect(lowered.instructions[3]!.operands, 'call несёт wbs').toEqual([imm(1), imm(CALL_WBS)]);
    // Результат: читается ИЗ ОКНА вызова в приёмник носителя.
    expect(regOf(lowered.instructions[4]!, 0), 'откуда читается результат').toEqual({
      index: CALL_WBS * 2,
      file: 'window',
    });
    expect(regOf(lowered.instructions[4]!, 1), 'куда читается результат').toEqual({ index: 5, file: 'window' });
  });

  it('без приёмника последней пересылки нет: результат не обещан — не читается', () => {
    const lowered = lowerCarrier(callCarrier(2, [3, 4]), { callDisplacement: 7 });
    expect(lowered.ok).toBe(true);
    if (!lowered.ok) return;
    expect(lowered.instructions.map((command) => command.mnemonic)).toEqual(['movts', 'movts', 'disp', 'call']);
  });

  it('вызов без аргументов: только disp и call', () => {
    const lowered = lowerCarrier(callCarrier(0, []), { callDisplacement: 2 });
    expect(lowered.ok).toBe(true);
    if (!lowered.ok) return;
    expect(lowered.instructions.map((command) => command.mnemonic)).toEqual(['disp', 'call']);
  });

  it('без смещения вызов не понижается — причина называет раскладку', () => {
    const lowered = lowerCarrier(callCarrier(1, [3]));
    expect(lowered.ok, 'вызов без адреса цели понижаться не должен').toBe(false);
    if (lowered.ok) return;
    expect(lowered.reason, 'причина отказа').toMatch(/смещение вызова|двухпроходной раскладки/);
  });

  it('окно вызова согласовано с измеренным ABI: 2*wbs равно регистру номера системного вызова', () => {
    // Два независимых измерения одного и того же сдвига: опыт с окном вызываемой (QEMU) и ABI
    // системных вызовов, где номер кладётся в `%r8` перед `call wbs=4` (docs/e2k-minimal-elf.md §3).
    expect(CALL_WBS * 2, 'сдвиг окна в регистрах').toBe(WINDOW_NUMBER_REGISTER);
  });
});

describe('понижение возврата: значение кладётся в приёмник соглашения', () => {
  it('со значением: movts в свой %r0, затем return %ctpr3', () => {
    const lowered = lowerCarrier(carrier('IR.ret', [imm(1), reg(6)]));
    expect(lowered.ok, lowered.ok ? '' : lowered.reason).toBe(true);
    if (!lowered.ok) return;
    expect(lowered.instructions.map((command) => command.mnemonic)).toEqual(['movts', 'return']);
    expect(regOf(lowered.instructions[0]!, 0), 'источник значения').toEqual({ index: 6, file: 'window' });
    expect(regOf(lowered.instructions[0]!, 1), 'приёмник соглашения: свой %r0').toEqual({ index: 0, file: 'window' });
    expect(lowered.instructions[1]!.operands, 'возврат — через %ctpr3').toEqual([imm(3)]);
  });

  it('без значения: только return', () => {
    const lowered = lowerCarrier(carrier('IR.ret', [imm(0), reg(0)]));
    expect(lowered.ok).toBe(true);
    if (!lowered.ok) return;
    expect(lowered.instructions.map((command) => command.mnemonic)).toEqual(['return']);
    expect(lowered.instructions[0]!.operands).toEqual([imm(3)]);
  });
});

describe('раскладка знает длину вызова и возврата', () => {
  it('длина вызова зависит от арности и приёмника — и совпадает с длиной кодирования', () => {
    const cases: ReadonlyArray<{ argc: number; destination?: number; commands: number; bytes: number }> = [
      { argc: 0, commands: 2, bytes: 8 + 16 },
      { argc: 0, destination: 5, commands: 3, bytes: 8 + 16 + 8 },
      { argc: 2, commands: 4, bytes: 8 + 8 + 8 + 16 },
      { argc: 2, destination: 5, commands: 5, bytes: 8 + 8 + 8 + 16 + 8 },
    ];
    for (const item of cases) {
      const carrierUnderTest = callCarrier(item.argc, [3, 4], item.destination);
      const form = carrierFormOf(carrierUnderTest);
      expect(form, `argc ${item.argc}, приёмник ${String(item.destination)}: формы нет`).toBeDefined();
      expect(form!.commands.length, `argc ${item.argc}: команд`).toBe(item.commands);
      expect(form!.commands.reduce((sum, command) => sum + command.size, 0), `argc ${item.argc}: байт`).toBe(item.bytes);
      // Таблица против кодировщика: размеры команд обязаны совпасть с длиной их кодирования.
      const lowered = lowerCarrier(carrierUnderTest, { callDisplacement: 1 });
      expect(lowered.ok).toBe(true);
      if (!lowered.ok) continue;
      form!.commands.forEach((command, at) => {
        expect(command.size, `${command.mnemonic}: таблица против кодировщика`).toBe(encoder.encode(lowered.instructions[at]!).length);
      });
    }
  });

  it('длина возврата: 8 без значения и 16 со значением', () => {
    for (const [flag, bytes, commands] of [
      [0, 8, 1],
      [1, 16, 2],
    ] as const) {
      const form = carrierFormOf(carrier('IR.ret', [imm(flag), reg(2)]));
      expect(form, `флаг ${flag}: формы нет`).toBeDefined();
      expect(form!.commands.length, `флаг ${flag}: команд`).toBe(commands);
      expect(form!.commands.reduce((sum, command) => sum + command.size, 0), `флаг ${flag}: байт`).toBe(bytes);
      expect(form!.commands[form!.commands.length - 1]!.mnemonic, 'последняя команда — возврат').toBe('return');
      expect(form!.commands[form!.commands.length - 1]!.size).toBe(REAL_SHORT_FORM_SIZE);
    }
  });

  it('вызов и возврат РАЗМЕЩАЮТСЯ: в неразмещённых их нет', () => {
    const table = layoutOf([
      callCarrier(2, [3, 4], 5),
      carrier('IR.ret', [imm(1), reg(6)]),
    ]);
    expect(table.unplaced, 'вызов и возврат обязаны получить форму').toEqual([]);
    expect(table.totalBytes, 'сумма размеров').toBe(8 + 8 + 8 + 16 + 8 + 8 + 8);
  });
});
