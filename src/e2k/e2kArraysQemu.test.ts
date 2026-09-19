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
function programBytes(first: number, second: number, heapAddress: number): { bytes: Uint8Array; carriers: number; refused: string[] } {
  const built = regModuleOf(sourceOf(first, second));
  if (built === null) throw new Error('программа с массивами не компилируется');
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

function exitCodeOf(first: number, second: number, file: string): number | undefined {
  const heap = MINIMAL_BASE + HEAP_OFFSET;
  const { bytes, refused } = programBytes(first, second, heap);
  // Отказов быть не должно: единственный носитель, который не понижается, — `IR.ret`, он пропущен.
  expect(refused, `непонижённые носители: ${refused.join('; ')}`).toEqual([]);
  fs.writeFileSync(
    path.join(ROOT, '.tmp', file),
    buildElfFromCode(bytes, MINIMAL_BASE, { writable: true, extraMemory: HEAP_OFFSET }).bytes,
  );
  return runInQemu(path.join(ROOT, '.tmp', file), { shim: true })?.status;
}

const shim = buildShim();

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
    const code = exitCodeOf(5, 7, 'e2k-array-57.elf');
    if (code === undefined) {
      expect(code, 'QEMU не запустился — причина названа в оракуле прогона (e2kQemuExec.test.ts)').toBeDefined();
      return;
    }
    expect(code, 'второй добавленный элемент (7)').toBe(7);
  });

  it('порядок другой — и результат другой: элементы 7 и 5 дают 5', () => {
    if (shim === undefined) return;
    const code = exitCodeOf(7, 5, 'e2k-array-75.elf');
    if (code === undefined) {
      expect(code, 'QEMU не запустился').toBeDefined();
      return;
    }
    expect(code, 'второй добавленный элемент (5) — значит порядок взят из памяти, а не из литерала').toBe(5);
  });
});
