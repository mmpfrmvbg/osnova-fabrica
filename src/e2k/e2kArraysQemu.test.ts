/**
 * ОРАКУЛ: МАССИВЫ РАБОТАЮТ В МОДЕЛИ БЕЗ `invoke`.
 *
 * # Что проверяется
 *
 * Программа на Основе с массивами (создать, добавить, получить) компилируется в регистровый IR,
 * эмиттится в носители оболочки, затем носители `IR.invoke` заменяются **настоящими** `ldd`/`std`
 * (`src/e2k/arrayRuntime.ts` через `lowerCarrier`), кодируются, собираются в ELF и **исполняются**
 * в QEMU. Код возврата — прочитанный из массива элемент.
 *
 * Различающий опыт: два элемента 5 и 7; читаем элемент с индексом 1 → **7**. Во втором опыте
 * порядок обратный (7, 5) → **5**. Одного опыта мало: совпадение могло быть случайным (значение
 * пришло не из памяти).
 *
 * Файл зависит от внешнего ресурса (`qemu-e2k` под шимом) и живёт в шлюзе `npm run gate:qemu`
 * (`docs/verification-debt.md`, случай 12).
 *
 * # Чего оракул НЕ доказывает
 *
 * Что так поведёт себя железо (QEMU — модель). И что массив живёт дольше процедуры: без `call`/`ret`
 * проверяется **одна** процедура (`главная`), куча — область в образе на отдельной странице.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { getEncoder, type AsmInstruction, type Operand } from './backend';
import { emitShell } from './emitterShell';
import { annotateAtomRegions } from '../compiler/atomRegions';
import { regModuleOf } from '../vliw/regOracle';
import { lowerCarrier } from './e2kRealRun';
import { ARRAY_REGISTERS, arrayPrologue } from './arrayRuntime';
import { allocateProgram } from './regAlloc';
import { layoutOf, secondPass } from './twoPassLayout';
import { pairPredicates } from './predicatePairing';
import { buildElfFromCode, MINIMAL_BASE, SYSCALL_WBS } from './elfMinimal';
import { SYS_EXIT, WINDOW_NUMBER_REGISTER } from './syscallRuntime';
import { buildShim, runInQemu } from '../scripts/e2kQemuExec';
import {
  FIR_REFERENCE_COEFFICIENTS,
  FIR_REFERENCE_INPUT,
  FIR_REFERENCE_SOURCE,
} from './firReference';

const ROOT = path.resolve(__dirname, '..', '..');
const encoder = getEncoder('e2k');
const shellEncoder = getEncoder('internal-shell');

/** Куча — отдельная страница: запись в страницу кода даёт ACCERR (см. `e2kMemoryQemu.test.ts`). */
const HEAP_OFFSET = 0x2000;

const imm = (value: number): Operand => ({ kind: 'imm', value });
const base = (index: number): Operand => ({ kind: 'reg', index });
const window_ = (index: number): Operand => ({ kind: 'reg', index, file: 'window' });

/** Программа на Основе: одна процедура, массивы, результат — элемент массива. */
function sourceOf(first: number, second: number): string {
  return [
    'модуль ПробаМассив',
    'процедура главная()',
    '  пусть a = []',
    `  система.массив.добавить(a, ${String(first)})`,
    `  система.массив.добавить(a, ${String(second)})`,
    '  пусть v = система.массив.получить(a, 1)',
    '  вернуть v',
    'конец',
  ].join('\n');
}

/**
 * Собрать образ: `setbn` → пролог рантайма массивов → понижённые носители → `exit(<результат>)`.
 *
 * `IR.ret` в понижении **не участвует** (возврата процедуры в e2k-бэкенде ещё нет): его регистр
 * читается, и значение уходит в код возврата `exit` — так результат виден снаружи.
 */
