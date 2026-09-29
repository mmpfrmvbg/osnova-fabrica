/**
 * ОРАКУЛ ВЫЗОВА ПРОЦЕДУРЫ И ВОЗВРАТА ИЗ НЕЁ — БЕЗ МОДЕЛИ.
 *
 * # Что здесь утверждается
 *
 * 1. **Адрес вызова берётся у раскладки** (тот же механизм, что цель перехода): без смещения
 *    `IR.call` — названный отказ `OSN-LOW-004`, а не молчаливый ноль (негативный контроль).
 * 2. **Форма возврата совпадает с понижением БАЙТ В БАЙТ.** Возврат процедуры — ПАРА
 *    (`return %ctpr3` + `ct %ctpr3`): одна `return` валит порт утверждением, одна `ct` — ловушка
 *    (`src/e2k/e2kCallWindowQemu.test.ts`). Если форма и понижение разойдутся, раскладка посчитает
 *    адреса по одним байтам, а соберётся другое — класс дефекта §3.35. Сторож сравнивает
 *    объявленный размер с длиной того, что реально выдаёт понижение.
 * 3. **Точка входа не обязана быть первой процедурой**: в начало потока встаёт переход к ней,
 *    и цели переходов при этом пересчитываются (иначе исполнение начнётся с чужой процедуры).
 * 4. **Границы вызываемой названы отказом, а не ловушкой в модели.** Печать из процедуры и
 *    рантайм массивов в ней по-прежнему отказывают (аргументы syscall адресуются относительно окна,
 *    §3.52). А вот ВЛОЖЕННЫЙ ВЫЗОВ (рекурсия) с 2026-09-29 БОЛЬШЕ НЕ ОТКАЗ: пролог вызывающей растит
 *    окно, вызов идёт с `wbs = 8`, возврат на глубине ≥ 2 — в порядке «`return` → значение → `ct`»
 *    (§3.57). Здесь стережётся и то, и другое.
 * 5. **Возвраты точки входа не занимают места в образе** (`zeroSize`): их место — её `exit`,
 *    и раскладка обязана считать их нулевыми, иначе адреса процедур за ними уезжают.
 *
 * # Чего здесь НЕТ
 *
 * Прогона в модели: числа кода возврата и вывода даёт шлюз (`gate:qemu`) и пробы. Здесь —
 * устройство: где берётся адрес, что чем понижается и что отказывает.
 */
import { describe, it, expect } from 'vitest';
import { getEncoder, type AsmInstruction, type Operand } from './backend';
import { lowerCarrier } from './e2kRealRun';
import { carrierFormOf, layoutOf } from './twoPassLayout';
import { imageOfCarriers, loweredProgram, shellCarriers } from './programImage';
import { LOWERING_CODES } from './loweringRefusal';
import { EXIT_CARRIER } from './printCall';
import {
  WINDOW_GROW_CARRIER,
  callAddresses,
  entryProcedureIndex,
  prepareImage,
  procedureAt,
  windowGrowInstructions,
} from './procedureCall';

const encoder = getEncoder('e2k');
const imm = (value: number): Operand => ({ kind: 'imm', value });
const reg = (index: number): Operand => ({ kind: 'reg', index });
const carrier = (mnemonic: string, operands: readonly Operand[]): AsmInstruction => ({ mnemonic, channel: 0, operands });

/** Вызов процедуры 0 с одним аргументом и приёмником (`flags = (аргументов << 1) | приёмник`). */
const CALL = carrier('IR.call', [imm(3), reg(1), reg(0), imm(0), reg(2)]);

const CALLER_CALLEE = `процедура удвоить(ч: Число): Число
  вернуть ч + ч
конец_процедуры

процедура главная()
  вернуть удвоить(21)
конец_процедуры
`;

const RECURSION = `процедура факториал(н: Число): Число
  если н <= 1
    вернуть 1
  конец_если
  вернуть н * факториал(н - 1)
конец_процедуры

процедура главная()
  вернуть факториал(3)
конец_процедуры
`;

