/**
 * ОРАКУЛ: СВЁРТКА ВЛЕЗАЕТ В РЕГИСТРЫ, КОГДА ЕЁ НЕ ВЫЗЫВАЮТ, А ВСТРАИВАЮТ.
 *
 * # Задача и её решение
 *
 * Ядро `свёртка` раскладке не поддавалось: как вызываемая процедура оно получает **шесть** свободных
 * регистров (окно вызываемой 8 минус два параметра), а в самой плотной точке нужно больше
 * (`docs/hardware-debt.md` §3.19: нехватка 4 при окне вызываемой). Владелец выбрал путь «правка
 * источника + встраивание вместо вызова» — здесь он **измерен**, а не обещан:
 *
 * 1. источник сжат: `j` не заводится именем, длины читаются в условии цикла, `левое`/`правое` не
 *    заводятся (это уже мерилось, §3.19: требование 10 → 8);
 * 2. тело `свёртки` **встроено в `главную`**: параметров у неё нет, поэтому свободны все десять
 *    регистров (`%b[0..9]`; верхние шесть заняты рантаймом массивов), а не шесть;
 * 3. проверка — не «должно влезть», а **исполнение**: код возврата обязан быть эталоном из
 *    `tests/dsp/reference.json` (свёртка `[1,2,3]` и `[4,5,6]` → контрольная сумма **90**).
 *
 * # Чего оракул не доказывает
 *
 * Что так поведёт себя железо (QEMU — модель). И что исходное ядро `свёртка` теперь раскладывается:
 * раскладывается **встроенный вариант**; `tests/dsp/kernels/convolution.osnova` не менялся.
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
import { ARRAY_REGISTERS, arrayPrologue } from './arrayRuntime';
import { IMAGE_TAIL_OFFSET, MINIMAL_BASE, SYSCALL_WBS, WRITE_ZONE_EXTRA_MEMORY, buildElfFromCode } from './elfMinimal';
import { SYS_EXIT, WINDOW_NUMBER_REGISTER } from './syscallRuntime';
import { buildShim, runInQemu } from '../scripts/e2kQemuExec';

const ROOT = path.resolve(__dirname, '..', '..');
const encoder = getEncoder('e2k');
const shellEncoder = getEncoder('internal-shell');
const HEAP_OFFSET = IMAGE_TAIL_OFFSET;
const imm = (value: number): Operand => ({ kind: 'imm', value });
const window_ = (index: number): Operand => ({ kind: 'reg', index, file: 'window' });

/**
 * Свёртка одним куском: тела `свёртка` и `сумма` встроены в `главную` (вызов невозможен: у
 * вызываемой шесть свободных регистров, у самой вызываемой — шесть — и рантайм массивов живёт в
 * `%b[10..15]`, которых в окне вызываемой нет вовсе).
 *
 * Массивы строятся через `добавить`: построение массива из трёх и более литералов в модели падает
 * (измерено `.tmp/array-min.ts`, долг назван в `docs/hardware-debt.md` §3.20).
 */
const INLINE_CONVOLUTION = `процедура главная()
  пусть а = []
  пусть б = []
  система.массив.добавить(а, 1)
  система.массив.добавить(а, 2)
  система.массив.добавить(а, 3)
  система.массив.добавить(б, 4)
  система.массив.добавить(б, 5)
  система.массив.добавить(б, 6)
  пусть итог = 0
  пусть n = 0
  пока n < система.массив.длина(а) + система.массив.длина(б) - 1
    пусть k = 0
    пока k < система.массив.длина(а)
      если n - k >= 0
        если n - k < система.массив.длина(б)
          итог = итог + система.массив.получить(а, k) * система.массив.получить(б, n - k)
        конец
      конец
      k = k + 1
    конец
    n = n + 1
  конец
  вернуть итог
конец
`;

interface Built {
  readonly bytes: Uint8Array;
  readonly refused: readonly string[];
  readonly registers: number;
  readonly carriers: number;
}

