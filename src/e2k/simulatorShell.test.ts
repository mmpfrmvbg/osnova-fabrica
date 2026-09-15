/**
 * ОРАКУЛ СИМУЛЯТОРА НА ОБОЛОЧКЕ.
 *
 * # Что проверяется
 *
 * 1. **Семантика сохранена.** Пять DSP-ядер проходят маршрут «исходник → `RegModule` →
 *    разметка атомов → эмиттер → байты → **симулятор на оболочке**» и дают те же числа, что
 *    независимый эталон `tests/dsp/reference.json` (181 / 119 / 4 / 90 / 32) и регистровая VM.
 * 2. **Такты по модели.** Числа тактов каждого ядра сверяются с артефактом
 *    `tests/e2k/shell-ticks.json` (артефакт создаёт `src/scripts/shell-ticks.ts`).
 * 3. **Зависимости учитываются.** Снятие учёта зависимостей (`ignoreDependencies`) меняет такты
 *    и не меняет числа ядер.
 * 4. **Порядок инструкций учитывается.** На синтетической паре программ показано: перенос
 *    независимой инструкции в зазор между длинной операцией и её потребителем уменьшает такты.
 * 5. **Четыре дефекта** (4.1–4.4) ловятся: снятие учёта зависимостей, подмена класса (ALU → MEM),
 *    снятие учёта перестановки, подмена семантики (`add` → `sub`). Инъекция живёт в коде
 *    (`SimulatorDefects`), поэтому дефекты стоят в общем прогоне, а не только в отчёте.
 *
 * # НАЙДЕНО (записано тестом, а не отчётом)
 *
 * **Перестановка эмиттера на пяти ядрах тактов не меняет.** Порядок инструкций в потоке
 * оболочки — это **порядок слотов широкой команды** (`reorderScheduler` заполняет пакет за
 * тактом), а не порядок выдачи однослотовой машины. Упаковки в оболочке нет, поэтому выигрыш
 * планировщика, который считает `cycles` по пакетам (`metrics.gain`), в такты оболочки не
 * переходит. На синтетической программе видно и обратное: перестановка эмиттера может сделать
 * расписание оболочки **дороже** на такт (13 → 14), потому что независимая инструкция уезжает
 * в тот же пакет, что и длинная операция, и в плоском потоке оказывается между производителем и
 * потребителем вместо зазора. Это утверждение о паре «эмиттер + симулятор оболочки», а не о e2k.
 *
 * # Чего оракул НЕ доказывает
 *
 * Что такты настоящие: числа получены **по модели** `docs/vliw-e2k-model.md` и **не валидированы
 * на железе**. Что код корректен для e2k: это **симулятор на оболочке**, а не симулятор e2k, —
 * носители `IR.*` наши, документированных операций e2k здесь нет.
 *
 * # Оракул написан ДО реализации
 *
 * Правило проекта «оракул раньше кода»: файл внесён до появления `src/e2k/simulatorShell.ts`,
 * и на том коммите прогон красный (модуля нет). Числа тактов добавлены коммитом с
 * симулятором — их нельзя знать до первого честного замера, а семантика (181/119/4/90/32)
 * известна заранее: она из независимого эталона, а не из этого кода.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { getEncoder } from './backend';
import { emitShell } from './emitterShell';
import { annotateAtomRegions, verifyAtomRegions } from '../compiler/atomRegions';
import { regModuleOf } from '../vliw/regOracle';
import { RegVM } from '../runtime/vm/reginterpreter';
import { createDefaultInvokeHandler } from '../runtime/vm/interpreter';
import { resolveEntryIndex } from '../oracle/parity';
import type { RegModule } from '../runtime/vm/regcode';
import {
  SIMULATOR_PASSPORT,
  decodeShellProgram,
  simulateShellImage,
  type ExecutionOrder,
  type ShellProgram,
  type ShellRunResult,
  type SimulatorDefects,
} from './simulatorShell';

const ROOT = path.resolve(__dirname, '..', '..');
const KERNELS_DIR = path.join(ROOT, 'tests', 'dsp', 'kernels');
const REFERENCE = path.join(ROOT, 'tests', 'dsp', 'reference.json');
const TICKS_ARTIFACT = path.join(ROOT, 'tests', 'e2k', 'shell-ticks.json');

const encoder = getEncoder('internal-shell');

/** Пять ядер и атом, соответствующий природе каждого (как в сквозном прогоне). */
const KERNELS: Array<{ name: string; atom: string; algorithm: string }> = [
  { name: 'fir', atom: 'A5', algorithm: 'FIR-фильтр' },
  { name: 'iir', atom: 'A5', algorithm: 'IIR-фильтр' },
  { name: 'fft', atom: 'A5', algorithm: 'БПФ radix-2' },
  { name: 'convolution', atom: 'A6', algorithm: 'свёртка' },
  { name: 'correlation', atom: 'A6', algorithm: 'корреляция' },
];

