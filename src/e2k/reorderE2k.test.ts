/**
 * ОРАКУЛ ПЕРЕСТАНОВКИ В РЕАЛЬНОЙ ВЕТВИ e2k.
 *
 * # Что выяснилось до реализации, и почему это меняет задачу
 *
 * Задание предполагало, что перестановку нужно **включить** в `src/e2k/e2kRealRun.ts`. Замер
 * показал три факта, и все три проверяются здесь:
 *
 * 1. **Перестановка в реальной ветви уже действует.** Она делается эмиттером
 *    (`src/e2k/emitterShell.ts:396` — `scheduleRegWithReorder`), и только для регионов атомов с
 *    `optimizable: true` (`src/compiler/atomRegions.ts:55-56` — `A5`, `A6`; ядра используют именно
 *    их). Проверка: порядок носителей при `A5/A6` отличается от порядка при `A1`
 *    (`optimizable: false`).
 * 2. **Вызвать `reorderScheduler` в `e2kRealRun` нельзя**: его вход — `RegInstruction`
 *    (`src/vliw/reorderScheduler.ts:37`), а из `src/e2k/` он не импортирует ничего. Структурная
 *    проверка ниже читает исходник и требует обе вещи.
 * 3. **Перестановка не меняет ни одного числа**: такты модели те же, байты образа те же, пакетов
 *    столько же. Причина названа в проекте заранее: перестановка заполняет **широкую команду**, а
 *    упаковки в оболочке нет (`memory/_index.md:227-233`).
 *
 * # Что этот оракул НЕ делает
 *
 * Не требует реализации перестановки: её не нужно добавлять — она уже есть, и её эффект равен нулю
 * по измерению. Оракул закрепляет **измеренные инварианты**, чтобы «включить перестановку» больше
 * не выглядело невыполненной работой.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { getEncoder } from './backend';
import { emitShell } from './emitterShell';
import { annotateAtomRegions } from '../compiler/atomRegions';
import { regModuleOf } from '../vliw/regOracle';
import { simulateShellImage } from './simulatorShell';

const ROOT = path.resolve(__dirname, '..', '..');
const KERNELS_DIR = path.join(ROOT, 'tests', 'dsp', 'kernels');

/** Ядра и атомы: `optimizable` — из каталога атомов (`src/compiler/atomRegions.ts:51-77`). */
export const REORDER_KERNELS: ReadonlyArray<{
  readonly name: string;
  readonly atom: string;
  readonly ticks: number;
  readonly carriers: number;
}> = [
  { name: 'fir', atom: 'A5', ticks: 802, carriers: 111 },
  { name: 'iir', atom: 'A5', ticks: 390, carriers: 85 },
  { name: 'fft', atom: 'A5', ticks: 226, carriers: 105 },
  { name: 'convolution', atom: 'A6', ticks: 707, carriers: 110 },
  { name: 'correlation', atom: 'A6', ticks: 183, carriers: 100 },
];

const shellEncoder = getEncoder('internal-shell');

/** Собрать образ ядра с указанным атомом: флаг `optimizable` берётся из каталога по атому. */
export function emitKernel(name: string, atom: string) {
  const source = fs.readFileSync(path.join(KERNELS_DIR, `${name}.osnova`), 'utf-8');
  const built = regModuleOf(source);
  if (built === null) throw new Error(`ядро не компилируется: ${name}`);
  const annotated = annotateAtomRegions(built.module, [
    { atom, procedures: built.module.procedures.map((procedure) => procedure.name) },
  ]);
  return emitShell(annotated, shellEncoder);
}

describe('перестановка в реальной ветви: структурная проверка', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'vliw', 'reorderScheduler.ts'), 'utf8');

  it('1.1 reorderScheduler работает на RegInstruction и не знает потока носителей e2k', () => {
    expect(source, 'импорт типа RegInstruction').toContain('import type { RegInstruction }');
    expect(source, 'ни одного импорта из src/e2k').not.toMatch(/from\s+"\.\.\/e2k/);
    // Все публичные входы — RegInstruction[]; проверяется по сигнатурам закреплённых функций.
    for (const name of ['scheduleRegWithReorder', 'scheduleRegInOrder', 'scheduleGraphWithReorder']) {
      const at = source.indexOf(`export function ${name}`);
      expect(at, `${name} объявлена`).toBeGreaterThan(0);
      expect(source.slice(at, at + 200), `${name}: вход`).toContain('readonly RegInstruction[]');
    }
  });

  it('1.2 эмиттер вызывает перестановку — она уже в конвейере, а не отсутствует', () => {
    const emitter = fs.readFileSync(path.join(ROOT, 'src', 'e2k', 'emitterShell.ts'), 'utf8');
    expect(emitter, 'вызов планировщика').toContain('scheduleRegWithReorder');
    // И вызывается он только для оптимизируемых регионов: у неоптимизируемого порядок обязан совпасть.
    expect(emitter, 'условие по optimizable').toContain('if (region.optimizable)');
  });
});

