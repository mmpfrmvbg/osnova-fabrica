/**
 * ОРАКУЛ РАНТАЙМА ОСТАТКА: форма, отказы и связь с IIR.
 *
 * Проверяется то, что видно без модели: одна команда `SMODX` в пятом канале, причины отказов, и то,
 * что ядро IIR действительно зовёт именно эту функцию (`система.математика.остаток`) — иначе рантайм
 * был бы «на всякий случай». Исполнение — `src/e2k/e2kMathQemu.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { getEncoder, type Operand } from './backend';
import { REMAINDER_CHANNEL, REMAINDER_MNEMONIC, SUPPORTED_MATH_CALLS, lowerMathCall } from './mathRuntime';
import { REAL_OPCODES } from './e2k-real';
import { assembleAll, asTextOf, findExternalAs, type AsSample } from '../scripts/e2kExternalAs';

const ROOT = path.resolve(__dirname, '..', '..');
const encoder = getEncoder('e2k');
const reg = (index: number): Operand => ({ kind: 'reg', index });
const imm = (value: number): Operand => ({ kind: 'imm', value });

describe('рантайм остатка: форма и отказы', () => {
  it('`система.математика.остаток` даёт одну команду SMODX в пятом канале', () => {
    const lowered = lowerMathCall(SUPPORTED_MATH_CALLS[0]!, [reg(1), reg(2)], 3);
    expect(lowered.length, 'остаток — одна команда').toBe(1);
    expect(lowered[0]!.mnemonic, 'мнемоника из источника').toBe(REMAINDER_MNEMONIC);
    expect(lowered[0]!.channel, 'канал: только пятый разрешён источником').toBe(REMAINDER_CHANNEL);
    // Порядок операндов — из записи таблицы МЦСТ (`src/e2k/e2k-real.ts`: `src1`, `src2`, `dst`).
    const entry = REAL_OPCODES.find((item) => item.mnemonic === REMAINDER_MNEMONIC);
    expect(entry, 'форма обязана быть в таблице').toBeDefined();
    expect(entry!.operands, 'порядок операндов формы').toEqual(['src1', 'src2', 'dst']);
    expect(entry!.channels, 'каналы формы').toEqual([REMAINDER_CHANNEL]);
    expect(lowered[0]!.operands.map((operand) => (operand.kind === 'reg' ? operand.index : -1))).toEqual([1, 2, 3]);
    // Кодировщик принимает форму (иначе рантайм бесполезен).
    expect(encoder.encode(lowered[0]!).length, 'байт в команде').toBeGreaterThan(0);
  });

  it('частное НЕ делается: `/` в языке вещественное, а формы e2k целочисленные', () => {
    expect(() => lowerMathCall('система.математика.частное', [reg(1), reg(2)], 3)).toThrow(/вещественное/);
    expect(SUPPORTED_MATH_CALLS, 'в рантайме только остаток').toEqual(['система.математика.остаток']);
  });

  it('отказы названы причиной: арность, отсутствие приёмника, не-регистр', () => {
    expect(() => lowerMathCall(SUPPORTED_MATH_CALLS[0]!, [reg(1)], 3)).toThrow(/аргументов 1/);
    expect(() => lowerMathCall(SUPPORTED_MATH_CALLS[0]!, [reg(1), reg(2)], undefined)).toThrow(/приёмник не передан/);
    expect(() => lowerMathCall(SUPPORTED_MATH_CALLS[0]!, [reg(1), imm(3)], 3)).toThrow(/не в регистре/);
  });

  it('ядру IIR остаток больше НЕ нужен: целочисленное частное даёт оператор `div`', () => {
    // Перемер 2026-09-25. Прежде ядро выражало частное через остаток — трюком `(a - a % b) / b`,
    // потому что оператора `div` (БЛОК 2) не было, а `/` в языке вещественное. Теперь `div` есть и
    // понижается в `SDIVs`, поэтому трюк снят: у ядра IIR он давал единственный оставшийся отказ
    // понижения во всём конвейере (`IR.div`).
    //
    // Рантайм остатка при этом НЕ осиротел: его форму и отказы проверяет этот файл, а исполнение —
    // шлюзовый оракул `src/e2k/e2kMathQemu.test.ts` (там `остаток` считается в модели).
    const source = fs.readFileSync(path.join(ROOT, 'tests', 'dsp', 'kernels', 'iir.osnova'), 'utf-8');
    expect(source, 'IIR больше не выражает частное через остаток').not.toContain('система.математика.остаток');
    expect(source, 'вместо трюка — оператор `div`').toContain('вернуть числитель div знаменатель');
  });

  it('ассемблер МЦСТ собирает ту же команду — и байты те же (живая сверка)', () => {
    const { tool } = findExternalAs();
    if (tool === undefined) {
      // Ассемблер живёт в WSL-дистрибутиве `e2k`; без него сверка не состоит, и это названо, а не
      // выдано за совпадение (то же правило, что в `src/e2k/e2kDivisionForms.test.ts`).
      expect(tool, 'ассемблер МЦСТ недоступен: сверка НЕ состоялась').toBeUndefined();
      return;
    }
    const lowered = lowerMathCall(SUPPORTED_MATH_CALLS[0]!, [reg(1), reg(2)], 3);
    const ours = encoder.encode(lowered[0]!);
    // Текст для ассемблера строится по `argFormats` записи: у `smodx` первый операнд — ДВОЙНОЙ
    // (`ARGS_DSS`, `%db[1]`), и `as` различает `%b` и `%db` в тексте, хотя номер в поле один
    // (это измерено в `src/e2k/e2kDivisionForms.test.ts` и записано в `docs/e2k-opcodes-real.md` §7.14).
    const entry = REAL_OPCODES.find((item) => item.mnemonic === REMAINDER_MNEMONIC)!;
    const sample: AsSample = {
      key: REMAINDER_MNEMONIC,
      mnemonic: REMAINDER_MNEMONIC,
      channel: REMAINDER_CHANNEL,
      form: `ALF1 (${entry.argFormats.join('')})`,
      asText: asTextOf(entry, REMAINDER_CHANNEL),
      instruction: lowered[0]!,
      source: entry.source,
    };
    const [theirs] = assembleAll([sample]);
    expect(theirs?.ok, 'ассемблер обязан собрать форму').toBe(true);
    if (theirs === undefined || !theirs.ok) return;
    expect([...ours], 'байты против ассемблера МЦСТ').toEqual([...theirs.bytes]);
  });
});