function programBytes(source: string, heapAddress: number): { bytes: Uint8Array; carriers: number; refused: string[] } {
  const built = regModuleOf(source);
  if (built === null) throw new Error('программа не компилируется');
  const annotated = annotateAtomRegions(built.module, [
    { atom: 'A5', procedures: built.module.procedures.map((procedure) => procedure.name) },
  ]);
  const emitted = emitShell(annotated, shellEncoder);
  const context = { constants: emitted.scheduled.constants, invokeNames: emitted.image.invokeNames };

  const body: AsmInstruction[] = [];
  const refused: string[] = [];
  let returnRegister: number | undefined;
  for (let index = 0; index < emitted.instructions.length; index++) {
    const carrier = emitted.instructions[index]!;
    if (carrier.mnemonic === 'IR.ret') {
      // У `IR.ret` операнды `[есть значение, регистр]` (`src/e2k/emitterShell.ts:273-278`).
      // Возвратов в коде ДВА (второй — «без значения»), поэтому берём только тот, где флаг стоит,
      // и только первый такой: иначе «регистром возврата» окажется служебный.
      const flag = carrier.operands[0];
      const value = carrier.operands[1];
      if (returnRegister === undefined && flag?.kind === 'imm' && flag.value === 1 && value?.kind === 'reg') {
        returnRegister = value.index;
      }
      continue;
    }
    const lowered = lowerCarrier(carrier, context);
    if (!lowered.ok) {
      refused.push(`${carrier.mnemonic}: ${lowered.reason}`);
      continue;
    }
    body.push(...lowered.instructions);
  }
  if (returnRegister === undefined) throw new Error('в программе нет возврата значения');

  const instructions: AsmInstruction[] = [
    // Пролог сам ставит окно нужного размера (`ARRAY_WINDOW_RSZ`): без него верхние регистры
    // рантайма не адресуются — измерено (`.tmp/rsz-sweep.ts`).
    ...arrayPrologue(heapAddress),
    ...body,
    // Результат — в оконный r1 (код возврата `exit`): сложение с зарезервированным нулём.
    {
      mnemonic: 'adds',
      channel: 0,
      operands: [base(returnRegister), base(ARRAY_REGISTERS.zero), window_(WINDOW_NUMBER_REGISTER + 1)],
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
  return { bytes, carriers: emitted.instructions.length, refused };
}

/**
 * Источник программы с массивом из ЛИТЕРАЛОВ. Служит оракулом к правке WAR-рёбер
 * (`src/vliw/regGraph.ts`): при трёх и более литералах планировщик выносил чтение длины над третьим
 * `добавить`, и рантайм читал память по адресу-длине (ловушка 0x100110 на команде #33, измерено
 * `docs/e2k-array-literals.md`). Два литерала работали и до правки — поэтому нужны оба случая.
 */
function literalSource(values: readonly number[]): string {
  return [
    'модуль ПробаМассивЛитералов',
    'процедура главная()',
    `  пусть a = [${values.join(', ')}]`,
    '  вернуть система.массив.длина(a)',
    'конец',
  ].join('\n');
}

function exitCodeOf(source: string, file: string): number | undefined {
  const heap = MINIMAL_BASE + HEAP_OFFSET;
  const { bytes, refused } = programBytes(source, heap);
  // Отказов быть не должно: единственный носитель, который не понижается, — `IR.ret`, он пропущен.
  expect(refused, `непонижённые носители: ${refused.join('; ')}`).toEqual([]);
  fs.writeFileSync(
    path.join(ROOT, '.tmp', file),
    buildElfFromCode(bytes, MINIMAL_BASE, { writable: true, extraMemory: HEAP_OFFSET }).bytes,
  );
  return runInQemu(path.join(ROOT, '.tmp', file), { shim: true })?.status;
}

/**
 * Полный конвейер (раскладка регистров, раскладка адресов, пары предикатов, понижение) — тот же,
 * что в `e2kConvolutionQemu.test.ts`. Нужен там, где в программе есть ЦИКЛЫ: без раскладки адресов
 * у переходов нет смещений.
 */
function loweredProgram(source: string): { bytes: Uint8Array; refused: readonly string[]; used: number } {
  const built = regModuleOf(source);
  if (built === null) throw new Error('программа не компилируется');
  const annotated = annotateAtomRegions(built.module, [
    { atom: 'A5', procedures: built.module.procedures.map((procedure) => procedure.name) },
  ]);
  const emitted = emitShell(annotated, shellEncoder);
  const allocation = allocateProgram(emitted.instructions, emitted.scheduled.procedures);
  const report = allocation.report[0]!;
  if (!report.ok) throw new Error(`раскладка отказала: ${report.reason ?? 'причина не названа'}`);
  return {
    ...imageOfCarriers(allocation.instructions, emitted.scheduled.constants, emitted.image.invokeNames),
    used: report.used,
  };
}

/**
 * Собрать образ из УЖЕ РАЗЛОЖЕННОГО потока носителей: раскладка адресов, пары «сравнение + переход»,
 * понижение, пролог рантайма массивов и выход через `exit`.
 *
 * Вынесено из {@link loweredProgram}, чтобы тем же путём можно было прогнать поток, собранный
 * ВРУЧНУЮ: у источника эмиттер вправе переставить чтения, и давление на регистры падает само
 * (измерено: программа с одиннадцатью чтениями массива даёт пик 5 и вытеснения не требует).
 */
function imageOfCarriers(
  code: readonly AsmInstruction[],
  constants: readonly unknown[],
  invokeNames: readonly string[],
): { bytes: Uint8Array; refused: readonly string[] } {
  const context = { constants, invokeNames };
  const layout = layoutOf(code, { invokeNames, constants });
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
    ...arrayPrologue(MINIMAL_BASE + HEAP_OFFSET),
    ...body,
    {
      mnemonic: 'adds',
      channel: 0,
      operands: [base(returnRegister), base(ARRAY_REGISTERS.zero), window_(WINDOW_NUMBER_REGISTER + 1)],
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
  return { bytes, refused };
}

const shim = buildShim();

/**
 * ЗАМЕР: ДВА МАССИВА В ОДНОЙ ПРОГРАММЕ — БЛОКИ НЕ ПЕРЕСЕКАЮТСЯ, FIR ДАЁТ 181.
 *
 * # Что было и что стало (QEMU-e2k)
 *
 * БЫЛО (до правки `src/e2k/arrayRuntime.ts`): `создать` сдвигал указатель кучи на слово заголовка,
 * а `добавить` — **не сдвигал вовсе**. Блок ВТОРОГО массива ложился на первый элемент ПЕРВОГО:
 * карта `получить(вход, i)` при i = 0…7 давала `[длина(коэф), коэф[0..3], вход[5..7]]` =
 * `4, 1, 2, 3, 4, 9, 2, 6`, и FIR давал **177** вместо 181. Слагаемые −4 считались поимённо:
 * `(4−3)·1 + (2−4)·3 + (3−1)·4 + (4−5)·4 = +1 −6 +8 −4 = −4`.
 *
 * СТАЛО: `добавить` двигает указатель кучи на элемент (9 → 10 команд в понижении), карта
 * `получить(вход, i)` — **сам массив** `3, 1, 4, 1, 5, 9, 2, 6`, и FIR даёт эталонные **181**.
 *
 * # Чем это ловится, если правку снять
 *
 * `src/e2k/arrayHeap.test.ts` (модель команд, без QEMU) и сторож последовательности в
 * `src/e2k/e2kArrays.test.ts`; здесь — исполнение. Если снять сдвиг кучи, краснеют и карта, и FIR.
 *
 * # Чего оракул не делает
 *
 * Не проверяет железо: QEMU — модель. И не чинит ДРУГОЕ ограничение кучи: массивы, растущие
 * вперемежку (`создать(a); создать(b); добавить(a, …); добавить(b, …)`), по-прежнему делят одну
 * кучу — это замерено в `src/e2k/arrayHeap.test.ts` отдельной проверкой.
 */
function twoArrayProgram(declarations: readonly string[], first: string, expression: string): string {
  return ['модуль ПробаКуча', 'процедура главная()', ...declarations, first, `  вернуть ${expression}`, 'конец'].join('\n');
}

const ВХОД = FIR_REFERENCE_INPUT;
const КОЭФ = FIR_REFERENCE_COEFFICIENTS;

/**
 * FIR целиком: две петли, один аккумулятор — источник, которым измерен эталон 181.
 *
 * Вынесен в `src/e2k/firReference.ts`: на тот же текст смотрит оракул вытеснения
 * (`src/vliw/spill.test.ts`) — «эталонный источник вытеснения не получает».
 */
const FIR = FIR_REFERENCE_SOURCE;

function exitOfLowered(source: string, file: string): number | undefined {
  const { bytes, refused, used } = loweredProgram(source);
  expect(refused, `непонижённые носители: ${refused.join('; ')}`).toEqual([]);
  expect(used, 'выдано регистров').toBeLessThanOrEqual(10);
  fs.writeFileSync(
    path.join(ROOT, '.tmp', file),
    buildElfFromCode(bytes, MINIMAL_BASE, { writable: true, extraMemory: HEAP_OFFSET }).bytes,
  );
  return runInQemu(path.join(ROOT, '.tmp', file), { shim: true, timeoutMs: 20_000 })?.status;
}

describe('два массива в куче: блоки не пересекаются, FIR = 181', () => {
  it('шим и модель доступны — или причина названа', () => {
    if (shim === undefined) {
      expect(shim, 'шим не собран: в WSL-дистрибутиве нет компилятора C (docs/e2k-qemu-run.md §2.5)').toBeUndefined();
      return;
    }
    expect(shim.length).toBeGreaterThan(3);
  });

  it('контроль: у ОДНОГО массива чтение верное на обоих концах', () => {
    if (shim === undefined) return;
    const zero = exitOfLowered(twoArrayProgram([ВХОД], '', 'система.массив.получить(вход, 0)'), 'e2k-heap-one-0.elf');
    const three = exitOfLowered(twoArrayProgram([ВХОД], '', 'система.массив.получить(вход, 3)'), 'e2k-heap-one-3.elf');
    expect(zero, 'вход[0] при одном массиве').toBe(3);
    expect(three, 'вход[3] при одном массиве').toBe(1);
  });

  it('при ДВУХ массивах карта чтения первого равна самому массиву', () => {
    if (shim === undefined) return;
    const measured: number[] = [];
    for (let index = 0; index < 8; index++) {
      const code = exitOfLowered(
        twoArrayProgram([ВХОД, КОЭФ], '', `система.массив.получить(вход, ${String(index)})`),
        `e2k-heap-two-${String(index)}.elf`,
      );
      if (code === undefined) {
        expect(code, 'модель не довела программу до выхода').toBeDefined();
        return;
      }
      measured.push(code);
    }
    // Было (перекрытие блоков): 4, 1, 2, 3, 4, 9, 2, 6. Стало — сам `вход`.
    expect(measured, 'карта получить(вход, 0…7) при двух массивах').toEqual([3, 1, 4, 1, 5, 9, 2, 6]);
  });

  it('второй массив цел: его элементы читаются верно', () => {
    if (shim === undefined) return;
    const first = exitOfLowered(twoArrayProgram([ВХОД, КОЭФ], '', 'система.массив.получить(коэффициенты, 0)'), 'e2k-heap-h0.elf');
    const last = exitOfLowered(twoArrayProgram([ВХОД, КОЭФ], '', 'система.массив.получить(коэффициенты, 3)'), 'e2k-heap-h3.elf');
    expect(first, 'коэф[0]').toBe(1);
    expect(last, 'коэф[3]').toBe(4);
  });

  it('FIR целиком: 181 — эталон tests/dsp/reference.json', () => {
    if (shim === undefined) return;
    const code = exitOfLowered(FIR, 'e2k-heap-fir.elf');
    if (code === undefined) {
      expect(code, 'модель не довела FIR до выхода').toBeDefined();
      return;
    }
    // До правки кучи здесь было 177, и −4 считалось по слагаемым
    // ((4−3)·1 + (2−4)·3 + (3−1)·4 + (4−5)·4): чтения `вход[n-k]` шли из чужого блока.
    expect(code, 'FIR при непересекающихся блоках').toBe(181);
  });
});

describe('массивы в модели: настоящие обращения вместо invoke', () => {
  it('шим и модель доступны — или причина названа', () => {
    if (shim === undefined) {
      expect(shim, 'шим не собран: в WSL-дистрибутиве нет компилятора C (docs/e2k-qemu-run.md §2.5)').toBeUndefined();
      return;
    }
    expect(shim.length).toBeGreaterThan(3);
  });

  it('различающий опыт: элементы 5 и 7 — читаем индекс 1 и получаем 7', () => {
    if (shim === undefined) return;
    const code = exitCodeOf(sourceOf(5, 7), 'e2k-array-57.elf');
    if (code === undefined) {
      expect(code, 'QEMU не запустился — причина названа в оракуле прогона (e2kQemuExec.test.ts)').toBeDefined();
      return;
    }
    expect(code, 'второй добавленный элемент (7)').toBe(7);
  });

  it('порядок другой — и результат другой: элементы 7 и 5 дают 5', () => {
    if (shim === undefined) return;
    const code = exitCodeOf(sourceOf(7, 5), 'e2k-array-75.elf');
    if (code === undefined) {
      expect(code, 'QEMU не запустился').toBeDefined();
      return;
    }
    expect(code, 'второй добавленный элемент (5) — значит порядок взят из памяти, а не из литерала').toBe(5);
  });

  it('массив из ТРЁХ литералов строится: длина = 3', () => {
    if (shim === undefined) return;
    // До правки WAR-рёбер (`src/vliw/regGraph.ts`) здесь была ловушка 0x100110 на команде #33:
    // планировщик выносил чтение длины над третьим `добавить`, и рантайм читал память по адресу-длине
    // (измерено `docs/e2k-array-literals.md`). Два литерала проходили и прежде — исход различающий.
    const code = exitCodeOf(literalSource([1, 2, 3]), 'e2k-array-literal-3.elf');
    if (code === undefined) {
      expect(code, 'модель не довела программу до выхода (до правки здесь была ловушка)').toBeDefined();
      return;
    }
    expect(code, 'длина массива из трёх литералов').toBe(3);
  });

  it('массив из ЧЕТЫРЁХ литералов строится: длина = 4', () => {
    if (shim === undefined) return;
    const code = exitCodeOf(literalSource([1, 2, 3, 4]), 'e2k-array-literal-4.elf');
    if (code === undefined) {
      expect(code, 'модель не довела программу до выхода').toBeDefined();
      return;
    }
    expect(code, 'длина массива из четырёх литералов').toBe(4);
  });

  it('ВЫТЕСНЕНИЕ В ПАМЯТЬ исполняется: одиннадцать живых значений дают верное число', () => {
    if (shim === undefined) return;
    // Поток собирается ВРУЧНУЮ, и это не прихоть: у источника эмиттер вправе переставить чтения, и
    // давление падает само — измерено (`.tmp/spill-program-check.ts`), программа с одиннадцатью
    // чтениями массива даёт пик 5 и вытеснения не требует. Здесь одиннадцать значений определены
    // подряд и все читаются в конце, то есть живы ОДНОВРЕМЕННО, а свободных регистров у процедуры без
    // параметров десять (`%b[0..9]`; `%b[10..15]` держит рантайм массивов). Раскладка обязана
    // вытеснить одно значение в слот и подгружать его перед чтением (`src/vliw/spill.ts`), а сумма
    // обязана остаться верной: 1 + 2 + … + 11 = 66.
    const constants = Array.from({ length: 11 }, (_, index) => index + 1);
    const program: AsmInstruction[] = constants.map((_, index) => ({
      mnemonic: 'IR.const',
      channel: 0,
      operands: [base(index), imm(index), imm(0)],
    }));
    let sum = 0;
    let next = constants.length;
    for (let index = 1; index < constants.length; index++) {
      program.push({ mnemonic: 'IR.add', channel: 0, operands: [base(next), base(sum), base(index)] });
      sum = next;
      next++;
    }
    program.push({ mnemonic: 'IR.ret', channel: 0, operands: [imm(1), base(sum)] });
    const allocation = allocateProgram(program, [{ name: 'главная', codeOffset: 0, vregs: next }]);
    const report = allocation.report[0]!;
    expect(report.ok, report.ok ? '' : `отказ: ${report.reason ?? ''}`).toBe(true);
    // Вытеснено два значения (не одно): линейный проход встаёт на первой точке нехватки, а не на
    // самой плотной, и второго регистра ему не хватает там же. Главное — что вытеснение есть и что
    // оно не больше разрешённого минимума.
    expect(report.spilled.length, 'вытеснено значений').toBeGreaterThanOrEqual(1);
    expect(report.spilled.length, 'вытеснений на процедуру').toBeLessThanOrEqual(2);
    const image = imageOfCarriers(allocation.instructions, constants, []);
    expect(image.refused, 'непонижённые носители: вытеснение обязано понижаться').toEqual([]);
    fs.writeFileSync(
      path.join(ROOT, '.tmp', 'e2k-spill.elf'),
      buildElfFromCode(image.bytes, MINIMAL_BASE, { writable: true, extraMemory: HEAP_OFFSET }).bytes,
    );
    const code = runInQemu(path.join(ROOT, '.tmp', 'e2k-spill.elf'), { shim: true })?.status;
    if (code === undefined) {
      expect(code, 'модель не довела программу с вытеснением до выхода').toBeDefined();
      return;
    }
    expect(code, 'сумма одиннадцати значений').toBe(66);
  });
});