interface Reference {
  [algorithm: string]: { checksum: number };
}

/** Запись артефакта тактов по одному ядру. */
interface TicksEntry {
  checksum: number;
  atom: string;
  staticInstructions: number;
  instructions: number;
  ticks: number;
  ticksLinear: number;
  cpi: number;
  classes: Array<{ label: string; executed: number; ticks: number; stalls: number }>;
}

interface TicksArtifact {
  kernels: Record<string, TicksEntry>;
  total: { staticInstructions: number; instructions: number; ticks: number; ticksLinear: number };
}

/** Опции прогона одного ядра: порядок, дефекты и предел шагов. */
interface KernelRun {
  order?: ExecutionOrder;
  defects?: SimulatorDefects;
  maxSteps?: number;
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
}

function readReference(): Reference {
  return readJson<Reference>(REFERENCE);
}

function readArtifact(): TicksArtifact {
  if (!fs.existsSync(TICKS_ARTIFACT)) {
    throw new Error(
      'нет tests/e2k/shell-ticks.json — артефакт тактов создаётся `npx tsx src/scripts/shell-ticks.ts --write`',
    );
  }
  return readJson<TicksArtifact>(TICKS_ARTIFACT);
}

/** Исходник ядра, собранный в регистровый модуль. */
function kernelModule(name: string): RegModule {
  const source = fs.readFileSync(path.join(KERNELS_DIR, `${name}.osnova`), 'utf-8');
  const built = regModuleOf(source);
  if (!built) throw new Error(`ядро не компилируется: ${name}`);
  return built.module;
}

/** Ядро с разметкой атомов и порождённым потоком байтов оболочки. */
function kernelImage(name: string, atom: string): ReturnType<typeof emitShell> {
  const module = kernelModule(name);
  const annotated = annotateAtomRegions(module, [
    { atom, procedures: module.procedures.map((p) => p.name) },
  ]);
  const problems = verifyAtomRegions(annotated);
  if (problems.length > 0) {
    throw new Error(`${name}: разметка не прошла проверку: ${problems.join('; ')}`);
  }
  return emitShell(annotated, encoder);
}

/** Программа симулятора по ядру: байты → носители → выбранный порядок исполнения. */
function kernelProgram(name: string, atom: string, options: KernelRun = {}): ShellProgram {
  return decodeShellProgram(kernelImage(name, atom).image, encoder, options);
}

/** Прогон ядра симулятором на оболочке. */
async function runKernel(
  name: string,
  atom: string,
  options: KernelRun = {},
): Promise<ShellRunResult> {
  return simulateShellImage(kernelImage(name, atom).image, encoder, options);
}

/** Прогон ядра напрямую регистровой VM — вторая сверка семантики, помимо эталона. */
async function runDirect(name: string): Promise<unknown> {
  const module = kernelModule(name);
  const entry = resolveEntryIndex(module.procedures, undefined) ?? 0;
  const host = createDefaultInvokeHandler();
  const vm = new RegVM(module, { maxSteps: 200_000, invoke: (n, a) => host(n, a) });
  return vm.runProcedure(entry, []);
}

// ─────────────────────────────────────────────────────────────────────────────
// Синтетическая программа: длинная операция (mul, 4 такта) и её потребитель
// ─────────────────────────────────────────────────────────────────────────────

/** Где стоит независимая инструкция относительно пары «умножение → сложение». */
type ProbeOrder = 'gap-after' | 'gap-between';

/**
 * Синтетическая программа из шести инструкций: `((2*3)+3)` и независимая копия.
 *
 * - `gap-after` — независимая инструкция после потребителя: зазор нечем заполнить;
 * - `gap-between` — независимая инструкция в зазоре: зазор заполняется.
 *
 * Атом выбирается из каталога: `A1` — неоптимизируемый (порядок сохраняется), `A5` —
 * оптимизируемый (эмиттер переставляет).
 */
