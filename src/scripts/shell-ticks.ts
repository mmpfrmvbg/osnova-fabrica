/**
 * АРТЕФАКТ ТАКТОВ СИМУЛЯТОРА НА ОБОЛОЧКЕ.
 *
 * Числа тактов пяти DSP-ядер, посчитанные **симулятором на оболочке**
 * (`src/e2k/simulatorShell.ts`) по модели задержек (`docs/vliw-e2k-model.md`). Артефакт —
 * точка сверки: тест симулятора проверяет, что прогон совпадает с ним, а тест документа
 * (`src/scripts/shellTicks.audit.test.ts`) — что числа в `docs/e2k-shell-ticks.md` совпадают
 * с артефактом, **не запуская симулятор**.
 *
 * **Это МОДЕЛЬ, а не железо.** Такты не измерены: модель не валидирована на железе
 * (`docs/hardware-debt.md`). И это **оболочка**, а не e2k: носители `IR.*` — наши имена.
 *
 * Использование:
 *   npx tsx src/scripts/shell-ticks.ts          # только проверка (exit 1 при расхождении)
 *   npx tsx src/scripts/shell-ticks.ts --write  # перезаписать артефакт
 */

import * as fs from 'fs';
import * as path from 'path';
import { getEncoder } from '../e2k/backend';
import { emitShell } from '../e2k/emitterShell';
import { SIMULATOR_PASSPORT, decodeShellProgram, runShellProgram } from '../e2k/simulatorShell';
import { annotateAtomRegions, verifyAtomRegions } from '../compiler/atomRegions';
import { regModuleOf } from '../vliw/regOracle';
import type { RegModule } from '../runtime/vm/regcode';

const ROOT = path.resolve(__dirname, '..', '..');

/** Формат артефакта — НАШЕ РЕШЕНИЕ (внешнего стандарта нет). */
export const TICKS_FORMAT = 'osnova-shell-ticks';

/** Версия формата артефакта — НАШЕ РЕШЕНИЕ. */
export const TICKS_VERSION = 1;

/** Где лежит артефакт. */
export const TICKS_ARTIFACT = path.join(ROOT, 'tests', 'e2k', 'shell-ticks.json');

/** Пять ядер и атом, соответствующий природе каждого. */
export const KERNELS: ReadonlyArray<{ name: string; atom: string; algorithm: string }> = [
  { name: 'fir', atom: 'A5', algorithm: 'FIR-фильтр' },
  { name: 'iir', atom: 'A5', algorithm: 'IIR-фильтр' },
  { name: 'fft', atom: 'A5', algorithm: 'БПФ radix-2' },
  { name: 'convolution', atom: 'A6', algorithm: 'свёртка' },
  { name: 'correlation', atom: 'A6', algorithm: 'корреляция' },
];

/** Класс задержки в записи артефакта. */
export interface ShellTicksClass {
  label: string;
  executed: number;
  ticks: number;
  stalls: number;
}

/** Такты одного ядра. */
export interface ShellTicksEntry {
  algorithm: string;
  atom: string;
  checksum: number;
  /** Сколько инструкций в программе (статически). */
  staticInstructions: number;
  /** Сколько инструкций исполнено с учётом циклов (динамически). */
  instructions: number;
  /** Такты по модели в порядке образа (с перестановкой). */
  ticks: number;
  /** Такты по модели в исходном линейном порядке. */
  ticksLinear: number;
  /** Такты на исполненную инструкцию: `ticks / instructions`. */
  cpi: number;
  /** Занятость конвейера по классам задержек. */
  classes: ShellTicksClass[];
}

/** Артефакт целиком. */
export interface ShellTicksArtifact {
  format: string;
  version: number;
  passport: {
    status: string;
    source: string;
    limitation: string;
    tickModel: string;
    note: string;
  };
  kernels: Record<string, ShellTicksEntry>;
  total: {
    staticInstructions: number;
    instructions: number;
    ticks: number;
    ticksLinear: number;
  };
}

/** Собрать ядро и породить поток байтов оболочки. */
function kernelImage(name: string, atom: string): ReturnType<typeof emitShell> {
  const source = fs.readFileSync(
    path.join(ROOT, 'tests', 'dsp', 'kernels', `${name}.osnova`),
    'utf-8',
  );
  const built = regModuleOf(source);
  if (!built) throw new Error(`ядро не компилируется: ${name}`);
  const module: RegModule = built.module;
  const annotated = annotateAtomRegions(module, [
    { atom, procedures: module.procedures.map((p) => p.name) },
  ]);
  const problems = verifyAtomRegions(annotated);
  if (problems.length > 0) {
    throw new Error(`${name}: разметка не прошла проверку: ${problems.join('; ')}`);
  }
  return emitShell(annotated, getEncoder('internal-shell'));
}

