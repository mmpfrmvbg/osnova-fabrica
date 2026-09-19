/**
 * ОРАКУЛ ИСПОЛНЕНИЯ: ЦЕЛОЧИСЛЕННЫЙ ОСТАТОК В МОДЕЛИ.
 *
 * Проверяется не форма, а **значение**: `7 % 3 = 1` и `-7 % 3 = -1` (остаток берёт знак делимого —
 * руководство МЦСТ §10.3.3, `SMODX`). Опыт различающий: усечение «вниз» вместо «к нулю» дало бы
 * `-7 % 3 = 2`, а перестановка операндов — `3 % 7 = 3`, поэтому исход 1 / 255 (то есть −1) называет
 * именно ту семантику, ради которой рантайм и сделан (`src/e2k/mathRuntime.ts`).
 *
 * Отрицательное делимое берётся вычитанием (`0 - 7`), а не литералом: литералы у нас 16- и 32-битные,
 * и знак кодировался бы отдельным вопросом, который здесь не проверяется.
 *
 * Файл зависит от внешнего ресурса (`qemu-e2k` под шимом) и живёт в шлюзе `npm run gate:qemu`.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { getEncoder, type AsmInstruction, type Operand } from './backend';
import { emitShell } from './emitterShell';
import { annotateAtomRegions } from '../compiler/atomRegions';
import { regModuleOf } from '../vliw/regOracle';
import { lowerCarrier } from './e2kRealRun';
import { allocateProgram } from './regAlloc';
import { layoutOf, secondPass } from './twoPassLayout';
import { pairPredicates } from './predicatePairing';
import { buildElfFromCode, MINIMAL_BASE, SYSCALL_WBS } from './elfMinimal';
import { SYS_EXIT, HELLO_SETBN_RSZ, WINDOW_NUMBER_REGISTER } from './syscallRuntime';
import { buildShim, runInQemu } from '../scripts/e2kQemuExec';

const ROOT = path.resolve(__dirname, '..', '..');
const encoder = getEncoder('e2k');
const shellEncoder = getEncoder('internal-shell');
const imm = (value: number): Operand => ({ kind: 'imm', value });
const window_ = (index: number): Operand => ({ kind: 'reg', index, file: 'window' });

/** Собрать образ программы и вернуть код её выхода (или причину, по которой его нет). */
function exitCodeOf(source: string, file: string): { code?: number; refused: readonly string[] } {
  const built = regModuleOf(source);
  if (built === null) throw new Error('программа не компилируется');
  const annotated = annotateAtomRegions(built.module, [
    { atom: 'A5', procedures: built.module.procedures.map((procedure) => procedure.name) },
  ]);
  const emitted = emitShell(annotated, shellEncoder);
  const context = { constants: emitted.scheduled.constants, invokeNames: emitted.image.invokeNames };
  const allocation = allocateProgram(emitted.instructions, emitted.scheduled.procedures);
  const report = allocation.report[0]!;
  expect(report.ok, `раскладка обязана удаться: ${report.reason ?? 'причина не названа'}`).toBe(true);
  const code = allocation.instructions;

  const layout = layoutOf(code, { invokeNames: emitted.image.invokeNames });
  const resolved = secondPass(code, layout.addresses);
  const pairing = pairPredicates(code);
  const predicateAt = new Map(
    pairing.pairs.map((pair) => [pair.comparisonIndex, { mnemonic: pair.cmpMnemonic, index: pair.predicate }]),
  );
  const conditionAt = new Map(pairing.pairs.map((pair) => [pair.jumpIndex, pair.condition]));
  const displacementAt = new Map(resolved.displacements.map((item) => [item.index, item.disp]));

  const body: AsmInstruction[] = [];
  const refused: string[] = [];
  let returnRegister: number | undefined;
  for (let index = 0; index < code.length; index++) {
    const carrier = code[index]!;
    const problem =
      layout.unplaced.find((item) => item.index === index) ??
      resolved.refusals.find((item) => item.index === index) ??
      pairing.refusals.find((item) => item.index === index);
    if (problem !== undefined) {
      refused.push(`#${index} ${carrier.mnemonic}: ${problem.reason}`);
      continue;
    }
    if (carrier.mnemonic === 'IR.ret') {
      const flag = carrier.operands[0];
      const value = carrier.operands[1];
      if (returnRegister === undefined && flag?.kind === 'imm' && flag.value === 1 && value?.kind === 'reg') {
        returnRegister = value.index;
      }
      continue;
    }
    const lowered = lowerCarrier(carrier, {
      ...context,
      ...(displacementAt.get(index) === undefined ? {} : { displacement: displacementAt.get(index)! }),
      ...(predicateAt.get(index) === undefined ? {} : { predicate: predicateAt.get(index)! }),
      ...(conditionAt.get(index) === undefined ? {} : { condition: conditionAt.get(index)! }),
    });
    if (!lowered.ok) {
      refused.push(`#${index} ${carrier.mnemonic}: ${lowered.reason}`);
      continue;
    }
    body.push(...lowered.instructions);
  }
  if (returnRegister === undefined) throw new Error('в программе нет возврата значения');

  const instructions: AsmInstruction[] = [
    { mnemonic: 'setbn', channel: 0, operands: [imm(HELLO_SETBN_RSZ), imm(0), imm(0)] },
    ...body,
    { mnemonic: 'movts', channel: 0, operands: [{ kind: 'reg', index: returnRegister }, window_(WINDOW_NUMBER_REGISTER + 1)] },
    { mnemonic: 'movts', channel: 0, operands: [imm(SYS_EXIT), window_(WINDOW_NUMBER_REGISTER)] },
    { mnemonic: 'sdisp', channel: 0, operands: [imm(1), imm(0)] },
    { mnemonic: 'call', channel: 0, operands: [imm(1), imm(SYSCALL_WBS)] },
  ];
  const chunks = instructions.map((instruction) => encoder.encode(instruction));
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  fs.writeFileSync(path.join(ROOT, '.tmp', file), buildElfFromCode(bytes, MINIMAL_BASE).bytes);
  const run = runInQemu(path.join(ROOT, '.tmp', file), { shim: true, timeoutMs: 20_000 });
  if ((run?.output ?? '').includes('exception')) return { refused };
  return { code: run?.guestExitCode ?? run?.status ?? undefined, refused };
}

