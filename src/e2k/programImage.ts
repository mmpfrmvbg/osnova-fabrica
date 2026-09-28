/**
 * ОДИН КОНВЕЙЕР ОБРАЗА: носители → байты программы для цели e2k.
 *
 * # Зачем модуль
 *
 * До него конвейер жил ДВУМЯ копиями: в оракуле цели (`e2kArraysQemu.test.ts`) и в обвязке
 * корпуса (`src/scripts/e2kProgramRun.ts`). Копии уже расходились однажды — и породили класс 3
 * (обвязка выбирала одну точку возврата из нескольких). Два пути сборки без сверки — тот же
 * дефект, что «два пути сборки» в компиляторе.
 *
 * # Что внутри
 *
 * Два потока, и оба нужны:
 *
 * | поток | когда | чем отличается |
 * |---|---|---|
 * | {@link programBytes} | программы БЕЗ циклов | носители оболочки → понижение → пролог рантайма массивов → `exit` |
 * | {@link loweredProgram} | программы с циклами и массивами | плюс раскладка регистров, раскладка адресов и пары предикатов — без них у переходов нет смещений |
 *
 * Код перенесён из `src/e2k/e2kArraysQemu.test.ts` **посимвольно**: смысл выноса — один путь,
 * а не другой путь. Закреплённые числа (FIR = 181 и прочие) держатся оракулами цели.
 */
import { getEncoder, type AsmInstruction, type Operand } from './backend';
import { emitShell } from './emitterShell';
import { annotateAtomRegions } from '../compiler/atomRegions';
import { regModuleOf } from '../vliw/regOracle';
import { lowerCarrier } from './e2kRealRun';
import { ARRAY_REGISTERS, arrayPrologue } from './arrayRuntime';
import { allocateProgram } from './regAlloc';
import { layoutOf, secondPass } from './twoPassLayout';
import { pairPredicates } from './predicatePairing';
import { IMAGE_TEXT_OFFSET, MINIMAL_BASE, SYSCALL_WBS } from './elfMinimal';
import { SYS_EXIT, WINDOW_NUMBER_REGISTER } from './syscallRuntime';
import { defUseOf } from './liveness';
import { cfgLiveSets } from '../vliw/cfg';
import { exitPrimitives, printAreaOf } from './printPrimitives';
import {
  PRINT_CALL,
  PrintCallRefusal,
  isPrintCarrier,
  planPrintSite,
  printArgumentOf,
  printSiteInstructions,
  withPrintSaveCount,
  type PrintSitePlan,
} from './printCall';

const encoder = getEncoder('e2k');
const shellEncoder = getEncoder('internal-shell');

/** Куча — отдельная страница: запись в страницу кода даёт ACCERR (см. `e2kMemoryQemu.test.ts`). */
export const HEAP_OFFSET = 0x2000;

/**
 * НОСИТЕЛИ ОБОЛОЧКИ — общий первый шаг обоих потоков.
 *
 * Вынесен отдельно, потому что на него смотрят ДВЕ вещи: сборка образа и подсчёт
 * возвратов со значением (`IR.ret` с флагом). Считать возвраты по тексту программы нельзя:
 * «вернуть» может быть записан по-разному, а носитель один и тот же.
 */
export function shellCarriers(source: string): readonly AsmInstruction[] {
  const built = regModuleOf(source);
  if (built === null) throw new Error('программа не компилируется');
  const annotated = annotateAtomRegions(built.module, [
    { atom: 'A5', procedures: built.module.procedures.map((procedure) => procedure.name) },
  ]);
  return emitShell(annotated, shellEncoder).instructions;
}

/** Сколько возвратов со значением: у `IR.ret` операнды `[есть значение, регистр]`. */
export function valueReturnsOf(source: string): number {
  return shellCarriers(source).filter((carrier) => {
    if (carrier.mnemonic !== 'IR.ret') return false;
    const flag = carrier.operands[0];
    return flag?.kind === 'imm' && flag.value === 1;
  }).length;
}

/**
 * САЙТЫ ПЕЧАТИ: план на каждый печатающий носитель — кого сохранить, чем адресовать, что печатать.
 *
 * План считается **до раскладки** и по ней же: длину сайта раскладка обязана знать заранее
 * (`src/e2k/printCall.ts`), иначе смещение перехода, пересекающего печать, считается по нулю.
 * Живость берётся по графу потока управления — тем же анализатором, что у раскладки регистров
 * (`src/e2k/liveness.ts` + `src/vliw/cfg.ts`), и на том же потоке: носители здесь уже несут
 * **физические** регистры (их выдала `allocateProgram`).
 */