/** Посчитать такты всех пяти ядер симулятором на оболочке. */
export async function collectShellTicks(): Promise<ShellTicksArtifact> {
  const encoder = getEncoder('internal-shell');
  const kernels: Record<string, ShellTicksEntry> = {};
  const total = { staticInstructions: 0, instructions: 0, ticks: 0, ticksLinear: 0 };

  for (const { name, atom, algorithm } of KERNELS) {
    const image = kernelImage(name, atom).image;
    const emitted = await runShellProgram(decodeShellProgram(image, encoder), {});
    const linear = await runShellProgram(decodeShellProgram(image, encoder, { order: 'linear' }), {});
    const entry: ShellTicksEntry = {
      algorithm,
      atom,
      checksum: Number(emitted.value),
      staticInstructions: emitted.report.staticInstructions,
      instructions: emitted.report.instructions,
      ticks: emitted.report.ticks,
      ticksLinear: linear.report.ticks,
      cpi: Number((emitted.report.ticks / emitted.report.instructions).toFixed(3)),
      classes: emitted.report.classes.map((stat) => ({
        label: stat.label,
        executed: stat.executed,
        ticks: stat.ticks,
        stalls: stat.stalls,
      })),
    };
    kernels[name] = entry;
    total.staticInstructions += entry.staticInstructions;
    total.instructions += entry.instructions;
    total.ticks += entry.ticks;
    total.ticksLinear += entry.ticksLinear;
  }

  return {
    format: TICKS_FORMAT,
    version: TICKS_VERSION,
    passport: {
      status: SIMULATOR_PASSPORT.status,
      source: SIMULATOR_PASSPORT.source,
      limitation: SIMULATOR_PASSPORT.limitation,
      tickModel: SIMULATOR_PASSPORT.tickModel,
      note:
        'ЧИСЛА ПО МОДЕЛИ, НЕ ЗАМЕР: это такты симулятора на внутренней оболочке проекта, ' +
        'а не e2k. Модель не валидирована на железе (docs/hardware-debt.md)',
    },
    kernels,
    total,
  };
}

/** Сериализация артефакта — та же форма, что у остальных артефактов проекта. */
export function serializeShellTicks(artifact: ShellTicksArtifact): string {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

/**
 * Расхождения артефакта с текущим прогоном.
 *
 * @returns список расхождений; пустой список — артефакт актуален
 */
export function tickDifferences(
  stored: ShellTicksArtifact,
  fresh: ShellTicksArtifact,
): string[] {
  const problems: string[] = [];
  if (stored.format !== fresh.format) problems.push(`формат: ${stored.format} ≠ ${fresh.format}`);
  if (stored.version !== fresh.version) {
    problems.push(`версия: ${stored.version} ≠ ${fresh.version}`);
  }
  for (const { name } of KERNELS) {
    const was = stored.kernels[name];
    const now = fresh.kernels[name];
    if (was === undefined) {
      problems.push(`${name}: нет записи в артефакте`);
      continue;
    }
    if (was.ticks !== now!.ticks) problems.push(`${name}: такты ${was.ticks} ≠ ${now!.ticks}`);
    if (was.ticksLinear !== now!.ticksLinear) {
      problems.push(`${name}: линейные такты ${was.ticksLinear} ≠ ${now!.ticksLinear}`);
    }
    if (was.instructions !== now!.instructions) {
      problems.push(`${name}: исполнено инструкций ${was.instructions} ≠ ${now!.instructions}`);
    }
    if (was.checksum !== now!.checksum) {
      problems.push(`${name}: число ядра ${was.checksum} ≠ ${now!.checksum}`);
    }
  }
  return problems;
}

async function main(): Promise<void> {
  const write = process.argv.includes('--write');
  const fresh = await collectShellTicks();
  const text = serializeShellTicks(fresh);

  if (write) {
    fs.mkdirSync(path.dirname(TICKS_ARTIFACT), { recursive: true });
    fs.writeFileSync(TICKS_ARTIFACT, text, 'utf-8');
    console.log(`артефакт записан: ${path.relative(ROOT, TICKS_ARTIFACT)}`);
  } else {
    if (!fs.existsSync(TICKS_ARTIFACT)) {
      console.error(`нет артефакта: ${path.relative(ROOT, TICKS_ARTIFACT)}`);
      process.exit(1);
    }
    const stored = JSON.parse(fs.readFileSync(TICKS_ARTIFACT, 'utf-8')) as ShellTicksArtifact;
    const problems = tickDifferences(stored, fresh);
    if (problems.length > 0) {
      console.error(`артефакт разошёлся с прогоном (${problems.length}):`);
      for (const problem of problems) console.error(`- ${problem}`);
      process.exit(1);
    }
    console.log('артефакт совпадает с прогоном');
  }

  for (const { name } of KERNELS) {
    const entry = fresh.kernels[name]!;
    console.log(
      `${name}: инструкций(дин)=${entry.instructions} тактов=${entry.ticks} ` +
        `линейно=${entry.ticksLinear} CPI=${entry.cpi.toFixed(3)}`,
    );
  }
  console.log(
    `итого: инструкций(стат)=${fresh.total.staticInstructions} ` +
      `инструкций(дин)=${fresh.total.instructions} тактов=${fresh.total.ticks} ` +
      `линейно=${fresh.total.ticksLinear}`,
  );
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
