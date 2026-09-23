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
  const context = { constants: emitted.scheduled.constants, invokeNames: emitted.image.invokeNames };
  const allocation = allocateProgram(emitted.instructions, emitted.scheduled.procedures);
  const report = allocation.report[0]!;
  if (!report.ok) throw new Error(`раскладка отказала: ${report.reason ?? 'причина не названа'}`);
  const code = allocation.instructions;
  const layout = layoutOf(code, { invokeNames: emitted.image.invokeNames, constants: emitted.scheduled.constants });
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
  return { bytes, refused, used: report.used };
}

const shim = buildShim();

/**
 * ЗАМЕР: ДВА МАССИВА В ОДНОЙ ПРОГРАММЕ — БЛОКИ ПЕРЕКРЫВАЮТСЯ, И ЧТЕНИЕ ПЕРВОГО ВРЁТ.
 *
 * # Что измерено (2026-09-23, QEMU-e2k)
 *
 * `система.массив.создать` сдвигает указатель кучи на **одно слово** (заголовок длины), а
 * `система.массив.добавить` **не сдвигает его вовсе** (`src/e2k/arrayRuntime.ts:193-218`). Значит
 * блок ВТОРОГО массива ложится ровно на первый элемент ПЕРВОГО. Для `вход = [3,1,4,1,5,9,2,6]` и
 * `коэффициенты = [1,2,3,4]` память становится
 * `[8, 4,1,2,3,4, 9,2,6]`: слот 0 — длина входа, слот 1 — длина коэффициентов, слоты 2…5 — сами
 * коэффициенты, слоты 6…8 — уцелевший хвост входа.
 *
 * Отсюда измеренная карта `получить(вход, i)` при `i = 0…7`:
 * **`4, 1, 2, 3, 4, 9, 2, 6`** — то есть `[длина(коэффициенты), коэф[0..3], вход[5..7]]`.
 * Второй массив цел (его блок писали последним), поэтому `получить(коэффициенты, i)` верен.
 *
 * # Почему это важно для FIR
 *
 * FIR читает `вход[n-k]` при `n-k = 0…7`, то есть первые пять чтений врут. Эталон 181, а разница
 * считается поимённо: `(4−3)·1 + (2−4)·3 + (3−1)·4 + (4−5)·4 = +1 −6 +8 −4 = −4` — ровно измеренные
 * **177**. То есть остаток −4 после правки зависимостей по памяти (`docs/e2k-regalloc-debt.md` §9) —
 * не планировщик, а перекрытие блоков в куче.
 *
 * # Чего оракул не делает
 *
 * Не чинит рантайм: правка `добавить` меняет длину носителя `IR.invoke` (9 → 10 команд) и все
 * замороженные числа форм, поэтому решение владельца, а не побочный эффект замера.
 */
function twoArrayProgram(declarations: readonly string[], first: string, expression: string): string {
  return ['модуль ПробаКуча', 'процедура главная()', ...declarations, first, `  вернуть ${expression}`, 'конец'].join('\n');
}

const ВХОД = '  пусть вход = [3, 1, 4, 1, 5, 9, 2, 6]';
const КОЭФ = '  пусть коэффициенты = [1, 2, 3, 4]';

/** FIR целиком: две петли, один аккумулятор — источник, которым измерен эталон 181. */
const FIR = [
  'модуль ПробаFIR',
  'процедура главная()',
  ВХОД,
  КОЭФ,
  '  пусть итог = 0',
  '  пусть n = система.массив.длина(коэффициенты) - 1',
  '  пока n < система.массив.длина(вход)',
  '    пусть k = 0',
  '    пока k < система.массив.длина(коэффициенты)',
  '      итог = итог + система.массив.получить(вход, n - k) * система.массив.получить(коэффициенты, k)',
  '      k = k + 1',
  '    конец',
  '    n = n + 1',
  '  конец',
  '  вернуть итог',
  'конец',
].join('\n');

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

describe('два массива в куче: перекрытие блоков — замер, а не ожидание', () => {
  it('шим и модель доступны — или причина названа', () => {
    if (shim === undefined) {
      expect(shim, 'шим не собран: в WSL-дистрибутиве нет компилятора C (docs/e2k-qemu-run.md §2.5)').toBeUndefined();
      return;
    }
    expect(shim.length).toBeGreaterThan(3);
  });

  it('контроль: у ОДНОГО массива чтение верное на обоих концах (перекрытие требует второго)', () => {
    if (shim === undefined) return;
    const zero = exitOfLowered(twoArrayProgram([ВХОД], '', 'система.массив.получить(вход, 0)'), 'e2k-heap-one-0.elf');
    const three = exitOfLowered(twoArrayProgram([ВХОД], '', 'система.массив.получить(вход, 3)'), 'e2k-heap-one-3.elf');
    expect(zero, 'вход[0] при одном массиве').toBe(3);
    expect(three, 'вход[3] при одном массиве').toBe(1);
  });

  it('карта чтения первого массива при ДВУХ массивах — измеренная, а не ожидаемая', () => {
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
    // Если это покраснело — рантайм массивов починен (указатель кучи двигается на `добавить`):
    // тогда обновить §3.22 `docs/hardware-debt.md`, FIR должен стать 181, а не 177.
    expect(measured, 'карта получить(вход, 0…7): [длина(коэф), коэф[0..3], вход[5..7]]').toEqual([
      4, 1, 2, 3, 4, 9, 2, 6,
    ]);
  });

  it('второй массив цел: его элементы читаются верно', () => {
    if (shim === undefined) return;
    const first = exitOfLowered(twoArrayProgram([ВХОД, КОЭФ], '', 'система.массив.получить(коэффициенты, 0)'), 'e2k-heap-h0.elf');
    const last = exitOfLowered(twoArrayProgram([ВХОД, КОЭФ], '', 'система.массив.получить(коэффициенты, 3)'), 'e2k-heap-h3.elf');
    expect(first, 'коэф[0]').toBe(1);
    expect(last, 'коэф[3]').toBe(4);
  });

  it('FIR целиком: 177 при эталоне 181, и −4 названо по слагаемым', () => {
    if (shim === undefined) return;
    const code = exitOfLowered(FIR, 'e2k-heap-fir.elf');
    if (code === undefined) {
      expect(code, 'модель не довела FIR до выхода').toBeDefined();
      return;
    }
    // Слагаемые разницы при карте [4,1,2,3,4,…] против [3,1,4,1,5,…]:
    //   (4−3)·1 + (2−4)·3 + (3−1)·4 + (4−5)·4 = +1 −6 +8 −4 = −4.
    expect(code, 'FIR при перекрытии блоков: 181 − 4').toBe(177);
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
});