function probeModule(order: ProbeOrder, atom: 'A1' | 'A5'): RegModule {
  const load = [
    { op: 'const', d: 1, type: 'i32', k: 0 },
    { op: 'const', d: 2, type: 'i32', k: 1 },
    { op: 'mul', d: 3, a: 1, b: 2 },
  ];
  const tail = order === 'gap-after'
    ? [
        { op: 'add', d: 4, a: 3, b: 2 },
        { op: 'move', d: 5, a: 1 },
        { op: 'ret', v: 4 },
      ]
    : [
        { op: 'move', d: 5, a: 1 },
        { op: 'add', d: 4, a: 3, b: 2 },
        { op: 'ret', v: 4 },
      ];
  const body = [...load, ...tail];
  return {
    ir: 'osnova-reg',
    version: 1,
    moduleName: `проба-порядка-${order}-${atom}`,
    constants: [2, 3],
    procedures: [{ name: 'главная', codeOffset: 0, argc: 0, vregs: 8, localToVreg: {} }],
    code: body as RegModule['code'],
    atoms: [{ atom, optimizable: atom === 'A5', procedure: 0, start: 0, end: body.length }],
  };
}

/** Прогон синтетической программы. */
async function runProbe(
  order: ProbeOrder,
  atom: 'A1' | 'A5',
  options: KernelRun = {},
): Promise<ShellRunResult> {
  const module = probeModule(order, atom);
  const problems = verifyAtomRegions(module);
  if (problems.length > 0) throw new Error(`проба ${order}: разметка не прошла проверку`);
  const emitted = emitShell(module, encoder);
  return simulateShellImage(emitted.image, encoder, options);
}

// ─────────────────────────────────────────────────────────────────────────────

describe('симулятор на оболочке: декодирование и паспорт', () => {
  it('байты разбираются в носители: инструкций столько же, сколько записей карты размещения', () => {
    for (const { name, atom } of KERNELS) {
      const emitted = kernelImage(name, atom);
      const program = decodeShellProgram(emitted.image, encoder);
      expect(program.instructions.length, `${name}: инструкций`).toBe(emitted.image.placement.length);
      expect(program.instructions.length, `${name}: инструкций`).toBe(emitted.scheduled.code.length);
      for (const instruction of program.instructions) {
        expect(
          instruction.carrier.startsWith('IR.'),
          `${name}: носитель «${instruction.carrier}»`,
        ).toBe(true);
      }
    }
  });

  it('паспорт модуля: статус ДОПУЩЕНИЕ, источник модели и «не валидировано на железе»', () => {
    expect(SIMULATOR_PASSPORT.status).toBe('ДОПУЩЕНИЕ');
    expect(SIMULATOR_PASSPORT.limitation).toMatch(/не валидировано на железе/);
    expect(SIMULATOR_PASSPORT.source).toMatch(/vliw-e2k-model/);
    expect(SIMULATOR_PASSPORT.title).toMatch(/оболочк/i);
    expect(SIMULATOR_PASSPORT.tickModel.length).toBeGreaterThan(20);
  });
});

describe('симулятор на оболочке: семантика пяти ядер', () => {
  for (const { name, atom, algorithm } of KERNELS) {
    it(`${name} (${algorithm}): число совпадает с независимым эталоном и с регистровой VM`, async () => {
      const reference = readReference();
      const result = await runKernel(name, atom);
      const direct = await runDirect(name);
      expect(Number(result.value), `${name}: симулятор ${String(result.value)}`).toBe(Number(direct));
      expect(Number(result.value), `${name}: против эталона`).toBe(reference[name]!.checksum);
    });
  }

  it('семантика не зависит от порядка: линейный прогон даёт те же числа', async () => {
    const reference = readReference();
    for (const { name, atom } of KERNELS) {
      const linear = await runKernel(name, atom, { order: 'linear' });
      expect(Number(linear.value), `${name}: линейный порядок`).toBe(reference[name]!.checksum);
    }
  });

  it('ядра детерминированы: два прогона дают одни и те же числа и такты', async () => {
    for (const { name, atom } of KERNELS) {
      const first = await runKernel(name, atom);
      const second = await runKernel(name, atom);
      expect(second.report.ticks, `${name}: такты второго прогона`).toBe(first.report.ticks);
      expect(Number(second.value), `${name}: число второго прогона`).toBe(Number(first.value));
    }
  });
});