describe('вызов процедуры и возврат: адрес, форма, границы', () => {
  it('адрес вызова берётся у раскладки — как цель перехода', () => {
    const code: AsmInstruction[] = [CALL, carrier('IR.ret', [imm(0), reg(0)])];
    const procedures = [{ name: 'главная', codeOffset: 0 }];
    const layout = layoutOf(code, { procedureReturn: true });
    const dispOffsetOf = (index: number): number | undefined => {
      const form = carrierFormOf(code[index]!, {});
      if (form === undefined) return undefined;
      let offset = 0;
      for (const command of form.commands) {
        if (command.mnemonic === 'disp') return offset;
        offset += command.size;
      }
      return undefined;
    };
    const calls = callAddresses({ code, procedures, addresses: layout.addresses, dispOffsetOf });
    // Вызов — последний носитель, цель — первый: смещение отрицательное и кратное 8 байтам.
    expect(calls.problems).toEqual([]);
    const disp = calls.displacements.get(0)!;
    expect(Number.isInteger(disp)).toBe(true);
    const callAddress = layout.addresses.get(0)!;
    const targetAddress = layout.addresses.get(procedures[0]!.codeOffset)!;
    expect(disp * 8).toBe(targetAddress - (callAddress + dispOffsetOf(0)!));
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: без смещения вызов отказывает названной причиной', () => {
    // Тот же носитель, но раскладка не знает адреса цели — это отказ, а не нулевое смещение.
    const addressed = callAddresses({
      code: [CALL],
      procedures: [{ name: 'нет-такой', codeOffset: 9 }],
      addresses: new Map([[0, 0]]),
      dispOffsetOf: () => 0,
    });
    expect(addressed.displacements.size).toBe(0);
    expect(addressed.problems).toHaveLength(1);
    expect(addressed.problems[0]!.code).toBe(LOWERING_CODES.noForm);
    expect(addressed.problems[0]!.reason).toContain('адрес цели неизвестен');
    // И само понижение без смещения отказывает кодом раскладки.
    const lowered = lowerCarrier(CALL, { invokeNames: [], constants: [] });
    expect(lowered.ok).toBe(false);
    if (!lowered.ok) expect(lowered.code).toBe(LOWERING_CODES.layout);
  });

  it('ФОРМА ВОЗВРАТА СОВПАДАЕТ С ПОНИЖЕНИЕМ: пара `return` + `ct` — 24 байта при значении, 16 без', () => {
    const withValue = carrier('IR.ret', [imm(1), reg(2)]);
    const withoutValue = carrier('IR.ret', [imm(0), reg(0)]);
    for (const [instruction, expected] of [
      [withValue, 24],
      [withoutValue, 16],
    ] as const) {
      const form = carrierFormOf(instruction, { procedureReturn: true });
      expect(form, 'форма возврата процедуры').toBeDefined();
      const declared = form!.commands.reduce((sum, command) => sum + command.size, 0);
      expect(declared, 'объявленный размер').toBe(expected);
      const lowered = lowerCarrier(instruction, { procedureReturn: true });
      expect(lowered.ok).toBe(true);
      if (!lowered.ok) continue;
      const emitted = lowered.instructions.reduce((sum, item) => sum + encoder.encode(item).length, 0);
      expect(emitted, 'столько же байт выдаёт понижение').toBe(declared);
      // Пара — это именно две команды управления: подготовка и переход.
      const mnemonics = lowered.instructions.map((item) => item.mnemonic);
      expect(mnemonics).toContain('return');
      expect(mnemonics).toContain('ct');
    }
    // НЕГАТИВНЫЙ КОНТРОЛЬ: без признака «возврат процедуры» форма НЕ несёт перехода — то есть
    // если бы понижение ставило пару всегда, объявление и реализация разошлись бы, и сторож
    // выше покраснел бы. Это и есть «снятие ret обязано краснеть»: снимаем `ct` из формы.
    const withoutPair = carrierFormOf(withValue, {});
    const declared = withoutPair!.commands.reduce((sum, command) => sum + command.size, 0);
    const emittedPair = lowerCarrier(withValue, { procedureReturn: true });
    const emittedBytes =
      emittedPair.ok ? emittedPair.instructions.reduce((sum, item) => sum + encoder.encode(item).length, 0) : 0;
    expect(declared, 'без признака форма короче').toBe(16);
    expect(emittedBytes, 'а понижение возврата процедуры длиннее — расхождение обязано быть видно').not.toBe(declared);
  });

  it('первый возврат точки входа становится ВЫХОДОМ, остальные не занимают места', () => {
    const code: AsmInstruction[] = [
      carrier('IR.add', [reg(1), reg(2), reg(3)]),
      carrier('IR.ret', [imm(1), reg(1)]),
      carrier('IR.ret', [imm(0), reg(0)]),
    ];
    const prepared = prepareImage(code, [{ name: 'главная', codeOffset: 0 }]);
    // Первый возврат — носитель ВЫХОДА (реальные байты: 4 команды = 40), второй — нулевой.
    expect(prepared.code[1]!.mnemonic).toBe(EXIT_CARRIER);
    expect(prepared.code[1]!.operands[1], 'выход значением — из регистра возврата').toEqual(reg(1));
    expect(prepared.zeroSize).toEqual([2]);
    const layout = layoutOf(prepared.code, { procedureReturn: true, zeroSize: prepared.zeroSize });
    const exitBytes = layout.entries.find((entry) => entry.index === 1)!.size;
    expect(exitBytes, 'выход — не приписка, а байты, которые раскладка видит').toBe(40);
    expect(layout.addresses.get(2), 'нулевой носитель стоит по адресу следующего').toBe(8 + exitBytes);
    expect(layout.totalBytes, 'и в размер образа не входит').toBe(8 + exitBytes);
  });

  it('точка входа не первая: в начало встаёт переход к ней, цели пересчитываются', () => {
    const code: AsmInstruction[] = [
      carrier('IR.add', [reg(1), reg(2), reg(3)]),
      carrier('IR.ret', [imm(1), reg(1)]),
      carrier('IR.const', [reg(0), imm(0), imm(0)]),
      carrier('IR.jmp', [imm(0)]),
      carrier('IR.ret', [imm(0), reg(0)]),
    ];
    const procedures = [
      { name: 'помощник', codeOffset: 0 },
      { name: 'главная', codeOffset: 2 },
    ];
    expect(entryProcedureIndex(procedures)).toBe(1);
    expect(procedureAt(procedures, 1)).toBe(0);
    const prepared = prepareImage(code, procedures);
    expect(prepared.addedEntryJump, 'переход добавлен').toBe(true);
    expect(prepared.code[0]!.mnemonic).toBe('IR.jmp');
    expect(prepared.code[0]!.operands[0], 'цель — первая команда точки входа в новом потоке').toEqual(imm(3));
    const entry = prepared.procedures.find((procedure) => procedure.name === 'главная')!;
    expect(entry.codeOffset, 'смещения процедур сдвинуты вместе с потоком').toBe(3);
    // Цель перехода внутри потока пересчитана: было 0, стало 1.
    const jump = prepared.code.find((item) => item.mnemonic === 'IR.jmp' && item !== prepared.code[0])!;
    expect(jump.operands[0]).toEqual(imm(1));
  });

  it('вложенный вызов БОЛЬШЕ НЕ ОТКАЗ: рекурсия понижается, форма роста окна совпадает с понижением', () => {
    // До §3.57 здесь стоял отказ «вызов из вызываемой процедуры невозможен: кольцо окон…». Теперь
    // конвейер растит окно в прологе вызывающей (носитель IR.window_grow) и зовёт с `wbs = 8`, а
    // возврат на глубине ≥ 2 идёт в порядке «return → значение → ct» — измерено `.tmp/osnova-mainAB.ts`
    // (V2 против V3: 9 против 7) и прогоном факториала (120, код 0).
    const recursion = loweredProgram(RECURSION);
    expect(recursion.refused, 'рекурсия обязана понижаться без отказов').toEqual([]);
    expect(recursion.bytes.length).toBeGreaterThan(0);

    // Сторож ФОРМЫ роста окна: объявленная длина обязана совпасть с тем, что выдаёт понижение.
    // Разойдутся — адреса процедур за прологом уедут (класс §3.35), и это будет видно здесь.
    const grow = carrier(WINDOW_GROW_CARRIER, []);
    const form = carrierFormOf(grow, {});
    expect(form, 'у роста окна обязана быть форма').toBeDefined();
    const declared = form!.commands.reduce((sum, command) => sum + command.size, 0);
    const emitted = windowGrowInstructions().reduce((sum, item) => sum + encoder.encode(item).length, 0);
    expect(declared, 'форма роста окна (setwd 16 + setbn 8)').toBe(24);
    expect(emitted, 'понижение роста окна выдаёт ровно те же байты').toBe(declared);
    const lowered = lowerCarrier(grow, {});
    expect(lowered.ok).toBe(true);
    if (lowered.ok) {
      expect(lowered.instructions.map((item) => item.mnemonic), 'setwd ДО setbn — порядок §3.56.2').toEqual([
        'setwd',
        'setbn',
      ]);
    }

    // Печать из вызываемой: системный вызов по-прежнему невозможен — аргументы syscall адресуются
    // ОТНОСИТЕЛЬНО ОКНА (§3.52, случай 23 реестра). Рекурсия снята — печать из процедуры НЕТ.
    const printing = `процедура печать_числа(ч: Число)
  система.лог.вывести(ч)
конец_процедуры

процедура главная()
  печать_числа(7)
конец_процедуры
`;
    const refused = loweredProgram(printing).refused;
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.map((item) => item.code)).toContain(LOWERING_CODES.runtime);

    // Контроль: ВЫЗОВ-ЛИСТ с арифметикой собирается без отказов — граница не «вызов вообще».
    const leaf = loweredProgram(CALLER_CALLEE);
    expect(leaf.refused, 'вызов листовой процедуры обязан понижаться').toEqual([]);
    expect(leaf.bytes.length).toBeGreaterThan(0);
  });

  it('вызываемая перед точкой входа: поток без отказов, вызов получает адрес', () => {
    // `08-факториал` устроен так же: первой в модуле идёт вызываемая процедура.
    const shell = shellCarriers(CALLER_CALLEE);
    expect(shell.filter((item) => item.mnemonic === 'IR.call').length, 'вызов один').toBe(1);
    // Вызываемая `ответ` (индексы 0–1) стоит ПЕРЕД точкой входа (индексы 2–4) — как в модуле.
    const image = imageOfCarriers(
      [
        carrier('IR.const', [reg(2), imm(0), imm(0)]),
        carrier('IR.ret', [imm(1), reg(2)]),
        carrier('IR.const', [reg(0), imm(1), imm(0)]),
        CALL,
        carrier('IR.ret', [imm(1), reg(2)]),
      ],
      [42, 21],
      [],
      {
        procedures: [
          { name: 'ответ', codeOffset: 0 },
          { name: 'главная', codeOffset: 2 },
        ],
      },
    );
    expect(image.refused, 'вызов размещён, адрес взят').toEqual([]);
    expect(image.bytes.length).toBeGreaterThan(0);
  });
});
