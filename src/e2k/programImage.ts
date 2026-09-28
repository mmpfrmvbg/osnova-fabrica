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
import { layoutOf, secondPass, carrierFormOf } from './twoPassLayout';
import { pairPredicates } from './predicatePairing';
import { IMAGE_TEXT_OFFSET, MINIMAL_BASE, SYSCALL_WBS } from './elfMinimal';
import { SYS_EXIT, WINDOW_NUMBER_REGISTER } from './syscallRuntime';
import { defUseOf } from './liveness';
import { cfgLiveSets } from '../vliw/cfg';
import { exitPrimitives, printAreaOf } from './printPrimitives';
import { LOWERING_CODES, LoweringRefusalError, refusalOf, type LoweringRefusal } from './loweringRefusal';
import {
  callAddresses,
  entryProcedureIndex,
  prepareImage,
  procedureAt,
  type ProcedureOffset,
} from './procedureCall';
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
  return shellOf(source).instructions;
}

/**
 * Носители оболочки И РАСПИСАНИЕ ПРОЦЕДУР — для тех, кому нужны границы процедур.
 *
 * Границы нужны двум вопросам: где точка входа (первая команда какой процедуры) и где кончается
 * процедура (чтобы её выход не провалился в следующую). Один вызов эмиттера на оба — потому что
 * второй вызов дал бы второе расписание, а два расписания расходятся (правило «один конвейер»).
 */
function shellOf(source: string): { instructions: readonly AsmInstruction[]; procedures: readonly ProcedureOffset[] } {
  const built = regModuleOf(source);
  if (built === null) throw new Error('программа не компилируется');
  const annotated = annotateAtomRegions(built.module, [
    { atom: 'A5', procedures: built.module.procedures.map((procedure) => procedure.name) },
  ]);
  const emitted = emitShell(annotated, shellEncoder);
  return {
    instructions: emitted.instructions,
    procedures: emitted.scheduled.procedures.map((procedure) => ({
      name: procedure.name,
      codeOffset: procedure.codeOffset,
    })),
  };
}

/** Возврат со значением ли это: у `IR.ret` операнды `[есть значение, регистр]`. */
function isValueReturn(carrier: AsmInstruction): boolean {
  if (carrier.mnemonic !== 'IR.ret') return false;
  const flag = carrier.operands[0];
  return flag?.kind === 'imm' && flag.value === 1;
}

/** Сколько возвратов со значением: у `IR.ret` операнды `[есть значение, регистр]`. */
export function valueReturnsOf(source: string): number {
  return shellCarriers(source).filter(isValueReturn).length;
}

/**
 * Сколько возвратов со значением В ТОЧКЕ ВХОДА.
 *
 * Это и есть мера для `MultiReturnRefusal`: у вызываемой процедуры возврат — свой (`return %ctpr3`,
 * сколько угодно точек), а у точки входа результат уходит кодом возврата процесса, и там по-прежнему
 * верна ровно одна точка выхода на один прогон. Считать возвраты по всему модулю (как было) значило
 * бы отказывать программе за ранний возврат ВЫЗЫВАЕМОЙ процедуры — то есть за то, что теперь работает.
 */