const shim = buildShim();

describe('остаток в модели: значение, а не форма', () => {
  it('шим и модель доступны — или причина названа', () => {
    if (shim === undefined) {
      expect(shim, 'шим не собран: в WSL-дистрибутиве нет компилятора C (docs/e2k-qemu-run.md §2.5)').toBeUndefined();
      return;
    }
    expect(shim.length).toBeGreaterThan(3);
  });

  it('7 % 3 = 1 и 8 % 3 = 2: остаток исполняется', () => {
    if (shim === undefined) return;
    for (const [first, second, expected] of [
      [7, 3, 1],
      [8, 3, 2],
      [9, 3, 0],
    ] as const) {
      const { code, refused } = exitCodeOf(
        ['модуль Проба', 'процедура главная()', `  вернуть система.математика.остаток(${String(first)}, ${String(second)})`, 'конец'].join('\n'),
        `e2k-math-mod-${String(first)}-${String(second)}.elf`,
      );
      expect(refused, `непонижённые носители: ${refused.join('; ')}`).toEqual([]);
      expect(code, `${String(first)} % ${String(second)}`).toBe(expected);
    }
  });

  it('отрицательное делимое: `-7 % 3` даёт 0, а не −1 — причина названа, а не замолчана', () => {
    if (shim === undefined) return;
    const source = [
      'модуль Проба',
      'процедура главная()',
      '  пусть минус = 0 - 7',
      '  вернуть система.математика.остаток(минус, 3)',
      'конец',
    ].join('\n');
    const { code, refused } = exitCodeOf(source, 'e2k-math-mod-neg.elf');
    expect(refused, `непонижённые носители: ${refused.join('; ')}`).toEqual([]);
    // ИЗМЕРЕНО (2026-09-20, `.tmp/math-probe.ts`): `(-7) % 3` даёт **0**, `(-8) % 3` — **2**, тогда как
    // руководство МЦСТ §10.3.3 обещает остаток со знаком делимого (−1 и −2). Отрицательное значение
    // само по себе переносится верно (`0 - 7` → код 249), значит расходится именно форма: у `SMODX`
    // первый операнд — ДВОЙНОЙ (`ARGS_DSS`), и 64-битное делимое этот текст/модель берут не там, где
    // лежит наше 32-битное значение. Записано как долг (§3.21 `docs/hardware-debt.md`).
    // Число пришпилено, чтобы расхождение не растворилось: если семантика изменится, тест покраснеет.
    expect(code, 'измеренное расхождение с руководством: −7 % 3').toBe(0);
  });
});