describe('перестановка в реальной ветви: порядок действительно меняется', () => {
  it('1.3 порядок носителей при optimizable-атоме отличается от неоптимизируемого', () => {
    const problems: string[] = [];
    for (const { name, atom } of REORDER_KERNELS) {
      const reordered = emitKernel(name, atom);
      const plain = emitKernel(name, 'A1');
      const orderChanged = reordered.instructions.some((instruction, index) => {
        const other = plain.instructions[index];
        if (other === undefined) return true;
        return (
          instruction.mnemonic !== other.mnemonic ||
          JSON.stringify(instruction.operands) !== JSON.stringify(other.operands)
        );
      });
      if (!orderChanged) problems.push(`${name}: порядок при ${atom} совпал с A1 — перестановки нет`);
      // И число инструкций обязано совпасть: перестановка не удаляет и не добавляет.
      if (reordered.instructions.length !== plain.instructions.length) {
        problems.push(
          `${name}: инструкций ${reordered.instructions.length} против ${plain.instructions.length}`,
        );
      }
    }
    expect(problems, 'изменение порядка').toEqual([]);
  });
});

describe('перестановка в реальной ветви: такты модели', () => {
  it('1.4 такты модели с перестановкой равны тактам без неё', async () => {
    const problems: string[] = [];
    const measured: string[] = [];
    for (const { name, atom, ticks } of REORDER_KERNELS) {
      const emitted = emitKernel(name, atom);
      const withReorder = await simulateShellImage(emitted.image, shellEncoder, { order: 'emitted' });
      const linear = await simulateShellImage(emitted.image, shellEncoder, { defects: { ignoreReorder: true } });
      measured.push(`${name}:${withReorder.report.ticks}/${linear.report.ticks}`);
      if (withReorder.report.ticks !== linear.report.ticks) {
        problems.push(`${name}: ${withReorder.report.ticks} с перестановкой против ${linear.report.ticks} линейно`);
      }
      if (withReorder.report.ticks !== ticks) {
        problems.push(`${name}: такты ${withReorder.report.ticks}, а закреплено ${ticks}`);
      }
    }
    expect(problems, 'такты до и после перестановки').toEqual([]);
    expect(measured, 'измеренные такты').toEqual([
      'fir:802/802',
      'iir:390/390',
      'fft:226/226',
      'convolution:707/707',
      'correlation:183/183',
    ]);
  });

  it('1.5 состав образа от перестановки не меняется: инструкций и байт столько же', () => {
    const problems: string[] = [];
    for (const { name, atom, carriers } of REORDER_KERNELS) {
      const reordered = emitKernel(name, atom);
      const plain = emitKernel(name, 'A1');
      if (reordered.instructions.length !== carriers) {
        problems.push(`${name}: носителей ${reordered.instructions.length}, закреплено ${carriers}`);
      }
      if (
        reordered.instructions.length * reordered.image.instructionSize !==
        plain.instructions.length * plain.image.instructionSize
      ) {
        problems.push(`${name}: размер образа изменился перестановкой`);
      }
    }
    expect(problems, 'состав образа').toEqual([]);
  });
});

describe('оракул собран и проверяет непустое множество', () => {
  it('каждое ядро собралось с обоими атомами и дало положительные такты', async () => {
    for (const { name, atom } of REORDER_KERNELS) {
      const emitted = emitKernel(name, atom);
      expect(emitted.instructions.length, `${name}: носителей`).toBeGreaterThan(0);
      const run = await simulateShellImage(emitted.image, shellEncoder, { order: 'emitted' });
      expect(run.report.ticks, `${name}: такты`).toBeGreaterThan(0);
    }
  });
});