describe('симулятор на оболочке: такты по модели', () => {
  it('тактов не меньше, чем исполненных инструкций, и число положительно', async () => {
    for (const { name, atom } of KERNELS) {
      const result = await runKernel(name, atom);
      expect(result.report.ticks, `${name}: тактов`).toBeGreaterThan(0);
      expect(result.report.ticks, `${name}: тактов меньше, чем инструкций`).toBeGreaterThanOrEqual(
        result.report.instructions,
      );
      expect(result.report.instructions, `${name}: исполнено инструкций`).toBeGreaterThan(0);
    }
  });

  it('числа тактов совпадают с артефактом tests/e2k/shell-ticks.json', async () => {
    const artifact = readArtifact();
    for (const { name, atom } of KERNELS) {
      const entry = artifact.kernels[name];
      expect(entry, `${name}: нет записи в артефакте`).toBeDefined();
      const result = await runKernel(name, atom);
      expect(result.report.ticks, `${name}: такты против артефакта`).toBe(entry!.ticks);
      expect(result.report.instructions, `${name}: инструкции против артефакта`).toBe(
        entry!.instructions,
      );
      expect(result.report.staticInstructions, `${name}: статических инструкций`).toBe(
        entry!.staticInstructions,
      );
      const linear = await runKernel(name, atom, { order: 'linear' });
      expect(linear.report.ticks, `${name}: линейные такты против артефакта`).toBe(
        entry!.ticksLinear,
      );
    }
  });

  it('артефакт не расходится с эталоном семантики и покрывает все пять ядер', () => {
    const artifact = readArtifact();
    const reference = readReference();
    expect(Object.keys(artifact.kernels).sort()).toEqual(KERNELS.map((k) => k.name).sort());
    for (const { name, atom } of KERNELS) {
      expect(artifact.kernels[name]!.checksum, `${name}: число ядра`).toBe(reference[name]!.checksum);
      expect(artifact.kernels[name]!.atom, `${name}: атом`).toBe(atom);
    }
  });

  it('зависимости учитываются: снятие учёта меняет такты, но не числа ядер', async () => {
    for (const { name, atom } of KERNELS) {
      const honest = await runKernel(name, atom);
      const loose = await runKernel(name, atom, { defects: { ignoreDependencies: true } });
      expect(Number(loose.value), `${name}: числа разошлись при снятии учёта зависимостей`).toBe(
        Number(honest.value),
      );
      expect(loose.report.ticks, `${name}: такты не уменьшились`).toBeLessThan(honest.report.ticks);
      expect(loose.report.instructions, `${name}: инструкций исполнено`).toBe(
        honest.report.instructions,
      );
      // Без учёта зависимостей тактов ровно столько, сколько исполнено инструкций.
      expect(loose.report.ticks, `${name}: такты без зависимостей`).toBe(loose.report.instructions);
    }
  });

  it('отчёт называет классы задержек и покрывает все исполненные инструкции', async () => {
    const result = await runKernel('fir', 'A5');
    expect(result.report.classes.length).toBeGreaterThan(0);
    const total = result.report.classes.reduce((sum, stat) => sum + stat.executed, 0);
    expect(total, 'классы не покрывают исполненные инструкции').toBe(result.report.instructions);
    for (const stat of result.report.classes) {
      expect(stat.ticks, `${stat.label}: занятость меньше числа инструкций`).toBeGreaterThanOrEqual(
        stat.executed,
      );
      expect(stat.stalls).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('симулятор на оболочке: порядок инструкций', () => {
  it('порядок решает: независимая инструкция в зазоре уменьшает такты', async () => {
    const after = await runProbe('gap-after', 'A1');
    const between = await runProbe('gap-between', 'A1');
    // Один и тот же смысл, разный порядок: без зазора потребитель ждёт умножение.
    expect(Number(after.value), 'смысл программ разошёлся').toBe(Number(between.value));
    expect(after.report.ticks, 'зазор после потребителя').toBe(14);
    expect(between.report.ticks, 'зазор заполнен').toBe(13);
    expect(
      between.report.ticks,
      `порядок не повлиял на такты: после=${after.report.ticks}, в зазоре=${between.report.ticks}`,
    ).toBeLessThan(after.report.ticks);
  });

  it('НАЙДЕНО: перестановка эмиттера на пяти ядрах тактов оболочки не меняет', async () => {
    const same: string[] = [];
    for (const { name, atom } of KERNELS) {
      const emitted = await runKernel(name, atom, { order: 'emitted' });
      const linear = await runKernel(name, atom, { order: 'linear' });
      expect(Number(emitted.value), `${name}: числа при перестановке`).toBe(Number(linear.value));
      expect(emitted.report.ticks, `${name}: такты разошлись`).toBe(linear.report.ticks);
      same.push(name);
    }
    // Порядок действительно переставлен: равенство тактов — факт, а не отсутствие перестановки.
    const program = kernelProgram('fir', 'A5');
    expect(program.reordered, 'перестановка не применялась — сравнение было бы пустым').toBe(true);
    expect(same.length).toBe(KERNELS.length);
  });

  it('НАЙДЕНО: на оболочке перестановка эмиттера расписание не сжимает (порядок слотов ≠ порядок выдачи)', async () => {
    // Порядок слотов широкой команды: независимая инструкция уезжает ВПЕРЁД, к умножению,
    // а не в зазор. На однослотовой оболочке это не помогает и может стоить такта.
    const emitted = await runProbe('gap-between', 'A5', { order: 'emitted' });
    const linear = await runProbe('gap-between', 'A5', { order: 'linear' });
    expect(Number(emitted.value), 'смысл разошёлся').toBe(Number(linear.value));
    expect(emitted.report.ticks, 'порядок слотов: независимая инструкция впереди').toBe(14);
    expect(linear.report.ticks, 'исходный порядок: независимая инструкция в зазоре').toBe(13);
    expect(
      emitted.report.ticks,
      'перестановка перестала менять порядок — утверждение устарело',
    ).not.toBe(linear.report.ticks);
    expect(emitted.report.ticks, 'перестановка стала выгодной — утверждение устарело').toBeGreaterThan(
      linear.report.ticks,
    );
  });
});

describe('симулятор на оболочке: четыре дефекта (негативный контроль)', () => {
  it('4.1 снятие учёта зависимостей уменьшает такты, числа ядер остаются', async () => {
    const honest = await runKernel('fir', 'A5');
    const loose = await runKernel('fir', 'A5', { defects: { ignoreDependencies: true } });
    expect(loose.report.ticks, 'дефект 4.1: такты без учёта зависимостей').toBe(727);
    expect(loose.report.ticks).toBeLessThan(honest.report.ticks);
    expect(Number(loose.value)).toBe(Number(honest.value));
    expect(loose.report.instructions).toBe(honest.report.instructions);
    expect(loose.report.ticks).toBe(loose.report.instructions);
  });

  it('4.2 подмена класса задержки (ALU → MEM) меняет такты', async () => {
    const honest = await runKernel('fir', 'A5');
    const broken = await runKernel('fir', 'A5', { defects: { latencyClassOverride: 'MEM' } });
    expect(broken.report.ticks, 'дефект 4.2: такты с подменённым классом').toBe(1337);
    expect(broken.report.ticks, 'подмена класса не повлияла на такты').not.toBe(honest.report.ticks);
    expect(Number(broken.value), 'подмена класса изменила числа ядра').toBe(Number(honest.value));
  });

  it('4.3 снятие учёта перестановки стирает разницу порядков (сравнение краснеет)', async () => {
    const emitted = await runProbe('gap-between', 'A5', { order: 'emitted' });
    const linear = await runProbe('gap-between', 'A5', { order: 'linear' });
    expect(emitted.report.ticks).not.toBe(linear.report.ticks);

    const brokenEmitted = await runProbe('gap-between', 'A5', {
      order: 'emitted',
      defects: { ignoreReorder: true },
    });
    expect(
      brokenEmitted.report.ticks,
      'снятие учёта перестановки не уравняло порядки',
    ).toBe(linear.report.ticks);
  });

  it('4.4 подмена семантики (add → sub) меняет числа', async () => {
    // Синтетика детерминирована: (2*3)+3 = 9, с подменой (2*3)-3 = 3.
    const honest = await runProbe('gap-after', 'A1');
    const broken = await runProbe('gap-after', 'A1', { defects: { swapAddToSub: true } });
    expect(Number(honest.value), 'исходное число пробы').toBe(9);
    expect(Number(broken.value), 'подмена семантики не замечена').not.toBe(Number(honest.value));
    // На ядре fir подмена ломает управление циклом: прогон не завершается — тест семантики
    // краснеет уже этим, а не совпадением чисел.
    await expect(
      runKernel('fir', 'A5', { defects: { swapAddToSub: true }, maxSteps: 20_000 }),
    ).rejects.toThrow(/предел шагов/);
    expect(Number((await runKernel('fir', 'A5')).value)).toBe(readReference().fir!.checksum);
  });
});

describe('симулятор на оболочке: форма отчёта', () => {
  it('simulateShellImage возвращает значение и отчёт с обязательными полями', async () => {
    const result: ShellRunResult = await runKernel('fft', 'A5');
    expect(result.report.order).toBe('emitted');
    expect(typeof result.report.ticks).toBe('number');
    expect(typeof result.report.instructions).toBe('number');
    expect(Array.isArray(result.report.classes)).toBe(true);
    expect(result.report.instructionSize).toBe(10);
    expect(result.report.staticInstructions).toBe(105);
    expect(result.report.tickModel).toMatch(/RAW/);
  });
});