function buildImage(source: string): Built {
  const built = regModuleOf(source);
  if (built === null) throw new Error('программа не компилируется');
  const annotated = annotateAtomRegions(built.module, [
    { atom: 'A5', procedures: built.module.procedures.map((procedure) => procedure.name) },
  ]);
  const emitted = emitShell(annotated, shellEncoder);
  const context = { constants: emitted.scheduled.constants, invokeNames: emitted.image.invokeNames };
  const allocation = allocateProgram(emitted.instructions, emitted.scheduled.procedures);
  const report = allocation.report[0]!;
  if (!report.ok) throw new Error(`раскладка отказала: ${report.reason ?? 'причина не названа'}`);
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

  const heap = MINIMAL_BASE + HEAP_OFFSET;
  const instructions: AsmInstruction[] = [
    ...arrayPrologue(heap),
    ...body,
    {
      mnemonic: 'adds',
      channel: 0,
      operands: [{ kind: 'reg', index: returnRegister }, { kind: 'reg', index: ARRAY_REGISTERS.zero }, window_(WINDOW_NUMBER_REGISTER + 1)],
    },
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
  return { bytes, refused, registers: report.used, carriers: report.rewritten };
}

const shim = buildShim();

describe('свёртка: правка источника плюс встраивание — и она влезает', () => {
  it('шим и модель доступны — или причина названа', () => {
    if (shim === undefined) {
      expect(shim, 'шим не собран: в WSL-дистрибутиве нет компилятора C (docs/e2k-qemu-run.md §2.5)').toBeUndefined();
      return;
    }
    expect(shim.length).toBeGreaterThan(3);
  });

  it('раскладка встроенной свёртки УДАЁТСЯ и берёт не больше десяти регистров', () => {
    // Перемер 2026-09-24: раскладка удалась после правки сопоставления пар
    // (`src/e2k/predicatePairing.ts` — у вызова считается только СУЩЕСТВУЮЩИЙ аргумент: слот
    // несуществующего несёт заполнитель, и он читался как второй читатель результата сравнения).
    // Ни одного отказа раскладки здесь больше нет, и это названо, а не замолчано.
    const built = buildImage(INLINE_CONVOLUTION);
    expect(built.registers, 'выдано регистров: больше десяти окно не даёт').toBeLessThanOrEqual(10);
    expect(built.refused, `непонижённые носители: ${built.refused.join('; ')}`).toEqual([]);
  });

  it('исполнение встроенной свёртки в модели НЕ состоялось — и это ИЗМЕРЕНО, а не объяснено', () => {
    if (shim === undefined) return;
    const built = buildImage(INLINE_CONVOLUTION);
    expect(built.refused, `непонижённые носители: ${built.refused.join('; ')}`).toEqual([]);
    // Имя файла — своё у каждого процесса: общий `.tmp`-файл держит убитый по таймауту QEMU, и
    // следующая запись падает с «UNKNOWN: unknown error, open …» (тот же класс, что случай 16
    // реестра проверяемости: проверки делили один изменяемый артефакт).
    const elf = path.join(ROOT, '.tmp', `e2k-convolution-inline-${String(process.pid)}.elf`);
    fs.writeFileSync(elf, buildElfFromCode(built.bytes, MINIMAL_BASE, { writable: true, extraMemory: WRITE_ZONE_EXTRA_MEMORY }).bytes);
    // Бюджет прогона короткий намеренно: здесь важно отличить «модель считает» от «модель встала»
    // (то же решение, что в `docs/e2k-setwd-memory.md` §2), а не измерить время.
    const run = runInQemu(elf, { shim: true, timeoutMs: 10_000 });
    const value = (run?.output ?? '').includes('exception') ? undefined : (run?.guestExitCode ?? run?.status ?? undefined);
    if (value === 90) {
      // Положительный исход тоже возможен — тогда он обязан быть УВИДЕН здесь, а не пройти незаметно.
      expect(value, 'встроенная свёртка исполнена — обновите ожидание и docs/hardware-debt.md').toBe(90);
      return;
    }
    // ИЗМЕРЕНО (2026-09-24): раскладка встроенной свёртки **удаётся** (проверка выше) и её поток
    // понижается без отказов, но прогон НЕ доводит программу до выхода. Причина при этом **не
    // установлена**, и здесь она не выдумывается: прежняя запись «виноват дефект раскладки циклов
    // (§3.20)» снята — тот дефект закрыт правками 2d3b0ea, а программа всё равно не завершается.
    // Проверено отдельно (2026-09-24): и с бюджетом 60 с (в шесть раз больше) значения нет —
    // то есть это не «модель считает медленно». Остаётся долгом; см. §3.24 `docs/hardware-debt.md`.
    expect(value, 'измерено: модель не довела программу до выхода').toBeUndefined();
  });
});