function planPrintSites(
  code: readonly AsmInstruction[],
  invokeNames: readonly string[],
  heapAddress: number,
  spilledAddresses: readonly number[],
): ReadonlyMap<number, PrintSitePlan> {
  const indexes = code
    .map((carrier, index) => (isPrintCarrier(carrier, invokeNames) ? index : -1))
    .filter((index) => index >= 0);
  if (indexes.length === 0) return new Map();
  const liveOut = cfgLiveSets(code, { defUse: defUseOf }).liveOut;
  const plans = new Map<number, PrintSitePlan>();
  for (const index of indexes) {
    const carrier = code[index]!;
    const argument = printArgumentOf(carrier);
    if (argument === undefined) {
      throw new PrintCallRefusal(
        `#${String(index)} «${PRINT_CALL}»: значение не в регистре — развёртка печати берёт его из регистра`,
      );
    }
    plans.set(
      index,
      planPrintSite({
        argument,
        heapAddress,
        liveAfter: liveOut[index] ?? [],
        occupied: spilledAddresses,
      }),
    );
  }
  return plans;
}
const imm = (value: number): Operand => ({ kind: 'imm', value });
const base = (index: number): Operand => ({ kind: 'reg', index });
const window_ = (index: number): Operand => ({ kind: 'reg', index, file: 'window' });

/**
 * Собрать образ: `setbn` → пролог рантайма массивов → понижённые носители → `exit(<результат>)`.
 *
 * `IR.ret` в понижении **не участвует** (возврата процедуры в e2k-бэкенде ещё нет): его регистр
 * читается, и значение уходит в код возврата `exit` — так результат виден снаружи. Отсюда
 * ограничение: обход верен только при ОДНОМ возврате со значением.
 *
 * Возврата со значением может **не быть вовсе** — у печатающей программы результат наружу отдаёт
 * `write`, а не код возврата. Тогда последовательность выхода не добавляется: программу завершает
 * её собственный `exit` (`src/e2k/printRuntime.ts`), а общий `exit(<регистр>)` отдал бы наружу
 * значение несуществующего возврата. Это не послабление, а то же правило с другой стороны:
 * код возврата — ВЫРАЖЕНИЕ возврата, и без возврата его нет.
 */
