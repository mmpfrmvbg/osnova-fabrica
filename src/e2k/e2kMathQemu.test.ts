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
import { runOnE2k } from '../scripts/e2kProgramRun';
import { RegVM } from '../runtime/vm/reginterpreter';
import { createDefaultInvokeHandler } from '../runtime/vm/interpreter';
import { resolveEntryIndex } from '../oracle/parity';
import { remainderInstructions } from './remainderRuntime';

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
  // Имя файла — своё у каждого процесса: общий `.tmp`-файл может держать убитый по таймауту QEMU,
  // и следующая запись упадёт с «UNKNOWN: unknown error, open …» (случай 16 реестра проверяемости:
  // проверки делили один изменяемый артефакт).
  const path0 = path.join(ROOT, '.tmp', `${file.replace(/\.elf$/, '')}-${String(process.pid)}.elf`);
  fs.writeFileSync(path0, buildElfFromCode(bytes, MINIMAL_BASE).bytes);
  const run = runInQemu(path0, { shim: true, timeoutMs: 20_000 });
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
        ['процедура главная()', `  вернуть система.математика.остаток(${String(first)}, ${String(second)})`, 'конец'].join('\n'),
        `e2k-math-mod-${String(first)}-${String(second)}.elf`,
      );
      expect(refused, `непонижённые носители: ${refused.join('; ')}`).toEqual([]);
      expect(code, `${String(first)} % ${String(second)}`).toBe(expected);
    }
  });

  it('отрицательное делимое: `-7 % 3` даёт 0, а не −1 — причина названа, а не замолчана', () => {
    if (shim === undefined) return;
    const source = [
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

/**
 * ОПЕРАТОР `%` ЯЗЫКА — ДРУГОЙ ПУТЬ, ЧЕМ `система.математика.остаток`.
 *
 * Их легко перепутать, и путаница стоила бы дорого, поэтому различие названо здесь:
 *
 * | путь | носитель | понижение | знак отрицательного |
 * |---|---|---|---|
 * | `%` языка | `IR.rem` | **серия** `sdivs` + `muls` + `subs` (`src/e2k/remainderRuntime.ts`) | **верный**: знак делимого |
 * | `система.математика.остаток` | вызов рантайма | `SMODX` | свой дефект знака (§3.21), **не трогается** |
 *
 * Оракул написан ДО правки (§2.1) и был красным: `.tmp/osnova-rem-state.ts` показал на всех шести
 * пробах НАЗВАННЫЙ отказ «формы понижения нет». Причина отказа стояла на посылке, которой нет:
 * обе VM (`reginterpreter`, `interpreter`) считают `a % b`, то есть остаток с отсечением к нулю, —
 * вещественного остатка не считает ни одна. Разбор — `docs/hardware-debt.md` §3.97.
 *
 * ЭТАЛОН СЧИТАЕТ РЕГИСТРОВАЯ VM, а не число из головы, и сравнивается он с ответом модели ЧЕРЕЗ
 * 8-БИТНЫЙ КАНАЛ: `-2` наблюдаемо как `254` (`-2 mod 256`) — это свойство канала возврата, названное
 * в `AGENTS.md`, а не расхождение счёта.
 */
describe('оператор % языка: остаток серией sdivs+muls+subs, знак делимого', () => {
  /** Эталон: то же, что считает язык, — регистровая VM. */
  async function эталонVM(source: string): Promise<number> {
    const built = regModuleOf(source);
    expect(built, 'программа обязана компилироваться').not.toBeNull();
    const entry = resolveEntryIndex(built!.module.procedures, undefined) ?? 0;
    const vm = new RegVM(built!.module, { invoke: createDefaultInvokeHandler(), maxSteps: 200_000 });
    return Number(await vm.runProcedure(entry, []));
  }

  const ПРОБЫ: readonly (readonly [string, string])[] = [
    ['17 % 5', 'вернуть 17 % 5'],
    ['20 % 5', 'вернуть 20 % 5'],
    ['7 % 10', 'вернуть 7 % 10'],
    ['100 % 7', 'вернуть 100 % 7'],
    ['знак делимого: (0 - 17) % 5', 'пусть а = 0 - 17\n  вернуть а % 5'],
    ['знак делимого: 17 % (0 - 5)', 'пусть б = 0 - 5\n  вернуть 17 % б'],
    // ДЛИННОЕ ВЫРАЖЕНИЕ — проба не «ещё один остаток», а ОРАКУЛ НА ДВА ДЕФЕКТА ПРАВКИ, и она
    // появилась потому, что негативный контроль показал: шести проб МАЛО.
    //   1) серия стоит ПЕРВОЙ, а после неё девять значений: временный регистр под частное
    //      (`%b[9]`) доходит до ЖИВОГО значения — сними резерв, и значение будет затёрто молча;
    //   2) всё, что стоит ПОСЛЕ серии, зависит от её длины: сломай форму (одна команда вместо
    //      трёх) — и адреса уедут. Замер: стол контроля, записи 14.1 и 14.2 (обе ловятся здесь).
    ['серия впереди девяти живых значений: (17 % 5) + 1 + … + 9', 'вернуть (17 % 5) + 1 + 2 + 3 + 4 + 5 + 6 + 7 + 8 + 9'],
    // ПЕРЕХОД ПОСЛЕ СЕРИИ — единственная проба, на которой видна ДЛИНА серии: адрес цели считает
    // раскладка, поэтому форма короче понижения уводит переход (запись контроля 14.1). Без этой
    // пробы шесть первых проб не различали сломанную форму: в прямой программе уехавший адрес
    // ни на что не влияет.
    // ВЫЗОВ ПОСЛЕ СЕРИИ — проба, на которой видна ДЛИНА серии. Цель вызова — АБСОЛЮТНЫЙ адрес
    // вызываемой, и она объявлена ПОСЛЕ точки входа, то есть лежит за серией: ошибка длины
    // (форма короче понижения) уводит её, и модель считает не то (запись контроля 14.1).
    // Прямой относительный переход ошибку длины не видит: обе его точки сдвигаются вместе.
    // Цикл здесь не годится по другой причине, и это тоже замер: форма `пока … конец` в этом
    // диалекте не компилируется вовсе (`.tmp/osnova-loop-form.ts`), независимо от остатка.
    [
      'вызов после серии: (17 % 5) + помощник(1)',
      'пусть а = 17 % 5\n  вернуть а + помощник(1)',
    ],
  ];

  for (const [имя, тело] of ПРОБЫ) {
    it(`${имя}: модель даёт то же, что регистровая VM`, async () => {
      if (shim === undefined) return;
      // Проба с вызовом несёт ВТОРУЮ процедуру — она и даёт абсолютную цель за серией.
      const хвост = тело.includes('помощник')
        ? '\nпроцедура помощник(н)\n  вернуть н + 39\nконец_процедуры\n'
        : '';
      const source = `процедура главная()\n  ${тело}\nконец_процедуры\n${хвост}`;
      const эталон = await эталонVM(source);
      const прогон = runOnE2k(source, `e2k-rem-${ПРОБЫ.findIndex((item) => item[0] === имя)}.elf`);
      expect(прогон.refused, `непонижённые носители: ${прогон.refused.map((item) => item.reason).join('; ')}`).toEqual([]);
      // Канал возврата — младший байт: отрицательное значение наблюдаемо как `значение mod 256`.
      const ожидание = ((эталон % 256) + 256) % 256;
      expect(прогон.status, `${имя}: эталон VM ${String(эталон)}`).toBe(ожидание);
    });
  }

  it('остаток НЕ трогает `SMODX`: путь `система.математика.остаток` остаётся своим', () => {
    // Проверка-разделитель: правка §3.97 не должна была «заодно починить» SMODX. Признак —
    // носители понижения: у оператора `%` их ТРИ на один носитель, и `smodx` среди них нет вовсе.
    const команды = remainderInstructions(2, 3, 4).map((item) => item.mnemonic);
    expect(команды, 'серия остатка').toEqual(['sdivs', 'muls', 'subs']);
    expect(команды, 'SMODX не участвует').not.toContain('smodx');
  });
});
