/**
 * A-fix: `stringPlan` не должен звать числовой `+` склейкой только потому, что клетка КОГДА-ТО
 * держала строку.
 *
 * Замер B2a (2026-11-11): после строковых `ч0`/`ч1` числовой `инд + 1` отказывал
 * `система.строка.объединить` — 19 ложных отказов. Причина — `byRegister` (история ЗНАЧЕНИЯ), а не
 * тип: `IR.add` исключён из числовой ветви (`stringPlan.ts:1016`), а `kill` стоит после проверки
 * `однаИзвестна` (`:1105`, `:1123`). Контроль «вырезать `ч0`/`ч1`» давал 0 таких отказов.
 *
 * Граница держится с двух сторон:
 *   • числовой `+` поверх переиспользованной клетки со строкой — НЕ отказ;
 *   • `s + "x"` (оба значения известны) — склейка, как была;
 *   • `строка-параметр + "x"` (значение одной стороны не доказано) — ПРЕЖНИЙ отказ.
 */
import { describe, expect, it } from 'vitest';
import { HEAP_OFFSET } from './programImage';
import { MINIMAL_BASE } from './elfMinimal';
import { planStrings } from './stringPlan';
import { STRING_CALLS } from './stringRuntime';

const reg = (index: number): { kind: 'reg'; index: number } => ({ kind: 'reg', index });
const imm = (value: number): { kind: 'imm'; value: number } => ({ kind: 'imm', value });
const carrier = (mnemonic: string, operands: readonly unknown[]) => ({ mnemonic, channel: 0, operands });

const plan = (code: readonly unknown[], constants: readonly unknown[]) =>
  planStrings(
    code as never,
    constants,
    [STRING_CALLS.concat],
    MINIMAL_BASE + HEAP_OFFSET,
  );

describe('stringPlan: числовой `+` после строкового литерала (A-fix)', () => {
  it('переиспользованная клетка со строкой + число — НЕ `строка.объединить`', () => {
    // r0 = 1 (число), r1 = "с" (строка), r2 = r1 + r0.
    // До правки: registerOf(r1) есть, registerOf(r0) нет → «одна сторона — строка» → отказ.
    const результат = plan(
      [
        carrier('IR.const', [reg(0), imm(0)]),
        carrier('IR.const', [reg(1), imm(1)]),
        carrier('IR.add', [reg(2), reg(1), reg(0)]),
      ],
      [1, 'с'],
    );

    expect(результат.problems, 'числовой `+` обязан остаться арифметикой').toEqual([]);
    expect(результат.counts.concats, 'склейки здесь нет').toBe(0);
  });

  it('законная склейка двух известных строк остаётся склейкой', () => {
    const результат = plan(
      [
        carrier('IR.const', [reg(0), imm(0)]),
        carrier('IR.const', [reg(1), imm(1)]),
        carrier('IR.add', [reg(2), reg(0), reg(1)]),
      ],
      ['аб', 'вг'],
    );

    expect(результат.problems, 'оба значения известны — отказа нет').toEqual([]);
    expect(результат.counts.concats, 'склейка обязана остаться склейкой').toBe(1);
  });

  it('`строка-параметр + "x"` — ПРЕЖНИЙ отказ (значение одной стороны не доказано)', () => {
    const результат = plan(
      [
        carrier('IR.const', [reg(0), imm(0)]),
        // r1 — параметр/значение из рантайма: ни значения, ни числа у него нет.
        carrier('IR.add', [reg(2), reg(1), reg(0)]),
      ],
      ['|'],
    );

    expect(результат.problems, 'одна сторона — строка, вторая неизвестна: отказ обязан остаться').toHaveLength(1);
    expect(результат.problems[0]).toContain('одна сторона — строка');
  });
});