export function programBytes(
  source: string,
  heapAddress: number,
): { bytes: Uint8Array; carriers: number; refused: string[] } {
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
  const instructions: AsmInstruction[] = [
    // Пролог сам ставит окно нужного размера (`ARRAY_WINDOW_RSZ`): без него верхние регистры
    // рантайма не адресуются — измерено (`.tmp/rsz-sweep.ts`).
    ...arrayPrologue(heapAddress),
    ...body,
    // Результат — в оконный r1 (код возврата `exit`): сложение с зарезервированным нулём.
    ...(returnRegister === undefined
      ? []
      : [
          {
            mnemonic: 'adds',
            channel: 0,
            operands: [base(returnRegister), base(ARRAY_REGISTERS.zero), window_(WINDOW_NUMBER_REGISTER + 1)],
          } satisfies AsmInstruction,
          { mnemonic: 'movts', channel: 0, operands: [imm(SYS_EXIT), window_(WINDOW_NUMBER_REGISTER)] },
          { mnemonic: 'sdisp', channel: 0, operands: [imm(1), imm(0)] },
          { mnemonic: 'call', channel: 0, operands: [imm(1), imm(SYSCALL_WBS)] },
        ]),
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
 * Полный конвейер (раскладка регистров, раскладка адресов, пары предикатов, понижение) — тот же,
 * что в `e2kConvolutionQemu.test.ts`. Нужен там, где в программе есть ЦИКЛЫ: без раскладки адресов
 * у переходов нет смещений.
 */
export function loweredProgram(source: string): { bytes: Uint8Array; refused: readonly string[]; used: number } {
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
    ...imageOfCarriers(allocation.instructions, emitted.scheduled.constants, emitted.image.invokeNames, {
      // Адреса слотов вытеснения — своим ходом: сайты печати кладут сохранённое в ВЕРХ области
      // слотов, и пересечение обязано быть названным отказом, а не порчей значения.
      spilledAddresses: allocation.report.flatMap((item) => item.spilled.map((spilled) => spilled.address)),
    }),
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
export function imageOfCarriers(
  code: readonly AsmInstruction[],
  constants: readonly unknown[],
  invokeNames: readonly string[],
  options: { readonly heapAddress?: number; readonly spilledAddresses?: readonly number[] } = {},
): { bytes: Uint8Array; refused: readonly string[] } {
  const context = { constants, invokeNames };
  const heapAddress = options.heapAddress ?? MINIMAL_BASE + HEAP_OFFSET;
  // ПЕЧАТЬ: план сайта — ДО раскладки, потому что её длину раскладка обязана знать (иначе
  // смещение перехода, пересекающего печать, считается по нулю — docs/hardware-debt.md §3.43).
  // Число сохраняемых регистров уезжает в сам носитель: другого канала к раскладке нет.
  const printPlans = planPrintSites(code, invokeNames, heapAddress, options.spilledAddresses ?? []);
  const planned =
    printPlans.size === 0
      ? code
      : code.map((carrier, index) => {
          const plan = printPlans.get(index);
          return plan === undefined ? carrier : withPrintSaveCount(carrier, plan.saved.length);
        });
  const layout = layoutOf(planned, { invokeNames, constants, heapAddress });
  const resolved = secondPass(planned, layout.addresses);
  const pairing = pairPredicates(planned);
  const predicateAt = new Map(
    pairing.pairs.map((pair) => [pair.comparisonIndex, { mnemonic: pair.cmpMnemonic, index: pair.predicate }]),
  );
  const conditionAt = new Map(pairing.pairs.map((pair) => [pair.jumpIndex, pair.condition]));
  const displacementAt = new Map(resolved.displacements.map((item) => [item.index, item.disp]));

  const body: AsmInstruction[] = [];
  const refused: string[] = [];
  let returnRegister: number | undefined;
  for (let index = 0; index < planned.length; index++) {
    const carrier = planned[index]!;
    const problem =
      layout.unplaced.find((item) => item.index === index) ??
      resolved.refusals.find((item) => item.index === index) ??
      pairing.refusals.find((item) => item.index === index);
    if (problem !== undefined) {
      refused.push(`#${index} ${carrier.mnemonic}: ${problem.reason}`);
      continue;
    }
    const plan = printPlans.get(index);
    if (plan !== undefined) {
      // Развёртка целиком: сохранение живых → число в текст и `write` → восстановление. Выхода
      // здесь НЕТ: печатающая программа завершается один раз в конце образа (§3.39, запись `43`
      // печатает в цикле).
      body.push(...printSiteInstructions(plan));
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

  const instructions: AsmInstruction[] = [
    ...arrayPrologue(heapAddress),
    ...body,
    // Выход по регистру возврата добавляется ТОЛЬКО тогда, когда возврат со значением в программе
    // есть (см. {@link programBytes}): без него программу завершает её собственный `exit`
    // (печатающая программа — `src/e2k/printRuntime.ts`).
    ...(returnRegister === undefined
      ? printPlans.size === 0
        ? []
        : // ПЕЧАТАЮЩАЯ программа без возврата значения: результат отдан `write`, и завершить её
          // обязан свой `exit(0)` — иначе поток уходит за свой код и падает кодом 134 (§3.39).
          exitPrimitives(0)
      : [
          {
            mnemonic: 'adds',
            channel: 0,
            operands: [base(returnRegister), base(ARRAY_REGISTERS.zero), window_(WINDOW_NUMBER_REGISTER + 1)],
          } satisfies AsmInstruction,
          { mnemonic: 'movts', channel: 0, operands: [imm(SYS_EXIT), window_(WINDOW_NUMBER_REGISTER)] },
          { mnemonic: 'sdisp', channel: 0, operands: [imm(1), imm(0)] },
          { mnemonic: 'call', channel: 0, operands: [imm(1), imm(SYSCALL_WBS)] },
        ]),
  ];

  const chunks = instructions.map((instruction) => encoder.encode(instruction));
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  // СТОРОЖ МЕСТА (§3.40.6): код не имеет права дорасти до площадки печати — иначе развёртка пишет
  // разряды поверх собственных команд, и это кончается отказом (измерено: три печати подряд,
  // 432 команды, код 139). Отказ называется ЧИСЛАМИ, а не «что-то пошло не так».
  if (printPlans.size > 0) {
    const codeEnd = MINIMAL_BASE + IMAGE_TEXT_OFFSET + bytes.length;
    const area = printAreaOf(heapAddress);
    if (codeEnd > area) {
      throw new PrintCallRefusal(
        `печать: код образа доходит до ${codeEnd.toString(16)}, а площадка печати стоит на ${area.toString(16)} ` +
          `(кода ${String(bytes.length)} байт) — развёртка писала бы разряды поверх своих команд. ` +
          'Место кончается: площадку нельзя двигать выше (там куча), а печатать в цикле — можно ' +
          '(docs/hardware-debt.md §3.40.6)',
      );
    }
  }
  return { bytes, refused };
}