export function entryValueReturnsOf(source: string): number {
  const shell = shellOf(source);
  const entry = shell.procedures[entryProcedureIndex(shell.procedures)];
  if (entry === undefined) return shell.instructions.filter(isValueReturn).length;
  const next =
    shell.procedures
      .map((procedure) => procedure.codeOffset)
      .filter((offset) => offset > entry.codeOffset)
      .sort((a, b) => a - b)[0] ?? shell.instructions.length;
  return shell.instructions.slice(entry.codeOffset, next).filter(isValueReturn).length;
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
 * ОКОННАЯ ФОРМА РЕГИСТРОВ для кода вызываемой процедуры.
 *
 * Измерено (`.tmp/osnova-call-enter.ts`, различающий опыт): в вызываемой процедуре та же команда
 * базовой формой (`%b[5]`) даёт исключение на первой же команде тела, а оконной (`%r5`) —
 * исполняется; кодирование различается одним битом (`05 …` против `85 …`). Поэтому весь код
 * вызываемой переводится в оконную форму ОДНИМ преобразованием, а не в каждой ветви понижения.
 *
 * Что не переводится: оконные регистры системных вызовов (`WINDOW_NUMBER_REGISTER` и соседи) уже
 * помечены, а вызываемой они и не нужны — системный вызов из неё невозможен (номер идёт в `%r8`,
 * которого у восьмирегистрового окна нет; измерено оракулом окна).
 */
function withWindowRegisters(instructions: readonly AsmInstruction[]): AsmInstruction[] {
  return instructions.map((instruction) => ({
    ...instruction,
    operands: instruction.operands.map((operand) =>
      operand.kind === 'reg' && operand.file === undefined ? { ...operand, file: 'window' as const } : operand,
    ),
  }));
}

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
): { bytes: Uint8Array; carriers: number; refused: LoweringRefusal[] } {
  const built = regModuleOf(source);
  if (built === null) throw new Error('программа не компилируется');
  const annotated = annotateAtomRegions(built.module, [
    { atom: 'A5', procedures: built.module.procedures.map((procedure) => procedure.name) },
  ]);
  const emitted = emitShell(annotated, shellEncoder);
  const context = { constants: emitted.scheduled.constants, invokeNames: emitted.image.invokeNames };

  const body: AsmInstruction[] = [];
  const refused: LoweringRefusal[] = [];
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
      // Код берётся у ПОНИЖЕНИЯ, а не выводится из текста: причина отказа — личность.
      refused.push(refusalOf(lowered.code, `${carrier.mnemonic}: ${lowered.reason}`));
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
export function loweredProgram(source: string): { bytes: Uint8Array; refused: readonly LoweringRefusal[]; used: number } {
  const built = regModuleOf(source);
  if (built === null) throw new Error('программа не компилируется');
  const annotated = annotateAtomRegions(built.module, [
    { atom: 'A5', procedures: built.module.procedures.map((procedure) => procedure.name) },
  ]);
  const emitted = emitShell(annotated, shellEncoder);
  const allocation = allocateProgram(emitted.instructions, emitted.scheduled.procedures);
  const report = allocation.report[0]!;
  if (!report.ok) {
    // Отказ раскладки — тот же контракт, но канал другой: образ не собирается вовсе, поэтому
    // это ИСКЛЮЧЕНИЕ с кодом `OSN-LOW-004`, а не запись в `refused` (личность одна — канал разный).
    throw new LoweringRefusalError(
      LOWERING_CODES.layout,
      `раскладка отказала: ${report.reason ?? 'причина не названа'}`,
    );
  }
  return {
    ...imageOfCarriers(allocation.instructions, emitted.scheduled.constants, emitted.image.invokeNames, {
      // Адреса слотов вытеснения — своим ходом: сайты печати кладут сохранённое в ВЕРХ области
      // слотов, и пересечение обязано быть названным отказом, а не порчей значения.
      spilledAddresses: allocation.report.flatMap((item) => item.spilled.map((spilled) => spilled.address)),
      // Смещения процедур ПОСЛЕ раскладки: снятие копий и вытеснение их двигают, а адрес вызова
      // считается по ним — тем же способом, что цель перехода (docs/hardware-debt.md §3.35).
      procedures: allocation.procedures.map((procedure) => ({
        name: procedure.name,
        codeOffset: procedure.codeOffset,
      })),
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
  options: {
    readonly heapAddress?: number;
    readonly spilledAddresses?: readonly number[];
    /**
     * Процедуры потока (`codeOffset` — индекс первого носителя процедуры) и их имена.
     *
     * Нужны ровно для двух вещей: куда вести исполнение (точка входа) и куда звать (`IR.call`).
     * Без них поток считается ОДНОЙ процедурой — как было до появления вызовов.
     */
    readonly procedures?: readonly ProcedureOffset[];
  } = {},
): { bytes: Uint8Array; refused: readonly LoweringRefusal[] } {
  const context = { constants, invokeNames };
  const heapAddress = options.heapAddress ?? MINIMAL_BASE + HEAP_OFFSET;
  // ПОДГОТОВКА ПОТОКА: возвраты точки входа убираются (их место — её `exit`), а если точка входа
  // стоит не первой, в начало встаёт переход к ней. Так раскладка видит РОВНО тот поток, который
  // соберётся: раньше она резервировала байты под неисполняемые возвраты, и адреса процедур за ними
  // уезжали (класс дефекта §3.35).
  const prepared = prepareImage(code, options.procedures ?? []);
  const plannedCode = prepared.code;
  const procedures = prepared.procedures;
  const entryAt = procedures.length === 0 ? 0 : entryProcedureIndex(procedures);
  // ПЕЧАТЬ: план сайта — ДО раскладки, потому что её длину раскладка обязана знать (иначе
  // смещение перехода, пересекающего печать, считается по нулю — docs/hardware-debt.md §3.43).
  // Число сохраняемых регистров уезжает в сам носитель: другого канала к раскладке нет.
  const printPlans = planPrintSites(plannedCode, invokeNames, heapAddress, options.spilledAddresses ?? []);
  const planned =
    printPlans.size === 0
      ? plannedCode
      : plannedCode.map((carrier, index) => {
          const plan = printPlans.get(index);
          return plan === undefined ? carrier : withPrintSaveCount(carrier, plan.saved.length);
        });
  // Возвраты, оставшиеся в потоке после подготовки, принадлежат ВЫЗЫВАЕМЫМ процедурам — значит
  // они ИСПОЛНЯЮТСЯ, и форма обязана считать пару (`procedureReturn`). Возвраты точки входа
  // помечены нулевыми (`zeroSize`): их место занимает её `exit`.
  const zeroSize = new Set(prepared.zeroSize);
  const layout = layoutOf(planned, {
    invokeNames,
    constants,
    heapAddress,
    procedureReturn: true,
    zeroSize: prepared.zeroSize,
  });
  const resolved = secondPass(planned, layout.addresses);
  const pairing = pairPredicates(planned);
  // ВЫЗОВ: адрес вызываемой известен только теперь — тем же механизмом, что цель перехода.
  const calls = callAddresses({
    code: planned,
    procedures,
    addresses: layout.addresses,
    dispOffsetOf: (index) => {
      const form = carrierFormOf(planned[index]!, { invokeNames, constants, heapAddress });
      if (form === undefined) return undefined;
      let offset = 0;
      for (const command of form.commands) {
        if (command.mnemonic === 'disp') return offset;
        offset += command.size;
      }
      return undefined;
    },
  });
  const callProblemAt = new Map(calls.problems.map((problem) => [problem.index, problem]));
  const predicateAt = new Map(
    pairing.pairs.map((pair) => [pair.comparisonIndex, { mnemonic: pair.cmpMnemonic, index: pair.predicate }]),
  );
  const conditionAt = new Map(pairing.pairs.map((pair) => [pair.jumpIndex, pair.condition]));
  const displacementAt = new Map(resolved.displacements.map((item) => [item.index, item.disp]));
  // Где кончается процедура точки входа: сразу за ней обязан стоять её ВЫХОД, иначе исполнение
  // провалится в следующую процедуру (раньше это было неважно — процедура была одна).
  const entryEndsAt = prepared.entryEndsAt;

  const body: AsmInstruction[] = [];
  const refused: LoweringRefusal[] = [];
  const returnRegister = prepared.entryReturnRegister;
  let entryExitEmitted = false;
  const entryExit = (): AsmInstruction[] =>
    returnRegister === undefined
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
        ];

  /**
   * ГРАНИЦЫ ВЫЗЫВАЕМОЙ ПРОЦЕДУРЫ, названные числом регистров.
   *
   * Окно вызываемой — восемь регистров (`call wbs = 4` уменьшает `size_q`; измерено
   * `src/e2k/e2kCallWindowQemu.test.ts`), и это отсекает три вещи, каждая — названный отказ,
   * а не тихая ловушка в модели:
   *
   * | что | почему нельзя |
   * |---|---|
   * | системный вызов (и печать: она делает `write`) | номер вызова идёт в `%r8`, которого у вызываемой нет |
   * | вложенный вызов | аргументы кладутся в `%r8` вызывающего — то есть в несуществующий `%r8` вызываемой |
   * | рантайм массивов и вытеснение | работают на `%b[10..15]`, а окно вызываемой кончается на `%b[7]` |
   */
  const calleeLimit = (carrier: AsmInstruction): { code: LoweringRefusal['code']; reason: string } | undefined => {
    const mnemonic = carrier.mnemonic;
    if (mnemonic === 'IR.call') {
      return {
        code: LOWERING_CODES.runtime,
        reason:
          'вызов из вызываемой процедуры невозможен: аргументы кладутся в %r8 вызывающего, а её окно — ' +
          'восемь регистров %r0..%r7 (измерено: src/e2k/e2kCallWindowQemu.test.ts). Рекурсия и взаимный ' +
          'вызов требуют окна шире; это решение о геометрии модели, а не о конвейере (docs/hardware-debt.md §3.45)',
      };
    }
    if (mnemonic === 'IR.invoke') {
      return {
        code: LOWERING_CODES.runtime,
        reason:
          'операция рантайма из вызываемой процедуры невозможна: рантайм массивов держит состояние в ' +
          '%b[12..15], а окно вызываемой — %b[0..7] (измерено: src/e2k/e2kCallWindowQemu.test.ts)',
      };
    }
    if (mnemonic === 'IR.spill_ld' || mnemonic === 'IR.spill_st') {
      return {
        code: LOWERING_CODES.layout,
        reason:
          'вытеснение в памяти из вызываемой процедуры невозможно: смещением слота служит %b[12], ' +
          'которого у восьмирегистрового окна вызываемой нет',
      };
    }
    return undefined;
  };

  for (let index = 0; index < planned.length; index++) {
    const carrier = planned[index]!;
    if (index === entryEndsAt && !entryExitEmitted) {
      body.push(...entryExit());
      entryExitEmitted = true;
    }
    // Источники отказа, и КОД у каждого свой — он и есть личность причины:
    //   1. носитель не размещён (`layout.unplaced`) — код у причины своя (нет формы / печать / контракт);
    //   2. переходу не хватило смещения (`secondPass`) — код ставит второй проход;
    //   3. вызову не хватило адреса цели (`callAddresses`) — свой код;
    //   4. пара предикатов не составилась (`pairPredicates`) — код у сопоставления.
    const inCallee = procedures.length > 0 && procedureAt(procedures, index) !== entryAt;
    const limit = inCallee ? calleeLimit(carrier) : undefined;
    const problem =
      limit ??
      layout.unplaced.find((item) => item.index === index) ??
      resolved.refusals.find((item) => item.index === index) ??
      callProblemAt.get(index) ??
      pairing.refusals.find((item) => item.index === index);
    if (problem !== undefined) {
      refused.push(refusalOf(problem.code, `#${index} ${carrier.mnemonic}: ${problem.reason}`));
      continue;
    }
    const plan = printPlans.get(index);
    if (plan !== undefined) {
      if (inCallee) {
        refused.push(
          refusalOf(
            LOWERING_CODES.print,
            `#${index} ${carrier.mnemonic}: печать из вызываемой процедуры невозможна — она делает системный вызов ` +
              '`write`, а номер вызова идёт в %r8, которого у восьмирегистрового окна вызываемой нет ' +
              '(измерено: src/e2k/e2kCallWindowQemu.test.ts)',
          ),
        );
        continue;
      }
      // Развёртка целиком: сохранение живых → число в текст и `write` → восстановление. Выхода
      // здесь НЕТ: печатающая программа завершается один раз в конце образа (§3.39, запись `43`
      // печатает в цикле).
      body.push(...printSiteInstructions(plan));
      continue;
    }
    if (carrier.mnemonic === 'IR.ret' && zeroSize.has(index)) {
      // Возврат точки входа: в образ не попадает, её выход — `exit(значение)` в конце процедуры.
      continue;
    }
    const callDisplacement = calls.displacements.get(index);
    const lowered = lowerCarrier(carrier, {
      ...context,
      ...(displacementAt.get(index) === undefined ? {} : { displacement: displacementAt.get(index)! }),
      ...(callDisplacement === undefined ? {} : { callDisplacement }),
      ...(predicateAt.get(index) === undefined ? {} : { predicate: predicateAt.get(index)! }),
      ...(conditionAt.get(index) === undefined ? {} : { condition: conditionAt.get(index)! }),
      // Возврат ИСПОЛНЯЕТСЯ только у вызываемой процедуры (возвраты точки входа убраны из потока
      // подготовкой), поэтому пара `return`+`ct` ставится там и только там.
      ...(inCallee ? { procedureReturn: true } : {}),
    });
    if (!lowered.ok) {
      refused.push(refusalOf(lowered.code, `#${index} ${carrier.mnemonic}: ${lowered.reason}`));
      continue;
    }
    // ОКОННАЯ ФОРМА РЕГИСТРОВ В ВЫЗЫВАЕМОЙ. Измерено (`.tmp/osnova-call-enter.ts`): в вызываемой
    // процедуре БАЗОВАЯ форма (`%b[N]`, без бита окна) даёт исключение на первой же команде тела,
    // тогда как та же команда оконной формой (`%rN`) исполняется. Поэтому весь код вызываемой
    // переводится в оконную форму одним преобразованием здесь, а не в каждой ветви понижения:
    // второй список мест разошёлся бы с первым (правило «один путь»).
    body.push(...(inCallee ? withWindowRegisters(lowered.instructions) : lowered.instructions));
  }
  if (!entryExitEmitted) body.push(...entryExit());

  const instructions: AsmInstruction[] = [...arrayPrologue(heapAddress), ...body];

  const chunks = instructions.map((instruction) => encoder.encode(instruction));
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  // СТОРОЖ МЕСТА (§3.40.6): код не имеет права дорасти до площадки печати — иначе развёртка пишет
  // разряды поверх собственных команд. ГДЕ начинается код — ИЗМЕРЕНО, и это `MINIMAL_BASE + 0x1000`
  // (`IMAGE_TEXT_OFFSET`): три печати подряд дают `SIGSEGV {code=ACCERR, addr=0x101ec5}`, то есть
  // площадка печати лежит В СТРАНИЦЕ КОДА (`.tmp/osnova-three-fault.ts`). Тот же сдвиг виден у
  // дизассемблера МЦСТ (§3.40.5) и у адреса ловушки порта: адреса порта и дизассемблера на 0x1000
  // НИЖЕ настоящих адресов кода — это несогласованность заголовков ELF, а не наша арифметика.
  if (printPlans.size > 0) {
    const codeEnd = MINIMAL_BASE + IMAGE_TEXT_OFFSET + bytes.length;
    const area = printAreaOf(heapAddress);
    if (codeEnd > area) {
      throw new PrintCallRefusal(
        `печать: код образа доходит до ${codeEnd.toString(16)}, а площадка печати стоит на ${area.toString(16)} ` +
          `(кода ${String(bytes.length)} байт) — ` +
          'развёртка писала бы разряды поверх своих команд. Место кончается: площадку нельзя двигать выше ' +
          '(там куча), а печатать в цикле — можно (docs/hardware-debt.md §3.40.6)',
      );
    }
  }
  return { bytes, refused };
}
