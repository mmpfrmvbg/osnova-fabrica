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
 * | `src/e2k/lowered.ts#loweredProgram` | программы с циклами и массивами | плюс раскладка регистров, раскладка адресов и пары предикатов — без них у переходов нет смещений |
 *
 * САМ `loweredProgram` живёт НЕ ЗДЕСЬ (с 5е, D11): публичная дверь — `src/e2k/lowered.ts`, а сырой путь,
 * который отдаёт байты и под отказом, — `src/e2k/guards/loweredUnchecked.ts#loweredProgramUnchecked`.
 * Здесь остались КИРПИЧИ этого пути (`{@link imageOfCarriers}`, кодировщики, помощники), и это не
 * вкусовщина: дверь обязана быть одна, а под отказом байты лгут, поэтому взять их можно только явно.
 *
 * Код перенесён из `src/e2k/e2kArraysQemu.test.ts` **посимвольно**: смысл выноса — один путь,
 * а не другой путь. Закреплённые числа (FIR = 181 и прочие) держатся оракулами цели.
 */
import { getEncoder, type AsmInstruction, type Operand } from './backend';
import { ШАГ_ДО_ПОТОКА } from './loweredTypes';
import { emitShell } from './emitterShell';
import { annotateAtomRegions } from '../compiler/atomRegions';
import {
  frontendRefusalMessage,
  isNumberType,
  isStringType,
  regModuleOrNamedFailure,
  type ProcedureTypeInfo,
} from './recordPlan';
import type { CompileOptions } from '../compiler/compiler';
import type { TypeRef } from '../compiler/ast';
import { lowerCarrier } from './e2kRealRun';
import {
  ARRAY_REGISTERS,
  ARRAY_SLOT_CARRIER,
  ARRAY_VALUES_CARRIER,
  CALLEE_ZERO_CARRIER,
  ENTRY_ARRAY_BASE,
  isArrayCreateCall,
  isArrayRuntimeCall,
  arrayBaseProblems,
  arrayPrologue,
  type ProcedureNumberFacts,
} from './arrayRuntime';
import { layoutOf, secondPass, carrierFormOf } from './twoPassLayout';
import { pairPredicates } from './predicatePairing';
import { MINIMAL_BASE, SYSCALL_TRAP, SYSCALL_WBS, WRITE_ZONE_EXTRA_MEMORY, IMAGE_TAIL_OFFSET, spillBaseOf } from './elfMinimal';
import {
  ENTRY_SYSCALL_FRAME,
  GROWN_SYSCALL_FRAME,
  SYS_EXIT,
  WINDOW_NUMBER_REGISTER,
  syscallCallClose,
  syscallCallOpen,
  type SyscallFrame,
} from './syscallRuntime';
import { defUseOf } from './liveness';
import { cfgLiveSets } from '../vliw/cfg';
import { exitPrimitives, printAreaOf } from './printPrimitives';
import { LOWERING_CODES, LoweringRefusalError, refusalOf, refusalWithSource, type LoweringRefusal } from './loweringRefusal';
import { STRING_MARK_OPERAND, isStringPrint, planStrings, staticBytesOf, stringMarksOf, type StringTypeFacts } from './stringPlan';
import { INNER_CALL_WBS, WINDOW_GROW_CARRIER } from './procedureCall';
import {
  ARENA_BASE,
  ARENA_FLAG_REGISTER,
  ARENA_REFUSAL_TEXT,
  arenaGroups,
  arenaRefusalCarriers,
  arenaReservedRegisters,
  usesArena,
} from './arenaRuntime';
import { STRING_CALLS, STRING_ARENA_CONCAT_CARRIER, STRING_ARENA_COPY_CARRIER, STRING_DESCRIPTOR_MARK, STRING_SLICE_CELLS, STRING_SLICE_DECLARED_CELLS, STRING_SLICE_DESTINATION_CELL, STRING_SLICE_RUNTIME_CARRIER, stringArenaCopyInstructions, stringSliceGroups, utf8Bytes, type StringSliceSiteRequest } from './stringRuntime';
import { proveStringValues } from './stringValueProof';
import {
  COLLECTION_REFUSAL_TEXTS,
  collectionGroups,
  collectionRefusalKinds,
  usesCollections,
  type CollectionRefusalKind,
} from './collectionsRuntime';
import {
  STRING_PRINT_CLOBBERS,
  resolveSliceRelativeTargets,
  stringConcatInstructions,
  stringLengthFromDescriptorInstructions,
  stringLengthInstructions,
  stringSymbolFromDescriptorInstructions,
  stringSymbolInstructions,
  stringWriteInstructions,
} from './stringRuntime';
import {
  ARENA_LIMIT_BASE,
  ARENA_POINTER_BASE,
  callAddresses,
  entryProcedureIndex,
  expandCarriers,
  prepareImage,
  procedureAt,
  type ProcedureOffset,
} from './procedureCall';
import {
  EXIT_CARRIER,
  PRINT_CALL,
  PRINT_TEXT_CARRIER,
  PRINT_WRITE_CARRIER,
  SHARED_PRINT_PROCEDURE,
  SHARED_SITE_CLOBBERS,
  PrintCallRefusal,
  exitCarrierInstructions,
  isPrintCarrier,
  planPrintSite,
  printArgumentOf,
  printSiteInstructions,
  printTextInstructions,
  printWriteInstructions,
  withPrintSaveCount,
  withPrintFrame,
  type PrintSitePlan,
} from './printCall';

const encoder = getEncoder('e2k');
export const shellEncoder = getEncoder('internal-shell');

/**
 * Куча — начало ХВОСТА ОБРАЗА, и величина берётся из `elfMinimal` (одно число, два имени).
 *
 * Смещение в 0x11000 (а не 0x2000) выбрано замером: вместе с кучей от него считаются слоты
 * вытеснения, площадка печати и сохранения сайтов, то есть **вся область записи**, и она обязана
 * лежать на странице, где нет кода (`docs/hardware-debt.md` §3.91, замер §3.90.7).
 */
export const HEAP_OFFSET = IMAGE_TAIL_OFFSET;

/**
 * РАЗМЕР СТРАНИЦЫ, которой модель защищает переведённый код, — 4096 байт.
 *
 * Не догадка: замер 2026-09-29 (`docs/hardware-debt.md` §3.90.7) — программа с концом кода
 * `0x1008d0` работает, а с `0x101480` и `0x101c60` падает `ACCERR` на записи в площадку печати
 * (`0x101ecb`). Обе границы лежат в одной странице `[0x101000, 0x102000)`, а первая — нет: значит
 * страница 4 КиБ, а не 16 и не 64.
 */
export const WRITE_PAGE_BYTES = 0x1000;

/**
 * НОСИТЕЛИ ОБОЛОЧКИ — общий первый шаг обоих потоков.
 *
 * Вынесен отдельно, потому что на него смотрят ДВЕ вещи: сборка образа и подсчёт
 * возвратов со значением (`IR.ret` с флагом). Считать возвраты по тексту программы нельзя:
 * «вернуть» может быть записан по-разному, а носитель один и тот же.
 */
export function shellCarriers(source: string, options: CompileOptions = {}): readonly AsmInstruction[] {
  return shellOf(source, options).instructions;
}

/**
 * Носители оболочки И РАСПИСАНИЕ ПРОЦЕДУР — для тех, кому нужны границы процедур.
 *
 * Границы нужны двум вопросам: где точка входа (первая команда какой процедуры) и где кончается
 * процедура (чтобы её выход не провалился в следующую). Один вызов эмиттера на оба — потому что
 * второй вызов дал бы второе расписание, а два расписания расходятся (правило «один конвейер»).
 */
function shellOf(
  source: string,
  options: CompileOptions = {},
): { instructions: readonly AsmInstruction[]; procedures: readonly ProcedureOffset[] } {
  const built = regModuleOrNamedFailure(source, options);
  // ПРИЧИНА НАЗВАНА (D5, случай 73): отказ языка уходит с кодом каталога и текстом, а не безымянным
  // «программа не компилируется» — класс отказа при этом остаётся языковым, не понижения
  // (`src/e2k/recordPlan.ts#frontendRefusalMessage`).
  if (!built.ok) throw new Error(frontendRefusalMessage(built.причины));
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
export function entryValueReturnsOf(source: string, options: CompileOptions = {}): number {
  const shell = shellOf(source, options);
  const entry = shell.procedures[entryProcedureIndex(shell.procedures)];
  if (entry === undefined) return shell.instructions.filter(isValueReturn).length;
  const next =
    shell.procedures
      .map((procedure) => procedure.codeOffset)
      .filter((offset) => offset > entry.codeOffset)
      .sort((a, b) => a - b)[0] ?? shell.instructions.length;
  return shell.instructions.slice(entry.codeOffset, next).filter(isValueReturn).length;
}

/** Сколько в потоке сайтов печати (по именам вызовов, а не по тексту программы). */
function countPrintSites(code: readonly AsmInstruction[], invokeNames: readonly string[]): number {
  return code.filter((carrier) => isPrintCarrier(carrier, invokeNames)).length;
}

/**
 * РАЗДЕЛЁННАЯ ПЕЧАТЬ: заменить каждый сайт группой «сохранение → вызов листовой процедуры → `write` → восстановление».
 *
 * Зачем: развёртка «число → текст» — ≈1400 байт НА КАЖДЫЙ сайт, и площадка печати (≈3776 байт кода)
 * кончалась на третьем сайте. В листовой процедуре она стоит один раз, а сайт платит за вызов и за
 * `write` у вызывающего (системный вызов из вызываемой невозможен: номер идёт в `%r8`, которого у её
 * восьмирегистрового окна нет — измерено `src/e2k/e2kCallWindowQemu.test.ts`).
 *
 * Порог — ДВА сайта: делить выгодно уже с двух (≈2900 против 2864 байт), и порог назван числом,
 * а не «когда станет много». Печать одного числа остаётся инлайновой: там делить нечего.
 */
function sharePrintSites(
  code: readonly AsmInstruction[],
  invokeNames: readonly string[],
  heapAddress: number,
  spilledAddresses: readonly number[],
  procedureCount: number,
): { readonly groupAt: ReadonlyMap<number, readonly AsmInstruction[]>; readonly problems: readonly LoweringRefusal[] } {
  const indexes = code
    // ДЕЛЯТСЯ только сайты ЧИСЛА: у строки нет развёртки, делить нечего — её байты и так лежат в образе
    // один раз. Печать строки в этот список попасть не должна: иначе строка ушла бы в «число → текст»
    // и напечатался бы АДРЕС её байтов (измерено: «1056442» вместо «Аня»).
    .map((carrier, index) => (isPrintCarrier(carrier, invokeNames) && !isStringPrint(carrier) ? index : -1))
    .filter((index) => index >= 0);
  if (indexes.length < 2) return { groupAt: new Map(), problems: [] };
  const liveOut = cfgLiveSets(code, { defUse: defUseOf }).liveOut;
  const groupAt = new Map<number, readonly AsmInstruction[]>();
  const problems: LoweringRefusal[] = [];
  const occupied = spilledAddresses.map((address) => address - spillBaseOf(heapAddress)).filter((offset) => offset >= 0);
  for (const index of indexes) {
    const carrier = code[index]!;
    const argument = carrier.operands[1];
    if (argument === undefined || argument.kind !== 'reg') {
      problems.push(
        refusalWithSource(
          LOWERING_CODES.print,
          `#${index} ${carrier.mnemonic}: у печати нет регистра значения — разделённому сайту нечего передать вызовом`,
          carrier.sourceRef,
        ),
      );
      continue;
    }
    try {
      const plan = planPrintSite({
        argument: argument.index,
        heapAddress,
        liveAfter: liveOut[index] ?? [],
        occupied,
        clobbered: SHARED_SITE_CLOBBERS,
      });
      // НОЛЬ САЙТА — НИЗКИЙ регистр (см. `IR.zero` в раскладке). Почему не ноль рантайма `%b[12]`:
      // он измеренно недоступен после возврата из вызываемой — окно вызывающего сужается до
      // `%b[0..11]` (`.tmp/osnova-after-call-window.ts`), а вытеснение сайта идёт вокруг вызова.
      // Берём регистр, которого не касается НИКТО вокруг сайта: ни вызываемая (её окно `%b[8..15]`),
      // ни хвост `write` (`%b[2]`, `%b[4]`, `%b[6]`, `%b[9]`).
      // ЖИВЫЕ ЧЕРЕЗ САЙТ — ТОЖЕ ЗАНЯТЫ (случай 71, вторая половина; решение владельца 2026-11-04).
      // Прежняя редакция брала `busy` только из сохранённых, аргумента и временного, а `IR.zero`
      // понижается в `movts 0` и УНИЧТОЖАЕТ регистр. Регистр, живой через сайт, живостью от порчи
      // не защищён: `saved = liveAfter ∩ clobbered`, а список порчи — список ВЫЗЫВАЕМОЙ. Измерено:
      // две пробы сторожа давали 1072 вместо 1073 (индекс жил через сайт и был обнулён), а печать
      // числа из переменной печатала 0 вместо 7. Теперь такой регистр под ноль не берётся вовсе, и
      // при нехватке свободных срабатывает названный отказ ниже — не тихое обнуление.
      const busy = new Set<number>([
        ...plan.saved.map((item) => item.register),
        ...(liveOut[index] ?? []),
        argument.index,
        plan.scratch,
      ]);
      const zero = [0, 1, 3, 5, 7].find((register) => !busy.has(register));
      if (zero === undefined) {
        problems.push(
          refusalWithSource(
            LOWERING_CODES.print,
            `#${index} ${carrier.mnemonic}: разделённому сайту нужен НИЗКИЙ регистр под ноль ` +
              `(ноль рантайма %b[12] после вызова недоступен), а свободных в %b[0,1,3,5,7] нет: ` +
              `заняты ${[...busy].sort((a, b) => a - b).map((r) => `%b[${String(r)}]`).join(', ')}`,
            carrier.sourceRef,
          ),
        );
        continue;
      }
      const group: AsmInstruction[] = [];
      // Ноль кладётся ПЕРЕД сохранением: им адресуется смещение слота, и он переживает и вызов,
      // и хвост (низкие регистры не трогает ни вызываемая, ни хвост).
      group.push({ mnemonic: 'IR.zero', channel: 0, operands: [base(zero)] });
      for (const item of plan.saved) {
        group.push({
          mnemonic: 'IR.spill_st',
          channel: 0,
          operands: [base(item.register), base(plan.scratch), imm(item.address), base(zero)],
        });
      }
      // Вызов листовой процедуры: один аргумент, без приёмника (`flags = аргументов << 1`).
      group.push({
        mnemonic: 'IR.call',
        channel: 0,
        operands: [imm(2), base(argument.index), base(0), imm(procedureCount), base(0)],
      });
      group.push({ mnemonic: PRINT_WRITE_CARRIER, channel: 0, operands: [] });
      for (const item of plan.saved) {
        group.push({
          mnemonic: 'IR.spill_ld',
          channel: 0,
          operands: [base(plan.scratch), base(item.register), imm(item.address), base(zero)],
        });
      }
      groupAt.set(index, group);
    } catch (error) {
      problems.push(
        refusalWithSource(
          LOWERING_CODES.print,
          `#${index} ${carrier.mnemonic}: разделённый сайт не спланирован — ` +
            (error instanceof Error ? error.message : String(error)),
          carrier.sourceRef,
        ),
      );
    }
  }
  return { groupAt, problems };
}

/** Тело листовой процедуры «число → текст»: развёртка и возврат (пара `return` + `ct` — как у всех вызываемых). */
function sharedTextCarriers(): AsmInstruction[] {
  return [
    { mnemonic: PRINT_TEXT_CARRIER, channel: 0, operands: [] },
    { mnemonic: 'IR.ret', channel: 0, operands: [imm(0), base(0)] },
  ];
}

/**
 * ПЛАН ВЫВОДА СТРОК: кого сохранить вокруг `write` и сколько это байт.
 *
 * Строку не преобразуют — её байты уже в образе, — поэтому портится меньше регистров, чем у печати
 * числа (`STRING_PRINT_CLOBBERS`), и сохранять надо только живое из них. Число сохранённых уезжает
 * в сам носитель (пометка), иначе раскладке неоткуда взять длину сайта.
 */
function planStringPrintSites(
  code: readonly AsmInstruction[],
  invokeNames: readonly string[],
  heapAddress: number,
  spilledAddresses: readonly number[],
): ReadonlyMap<number, PrintSitePlan> {
  const indexes = code
    .map((carrier, index) => (isPrintCarrier(carrier, invokeNames) && isStringPrint(carrier) ? index : -1))
    .filter((index) => index >= 0);
  if (indexes.length === 0) return new Map();
  const liveOut = cfgLiveSets(code, { defUse: defUseOf }).liveOut;
  const plans = new Map<number, PrintSitePlan>();
  for (const index of indexes) {
    const argument = printArgumentOf(code[index]!);
    if (argument === undefined) continue;
    plans.set(
      index,
      planPrintSite({
        argument,
        heapAddress,
        liveAfter: liveOut[index] ?? [],
        occupied: spilledAddresses,
        clobbered: STRING_PRINT_CLOBBERS,
      }),
    );
  }
  return plans;
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
    // Печать СТРОКИ — не этот путь: у неё нет развёртки «число → текст», её байты уже лежат в образе
    // (пометка носителя — длина строки в байтах, `src/e2k/stringPlan.ts`).
    .map((carrier, index) => (isPrintCarrier(carrier, invokeNames) && !isStringPrint(carrier) ? index : -1))
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
  const built = regModuleOrNamedFailure(source);
  // Та же названная причина, что и в `shellOf`: у `programBytes` канал тот же — исключение с
  // диагностиками языка (`src/e2k/recordPlan.ts#frontendRefusalMessage`).
  if (!built.ok) throw new Error(frontendRefusalMessage(built.причины));
  const annotated = annotateAtomRegions(built.module, [
    { atom: 'A5', procedures: built.module.procedures.map((procedure) => procedure.name) },
  ]);
  const emitted = emitShell(annotated, shellEncoder);
  const context = {
    constants: emitted.scheduled.constants,
    invokeNames: emitted.image.invokeNames,
    // ПУТЬ БЕЗ РАСКЛАДКИ: процедур здесь нет (пролог образа растит окно сам), значит плоскость одна —
    // плоскость точки входа, и её блок рантайма фиксирован (§3.128). Вызываемых в этом потоке быть не
    // может: раскладку, которая одна выдаёт базы, этот сборщик не зовёт вовсе.
    arrayBase: ENTRY_ARRAY_BASE,
  };

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
      refused.push(refusalWithSource(lowered.code, `${carrier.mnemonic}: ${lowered.reason}`, carrier.sourceRef));
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
          ...syscallCallOpen(ENTRY_SYSCALL_FRAME),
          { mnemonic: 'sdisp', channel: 0, operands: [imm(1), imm(SYSCALL_TRAP)] },
          { mnemonic: 'call', channel: 0, operands: [imm(1), imm(SYSCALL_WBS)] },
          ...syscallCallClose(ENTRY_SYSCALL_FRAME),
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

/**
 * Зовёт ли поток рантайм КУЧИ МАССИВОВ (`система.массив.*`) — по именам вызовов образа оболочки.
 *
 * Нужно ровно для одного: назвать отказ, когда в одной программе сошлись арена и куча массивов
 * (они начинаются с одного адреса — `HEAP_OFFSET`).
 */
function usesArrayHeap(code: readonly AsmInstruction[], invokeNames: readonly string[]): boolean {
  return code.some((carrier) => {
    if (carrier.mnemonic !== 'IR.invoke') return false;
    const payload = carrier.operands[3];
    return (
      payload !== undefined &&
      payload.kind === 'imm' &&
      isArrayRuntimeCall(invokeNames[payload.value] ?? '')
    );
  });
}

/**
 * ТОЧКА ВХОДА ПОЛЬЗУЕТСЯ РАНТАЙМОМ МАССИВОВ (D12, 2026-11-08) — нужен ли её сайтам печати возврат
 * блока `%b[12..15]` после системного вызова.
 *
 * Признак — вызов `система.массив.*` в ТЕЛЕ точки входа (не в чужой процедуре): в кадре точки входа
 * `call wbs = 4` кладёт в окно ядра ровно её `%b[8..15]`, и после `write` собственные `%b[13..15]`
 * читаются как нули (замер: `src/e2k/arrayRuntime.ts#arrayBlockRestore`). Программа без массивов
 * восстанавливать нечего, поэтому ни одной лишней команды не получает.
 *
 * Отдельной функцией — чтобы сторож звал ТУ ЖЕ проверку, что и конвейер: разойдись они, сторож
 * зеленел бы на пустом месте.
 */
export function entryUsesArrayRuntime(
  code: readonly AsmInstruction[],
  procedures: readonly ProcedureOffset[],
  entryAt: number,
  invokeNames: readonly string[],
): boolean {
  const start = procedures[entryAt]?.codeOffset ?? 0;
  const end =
    procedures
      .map((procedure) => procedure.codeOffset)
      .filter((offset) => offset > start)
      .sort((a, b) => a - b)[0] ?? code.length;
  return usesArrayHeap(code.slice(start, end), invokeNames);
}

/**
 * ПРОЦЕДУРЫ, РАБОТАЮЩИЕ С МАССИВАМИ (`система.массив.*`): им раскладка выдаёт блок рантайма (§3.128).
 *
 * Список строится ДО раскладки и передаётся ей: у самой раскладки имён хост-вызовов нет (они живут в
 * таблице образа оболочки), а поиск «в диапазоне процедуры есть вызов массива» нужен именно ей.
 */
export function arrayProceduresOf(
  code: readonly AsmInstruction[],
  procedures: readonly ProcedureOffset[],
  invokeNames: readonly string[],
): number[] {
  const found: number[] = [];
  procedures.forEach((procedure, at) => {
    const to = procedures[at + 1]?.codeOffset ?? code.length;
    if (usesArrayHeap(code.slice(procedure.codeOffset, to), invokeNames)) found.push(at);
  });
  return found;
}

/**
 * ПРОЦЕДУРЫ, КОТОРЫМ НУЖЕН АДРЕС ЯЧЕЙКИ КУЧИ В ИХ ОКНЕ (A4, срез 3, §3.137), — те, что ВЫДЕЛЯЮТ
 * массив (`система.массив.создать`).
 *
 * Зачем список отдельно от {@link arrayProceduresOf}: работа с массивом и ВЫДЕЛЕНИЕ памяти — разные
 * нужды. Чтение (`получить`) и запись (`установить`) обходятся блоком в три клетки и `%b[15]` не
 * трогают вовсе; `создать` же читает и двигает ЯЧЕЙКУ КУЧИ по адресу в `%b[15]`, и адрес этот в
 * плоскости вызываемой никто, кроме её пролога роста, положить не может.
 *
 * Точка входа в список не входит: у неё адрес кладёт пролог ОБРАЗА (`arrayPrologue`).
 */
/**
 * ПРОЦЕДУРЫ, В КОТОРЫХ СТРОКОВАЯ ОПЕРАЦИЯ СТОИТ В ПЛОСКОСТИ ВЫЗЫВАЕМОЙ (шаг 2.3, случай 73).
 *
 * Зачем список нужен ДО раскладки. Строковый рантайм держит временные в клетках `%b[10]`, `%b[11]`,
 * `%b[13]` (`STRING_REGISTERS`, `src/e2k/stringRuntime.ts`). В плоскости точки входа эти клетки и
 * так недоступны значениям (бюджет входа — `%b[0..9]`), а в плоскости вызываемой они ВХОДЯТ в её
 * бюджет (`CALLEE_REGISTERS` = `%b[8..23]` без клетки нуля) — то есть без закрепления раскладка
 * отдала бы их значениям программы, и рантайм затёр бы их МОЛЧА. Поэтому вызывающий считает этот
 * список заранее и закрепляет клетки УСЛОВНО — ровно как у арены, коллекций и ячейки кучи: у
 * программ без строк в вызываемых бюджет не меняется, и закреплённые числа не двигаются.
 *
 * Точка входа в список не входит: у неё те же клетки держит `RESERVED_REGISTERS`.
 */
/**
 * ПРОЦЕДУРЫ, КОТОРЫМ НУЖНЫ ВРЕМЕННЫЕ СТРОКОВОГО РАНТАЙМА, — ВКЛЮЧАЯ ТОЧКУ ВХОДА.
 *
 * Этим списком решается, закреплять ли `%b[10]`, `%b[11]` и `%b[13]` за рантаймом (B-блок). Прежняя
 * редакция (`stringCalleeProcedures`) исключала точку входа, потому что её клетки держал статический
 * `RESERVED_REGISTERS` = `%b[10..15]`. С расширенным пулом `%b[0..15]` статической полосы больше нет:
 * клетки входа входят в бюджет значений, и закреплять их обязан ТОТ ЖЕ условный резерв, что у
 * вызываемой, — иначе раскладка отдаст их значениям и рантайм затёр бы их МОЛЧА (D4 малого B).
 */
export function stringProcedures(
  code: readonly AsmInstruction[],
  procedures: readonly ProcedureOffset[],
  invokeNames: readonly string[],
): Set<number> {
  const found = new Set<number>();
  code.forEach((carrier, index) => {
    if (carrier.mnemonic !== 'IR.invoke') return;
    const payload = carrier.operands[3];
    if (payload === undefined || payload.kind !== 'imm') return;
    const name = invokeNames[payload.value];
    if (name !== STRING_CALLS.length && name !== STRING_CALLS.symbol && name !== STRING_CALLS.concat) return;
    // Номер процедуры берётся ТЕМ ЖЕ способом, что у отказа в теле (`procedureAt`): счёт по отрезкам
    // `codeOffset` разошёлся бы с ним, если процедуры идут не по порядку смещений, — и отказ сказал бы
    // «клетки не закреплены» там, где они закреплены.
    const at = procedureAt(procedures, index);
    if (at !== undefined) found.add(at);
  });
  return found;
}

/**
 * То же, но БЕЗ точки входа: проверка в теле (`imageOfCarriers`) судит только вызываемую, а у входа
 * закрепление проверяется не словом, а самим `reserved`/бюджетом.
 */
export function stringCalleeProcedures(
  code: readonly AsmInstruction[],
  procedures: readonly ProcedureOffset[],
  invokeNames: readonly string[],
  entryAt: number,
): Set<number> {
  const found = stringProcedures(code, procedures, invokeNames);
  found.delete(entryAt);
  return found;
}

/**
 * НУЖНЫ ЛИ ВРЕМЕННЫЕ СТРОКОВОГО РАНТАЙМА В ПЛОСКОСТИ ВЫЗЫВАЕМОЙ — ОТВЕТ СЧИТАЕТСЯ ПО ПЛАНУ СТРОК.
 *
 * Почему не по сырому потоку: склейка `+` приходит от оболочки носителем `IR.add`, а СТРОКОВЫМ вызовом
 * становится только В ПЛАНЕ (`src/e2k/stringPlan.ts`) — по реестру типов и доказанным значениям. Скан
 * сырого потока не увидел бы её и сказал бы «строк в вызываемой нет», хотя они есть: ровно так
 * `с_токеном` (три строки-параметра) осталась без закреплённых клеток и отказала бы на верной
 * программе. Поэтому разведка идёт ТЕМ ЖЕ проходом, что окончательный план (`planStrings`), с ТЕМИ ЖЕ
 * фактами типов (`stringTypeFactsOf`/`provedValuesOf`) — иначе разведка и поток разошлись бы
 * (класс §3.134.6). Цена — второй проход; тем же способом решает арена (§3.138).
 */
export function stringNeedProcedures(input: {
  readonly code: readonly AsmInstruction[];
  readonly constants: readonly unknown[];
  readonly invokeNames: readonly string[];
  readonly procedures: readonly ProcedureOffset[];
  readonly procedureTypes: readonly ProcedureTypeInfo[] | undefined;
  readonly heapAddress: number;
  readonly entryAt: number;
}): Set<number> {
  const declaredTypes: readonly ProcedureOffset[] =
    input.procedures.length === 0 ? [{ name: 'главная', codeOffset: 0 }] : input.procedures;
  // Доказанные значения НУЖНЫ и здесь: без них склейка доказанной строки в вызываемой не попадает
  // в план, детектор говорит «строк нет», и настоящая строковая операция остаётся без клеток 10/11/13
  // (`booleanLiterals.test.ts`, `stringTypeParam.test.ts` СК1б). Ложная нужда B снимается не этим, а
  // РАЗДЕЛЕНИЕМ входа и вызываемой в `loweredUnchecked`: строка во ВХОДЕ больше не закрепляет клетки
  // вызываемой (случай 89).
  const typeFacts = stringTypeFactsOf(
    declaredTypes,
    input.procedureTypes,
    provedValuesOf(input.code, declaredTypes, input.constants, input.invokeNames, input.procedureTypes),
  );
  const planned = planStrings(
    input.code,
    input.constants,
    input.invokeNames,
    input.heapAddress,
    factsOptions(typeFacts),
  );
  const found = stringProcedures(planned.code, input.procedures, planned.invokeNames);
  // ДОКАЗАННЫЕ ЗНАЧЕНИЯ — НЕ ПРАВО КАЖДОЙ ПРОЦЕДУРЫ НА СТРОКОВЫЙ РЕЗЕРВ. В B доказательство
  // превращало `система.массив.получить` в `система.строка.символ` во ВСЕХ процедурах (числа/знаки/
  // ключевые), хотя их параметры — `Список Число`; резерв 10/11/13 отнимал у них три подряд клетки
  // и давал 19 отказов `#246`. Поэтому доказательный ответ принимается только там, где СТРОКОВОСТЬ
  // названа ИНТЕРФЕЙСОМ (строковый параметр или возврат), либо где в процедуре есть ЯВНЫЙ вызов
  // строкового рантайма. Склейка доказанных строк в вызываемой (`с_токеном`, СК1б) имеет строковые
  // параметры/возврат — её резерв сохраняется; числовые handler'ы B — нет.
  const typed = new Set<number>();
  if (typeFacts !== undefined) {
    typeFacts.stringParams.forEach((cells, at) => {
      if (cells.length > 0) typed.add(at);
    });
    typeFacts.stringReturns?.forEach((at) => typed.add(at));
  }
  for (const at of [...found]) {
    if (typed.has(at)) continue;
    const from = declaredTypes[at]?.codeOffset ?? 0;
    const to = declaredTypes[at + 1]?.codeOffset ?? planned.code.length;
    // СЫРОЙ поток, а не `planned.code`: доказательство само превращает `массив.получить` в
    // `строка.символ`, и проверка по плану приняла бы это превращение за «явную строковую операцию» —
    // то есть ровно за то, что фильтр и должен отсечь.
    const explicit = input.code.slice(from, to).some((carrier) => {
      if (carrier.mnemonic !== 'IR.invoke') return false;
      const payload = carrier.operands[3];
      if (payload === undefined || payload.kind !== 'imm') return false;
      return (input.invokeNames[payload.value] ?? '').startsWith('система.строка.');
    });
    if (!explicit) found.delete(at);
  }
  return found;
}

export function heapSlotProcedures(
  code: readonly AsmInstruction[],
  procedures: readonly ProcedureOffset[],
  invokeNames: readonly string[],
  entryAt: number,
): Set<number> {
  const found = new Set<number>();
  procedures.forEach((procedure, at) => {
    if (at === entryAt) return;
    const to = procedures[at + 1]?.codeOffset ?? code.length;
    const allocates = code.slice(procedure.codeOffset, to).some((carrier) => {
      if (carrier.mnemonic !== 'IR.invoke') return false;
      const payload = carrier.operands[3];
      return (
        payload !== undefined &&
        payload.kind === 'imm' &&
        isArrayCreateCall(invokeNames[payload.value] ?? '')
      );
    });
    if (allocates) found.add(at);
  });
  return found;
}

/**
 * ГЛУБИНА ВЫЗОВА каждой процедуры от точки входа (A4, §3.135).
 *
 * Ребро — носитель `IR.call`: цель лежит в его четвёртом операнде (проверено `regAlloc`-оракулом
 * блока рантайма, `src/e2k/arrayBlockOwnership.test.ts`). Глубина — длина КРАТЧАЙШЕГО пути: первый
 * обход её и даёт, второго смысла у неё нет (нужна граница «плоскость 1 или глубже», а не число).
 *
 * Зачем понадобилась: стена «окно вызываемой» измерялась как свойство ОДНОЙ процедуры (`inCallee`),
 * а замер 2026-10-24 показал, что у записи в массив она зависит от ГЛУБИНЫ — в плоскости 1 она
 * проходит, в плоскости 2 зацикливает МОДЕЛЬ (замер 2026-10-29: та же проба на железе проходит —
 * стена модели, а не цели). Различить это без графа вызовов нечем.
 */
function callDepths(
  instructions: readonly AsmInstruction[],
  procedures: readonly ProcedureOffset[],
  entryAt: number,
): ReadonlyMap<number, number> {
  const targets: number[][] = procedures.map((procedure, at) => {
    const end = procedures[at + 1]?.codeOffset ?? instructions.length;
    const found: number[] = [];
    for (const carrier of instructions.slice(procedure.codeOffset, end)) {
      if (carrier.mnemonic !== 'IR.call') continue;
      const payload = carrier.operands[3];
      if (payload !== undefined && payload.kind === 'imm') found.push(payload.value);
    }
    return found;
  });
  const depth = new Map<number, number>([[entryAt, 0]]);
  const queue: number[] = [entryAt];
  while (queue.length > 0) {
    const at = queue.shift()!;
    for (const to of targets[at] ?? []) {
      if (depth.has(to)) continue;
      depth.set(to, (depth.get(at) ?? 0) + 1);
      queue.push(to);
    }
  }
  return depth;
}

/**
 * РОСТ ОКНА: какие процедуры обязаны получить свой пролог (§3.56.5, правила 1–2).
 *
 * Пролог нужен ТОЙ процедуре, которая сама вызывает, — и только ей: точке входа он не нужен (её
 * вызовы идут с `wbs = 4`, а её окно и так 16), а листовой вызываемой не нужен тем более. Признак
 * берётся по факту: в диапазоне носителей процедуры есть `IR.call`.
 */
function windowGrowthAt(
  code: readonly AsmInstruction[],
  procedures: readonly ProcedureOffset[],
  invokeNames: readonly string[],
  arrayBases: readonly (number | undefined)[] = [],
  heapSlotAt: ReadonlySet<number> = new Set<number>(),
  heapAddress = 0,
  /**
   * Ставить ли ВСЕМ вызываемым ноль её плоскости (`IR.callee_zero`, ATOM-05-02-01).
   *
   * По умолчанию `false` — и это не осторожность: этим вызовом набор «процедур, которые сами
   * вызывают» пересчитывается ПОСЛЕ всех вставок (`depthTwo` ниже), и лишние ключи сделали бы
   * листовую процедуру «глубины 2» — то есть получили бы чужой `wbs` и чужой порядок возврата.
   * Ноль ставится там, где пролог процедуры действительно собирается (см. `emitCalleePrologue`).
   */
  zeroCellOfCallee = false,
): ReadonlyMap<number, readonly AsmInstruction[]> {
  const growth = new Map<number, readonly AsmInstruction[]>();
  if (procedures.length === 0) return growth;
  const entryAt = entryProcedureIndex(procedures);
  procedures.forEach((procedure, at) => {
    if (at === entryAt) return;
    const end =
      procedures
        .map((other) => other.codeOffset)
        .filter((offset) => offset > procedure.codeOffset)
        .sort((a, b) => a - b)[0] ?? code.length;
    // Пролог нужен и вызову, и СИСТЕМНОМУ ВЫЗОВУ (печати): syscall — тоже вызов в ядро, у него те же
    // правила кольца окон (§3.58). Без роста окна его `wbs = 8` даёт пустой кадр ядра и порт аварийно
    // завершается — измерено матрицей `.tmp/osnova-syscall-matrix.ts`.
    const body2 = code.slice(procedure.codeOffset, end);
    // РОСТ ОКНА НУЖЕН И СИСТЕМНОМУ ВЫЗОВУ (`IR.invoke`), а не только `IR.call` и печати.
    // `IR.invoke` — это `система.*`: номер и аргументы идут в `%r(2*wbs)`, то есть ЗА границей
    // окна процедуры. Прежде `IR.invoke` в это условие не входил, и процедура, работающая с
    // массивом (индекс/длина — это `IR.invoke`), окна не растила: тогда `calleeLimit` отказывал
    // ей по `OSN-LOW-003`, хотя отказ снят именно для ВЫРАЩЕННОГО кадра (§3.57–§3.58).
    // Замер: `cycle_array` — 7 отказов до правки.
    const needsGrowth = body2.some(
      (carrier) =>
        carrier.mnemonic === 'IR.call' ||
        carrier.mnemonic === 'IR.invoke' ||
        isPrintCarrier(carrier, invokeNames),
    );
    // НОЛЬ ПЛОСКОСТИ СТАВИТСЯ И ЛИСТОВОЙ (ATOM-05-02-01): ей рост окна не нужен вовсе, а клетка
    // нуля нужна именно ей — переход, ветвящийся по значению, стоит внутри процедуры, которая
    // никого не зовёт. Поэтому «нужен ли пролог» решается ОБОИМИ слагаемыми, а не одним `needsGrowth`.
    if (!needsGrowth && !zeroCellOfCallee) return;
    // ПРОЛОГ — ПЕРЕД первым носителем процедуры, а не ВМЕСТО него: `expandCarriers` заменяет
    // указанный носитель группой, поэтому первый носитель входит в группу вторым (иначе пролог
    // съел бы первую команду тела — так и случилось: у процедуры, начинавшейся с вызова,
    // вызов исчезал, и она возвращала мусор).
    const first = code[procedure.codeOffset];
    if (first === undefined) return;
    // ПРОЛОГ ЗНАЧЕНИЙ РАНТАЙМА МАССИВОВ — В ПЛОСКОСТИ ЭТОЙ ПРОЦЕДУРЫ (§3.128).
    //
    // Он идёт НОСИТЕЛЕМ и в той же группе, что рост окна: группа заменяет первый носитель процедуры,
    // поэтому `setwd`/`setbn` окажутся ПЕРЕД значениями (а `movts … %b[N]` требует годного окна), а
    // конвейер переведёт их в оконную форму вместе с остальным телом вызываемой. Базу взяла раскладка.
    const arrayBase = arrayBases[at];
    growth.set(procedure.codeOffset, [
      ...(needsGrowth ? [{ mnemonic: WINDOW_GROW_CARRIER, channel: 0, operands: [] } as AsmInstruction] : []),
      // ПРОЛОГ ЗНАЧЕНИЙ — ДВЕ КОМАНДЫ ВМЕСТО ТРЁХ (A4, §3.135): ноль и восемь в блок вызываемой.
      // Единицы нет намеренно: она нужна только `добавить`, а `добавить` в вызываемой отказывает
      // (куча живёт в плоскости точки входа). Вместе с отказом от второго временного блок стал
      // ТРИ клетки вместо пяти — и запись в массив из вызываемой перестала быть отказом.
      ...(arrayBase === undefined
        ? []
        : [{ mnemonic: ARRAY_VALUES_CARRIER, channel: 0, operands: [imm(arrayBase)] }]),
      // АДРЕС ЯЧЕЙКИ КУЧИ — ПОСЛЕ роста окна и значений (A4 §3.137): `movtd … %b[15]` требует
      // ГОДНОГО окна этой плоскости, а годным его делает `setwd`/`setbn` выше. Носитель нужен ровно
      // тем процедурам, которые выделяют массив; у прочих его нет, и `создать` в них отказывает.
      ...(heapSlotAt.has(at)
        ? [{ mnemonic: ARRAY_SLOT_CARRIER, channel: 0, operands: [{ kind: 'imm64', value: BigInt(heapAddress) } as Operand] }]
        : []),
      // НОЛЬ ПЛОСКОСТИ — ПОСЛЕДНИМ (ATOM-05-02-01): `setwd` выше меняет геометрию окна, то есть
      // переводит `%rN` на другие физические регистры, поэтому ноль, положенный ДО роста, оказался бы
      // не в той клетке, которую прочтёт `cmpesb` перехода по значению. ПЕРЕД первым носителем тела —
      // потому что читать клетку может самый первый из них.
      ...(zeroCellOfCallee ? [{ mnemonic: CALLEE_ZERO_CARRIER, channel: 0, operands: [] } as AsmInstruction] : []),
      first,
    ]);
  });
  return growth;
}

/**
 * Собрать образ из УЖЕ РАЗЛОЖЕННОГО потока носителей: раскладка адресов, пары «сравнение + переход»,
 * понижение, пролог рантайма массивов и выход через `exit`.
 *
 * Вынесено из сырого пути (`src/e2k/guards/loweredUnchecked.ts#loweredProgramUnchecked`), чтобы тем же путём можно было прогнать поток, собранный
 * ВРУЧНУЮ: у источника эмиттер вправе переставить чтения, и давление на регистры падает само
 * (измерено: программа с одиннадцатью чтениями массива даёт пик 5 и вытеснения не требует).
 */
/**
 * ТИПЫ ПРОЦЕДУР, ВЫРОВНЕННЫЕ ПО ПОТОКУ: индекс процедуры потока → её тип (шаг 2.3).
 *
 * Сопоставление ИМЕНЕМ, а не порядком: список процедур AST и список процедур потока приходят из разных
 * слоёв, и совпадение порядков — соглашение, которое разошлось бы молча (класс §3.35). Если по имени не
 * нашлось, берётся порядок — но ТОЛЬКО когда длины списков совпадают, иначе лучше «типа нет», чем
 * ЧУЖОЙ тип: чужая `Строка` сняла бы отказ там, где его обязан назвать кто-то другой.
 */
function typesByProcedure(
  procedures: readonly ProcedureOffset[],
  types: readonly ProcedureTypeInfo[] | undefined,
): readonly (ProcedureTypeInfo | undefined)[] {
  if (types === undefined || types.length === 0) return [];
  const sameLength = types.length === procedures.length;
  return procedures.map((procedure, at) => {
    const byName = types.find((type) => type.name === procedure.name);
    if (byName !== undefined) return byName;
    return sameLength ? types[at] : undefined;
  });
}

/** КЛЕТКИ-ПАРАМЕТРЫ, чей ТИП назван: индекс процедуры → номера клеток (замер: параметр `i` живёт в `%b[i]`). */
function paramCellsOf(
  aligned: readonly (ProcedureTypeInfo | undefined)[],
  matches: (type: TypeRef | undefined) => boolean,
): readonly (readonly number[])[] {
  return aligned.map((type) => {
    const cells: number[] = [];
    (type?.paramTypes ?? []).forEach((param, at) => {
      if (matches(param)) cells.push(at);
    });
    return cells;
  });
}

/** Факты «строковость из типа» для планирования строк. */
function stringTypeFactsOf(
  procedures: readonly ProcedureOffset[],
  types: readonly ProcedureTypeInfo[] | undefined,
  /**
   * ДОКАЗАТЕЛЬСТВО ЗНАЧЕНИЙ (`src/e2k/stringValueProof.ts`) — то, без чего тип даёт ЗАКОННОСТЬ
   * операции, но не даёт ни длины, ни таблицы кодов. Доказанное значение едет ТЕКСТОМ (мост
   * `proofTexts`), и карта ключуется ПАРОЙ «процедура + клетка», а не строкой на весь образ: у двух
   * процедур с одним вызовом каждая значения РАЗНЫЕ, и общая карта приписала бы одной чужое.
   */
  proof?: {
    readonly parameters: ReadonlyMap<number, ReadonlyMap<number, string>>;
    /**
     * МНОЖЕСТВА значений клеток (TD-0001): все сайты известны, значения разные. Клетка, у которой
     * значение ДОКАЗАНО, сюда не попадает — два пути к одному значению разошлись бы.
     */
    readonly paramChoices?: ReadonlyMap<number, ReadonlyMap<number, readonly string[]>>;
    /**
     * ЧИСЛОВЫЕ ЗНАЧЕНИЯ ПАРАМЕТРОВ: клетка → ОДНО число, если так передают ВСЕ её прямые сайты
     * (ATOM-06-02-02). Множества здесь нет намеренно — см. сборку `paramNumbers` в `provedValuesOf`.
     */
    readonly paramNumbers?: ReadonlyMap<number, ReadonlyMap<number, number>>;
    readonly resultValues: ReadonlyMap<number, string>;
    readonly resultReasons: ReadonlyMap<number, string>;
    // ВРЕМЕННАЯ ДИАГНОСТИЧЕСКАЯ ПРАВКА (замер цены пути (а) случая 76; откатывается).
    readonly callValues?: ReadonlyMap<number, string>;
  },
): StringTypeFacts | undefined {
  const aligned = typesByProcedure(procedures, types);
  if (aligned.length === 0) return undefined;
  const paramValues = procedures.map((_, at) => proof?.parameters.get(at) ?? new Map<number, string>());
  const paramChoices = procedures.map((_, at) => proof?.paramChoices?.get(at) ?? new Map<number, readonly string[]>());
  // ЧИСЛА ПАРАМЕТРОВ (ATOM-06-02-02): та же карта «процедура → клетка», но значением — ОДНО число.
  const paramNumbers = procedures.map((_, at) => proof?.paramNumbers?.get(at) ?? new Map<number, number>());
  return {
    procedureOffsets: procedures.map((procedure) => procedure.codeOffset),
    procedureNames: procedures.map((procedure) => procedure.name),
    stringParams: paramCellsOf(aligned, isStringType),
    // ВОЗВРАТ ИЗ ВЫЗОВА: ТИП, А НЕ ЗНАЧЕНИЕ (ERR-0002). Нужен ровно затем, чтобы форма без значения
    // И без типа опознавалась как строка и отказывала ПО ИМЕНИ, а не складывала два адреса.
    stringReturns: new Set(aligned.flatMap((info, at) => (isStringType(info?.returnType) ? [at] : []))),
    paramValues,
    ...(proof?.paramNumbers === undefined ? {} : { paramNumbers }),
    ...(proof?.paramChoices === undefined ? {} : { paramChoices }),
    ...(proof?.callValues === undefined ? {} : { callValues: proof.callValues }),
    ...(proof === undefined
      ? {}
      : { resultValues: proof.resultValues, resultReasons: proof.resultReasons }),
  };
}

/**
 * ДОКАЗАННЫЕ ЗНАЧЕНИЯ — вызов модуля доказательства и перевод записей пула в тексты.
 *
 * `stringPool` — БАЙТЫ записей: сравнивать значения номерами записей нельзя (два литерала «абв» лежат
 * двумя записями), поэтому байты собираются здесь, а сравнение делает модуль.
 */
function provedValuesOf(
  code: readonly AsmInstruction[],
  procedures: readonly ProcedureOffset[],
  constants: readonly unknown[],
  invokeNames: readonly string[],
  types: readonly ProcedureTypeInfo[] | undefined,
): {
  readonly parameters: ReadonlyMap<number, ReadonlyMap<number, string>>;
  /**
   * МНОЖЕСТВА значений по сайтам (TD-0001): клетка → все значения её сайтов, ТОЛЬКО строки пула.
   *
   * Строится по `proof.siteValues` (значения ВСЕХ сайтов) с двумя условиями: значений БОЛЬШЕ ОДНОГО
   * (одно — это уже доказательство, `parameters`) и все они — ЗАПИСИ ПУЛА. Второе условие и есть
   * граница механизма: дескриптор есть только у блоба литерала, а значение, собранное в рантайме
   * (склейка в буфере или в арене), записью пула не является и сюда не попадёт.
   */
  readonly paramChoices: ReadonlyMap<number, ReadonlyMap<number, readonly string[]>>;
  /** ЧИСЛА ПАРАМЕТРОВ (ATOM-06-02-02): клетка → одно число, если так передают ВСЕ её сайты. */
  readonly paramNumbers: ReadonlyMap<number, ReadonlyMap<number, number>>;
  readonly resultValues: ReadonlyMap<number, string>;
  readonly resultReasons: ReadonlyMap<number, string>;
  // ВРЕМЕННАЯ ДИАГНОСТИЧЕСКАЯ ПРАВКА (замер цены пути (а) случая 76; откатывается).
  readonly callValues: ReadonlyMap<number, string>;
  /** Носители `IR.result_pick`, чья нагрузка НЕ доказана строкой: недоказанный тег или Неудача. */
  readonly nonSuccessPicks: ReadonlySet<number>;
  // ВХОДЫ ДОКАЗАТЕЛЬСТВА — возвращаются наружу ровно затем, чтобы сторож индексации мог пересчитать
  // НОМЕРА на потоке ПОСЛЕ планирования строк: план дописывает свой пролог, и номера сдвигаются.
  readonly declaredTypes: readonly ProcedureOffset[];
  readonly constants: readonly unknown[];
  readonly invokeNames: readonly string[];
  readonly procedureTypes: readonly ProcedureTypeInfo[] | undefined;
} {
  const stringPool = constants.map((raw) => (typeof raw === 'string' ? utf8Bytes(raw) : []));
  /** Запись пула → ТЕКСТ: план строк работает текстом, доказательство — записями. */
  const textOf = (record: number): string => Buffer.from(stringPool[record] ?? []).toString('utf-8');
  const aligned = typesByProcedure(procedures, types);
  const proof = proveStringValues({
    code,
    procedures,
    invokeNames,
    stringPool,
    constantValues: constants,
    paramTypes: aligned.map((type) => (type?.paramTypes ?? []).map((param) => param?.name)),
  });
  const parameters = new Map<number, ReadonlyMap<number, string>>();
  for (const [procedure, cells] of proof.parameters) {
    const texts = new Map<number, string>();
    for (const [cell, record] of cells) texts.set(cell, textOf(record));
    parameters.set(procedure, texts);
  }
  // ── МНОЖЕСТВА ЗНАЧЕНИЙ ПО САЙТАМ (TD-0001) ───────────────────────────────────────────────────────
  //
  // Здесь же, где и доказанные значения: тот же текст значения (`textOf`), та же пара «процедура +
  // клетка». Отличие одно: значений НЕСКОЛЬКО, и потому длина с таблицей кодов берутся не на сборке,
  // а из дескриптора перед блобом. Требование «все — строки пула» — не осторожность, а условие
  // верности: у значения, собранного в рантайме, дескриптора нет вовсе.
  const paramChoices = new Map<number, ReadonlyMap<number, readonly string[]>>();
  for (const [procedure, cells] of proof.siteValues) {
    const choices = new Map<number, readonly string[]>();
    for (const [cell, values] of cells) {
      if (values.length < 2) continue;
      if (!values.every((value) => value.kind === 'строка')) continue;
      const texts = values.map((value) => textOf(value.kind === 'строка' ? value.pool : 0));
      if (new Set(texts).size < 2) continue;
      choices.set(cell, texts);
    }
    if (choices.size > 0) paramChoices.set(procedure, choices);
  }
  // ── ИСХОД ПАРЫ — ПО САЙТУ, А НЕ ПО ПРОЦЕДУРЕ ────────────────────────────────────────────────────
  //
  // `добыть("абв", 5)` отдаёт Успех, и нагрузка там — `Строка`; `добыть("абв", 0)` отдаёт Неудачу, и в
  // ТОЙ ЖЕ клетке лежит поле другого типа (`Е`). Доказательство, ключёванное процедурой, уравняло бы
  // эти два сайта и напечатало 1072 вместо отказа — тихая ложь (замер verifier'а, проба П12). Поэтому
  // значение нагрузки берётся ТОЛЬКО у сайта с доказанным успехом, а всякий иной исход назван причиной.
  const resultValues = new Map<number, string>();
  const resultReasons = new Map<number, string>();
  /**
   * САЙТЫ, ГДЕ НАГРУЗКА НЕ ДОКАЗАНА СТРОКОЙ (шаг 2.3, случай 73): недоказанный тег и доказанная Неудача.
   *
   * Зачем отдельным множеством, а не разбором текста причины: по нему сторож индексации
   * (`src/e2k/arrayRuntime.ts#arrayBaseProblems`) отказывает `нагрузка[0]` ПО ИМЕНИ. Без него
   * `пусть тег, нагрузка = добыть("абв", 0)` + `нагрузка[0]` собиралось с НУЛЁМ отказов и модель
   * возвращала код 9 с пустым выводом (замер 2026-11-05, `.tmp/a230-зонд-пара.ts`): в клетке нагрузки
   * на этом сайте лежит поле типа `Е`, то есть число 7 — обращение уходило в память по адресу 7.
   * Сайт с доказанным Успехом сюда НЕ попадает: там значение нагрузки известно (`resultValues`), и
   * планирование строк заменяет индексацию символом строки (1072 — замер той же пробы).
   */
  const nonSuccessPicks = new Set<number>();
  for (let index = 1; index < code.length; index++) {
    const carrier = code[index]!;
    if (carrier.mnemonic !== 'IR.result_pick') continue;
    const anchor = carrier.operands[1];
    const destination = carrier.operands[0];
    const previous = code[index - 1]!;
    // Сайт пары — `IR.result_pick` СРАЗУ за `IR.call`, чей приёмник тега равен якорю нагрузки: так его
    // строит кодоген (`src/compiler/regcodegen.ts`), и другой связи между носителями нет.
    const callDestination = previous.mnemonic === 'IR.call' ? previous.operands[4] : undefined;
    if (anchor?.kind !== 'reg' || destination?.kind !== 'reg') continue;
    if (callDestination?.kind !== 'reg' || callDestination.index !== anchor.index) continue;
    const outcome = proof.pairs.get(index);
    if (outcome === undefined) {
      resultReasons.set(index, 'тег пары не проверен программой и не доказан сборкой');
      nonSuccessPicks.add(index);
      continue;
    }
    if (outcome.tag !== 'успех') {
      resultReasons.set(index, 'нагрузка пары — поле типа «Е», не «Строка»: тег на этом сайте доказан как «неудача»');
      nonSuccessPicks.add(index);
      continue;
    }
    const payload = outcome.payload;
    if (payload !== undefined && payload.kind === 'строка') resultValues.set(index, textOf(payload.pool));
    else resultReasons.set(index, 'успех пары несёт поле не типа «Строка» — индекс по нему не строковый');
  }
  // ── ЧИСЛОВЫЕ ЗНАЧЕНИЯ ПАРАМЕТРОВ (ATOM-06-02-02, 2026-11-06) ─────────────────────────────────────
  //
  // Тот же `siteValues`, но с ЗАМЕНОЙ, которая и делает факт числовым: у края среза `подстрока(с, н, к)`
  // должно быть ОДНО значение. Множество чисел наружу не отдаётся намеренно: выбор «одного из многих»
  // был бы догадкой, а не доказательством (`число 1` и `число 4` на разных сайтах — это НЕ «4»).
  //
  // Почему это нужно: `numbersOf` плана наполняется СВЁРТКОЙ по потоку (`IR.const`, `IR.add`), и число,
  // приехавшее ПАРАМЕТРОМ, до свёртки не доходит вовсе. Замер (`.tmp/06-02-оракул-до.ts`, пробы П7/П8):
  // срез в вызываемой отказывал «края среза известны только в рантайме» ДАЖЕ тогда, когда оба её сайта
  // (и даже единственный сайт) передают один и тот же литерал — то есть доказательство было, а моста к
  // числовому счёту плана не было. Все сайты обязаны быть известны; это гарантирует `siteValues`
  // (`deriveParams` отбрасывает клетку, у которой хоть один сайт неизвестен).
  const paramNumbers = new Map<number, ReadonlyMap<number, number>>();
  for (const [procedure, cells] of proof.siteValues) {
    const numbers = new Map<number, number>();
    for (const [cell, values] of cells) {
      const first = values[0];
      if (first === undefined || first.kind !== 'целое') continue;
      if (!values.every((value) => value.kind === 'целое' && value.value === first.value)) continue;
      numbers.set(cell, first.value);
    }
    if (numbers.size > 0) paramNumbers.set(procedure, numbers);
  }
  // ВРЕМЕННАЯ ДИАГНОСТИЧЕСКАЯ ПРАВКА (замер цены пути (а) случая 76; откатывается `git checkout HEAD --`).
  const callValues = new Map<number, string>();
  for (const [site, record] of proof.callValues) callValues.set(site, textOf(record));
  return {
    parameters,
    paramChoices,
    paramNumbers,
    callValues,
    resultValues,
    resultReasons,
    nonSuccessPicks,
    declaredTypes: procedures,
    constants,
    invokeNames,
    procedureTypes: types,
  };
}

/** Факты «число из типа» для сторожа индексации: `Число`-параметр массивом быть не может. */
function numberTypeFactsOf(
  procedures: readonly ProcedureOffset[],
  types: readonly ProcedureTypeInfo[] | undefined,
): readonly ProcedureNumberFacts[] {
  const aligned = typesByProcedure(procedures, types);
  if (aligned.length === 0) return [];
  const cells = paramCellsOf(aligned, isNumberType);
  return procedures.map((procedure, at) => ({
    codeOffset: procedure.codeOffset,
    name: procedure.name,
    numbers: cells[at] ?? [],
  }));
}

/** Опции планирования строк: факты типов кладутся ТОЛЬКО когда они есть (иначе поведение прежнее). */
function factsOptions(
  facts: StringTypeFacts | undefined,
  sliceEntryRange?: { readonly from: number; readonly to: number },
): { readonly types?: StringTypeFacts; readonly sliceEntryRange?: { readonly from: number; readonly to: number } } {
  return {
    ...(facts === undefined ? {} : { types: facts }),
    ...(sliceEntryRange === undefined ? {} : { sliceEntryRange }),
  };
}

/**
 * НОМЕРА НОСИТЕЛЕЙ `IR.result_pick`, ЧЬЯ НАГРУЗКА НЕ ДОКАЗАНА УСПЕХОМ, — НА ПОТОКЕ ПОСЛЕ ПЛАНИРОВАНИЯ.
 *
 * Считается второй раз намеренно: планирование строк дописывает в начало потока СВОЙ пролог, поэтому
 * индексы, снятые с входного `code`, сдвинуты (замер `.tmp/a230-зонд-пара.ts`: `IR.jmp` +
 * `IR.callee_zero`, сдвиг 2), и набор с чужого потока пометил бы не тот носитель — класс «разведка
 * разошлась с потоком» (§3.134.6). Второй счёт запускается ТОЛЬКО когда пары в программе вообще есть:
 * у программы без пар `size` равен нулю, и лишнего доказательства не считается.
 */
function pairPicksForGuard(
  planned: readonly AsmInstruction[],
  proof: ReturnType<typeof provedValuesOf> | undefined,
): ReadonlySet<number> {
  if (proof === undefined || proof.nonSuccessPicks.size === 0) return new Set<number>();
  return provedValuesOf(
    planned,
    proof.declaredTypes,
    proof.constants,
    proof.invokeNames,
    proof.procedureTypes,
  ).nonSuccessPicks;
}

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
    /**
     * БАЗЫ БЛОКОВ РАНТАЙМА МАССИВОВ по процедурам — как их выдала раскладка (`allocateProgram`,
     * поле `arrayBases`). Нет базы — обращение к массиву в этой процедуре отказывает по имени, а не
     * угадывает клетки (§3.128).
     */
    readonly arrayBases?: readonly (number | undefined)[];
    /**
     * ЗАКРЕПЛЕНЫ ЛИ РЕГИСТРЫ АРЕНЫ у этого потока — слово того, кто раскладывал регистры.
     *
     * Арена пишет указатель и предел **в обход** потока носителей (`src/e2k/arenaRuntime.ts`),
     * поэтому раскладка обязана была их не отдать. Знание об этом живёт у вызывающего
     * (`src/e2k/lowered.ts#loweredProgram` решает это ДО раскладки — по разведке планирования строк), а проверить
     * его можно только здесь, где известно, нужна ли арена на самом деле. `false` при нужной арене —
     * НАЗВАННЫЙ отказ, а не тихая порча: иначе выделение взяло бы мусор вместо указателя.
     */
    readonly arenaReserved?: boolean;
    /**
     * ЗАКРЕПЛЕНА ЛИ КЛЕТКА `%b[15]` ЗА АДРЕСОМ ЯЧЕЙКИ КУЧИ — слово того, кто раскладывал регистры
     * (A4, срез 3, §3.137).
     *
     * Нужен ровно там, где адрес кладёт пролог роста вызываемой: если раскладка не знала о нужде в
     * этой клетке, адрес и значение программы встали бы в один регистр, и адрес был бы затёрт МОЛЧА.
     * `false` (или отсутствие слова) при нужде — НАЗВАННЫЙ отказ `создать` в вызываемой, а не порча.
     */
    readonly heapSlotReserved?: boolean;
    /**
     * ЗАКРЕПЛЕНЫ ЛИ ВРЕМЕННЫЕ СТРОКОВОГО РАНТАЙМА В ПЛОСКОСТИ ВЫЗЫВАЕМОЙ (шаг 2.3, случай 73).
     *
     * Строковый рантайм держит состояние в `%b[10]`, `%b[11]`, `%b[13]` (`STRING_REGISTERS`). В
     * плоскости входа они недоступны значениям, а в плоскости вызываемой входят в её бюджет, поэтому
     * вызывающий закрепляет их УСЛОВНО — только у образов, где строковая операция стоит в вызываемой
     * (`stringCalleeProcedures`). Слово проверяется ЗДЕСЬ, где видно, нужны ли клетки на самом деле:
     * разойдись резерв и нужда — операция обязана отказать ПО ИМЕНИ, а не затереть значение молча.
     */
    readonly stringsCalleeReserved?: boolean;
    /**
     * ЗАКРЕПЛЕНЫ ЛИ КЛЕТКИ САЙТА РАНТАЙМ-СРЕЗА (`STRING_SLICE_DECLARED_CELLS`) — слово того, кто
     * раскладывал регистры (шаг подключения, ATOM-06-02-02).
     *
     * Сайт берёт четыре клетки ИЗ БЮДЖЕТА ПРОГРАММЫ (`%b[0..3]` в выбранной раскладке) и пишет в них
     * байт, счётчик, адрес таблицы и результат сравнений. Если раскладка не знала об этом, в тех же
     * клетках жили бы значения программы, и петля затирала бы их МОЛЧА. `false` (или отсутствие
     * слова) при нужде — НАЗВАННЫЙ отказ конвейера, а не порча.
     */
    readonly sliceReserved?: boolean;
    /**
     * ПОТОК НЕРАЗЛОЖЕН (`allocateProgram` отказала хоть одной процедуре) — носители сохраняют
     * ВИРТУАЛЬНЫЕ регистры, и байты такого образа наружу не уходят (буква D13, `src/e2k/guards/loweredUnchecked.ts`).
     *
     * Слово нужно сайтам, которые СУДЯТ о клетках: арена и коллекции пишут в закреплённые номера и
     * молчат, а рантайм-срез сверяет роли с клетками арены и полосой — на неразложенном потоке эта
     * сверка была бы отказом не по делу (замер: `%b[6]` оказался ролью «from», потому что раскладка
     * отказала и в потоке остались виртуальные номера).
     */
    readonly diagnosticFlow?: boolean;
    /**
     * ТИПЫ ПРОЦЕДУР (`src/e2k/recordPlan.ts#procedureTypesOf`) — СТРОКОВОСТЬ И ЧИСЛО ИЗ ТИПА (шаг 2.3).
     *
     * В носителе типа нет: `IR.invoke` несёт индекс имени, `IR.result_pick` — два регистра. Поэтому
     * «параметр 1 объявлен `Строка`» и «параметр 0 объявлен `Число`» знает только конвейер, у которого
     * есть AST. Без этого списка поведение прежнее байт-в-байт: строковая операция по параметру
     * отказывает «аргумент не строка», а индексация по `Число`-параметру молча читает память.
     */
    readonly procedureTypes?: readonly ProcedureTypeInfo[];
  } = {},
): {
  bytes: Uint8Array;
  refused: readonly LoweringRefusal[];
  /**
   * ШАГ КАЖДОГО ОТКАЗА (D11) — индекс носителя, при обработке которого отказ принят; длина совпадает
   * с `refused`. Отказы стадий (строки, коллекции, разведение арены и кучи) идут ДО потока носителей,
   * поэтому их шаг — `0`: это честное «отказ программный», а не потерянный шаг.
   *
   * Зачем отдельным полем, а не в тексте причины: `Отказ` публичной двери обязан нести `шаг` ЧИСЛОМ, а
   * разбирать текст причины регуляркой запрещено — переписанная формулировка молча ослепила бы
   * читателя (`src/e2k/loweringRefusal.ts`, шапка).
   */
  readonly refusedSteps: readonly number[];
  /**
   * Чем образ пользуется: арена требует БОЛЬШЕ ОТОБРАЖЁННОЙ ПАМЯТИ (`extraMemory`), и это знание
   * обязано дойти до построения ELF — иначе арена окажется за отображённым и первое же обращение
   * к ней даст исключение. `extraMemory` пишет только `p_memsz`, кода не касается.
   */
  readonly arena: { readonly used: boolean; readonly extraMemory: number };
} {
  const heapAddress = options.heapAddress ?? MINIMAL_BASE + HEAP_OFFSET;
  // АРЕНА: пользуется ли образ ареной — и это ДВА источника, а не один. Первый — вызов
  // `система.память.выделить` в потоке; второй — СКЛЕЙКА СТРОК СВЕРХ СТАТИЧЕСКОГО БУФЕРА: она тоже
  // берёт блок у арены, и вызова для этого не нужно. Второй источник знает только планирование строк
  // (оно одно считает длины), поэтому при отсутствии явного вызова план строится дважды: первый
  // проход — РАЗВЕДКА (нужна ли образу строка отказа), второй — окончательный. Второй счётчик длин
  // не заводится: он разошёлся бы с планом (класс `docs/hardware-debt.md` §3.35).
  const arenaCall = usesArena(code, invokeNames);
  // КОЛЛЕКЦИИ: сайт собирается из носителей ДО раскладки адресов — по именам вызовов, не по тексту.
  const collectionsUsed = usesCollections(code, invokeNames);
  // ТИПЫ: и в разведку, и в окончательный план идут ОДНИ И ТЕ ЖЕ факты — иначе разведка и поток после
  // раскладки разошлись бы (класс §3.134.6), и отказ арены сработал бы на верной программе.
  const declaredTypes: readonly ProcedureOffset[] =
    options.procedures === undefined || options.procedures.length === 0
      ? [{ name: 'главная', codeOffset: 0 }]
      : options.procedures;
  /** Доказательство значений — ОДНО на всю функцию: из него берутся и факты строк, и исходы пар. */
  let pairProof: ReturnType<typeof provedValuesOf> | undefined;
  const typeFacts = stringTypeFactsOf(
    declaredTypes,
    options.procedureTypes,
    // ДОКАЗАТЕЛЬСТВО — на ТОМ ЖЕ потоке `code`, что разбирает `planStrings`: второй поток дал бы
    // индексы сайтов, разошедшиеся с пометками (класс §3.35).
    (pairProof = provedValuesOf(code, declaredTypes, constants, invokeNames, options.procedureTypes)),
  );
  // ГРАНИЦЫ ПРОЦЕДУР — ДО ПЛАНА СТРОК: план решает, понижать ли рантайм-срез, а его сайт живёт только
  // в плоскости ТОЧКИ ВХОДА (полоса `%b[10..15]` — её). Слово о границе идёт в ТОТ ЖЕ поток, который
  // план разбирает (`code`), иначе индексы разошлись бы с пометками (класс §3.35).
  //
  // Процедуры берутся из пометок потока (`options.procedures`), а пустой список значит «одна главная»:
  // тогда точка входа «ничья» только по смещению 0, а принадлежность считается как «последняя
  // процедура, чьё смещение ≤ индекса».
  const declaredProcedures: readonly ProcedureOffset[] =
    options.procedures === undefined || options.procedures.length === 0
      ? [{ name: 'главная', codeOffset: 0 }]
      : options.procedures;
  const sliceEntryRange = ((): { readonly from: number; readonly to: number } => {
    const from = declaredProcedures[entryProcedureIndex(declaredProcedures)]?.codeOffset ?? 0;
    const to =
      declaredProcedures
        .map((procedure) => procedure.codeOffset)
        .filter((offset) => offset > from)
        .sort((left, right) => left - right)[0] ?? code.length;
    return { from, to };
  })();
  const probe = arenaCall ? undefined : planStrings(code, constants, invokeNames, heapAddress, factsOptions(typeFacts, sliceEntryRange));
  // СЧЁТЧИК АРЕНЫ ОБЪЯВЛЯЕТСЯ ЖИВЫМ ЗДЕСЬ, до всякого `IR.arena_alloc`: сайт рантайм-среза зовёт
  // арену САМ (`counts.slicesRuntime`), и без этого слова пролога `IR.arena_init` не было бы вовсе —
  // сайт взял бы мусор вместо указателя арены, а `%b[4]`/`%b[6]` раскладка отдала бы программе.
  const arenaUsed = arenaCall || (probe?.counts.arenaConcats ?? 0) > 0 || (probe?.counts.slicesRuntime ?? 0) > 0;
  // Строка отказа арены планируется ВМЕСТЕ со прочими статическими блоками: её адрес выведен из конца
  // образа, и второй способ его считать разошёлся бы с первым (`src/e2k/stringPlan.ts`).
  if (arenaUsed && options.arenaReserved === false) {
    // Отказ конвейера, а не программы: канал — исключение с кодом, как у отказа раскладки
    // (`imageOfCarriers` здесь не собирает образ ВООБЩЕ: с незакреплёнными регистрами он был бы
    // мусором, а пустые байты в отчёте выглядели бы рабочим образом).
    throw new LoweringRefusalError(
      LOWERING_CODES.runtime,
      'арена нужна образу, а регистры её не закреплены: раскладка не знала об арене ' +
        '(разведка планирования строк и поток после раскладки разошлись) — это дефект конвейера, ' +
        'а не программы (src/e2k/guards/loweredUnchecked.ts#loweredProgramUnchecked)',
    );
  }
  // СТРОКА ОТКАЗА НУЖНА И КОЛЛЕКЦИЯМ, а не только арене: их блок отказа печатает СВОЮ строку
  // (выход за ёмкость блока), и планируется она тем же `planStrings`. ЗАМЕР: без этой ветви
  // `strings.arenaRefusal` оставался неопределённым, блок отказа НЕ дописывался вовсе, и переход
  // сайта уезжал за поток — «цель перехода #24 вне потока (инструкций 24)».
  //
  // СТРОК ТЕПЕРЬ СТОЛЬКО, СКОЛЬКО ПРИЧИН (случай 34 реестра проверяемости): у арены своя, у коллекций
  // три — граница блока, ёмкость при переезде и ответ `brk`. Прежняя редакция выбирала ОДНУ строку на
  // программу по признаку «пользуется ли она коллекциями И не пользуется ли ареной», и программа с
  // ОБОИМИ механизмами при отказе коллекции печатала текст арены — то есть называла чужой механизм.
  const collectionRefusalKindsNeeded: readonly CollectionRefusalKind[] = collectionsUsed
    ? collectionRefusalKinds(code, invokeNames)
    : [];
  const strings =
    arenaUsed || collectionsUsed
      ? planStrings(code, constants, invokeNames, heapAddress, {
          ...factsOptions(typeFacts, sliceEntryRange),
          ...(arenaUsed ? { arenaRefusal: ARENA_REFUSAL_TEXT } : {}),
          ...(collectionRefusalKindsNeeded.length === 0
            ? {}
            : { collectionRefusals: collectionRefusalKindsNeeded.map((kind) => COLLECTION_REFUSAL_TEXTS[kind]) }),
        })
      : probe!;
  // Адреса блобов — ПО ПРИЧИНАМ: порядок тот же, что у `collectionRefusalKinds` (один источник).
  const collectionRefusals: Partial<Record<CollectionRefusalKind, { address: number; byteLength: number }>> = {};
  collectionRefusalKindsNeeded.forEach((kind, at) => {
    const blob = strings.collectionRefusals?.[at];
    if (blob !== undefined) collectionRefusals[kind] = blob;
  });
  // СТРОКИ: литералы становятся адресами статических байтов, `длина`/`объединить` — пометками,
  // по которым ОДНИ И ТЕ ЖЕ команды считают и раскладка (форма), и понижение (байты). Планирование
  // идёт ДО всего остального: адреса блобов сдвигают сторож места, а пул констант — длину `IR.const`.
  const stringContext = { constants: strings.constants, invokeNames: strings.invokeNames };
  // Дальше весь конвейер работает с ПЕРЕПИСАННЫМ потоком и РАСШИРЕННЫМ пулом: строковый литерал —
  // это уже адрес, а не строка (`src/e2k/stringPlan.ts`).
  const context = stringContext;
  // ПРОЦЕДУРЫ уже объявлены выше (`declaredProcedures`) — там, где они понадобились ПЛАНУ СТРОК:
  // границы точки входа решают, понижать ли рантайм-срез. Второе объявление разошлось бы с первым.
  // АРЕНА В ПОТОКЕ: заведение в прологе (один раз на программу), сайт вместо каждого вызова операции,
  // блок отказа — в конце потока. Индексы и цели переходов пересчитывает `expandCarriers`: свой счёт
  // индексов разошёлся бы с ним (класс `docs/hardware-debt.md` §3.35).
  const arena = arenaUsed
    ? arenaGroups(strings.code, strings.invokeNames, declaredProcedures[entryProcedureIndex(declaredProcedures)]?.codeOffset ?? 0)
    : undefined;
  const withArena =
    arena === undefined ? { code: strings.code, procedures: declaredProcedures } : expandCarriers(strings.code, arena.groups, declaredProcedures);
  const arenaRefusal =
    arena === undefined || strings.arenaRefusal === undefined
      ? undefined
      : arenaRefusalCarriers(strings.arenaRefusal.address, strings.arenaRefusal.byteLength);
  const withRefusal =
    arenaRefusal === undefined || withArena.code.length === 0
      ? withArena
      : expandCarriers(
          withArena.code,
          new Map([
            [
              withArena.code.length - 1,
              [...withArena.code.slice(withArena.code.length - 1), ...arenaRefusal],
            ],
          ]),
          withArena.procedures,
        );
  // ── РАНТАЙМ-СРЕЗ В ПОТОКЕ (шаг подключения, ATOM-06-02-02) ────────────────────────────────────
  //
  // Тем же приёмом, что арена и коллекции: САЙТ — группой вместо носителя, ХВОСТ (петля, слово длины,
  // возврат за вызов) — группой носителя ПЕРЕД блоком отказа арены, индексы и цели переходов
  // пересчитывает `expandCarriers`. Ставится ЗДЕСЬ, сразу за блоком отказа арены, а не после коллекций,
  // по ИЗМЕРЕННОЙ причине: индекс блока отказа арены (цель перехода сайта при исчерпании) вычислим
  // только пока этот блок — ПОСЛЕДНЕЕ в потоке; коллекции дописывают за ним свои блоки отказа, и
  // «найти нужный» стало бы поиском по совпадению (§3.35). Позднейшие вставки (коллекции, рост окна,
  // разделённая печать) сдвигают цели сайта вместе со всем потоком — это их работа, не наша.
  //
  // ХВОСТ — ПЕРЕД БЛОКОМ ОТКАЗА, А НЕ ЗА НИМ (измерено, ERR-0009): `IR.exit` блока отказа несёт код
  // 231 и понижается в `movts _f16s` длиной 16 байт, а форма раскладки у него 8. Пока хвост стоял за
  // выходом, все его адреса уезжали на 8 байт: возврат петли попадал во ВТОРОЕ слово `movtd`
  // (литерал адреса слота), `ldd` читал по адресу, оставшемуся в `%b[0]`, и программа получала первый
  // байт источника вместо своего значения (208 = 0xD0). Перед выходом адреса хвоста верны, а сам
  // блок отказа (его никто не проходит насквозь) остаётся последним.
  const sliceRequests: StringSliceSiteRequest[] = [];
  if (arenaRefusal !== undefined) {
    const refusalIndex = withRefusal.code.length - arenaRefusal.length;
    withRefusal.code.forEach((carrier, index) => {
      if (carrier.mnemonic !== STRING_SLICE_RUNTIME_CARRIER) return;
      const [from, to, result, ...literals] = carrier.operands;
      if (
        from?.kind !== 'reg' ||
        to?.kind !== 'reg' ||
        result?.kind !== 'reg' ||
        literals.length !== 6 ||
        literals.some((operand) => operand?.kind !== 'imm')
      ) {
        throw new LoweringRefusalError(
          LOWERING_CODES.runtime,
          `#${String(index)} ${STRING_SLICE_RUNTIME_CARRIER}: носитель рантайм-среза без клеток краёв, ` +
            'приёмника или индексов пула — это дефект планирования строк (src/e2k/stringPlan.ts), а не программы',
        );
      }
      const [sourceAddress, sourceEnd, codePoints, tableAddress, one, sixteen] = literals.map(
        (operand) => (operand as { readonly kind: 'imm'; readonly value: number }).value,
      );
      sliceRequests.push({
        index,
        from: from.index,
        to: to.index,
        destination: STRING_SLICE_DESTINATION_CELL,
        result: result.index,
        literals: {
          sourceAddress: sourceAddress!,
          sourceEnd: sourceEnd!,
          codePoints: codePoints!,
          tableAddress: tableAddress!,
          one: one!,
          sixteen: sixteen!,
        },
        cells: STRING_SLICE_CELLS,
        arena: {
          pointer: ARENA_POINTER_BASE,
          flag: ARENA_FLAG_REGISTER,
          limit: ARENA_LIMIT_BASE,
          refusalIndex,
        },
        reserved: [...STRING_SLICE_DECLARED_CELLS, ...arenaReservedRegisters()],
      });
    });
  }
  const slices =
    sliceRequests.length === 0 || options.sliceReserved === false
      ? undefined
      : stringSliceGroups(withRefusal.code, sliceRequests, {
          checkCells: options.diagnosticFlow !== true,
          // ПЕРЕД БЛОКОМ ОТКАЗА: за ним `IR.exit` с кодом 231 — `movts _f16s` 16 байт против 8 в форме,
          // и хвост за выходом получал бы все адреса на 8 байт позже (ERR-0009).
          tailAt: withRefusal.code.length - arenaRefusal!.length - 1,
        });
  const withSlices =
    slices === undefined
      ? { code: withRefusal.code, procedures: withRefusal.procedures }
      : // ОТНОСИТЕЛЬНЫЕ ЦЕЛИ САЙТА ДОПИСЫВАЮТСЯ ЗДЕСЬ ЖЕ, сразу после раскрытия: `expandCarriers`
        // пересчитывает только цели ВНУТРИ прежнего потока, а «девятый носитель САЙТА» таковой не
        // является — без этой правки ветви обработки краёв уезжали в начало образа, и рантайм-срез
        // висел (ERR-0008). Правка ровно одна на весь конвейер: дальше это обычные номера носителей.
        (() => {
          const раскрытый = expandCarriers(withRefusal.code, slices.groups, withRefusal.procedures);
          return {
            code: resolveSliceRelativeTargets(
              раскрытый.code,
              sliceRequests[0]!.index,
              slices.relativeTargets,
            ),
            procedures: раскрытый.procedures,
          };
        })();
  // РЕЗЕРВ КЛЕТОК САЙТА сверяется с нуждой ЗДЕСЬ ЖЕ, как у арены: разойдись объявление и нужда —
  // названный отказ конвейера, а не молчаливая порча (клетки сайта взяты из бюджета программы).
  if (sliceRequests.length > 0 && options.sliceReserved !== true && options.diagnosticFlow !== true) {
    throw new LoweringRefusalError(
      LOWERING_CODES.runtime,
      'рантайм-срез нужен образу, а клетки его сайта не закреплены: раскладка не знала о срезе ' +
        '(разведка планирования строк и поток после раскладки разошлись) — это дефект конвейера, ' +
        'а не программы (src/e2k/guards/loweredUnchecked.ts#loweredProgramUnchecked)',
    );
  }
  const sliceCode = withSlices.code;
  const sliceProcedures: readonly ProcedureOffset[] = withSlices.procedures;
  // КОЛЛЕКЦИИ В ПОТОКЕ: сайт операции — проверка границы (у `выделить`/`расширить` — ответа `brk`) и
  // обращение по вычисленному адресу; у переезда ещё и цикл копирования. Тем же приёмом, что арена:
  // САЙТЫ — картой групп, ХВОСТ (циклы и блоки отказа) дописывается группой последнего носителя, а
  // индексы и цели переходов пересчитывает `expandCarriers`. Ставится ДО роста окна, чтобы все
  // последующие проходы видели готовый поток.
  //
  // БЛОКИ ОТКАЗА — ПО ОДНОМУ НА ПРИЧИНУ, и строка у каждого своя (случай 34): переход сайта
  // `положить`/`взять` ведёт в блок границы, переходы проверок `brk` — в блок памяти, проверки
  // ёмкости — в блок переезда. Прежняя редакция дописывала ОДИН блок с текстом арены.
  // ПОТОК ПОСЛЕ АРЕНЫ И РАНТАЙМ-СРЕЗА: имя `arenaCode` сохранено прежним, потому что дальше он и был
  // «поток после арены», а срез встал в ту же точку — ДО коллекций и роста окна, чтобы все
  // последующие проходы (и их пересчёт целей) видели сайт и хвост на своих местах.
  const arenaCode = sliceCode;
  const baseProcedures: readonly ProcedureOffset[] = sliceProcedures;
  const entryOffset = declaredProcedures[entryProcedureIndex(declaredProcedures)]?.codeOffset ?? 0;
  const nextProcedureOffset =
    declaredProcedures
      .map((procedure) => procedure.codeOffset)
      .filter((offset) => offset > entryOffset)
      .sort((a, b) => a - b)[0] ?? arenaCode.length;
  const collections = collectionsUsed
    ? collectionGroups(arenaCode, strings.invokeNames, {
        refusals: collectionRefusals,
        // ГРАНИЦА ТОЧКИ ВХОДА: коллекции живут там, где пролог образа завёл %b[12]/%b[13]/%b[14].
        // Вызов в вызываемой — НАЗВАННЫЙ ОТКАЗ (поле `problems`), а не тихая порча чужого состояния.
        entryRange: { from: entryOffset, to: nextProcedureOffset },
      })
    : undefined;
  const withCollections =
    collections === undefined
      ? { code: arenaCode, procedures: baseProcedures }
      : expandCarriers(arenaCode, collections.groups, baseProcedures);
  const collectionsCode = withCollections.code;
  const collectionsProcedures: readonly ProcedureOffset[] = withCollections.procedures;
  // РОСТ ОКНА: процедура, которая САМА вызывает, получает свой пролог `setwd wsz=16` + `setbn rsz=15`
  // (§3.56.5, правила 1–2) — иначе её внутренний вызов не имеет законного `wbs`. Растёт окно у той,
  // которая вызывает: точке входа оно не нужно (её вызовы идут с `wbs = 4`), листовой — тем более.
  //
  // АДРЕС ЯЧЕЙКИ КУЧИ (A4 §3.137) кладётся В ТУ ЖЕ ГРУППУ — и только тем процедурам, которые
  // выделяют массив, и только если раскладка знает об этой клетке (`heapSlotReserved`). Слово
  // проверяется ЗДЕСЬ, потому что здесь же видно, нужен ли адрес на самом деле: разойдись резерв и
  // нужда — `создать` в вызываемой обязан отказать по имени, а не прочесть чужую клетку.
  const heapSlotAt = heapSlotProcedures(
    collectionsCode,
    collectionsProcedures,
    strings.invokeNames,
    collectionsProcedures.length === 0 ? -1 : entryProcedureIndex(collectionsProcedures),
  );
  const heapSlotReadyAt: ReadonlySet<number> =
    heapSlotAt.size > 0 && options.heapSlotReserved !== true
      ? new Set<number>()
      : heapSlotAt;
  const growthAt = windowGrowthAt(
    collectionsCode,
    collectionsProcedures,
    strings.invokeNames,
    options.arrayBases ?? [],
    heapSlotReadyAt,
    heapAddress,
    // НОЛЬ КАЖДОЙ ВЫЗЫВАЕМОЙ (ATOM-05-02-01): клетка, равная нулю по построению, нужна плоскости
    // вызываемой для перехода, ветвящегося ПО ЗНАЧЕНИЮ (§3.166). Ставится всем вызываемым — и
    // листовой тоже, ей рост окна не нужен вовсе.
    true,
  );
  const grown = growthAt.size === 0 ? undefined : expandCarriers(collectionsCode, growthAt, collectionsProcedures);
  const growCode = grown?.code ?? collectionsCode;
  const growProcedures = grown?.procedures ?? baseProcedures;
  // РАЗДЕЛЁННАЯ ПЕЧАТЬ: если сайтов печати больше одного, развёртка (≈1400 байт на КАЖДЫЙ сайт)
  // выносится в листовую процедуру, а у сайта остаётся вызов и `write` (см. `src/e2k/printCall.ts`).
  // Тогда площадка печати перестаёт быть потолком: десять печатей стоят ≈2900 байт вместо 14320.
  const sharing = sharePrintSites(
    growCode,
    strings.invokeNames,
    heapAddress,
    options.spilledAddresses ?? [],
    growProcedures.length,
  );
  const expanded =
    sharing.groupAt.size === 0 ? undefined : expandCarriers(growCode, sharing.groupAt, growProcedures);
  const sharedCode = expanded?.code ?? growCode;
  const sharedProcedures = expanded?.procedures ?? growProcedures;
  // Листовая процедура «число → текст» встаёт В КОНЕЦ потока: её тело — развёртка, её вызов — у сайтов.
  const withText = sharing.groupAt.size === 0 ? sharedCode : [...sharedCode, ...sharedTextCarriers()];
  const proceduresWithText =
    sharing.groupAt.size === 0
      ? sharedProcedures
      : [
          ...sharedProcedures,
          // Индекс процедуры в списке — то, чем адресуется вызов; смещение — индекс первого носителя тела.
          { name: SHARED_PRINT_PROCEDURE, codeOffset: sharedCode.length },
        ];
  // ПОДГОТОВКА ПОТОКА: возвраты точки входа называются нулевыми (их место — её `exit`), а если точка
  // входа стоит не первой, в начало встаёт переход к ней. Так раскладка видит РОВНО тот поток,
  // который соберётся: раньше она резервировала байты под неисполняемые возвраты, и адреса процедур
  // за ними уезжали (класс дефекта §3.35). Выход без значения ставится только ПЕЧАТАЮЩЕЙ программе:
  // у прочих поведение прежнее и измеренное («без возврата — код 134», §3.39).
  const prepared = prepareImage(withText, proceduresWithText, {
    exitOnVoidReturn:
      sharing.groupAt.size > 0 || countPrintSites(collectionsCode, invokeNames) > 0 || strings.counts.prints > 0,
  });
  const plannedCode = prepared.code;
  const procedures = prepared.procedures;
  const entryAt = procedures.length === 0 ? 0 : entryProcedureIndex(procedures);
  // РАНТАЙМ МАССИВОВ В ТОЧКЕ ВХОДА (D12, 2026-11-08): нужен ли её сайтам печати ВОЗВРАТ БЛОКА
  // `%b[12..15]` после системного вызова. Признак тот же, что у `arrayProceduresOf`, но для точки
  // входа: вызов `система.массив.*` в её теле. Программа без массивов не получает ни одной лишней
  // команды — закреплённые числа (потолок печати) от этого не двигаются.
  const entryArrayRuntime = entryUsesArrayRuntime(plannedCode, procedures, entryAt, strings.invokeNames);
  const entryFrame: SyscallFrame = entryArrayRuntime
    ? { ...ENTRY_SYSCALL_FRAME, restoreHeapAddress: heapAddress }
    : ENTRY_SYSCALL_FRAME;
  // ПЕЧАТЬ: план сайта — ДО раскладки, потому что её длину раскладка обязана знать (иначе
  // смещение перехода, пересекающего печать, считается по нулю — docs/hardware-debt.md §3.43).
  // Число сохраняемых регистров уезжает в сам носитель: другого канала к раскладке нет.
  // При разделённой печати инлайновых сайтов не остаётся вовсе — планы пусты, и это не «не нашли».
  const printPlans = planPrintSites(plannedCode, strings.invokeNames, heapAddress, options.spilledAddresses ?? []);
  // СТРОКИ: свой план вывода (портится меньше регистров) — тот же механизм и тот же канал к раскладке.
  const stringPrintPlans = planStringPrintSites(
    plannedCode,
    strings.invokeNames,
    heapAddress,
    options.spilledAddresses ?? [],
  );
  const planned = plannedCode.map((carrier, index) => {
    // ПЛОСКОСТЬ ЭТОГО НОСИТЕЛЯ: в точке входа системный вызов идёт с `wbs = 4`, то есть в окне
    // ядра оказываются `%b[8..15]` точки входа (D12), — поэтому только её сайты помечаются
    // возвратом блока рантайма массивов. У выращенной процедуры окно ядра далеко от блока.
    const inEntry = procedures.length === 0 || procedureAt(procedures, index) === entryAt;
    const marked = (it: AsmInstruction): AsmInstruction => (inEntry ? withPrintFrame(it, entryFrame) : it);
    const numberPlan = printPlans.get(index);
    if (numberPlan !== undefined) return marked(withPrintSaveCount(carrier, numberPlan.saved.length));
    const stringPlan = stringPrintPlans.get(index);
    if (stringPlan === undefined) {
      // ХВОСТ `write` РАЗДЕЛЁННОЙ ПЕЧАТИ стоит у ВЫЗЫВАЮЩЕГО и делает тот же вызов — блок обязан
      // вернуться и здесь (у выращенной процедуры хвост — названный отказ, см. ниже).
      return carrier.mnemonic === PRINT_WRITE_CARRIER ? marked(carrier) : carrier;
    }
    // Число сохранённых — СЕДЬМОЙ пометкой носителя: шестая занята длиной строки, седьмая — адресом
    // перевода строки (`src/e2k/stringPlan.ts`), и раскладка читает их по порядку.
    const operands = [...carrier.operands];
    operands[STRING_MARK_OPERAND + 2] = imm(stringPlan.saved.length);
    return marked({ ...carrier, operands });
  });
  // ГЛУБИНА ≥ 2: процедуры, которые САМИ вызывают (по потоку после всех вставок). Их носители
  // понижаются иначе: свой `wbs = 8` и порядок возврата «`return` → значение → `ct`» (§3.56.5, 3–5).
  const depthTwo = new Set<number>(windowGrowthAt(planned, procedures, strings.invokeNames).keys());
  // ГЛУБИНА ВЫЗОВА каждой процедуры от точки входа: нужна границе A4 (§3.135) — запись в массив из
  // вызываемой ГЛУБИНЫ ≥ 2 зацикливает МОДЕЛЬ (замер 2026-10-24; 2026-10-29: та же проба проходит
  // на ЖЕЛЕЗЕ — стена модели, а не цели), и это отказ по имени, а не петля.
  const depthOf = callDepths(planned, procedures, entryAt);
  // Процедуры, которые зовут СЕБЯ: печать в них не проверена (виснет) — названный отказ, не тишина.
  const selfCalling = new Set<number>();
  procedures.forEach((procedure, at) => {
    const end =
      procedures.map((other) => other.codeOffset).filter((offset) => offset > procedure.codeOffset).sort((a, b) => a - b)[0] ??
      planned.length;
    const selfCalls = planned.slice(procedure.codeOffset, end).some((carrier) => {
      const payload = carrier.operands[3];
      return carrier.mnemonic === 'IR.call' && payload !== undefined && payload.kind === 'imm' && payload.value === at;
    });
    if (!selfCalls) return;
    for (let index = procedure.codeOffset; index < end; index++) selfCalling.add(index);
  });
  // Возвраты, оставшиеся в потоке после подготовки, принадлежат ВЫЗЫВАЕМЫМ процедурам — значит
  // они ИСПОЛНЯЮТСЯ, и форма обязана считать пару (`procedureReturn`). Возвраты точки входа
  // помечены нулевыми (`zeroSize`): их место занимает её `exit`.
  const zeroSize = new Set(prepared.zeroSize);
  // ГРАНИЦЫ ПРОЦЕДУР — ОДНИ И ТЕ ЖЕ для раскладки и для сопоставления пар. Поток носителей общий на
  // весь образ, и без списка начал окно живости сравнения уходит в следующую процедуру (случай 89).
  // Список идёт в ОБА прохода, иначе пометки материализации разойдутся с формой (см. `CarrierFormContext`).
  const procedureStarts = procedures.map((procedure) => procedure.codeOffset);
  const layout = layoutOf(planned, {
    invokeNames: strings.invokeNames,
    constants: strings.constants,
    heapAddress,
    procedureReturn: true,
    zeroSize: prepared.zeroSize,
    procedureStarts,
  });
  const resolved = secondPass(planned, layout.addresses);
  const pairing = pairPredicates(planned, { procedureStarts });
  // ВЫЗОВ: адрес вызываемой известен только теперь — тем же механизмом, что цель перехода.
  const calls = callAddresses({
    code: planned,
    procedures,
    addresses: layout.addresses,
    dispOffsetOf: (index) => {
      const form = carrierFormOf(planned[index]!, {
        invokeNames: strings.invokeNames,
        constants: strings.constants,
        heapAddress,
      });
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
  // Отказы ПЛАНИРОВАНИЯ СТРОК идут первыми: причина из плана (у значения не оказалось адреса,
  // склейка сверх буфера осталась без приёмника) обязана стоять ПЕРЕД отказом раскладки, который
  // видит уже следствие — отсутствие пометок (обе записи верны, но причина обязана быть первой).
  const refused: LoweringRefusal[] = [
    ...strings.problems.map((reason) => refusalOf(LOWERING_CODES.runtime, reason)),
    ...sharing.problems,
    // ОТКАЗЫ ПЛАНИРОВАНИЯ КОЛЛЕКЦИЙ: сайт не построился (операнды не той формы, регистр занят
    // рантаймом, вызов в вызываемой). Без этой строки сайт просто отсутствовал бы, а наблюдатель
    // получил бы «операция не развёрнута» — верное по букве и ложное по причине.
    ...(collections?.problems ?? []).map((reason) => refusalOf(LOWERING_CODES.runtime, reason)),
  ];
  // ШАГ КАЖДОГО ОТКАЗА — индекс носителя, при обработке которого отказ ПРИНЯТ (D11: `шаг` в `Отказе`).
  //
  // Собирается здесь, а не в 20 местах `refused.push`: у отказов носителей шаг известен ИЗ ЦИКЛА, и
  // `try/finally` вокруг тела итерации проставляет его и на `continue`, и на `return`. Править
  // двадцать точек значило бы завести двадцать мест, где шаг можно забыть, — и «шаг» молча уехал бы
  // на чужой носитель (ровно тот класс дефекта, что стережёт случай 58).
  //
  // Отказы СТАДИЙ (планирование строк, коллекции, разведение арены и кучи) идут ДО потока носителей:
  // номера носителя у них нет, поэтому их шаг — `ШАГ_ДО_ПОТОКА`, а НЕ `0`. Разница не косметическая:
  // `0` — законный индекс первого носителя, и «шаг 0» приписывало отказ стадии ПЕРВОЙ процедуре потока,
  // называя её читателю вместо честного «до потока» (поймано сторожем на теле лексера: 20 отказов
  // стадий называли носители `#142`, `#150`, … , а шаг у всех был `0`).
  const refusedSteps: number[] = refused.map(() => ШАГ_ДО_ПОТОКА);
  // АРЕНА И КУЧА МАССИВОВ В ОДНОЙ ПРОГРАММЕ НЕ РАЗВЕДЕНЫ — и это НАЗВАННЫЙ отказ, а не надежда.
  // Числа: куча рантайма массивов начинается с `HEAP_OFFSET` = `0x102000` (`%b[15]` кладёт туда
  // пролог), и арена начинается ТАМ ЖЕ (`src/e2k/arenaRuntime.ts#ARENA_BASE`) и растёт вверх.
  // Первая же запись массива легла бы в выделенный ареной блок — молча. Развести их (или отдать
  // арене другое место) — отдельная работа: `HEAP_OFFSET` приколот («равен `HEAP_OFFSET` всех
  // шлюзовых образов»), и трогать его здесь нельзя.
  if (arenaUsed && usesArrayHeap(code, invokeNames)) {
    refused.push(
      refusalOf(
        LOWERING_CODES.runtime,
        'арена и куча массивов в одной программе не разведены: обе начинаются с 0x102000 ' +
          '(HEAP_OFFSET) и растут вверх — запись массива легла бы в выделенный ареной блок. ' +
          'Разведение — отдельная работа (docs/hardware-debt.md §3.89)',
      ),
    );
    // Отказ программный (до потока носителей) — тот же ШАГ_ДО_ПОТОКА, что у отказов стадий выше.
    refusedSteps.push(ШАГ_ДО_ПОТОКА);
  }
  let exitEmitted = false;
  /** Печатает ли образ: инлайновые сайты ИЛИ разделённая печать (её хвост `write`). */
  const prints = printPlans.size > 0 || sharing.groupAt.size > 0;
  // ВЫХОД — ТЕПЕРЬ НОСИТЕЛЬ (`IR.exit`), а не приписка в конце: подготовка потока превращает в него
  // первый возврат точки входа (`src/e2k/procedureCall.ts#prepareImage`). Байты выхода раскладка
  // видит, поэтому адреса процедур за ним не уезжают. Запасной путь — для образа БЕЗ возврата
  // (бесконечный цикл): тогда выход ставится там, где кончается процедура точки входа, — но только
  // если программа печатает: без печати потоку есть куда деться, а без выхода печатающая программа
  // уходит за свой код и падает кодом 134 (§3.39).
  const fallbackExit = (): AsmInstruction[] => (prints ? exitPrimitives(0) : []);

  /**
   * ГРАНИЦЫ ВЫЗЫВАЕМОЙ ПРОЦЕДУРЫ, названные числами.
   *
   * Окно вызываемой при `size_q = 12` — **16** регистров (`%r0..%r15`; измерено порогом,
   * `src/e2k/e2kCallWindowQemu.test.ts`, §3.49). Прежняя редакция этого комментария говорила
   * «окно — восемь регистров, `%b[0..7]`»; после пересборки модели это **неверно**, и посылки
   * отказов приведены к факту (замер `.tmp/osnova-nested-wbs2.ts`, §3.51):
   *
   * | что | почему нельзя СЕГОДНЯ |
   * |---|---|
   * | вложенный вызов и рекурсия | кольцо окон: `call wbs = W` кладёт вызываемой `psize_q = size_q − W`, то есть `psize_q = size_q`; вложенный вызов обязан иметь `psize_q ≤ W₂ ≤ size_q`, значит `W₂ = size_q` **ровно**. Тогда у второй ступени `size_q = 0`, а аргументы легли бы в `%r(2*W₂) = %r(2*size_q)` — ровно за последним регистром окна вызывающей. Измерено: при `W₂ < psize_q` ловушка на самой `call`, при `W₂ = psize_q` — на входе вызываемой |
   * | системный вызов (и печать: она делает `write`) | тот же инвариант — системный вызов у нас тоже `call`, и номер идёт в `%r(2*wbs)`, то есть за границей окна процедуры. Замер с `wbs = 8`: вызов исполняется, но аргумент читается не оттуда — код **1** вместо 7 |
   * | вытеснение в памяти | смещением слота служит `%b[12]`: при окне 16 он ВНУТРИ окна — это ограничение снято; отказ держится лишь потому, что вытеснение в процедуре идёт вместе с рантаймом, а тот без системного вызова не работает |
   */
  const calleeLimit = (
    carrier: AsmInstruction,
    frame: { readonly grown: boolean },
  ): { code: LoweringRefusal['code']; reason: string } | undefined => {
    const mnemonic = carrier.mnemonic;
    // ПЕЧАТЬ ИЗ ПРОЦЕДУРЫ — БОЛЬШЕ НЕ ОТКАЗ (§3.58): системный вызов идёт по общим правилам перехода,
    // и в ВЫРАЩЕННОМ кадре он законен (номер в `%r16`, `wbs = 8`). Измерено матрицей
    // `.tmp/osnova-syscall-matrix.ts` и приёмкой задачи 29.
    if (frame.grown && (mnemonic === 'IR.print_write' || mnemonic === PRINT_TEXT_CARRIER)) return undefined;
    if (frame.grown && mnemonic === 'IR.invoke') return undefined;
    // ВЛОЖЕННЫЙ ВЫЗОВ БОЛЬШЕ НЕ ОТКАЗ: он был отказом, пока окно вызывающей не росло (тогда
    // `wbs = 8` при `size_q = 8` упиралось в `psize_q`, §3.51–§3.52). С 2026-09-29 пролог
    // вызывающей процедуры растит окно (`setwd wsz=16` + `setbn rsz=15`), и `wbs = 8` законен —
    // измерено `.tmp/osnova-mainAB.ts` (V3, код 7), правила и числа — docs/hardware-debt.md §3.56.5,
    // разбор — §3.57. Отказ `OSN-LOW-003` на рекурсию СНЯТ.
    if (mnemonic === 'IR.invoke') {
      return {
        code: LOWERING_CODES.runtime,
        reason:
          'операция рантайма из вызываемой процедуры невозможна: она делает системный вызов, а тот ' +
          'идёт через `call` и обязан иметь wbs ≥ psize_q = size_q процедуры; при wbs = psize_q ' +
          'номер и аргумент читаются не оттуда (замер: код 1 вместо 7), а меньший wbs порт ' +
          'отвергает (docs/hardware-debt.md §3.51)',
      };
    }
    if (mnemonic === 'IR.spill_ld' || mnemonic === 'IR.spill_st') {
      return {
        code: LOWERING_CODES.layout,
        reason:
          'вытеснение в памяти из вызываемой процедуры невозможно: ноль для адреса слота у ' +
          'вызываемой теперь ЕСТЬ (клетка `%r12` закреплена носителем `IR.callee_zero`, §3.166), ' +
          'поэтому прежняя причина отказа («клетки нуля нет») СНЯТА — но сам отказ сохранён по ' +
          'другой причине: вытеснение в процедуре идёт вместе с рантаймом массивов, а тот без ' +
          'системного вызова не работает; снятие отказа без замера на цели даёт не проверенное ' +
          'число, а тихую ложь (docs/hardware-debt.md §3.140, случай 55)',
      };
    }
    return undefined;
  };

  // ИНДЕКСАЦИЯ ПО ЧИСЛУ — НАЗВАННЫЙ ОТКАЗ, А НЕ ЧТЕНИЕ ПАМЯТИ (D4, случай 73 реестра).
  //
  // Считается по ТОМУ ЖЕ потоку, что понижается ниже (`planned`), и ДО цикла: индекс обязан совпасть
  // с шагом отказа (D11), иначе отказ назовёт чужой носитель — класс, который стережёт случай 58.
  // `constants.length` — граница ИСХОДНОГО пула: адреса статических байтов дописываются планированием
  // строк в ХВОСТ пула, и без этой границы адрес строки сошёл бы за литерал числа (`src/e2k/arrayRuntime.ts#arrayBaseProblems`).
  const arrayBaseProblemAt = new Map(
    arrayBaseProblems(
      planned,
      strings.constants,
      strings.invokeNames,
      constants.length,
      // ЧИСЛО ИЗ ТИПА (шаг 2.3, П4): `процедура ф(а: Число)` + `вернуть а[0]` сегодня даёт НОЛЬ отказов
      // и код 9 на модели (139 на железе) — тихая ложь. Список пуст, если типов не предъявили, и тогда
      // сторож ведёт себя как раньше, байт-в-байт.
      numberTypeFactsOf(procedures, options.procedureTypes),
      // НАГРУЗКА ПАРЫ БЕЗ ДОКАЗАННОГО УСПЕХА (шаг 2.3, случай 73): `нагрузка[0]` на сайте с
      // доказанной Неудачей (или с недоказанным тегом) обязана быть НАЗВАННЫМ отказом, а не чтением
      // памяти: замер `.tmp/a230-зонд-пара.ts` — `добыть("абв", 0)` + `нагрузка[0]` давало 0 отказов
      // и код 9 на модели.
      //
      // ГДЕ СЧИТАЕТСЯ: на `planned`, а НЕ на входном `code`. Планирование строк дописывает в НАЧАЛО
      // потока свой пролог (замер той же пробы: `IR.jmp`, `IR.callee_zero` — два носителя), поэтому
      // индексы сайтов пары на входном потоке на 2 МЕНЬШЕ, и набор, снятый с `code`, помечал бы чужой
      // носитель (класс «разведка разошлась с потоком», §3.134.6). Второй счёт запускается ТОЛЬКО
      // когда пары вообще есть (`size > 0`) — у программ без пар цена нулевая, и поведение прежнее.
      pairPicksForGuard(planned, pairProof),
    ).map((problem) => [problem.index, problem.reason]),
  );
  // ВРЕМЕННЫЕ СТРОКОВОГО РАНТАЙМА В ПЛОСКОСТИ ВЫЗЫВАЕМОЙ (шаг 2.3, случай 73) — тот же уговор, что у
  // клетки кучи: список нужды считается ЗДЕСЬ, по ТОМУ ЖЕ потоку, что понижается ниже (`planned`), иначе
  // номера процедур разошлись бы со списком, снятым до расширений, и закреплённая клетка не нашлась бы
  // (отказ называл бы «не закреплено» там, где закреплено). Слово о резерве приходит снаружи; разойдись
  // они — строковая операция в вызываемой остаётся НАЗВАННЫМ отказом, а не затирает значение программы.
  const stringCalleeAt = stringCalleeProcedures(planned, procedures, strings.invokeNames, entryAt);
  const stringsReadyAt: ReadonlySet<number> =
    stringCalleeAt.size > 0 && options.stringsCalleeReserved !== true ? new Set<number>() : stringCalleeAt;
  for (let index = 0; index < planned.length; index++) {
    // ШАГ ОТКАЗОВ ЭТОЙ ИТЕРАЦИИ (D11). Тело обёрнуто `try/finally`, потому что отказ уходит наружу и
    // через `continue`, и через `return`, — `finally` проставляет шаг в обоих случаях, а 20 точек
    // `refused.push` остаются нетронутыми. Отступ тела НАМЕРЕННО не переставлен: переотступление
    // четырёхсот строк сделало бы diff нечитаемым, а сам перенос шага — непроверяемым.
    const отказовДо = refused.length;
    try {
    const carrier = planned[index]!;
    if (index === entryEndsAt && !exitEmitted) {
      body.push(...fallbackExit());
      exitEmitted = true;
    }
    // Источники отказа, и КОД у каждого свой — он и есть личность причины:
    //   1. носитель не размещён (`layout.unplaced`) — код у причины своя (нет формы / печать / контракт);
    //   2. переходу не хватило смещения (`secondPass`) — код ставит второй проход;
    //   3. вызову не хватило адреса цели (`callAddresses`) — свой код;
    //   4. пара предикатов не составилась (`pairPredicates`) — код у сопоставления.
    const inCallee = procedures.length > 0 && procedureAt(procedures, index) !== entryAt;
    // БАЗА БЛОКА РАНТАЙМА МАССИВОВ для этой процедуры: её выдала раскладка (§3.128). `undefined` —
    // массивов в процедуре нет либо раскладку звали без списка процедур с массивами; тогда понижение
    // откажет по имени, а не угадает клетки.
    const arrayBase = (options.arrayBases ?? [])[procedureAt(procedures, index) ?? 0];
    if (process.env.OSN_DEBUG_BASE !== undefined && index < 14) {
      console.log(
        `[отладка базы] #${index} ${carrier.mnemonic}: процедура=${String(procedureAt(procedures, index))} ` +
          `процедур=${procedures.length} баз=${JSON.stringify(options.arrayBases ?? null)} выбрано=${String(arrayBase)}`,
      );
    }
    // На глубине ≥ 2 (процедура с выращенным окном) носители понижаются иначе — правила 3–5 §3.56.5, §3.58.
    const procedureStart = procedures[procedureAt(procedures, index) ?? 0]?.codeOffset ?? 0;
    const onDepthTwo = inCallee && depthTwo.has(procedureStart);
    /** Глубина вызова этой процедуры от точки входа (0 — сама точка входа). */
    const depth = depthOf.get(procedureAt(procedures, index) ?? 0) ?? 0;
    /**
     * ЗАКРЕПЛЁН ЛИ АДРЕС ЯЧЕЙКИ КУЧИ В ОКНЕ ЭТОЙ ПРОЦЕДУРЫ (A4 §3.137): носитель `IR.array_slot`
     * стоит в её прологе роста, и `%b[15]` у неё занят адресом. Тогда `создать` в вызываемой
     * понижается, а не отказывает.
     */
    const heapSlotReady = inCallee && heapSlotReadyAt.has(procedureAt(procedures, index) ?? 0);
    /** Выращен ли кадр этой процедуры: в нём и вызов, и системный вызов идут иначе. */
    const grownFrame = onDepthTwo;
    /** Кадр системного вызова для этого носителя: выращенный — у процедуры, иначе кадр точки входа
     * (с возвратом блока рантайма массивов, если образ его использует — D12). */
    const frame = inCallee && grownFrame ? GROWN_SYSCALL_FRAME : entryFrame;
    const limit = inCallee ? calleeLimit(carrier, { grown: grownFrame }) : undefined;
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
    // Индексация по ДОКАЗУЕМО-ЧИСЛОВОЙ базе: причина уже составлена планом вместе с номером шага.
    // Стоит ПОСЛЕ отказов раскладки: если носитель не размещён, первым обязан прозвучать тот отказ —
    // он про то, что программа не собирается вовсе, а не про смысл операции.
    const arrayBaseProblem = arrayBaseProblemAt.get(index);
    if (arrayBaseProblem !== undefined) {
      refused.push(refusalOf(LOWERING_CODES.runtime, arrayBaseProblem));
      continue;
    }
    const inSelfCalling = selfCalling.has(index);
    const plan = printPlans.get(index);
    if (plan !== undefined) {
      if (inSelfCalling) {
        refused.push(
          refusalOf(
            LOWERING_CODES.print,
            `#${index} ${carrier.mnemonic}: печать из процедуры, которая зовёт СЕБЯ, не проверена — ` +
              'первая стена названа (замер 2026-09-29, §3.60): печать занимает %b[0..11], живые регистры ' +
              'надо сохранять, а вытеснение в процедуре отказано (IR.spill_st — свой отказ); поведение ' +
              'без вытеснения не измерено',
          ),
        );
        continue;
      }
      if (inCallee && !grownFrame) {
        // Печать из процедуры возможна ТОЛЬКО в выращенном кадре: её syscall идёт с `wbs = 8`, а без роста
        // окна кадр ядра пуст (порт аварийно завершается). Рост ставит подготовка потока — если его нет,
        // это дефект подготовки, а не программы.
        refused.push(
          refusalOf(
            LOWERING_CODES.print,
            `#${index} ${carrier.mnemonic}: печать из процедуры без выращенного окна — ` +
              'пролог `IR.window_grow` обязан стоять (src/e2k/programImage.ts:windowGrowthAt)',
          ),
        );
        continue;
      }
      // Развёртка целиком: сохранение живых → число в текст и `write` → восстановление. Выхода
      // здесь НЕТ: печатающая программа завершается один раз в конце образа (§3.39, запись `43`
      // печатает в цикле).
      body.push(...printSiteInstructions(plan, frame));
      continue;
    }
    // ── СТРОКИ: вывод и две операции ─────────────────────────────────────────────────────────────
    if (carrier.mnemonic === 'IR.invoke') {
      const marks = stringMarksOf(carrier);
      const name = ((): string | undefined => {
        const payload = carrier.operands[3];
        return payload !== undefined && payload.kind === 'imm' ? strings.invokeNames[payload.value] : undefined;
      })();
      const stringPrint = stringPrintPlans.get(index);
      if (stringPrint !== undefined) {
        if (inCallee && !grownFrame) {
          refused.push(
            refusalOf(
              LOWERING_CODES.print,
              `#${index} ${String(name)}: печать строки из процедуры без выращенного окна — пролог ` +
                '`IR.window_grow` обязан стоять (src/e2k/programImage.ts:windowGrowthAt)',
            ),
          );
          continue;
        }
        const argument = printArgumentOf(carrier);
        const [byteLength, newlineAddress] = marks;
        if (argument === undefined || byteLength === undefined || newlineAddress === undefined) {
          refused.push(
            refusalOf(
              LOWERING_CODES.print,
              `#${index} ${String(name)}: у печати строки нет регистра, длины или адреса перевода строки`,
            ),
          );
          continue;
        }
        for (const item of stringPrint.saved) {
          body.push(
            { mnemonic: 'movtd', channel: 0, operands: [imm(item.address), base(stringPrint.scratch)] },
            { mnemonic: 'std', channel: 2, operands: [base(item.register), base(stringPrint.scratch), base(ARRAY_REGISTERS.zero)] },
          );
        }
        body.push(
          ...stringWriteInstructions({
            address: argument,
            byteLength,
            newlineAddress,
            frame,
          }),
        );
        for (const item of stringPrint.saved) {
          body.push(
            { mnemonic: 'movtd', channel: 0, operands: [imm(item.address), base(stringPrint.scratch)] },
            { mnemonic: 'ldd', channel: 0, operands: [base(stringPrint.scratch), base(ARRAY_REGISTERS.zero), base(item.register)] },
          );
        }
        continue;
      }
      if (
        (name === 'система.массив.установить' || isArrayCreateCall(name ?? '')) &&
        inCallee &&
        depth >= 2
      ) {
        // ЗАПИСЬ В ПАМЯТЬ РАНТАЙМА МАССИВОВ ИЗ ГЛУБИНЫ ≥ 2 — ОТКАЗ ПО ИМЕНИ, А НЕ ПЕТЛЯ (§3.135, §3.137).
        //
        // Замер 2026-10-24 (`.tmp/osnova-3135-deep.ts`, `.tmp/osnova-3135-discriminate.ts`):
        //   • `а[0] = 7` в вызываемой ГЛУБИНЫ 1 — код 7 (работает);
        //   • ЧТЕНИЕ `а[0]` из ТОЙ ЖЕ клетки в глубине 2 — работает, и блок при этом стоит в тех же
        //     клетках (`%b[12..14]`), что у записи: различие не в месте блока и не в адресе;
        //   • запись из глубины 2 — ни выхода, ни исключения за 90 с (модель зацикливается).
        //
        // ЗАМЕР 2026-10-29, ТРАССА ПОРТА ПО АДРЕСАМ (`.tmp/osnova-a4s3-low004-ШАГ2.md`, проба `к`,
        // ELF sha256 52f8755ae4090e97): петля стоит РОВНО на `std` записи элемента (pc = 0x1000d0) —
        // до неё дошли (исполнены пролог вызываемой и все пять `addd` вычисления адреса), после неё
        // (`movts`, `return`, `ct`) — ни разу за 6 с; тот же `std` с ТЕМИ ЖЕ операндами и в тех же
        // клетках при входе с `wbs = 4` (глубина 1) завершается. Единственные измеренные различия —
        // вход `call wbs = 16` (`INNER_CALL_WBS`) и ширина кадра вызывающего (`rsz = 0x1f` против
        // `0x7`). Механизм (почему `std` не завершается именно в таком входе) НЕ УСТАНОВЛЕН —
        // поэтому причина и названа «не установлена», а не выдана за найденную.
        //
        // `создать` здесь ПОТОМУ ЖЕ: его последовательность тоже пишет `std` (слово длины и ячейка
        // кучи), и глубина ≥ 2 — тот же вход. Иначе снятие отказа для `создать` открыло бы петлю.
        //
        // ЗАМЕР 2026-10-29, РЕШАЮЩИЙ: ТА ЖЕ ПРОБА НА ЖЕЛЕЗЕ ПРОХОДИТ. Образ
        // `.tmp/a4s3-k.elf` (sha256 52f8755ae4090e97 — тот самый, что зацикливается в модели)
        // прогнан на живой машине (`mmpvbg@w205p.mcst.ru:8194`, `timeout -s KILL 20`) ТРИ раза и
        // каждый раз вернул сторожевой код **3** — то есть `std` ЗАВЕРШИЛСЯ и управление ушло на
        // возврат (в модели `movts 3 → %r11` не исполнялся ни разу). Значит **стена — МОДЕЛИ, а не
        // цели**: наши байты на цели верны, а наш порт QEMU в этом входе `std` не завершает.
        //
        // Отказ при этом ОСТАЁТСЯ: все числа проекта берутся с модели (`src/e2k/qemuModelPassport.ts`),
        // и снять отказ значило бы объявить поведение проверенным там, где проверять нечем. Смена
        // политики верификации («принимать это место по железу») — решение владельца, а не побочный
        // эффект правки (A4 §3.137, `docs/verification-debt.md`, случай 48).
        refused.push(
          refusalOf(
            LOWERING_CODES.layout,
            `#${index} ${name}: запись в память рантайма массивов из плоскости, вошедшей выращенным ` +
              `кадром (глубина ${String(depth)}) — замер 2026-10-29: МОДЕЛЬ зацикливается РОВНО на ` +
              '`std` (0x1000d0: до записи доходит, после — ни разу), а ТА ЖЕ проба на ЖЕЛЕЗЕ ' +
              'проходит (код 3, три прогона): стена МОДЕЛИ, а не цели; пока числа берутся с модели — ' +
              'отказ вместо петли (A4 §3.135/§3.137)',
          ),
        );
        continue;
      }
      if (name === STRING_CALLS.symbol) {
        if (inCallee && !stringsReadyAt.has(procedureAt(procedures, index) ?? -1)) {
          refused.push(
            refusalOf(
              LOWERING_CODES.runtime,
              `#${index} ${name}: строковая операция в вызываемой процедуре невозможна — её временные ` +
                'клетки %b[10], %b[11] и %b[13] НЕ ЗАКРЕПЛЕНЫ за рантаймом (закреплён только %b[12] — ' +
                'клетка нуля, §3.166), и раскладка отдала бы их значениям программы: рантайм затёр бы ' +
                'их МОЛЧА. Резерв делается УСЛОВНО тем, кто раскладывал (stringCalleeProcedures → ' +
                'stringsCalleeReserved); разойдись он с нуждой — отказ, а не порча',
            ),
          );
          continue;
        }
        const destination = carrier.operands[4];
        const indexRegister = carrier.operands[2];
        const baseRegister = carrier.operands[1];
        const [codePoints, tableAddress] = marks;
        if (destination?.kind !== 'reg' || indexRegister?.kind !== 'reg' || baseRegister?.kind !== 'reg') {
          refused.push(
            refusalOf(LOWERING_CODES.runtime, `#${index} ${name}: индекс или приёмник не регистр — выбрать код нечем`),
          );
          continue;
        }
        // ДЕСКРИПТОР (TD-0001): числа сборке не известны — их читает сам рантайм по адресу значения.
        if (codePoints === STRING_DESCRIPTOR_MARK) {
          body.push(
            ...stringSymbolFromDescriptorInstructions({
              base: baseRegister.index,
              index: indexRegister.index,
              destination: destination.index,
            }),
          );
          continue;
        }
        if (codePoints === undefined || tableAddress === undefined) {
          refused.push(
            refusalOf(LOWERING_CODES.runtime, `#${index} ${name}: нет числа кодпоинтов или адреса таблицы кодов`),
          );
          continue;
        }
        body.push(
          ...stringSymbolInstructions({
            index: indexRegister.index,
            destination: destination.index,
            codePoints,
            tableAddress,
          }),
        );
        continue;
      }
      if (name === STRING_CALLS.length || name === STRING_CALLS.concat) {
        if (inCallee && !stringsReadyAt.has(procedureAt(procedures, index) ?? -1)) {
          refused.push(
            refusalOf(
              LOWERING_CODES.runtime,
              `#${index} ${name}: строковая операция в вызываемой процедуре невозможна — её временные ` +
                'клетки %b[10], %b[11] и %b[13] НЕ ЗАКРЕПЛЕНЫ за рантаймом (закреплён только %b[12] — ' +
                'клетка нуля, §3.166), и раскладка отдала бы их значениям программы: рантайм затёр бы ' +
                'их МОЛЧА. Резерв делается УСЛОВНО тем, кто раскладывал (stringCalleeProcedures → ' +
                'stringsCalleeReserved); разойдись он с нуждой — отказ, а не порча',
            ),
          );
          continue;
        }
        const destination = carrier.operands[4];
        const first = carrier.operands[1];
        const second = carrier.operands[2];
        if (destination?.kind !== 'reg' || first?.kind !== 'reg') {
          refused.push(refusalOf(LOWERING_CODES.runtime, `#${index} ${String(name)}: строковая операция без регистров`));
          continue;
        }
        if (name === STRING_CALLS.length) {
          const [byteLength, tableAddress] = marks;
          // ДЕСКРИПТОР (TD-0001): длины сборке не известно — число кодпоинтов читает сам рантайм.
          if (byteLength === STRING_DESCRIPTOR_MARK) {
            body.push(
              ...stringLengthFromDescriptorInstructions({ base: first.index, destination: destination.index }),
            );
            continue;
          }
          if (byteLength === undefined || tableAddress === undefined) {
            refused.push(
              refusalOf(LOWERING_CODES.runtime, `#${index} ${name}: нет длины строки или адреса таблицы продолжений`),
            );
            continue;
          }
          body.push(
            ...stringLengthInstructions({
              base: first.index,
              byteLength,
              destination: destination.index,
              tableAddress,
            }),
          );
          continue;
        }
        const [firstBytes, secondBytes, bufferAddress] = marks;
        if (firstBytes === undefined || secondBytes === undefined || bufferAddress === undefined || second?.kind !== 'reg') {
          refused.push(
            refusalOf(LOWERING_CODES.runtime, `#${index} ${name}: нет длин склеиваемых строк или адреса буфера`),
          );
          continue;
        }
        body.push(
          ...stringConcatInstructions({
            first: first.index,
            second: second.index,
            destination: destination.index,
            bufferAddress,
            firstBytes,
            secondBytes,
          }),
        );
        continue;
      }
    }
    // ── СКЛЕЙКА СВЕРХ СТАТИЧЕСКОГО БУФЕРА: копирование байтов В БЛОК АРЕНЫ ───────────────────────
    //
    // Выделение и проверка предела к этому месту уже сделаны: их выпустила группа арены
    // (`src/e2k/arenaRuntime.ts#arenaGroups`) — и командами того же сайта, что у
    // `система.память.выделить`. Здесь только байты: база записи — регистр-приёмник выделения.
    if (carrier.mnemonic === STRING_ARENA_COPY_CARRIER) {
      // ГРАНИЦА ШАГА 2.3 (случай 73): здесь снят НЕ тот отказ. Статические строковые операции
      // (`символ`, `длина`, склейка В СТАТИЧЕСКИЙ буфер) в вызываемой теперь работают — их временные
      // клетки закрепляются условно (`stringsCalleeReserved`). А ЭТА склейка идёт в блок АРЕНЫ, то
      // есть требует ВЫДЕЛЕНИЯ — системного вызова из вызываемой, а он не разблокирован: порядок
      // назван владельцу (§3.138.4: образ → место строковому рантайму → системный вызов из
      // вызываемой), и до него отказ остаётся НАЗВАННЫМ. Снятие его молча дало бы в теле вызываемой
      // последовательность системного вызова, о которой раскладка ничего не знает.
      if (inCallee) {
        refused.push(
          refusalOf(
            LOWERING_CODES.runtime,
            `#${index} ${STRING_CALLS.concat}: склейка сверх статического буфера в вызываемой процедуре ` +
              'невозможна — она требует ВЫДЕЛЕНИЯ БЛОКА У АРЕНЫ, то есть системного вызова, а системный ' +
              'вызов из вызываемой не разблокирован (порядок §3.138.4); временные клетки строкового ' +
              'рантайма при этом закреплены условно (шаг 2.3) и к этому отказу отношения не имеют',
          ),
        );
        continue;
      }
      const first = carrier.operands[0];
      const second = carrier.operands[1];
      const block = carrier.operands[2];
      const firstBytes = carrier.operands[3];
      const secondBytes = carrier.operands[4];
      if (
        first?.kind !== 'reg' ||
        second?.kind !== 'reg' ||
        block?.kind !== 'reg' ||
        firstBytes?.kind !== 'imm' ||
        secondBytes?.kind !== 'imm'
      ) {
        refused.push(
          refusalOf(
            LOWERING_CODES.runtime,
            `#${index} ${STRING_CALLS.concat}: у копирования в блок арены не та форма операндов ` +
              '(нужны две строки, регистр блока и две длины) — их ставит планирование строк',
          ),
        );
        continue;
      }
      body.push(
        ...stringArenaCopyInstructions({
          first: first.index,
          second: second.index,
          base: block.index,
          firstBytes: firstBytes.value,
          secondBytes: secondBytes.value,
        }),
      );
      continue;
    }
    // Носитель САЙТА склейки, доживший до понижения, — дефект конвейера: его обязан был расширить
    // `arenaGroups` (src/e2k/arenaRuntime.ts), и там же лежит проверка предела. Названо, а не «нет формы».
    if (carrier.mnemonic === STRING_ARENA_CONCAT_CARRIER) {
      refused.push(
        refusalOf(
          LOWERING_CODES.runtime,
          `#${index} ${STRING_CALLS.concat}: носитель склейки в арене не расширен группой арены — ` +
            'это дефект конвейера (src/e2k/arenaRuntime.ts#arenaGroups), а не программы',
        ),
      );
      continue;
    }
    if (carrier.mnemonic === PRINT_TEXT_CARRIER) {
      // ТЕЛО ЛИСТОВОЙ ПРОЦЕДУРЫ: развёртка «число → текст». Она живёт в вызываемой, поэтому все её
      // регистры — оконные (измерено: базовая форма в вызываемой даёт исключение на первой команде).
      if (!inCallee) {
        refused.push(
          refusalOf(
            LOWERING_CODES.print,
            `#${index} ${PRINT_TEXT_CARRIER}: тело разделённой печати стоит ВНЕ вызываемой процедуры — ` +
              'это дефект разделения (src/e2k/programImage.ts:sharePrintSites), а не программы',
          ),
        );
        continue;
      }
      body.push(...withWindowRegisters(printTextInstructions(heapAddress)));
      continue;
    }
    if (carrier.mnemonic === PRINT_WRITE_CARRIER) {
      // ХВОСТ `write` — у ВЫЗЫВАЮЩЕГО: только у него есть оконный регистр под номер системного вызова.
      if (inCallee) {
        // ГРАНИЦА ЗАФИКСИРОВАНА ОКОНЧАТЕЛЬНО (task-33, §3.62). Разделённая печать из процедуры:
        // скрытая процедура «число → текст» вызывается ИЗ ВЫРАЩЕННОГО КАДРА — и модель на этом встаёт
        // МОЛЧА. Из кадра точки входа ТОТ ЖЕ вызов работает (контроль: `1\n2\n`, код 0).
        //
        // ИСКЛЮЧЕНО ЗАМЕРАМИ (четыре кандидата, все с числами):
        //   1) форма регистров — в теле 0 базовых из 116 команд (дизассемблер, §3.61.1);
        //   2) хвост `write` — различитель `wbs = 4` даёт исключение ровно на `call` (IP 0x100078, §3.60.6);
        //   3) окно скрытой процедуры — её собственный рост исход не меняет (§3.60.2);
        //   4) разная ширина у одного тела — оба сайта в ВЫРАЩЕННЫХ кадрах (одна ширина 8) виснут так же
        //      (20 069 мс, порт напрямую: вывода НЕТ вовсе), а оба в точке входа (ширина 4) работают
        //      (`1\n2\n`, код 0, 1 124 мс) — §3.62.2.
        //
        // НЕПОНЯТОЕ (одной фразой): почему переход в это тело из выращенного кадра не исполняется при
        // ЗАКОННОЙ ширине 8, хотя тот же переход в другие тела (§3.57, рекурсия) работает.
        refused.push(
          refusalOf(
            LOWERING_CODES.print,
            `#${index} ${PRINT_WRITE_CARRIER}: разделённая печать из процедуры — ЗАФИКСИРОВАННАЯ ГРАНИЦА: ` +
              'вызов скрытой процедуры «число → текст» из выращенного кадра модель не исполняет (молчание, ' +
              'таймаут 20 000 мс, порт напрямую — вывода нет вовсе), а из кадра точки входа тот же вызов ' +
              'работает; исключены замером форма регистров (0 базовых из 116), хвост write, окно листа и ' +
              'разная ширина у одного тела (docs/hardware-debt.md §3.62)',
          ),
        );
        continue;
      }
      body.push(...printWriteInstructions(heapAddress, frame));
      continue;
    }
    if (carrier.mnemonic === EXIT_CARRIER) {
      // ВЫХОД ПРОГРАММЫ: носитель, а не приписка — его байты раскладка посчитала заранее.
      const value = carrier.operands[1];
      // КОД ВЫХОДА — ИЗ ОПЕРАНДА НОСИТЕЛЯ, а не константа: механизм один (подготовка образа),
            // и ненулевой код обязан доходить до байтов (§3.81).
            const exitCode = carrier.operands[0];
            body.push(
              ...exitCarrierInstructions(
                exitCode !== undefined && exitCode.kind === 'imm' ? exitCode.value : 0,
                value?.kind === 'reg' ? value.index : undefined,
              ),
            );
      exitEmitted = true;
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
      // Рантайм массивов узнаёт, что понижается ВЫЗЫВАЕМАЯ процедура: её куча недоступна, обращения
      // идут оконной формой. Без этого признака `создать`/`добавить` двигали бы чужую клетку (§3.127).
      ...(inCallee ? { inCallee: true } : {}),
      // Адрес ячейки кучи в этой плоскости закреплён прологом роста (A4 §3.137) — тогда `создать`
      // в вызываемой понижается; нет слова — отказ по имени внутри `lowerArrayCall`.
      ...(heapSlotReady ? { heapSlotReady: true } : {}),
      ...(arrayBase === undefined ? {} : { arrayBase }),
      // На глубине ≥ 2 — свой `wbs = 8` (окно выращено прологом процедуры) и измеренный порядок
      // возврата «`return` → значение → `ct`» (§3.56.3, V3 против V2).
      ...(onDepthTwo ? { callWbs: INNER_CALL_WBS, returnAfterCall: true } : {}),
    });
    if (!lowered.ok) {
      refused.push(refusalWithSource(lowered.code, `#${index} ${carrier.mnemonic}: ${lowered.reason}`, carrier.sourceRef));
      continue;
    }
    // ОКОННАЯ ФОРМА РЕГИСТРОВ В ВЫЗЫВАЕМОЙ. Измерено (`.tmp/osnova-call-enter.ts`): в вызываемой
    // процедуре БАЗОВАЯ форма (`%b[N]`, без бита окна) даёт исключение на первой же команде тела,
    // тогда как та же команда оконной формой (`%rN`) исполняется. Поэтому весь код вызываемой
    // переводится в оконную форму одним преобразованием здесь, а не в каждой ветви понижения:
    // второй список мест разошёлся бы с первым (правило «один путь»).
    body.push(...(inCallee ? withWindowRegisters(lowered.instructions) : lowered.instructions));
    } finally {
      // Каждый отказ, принятый В ЭТОЙ итерации, получает шаг = индекс её носителя. Порядок сохраняется:
      // `refused` и `refusedSteps` растут только здесь и только вместе.
      for (let уже = отказовДо; уже < refused.length; уже++) refusedSteps.push(index);
    }
  }
  if (!exitEmitted) body.push(...fallbackExit());

  const instructions: AsmInstruction[] = [...arrayPrologue(heapAddress), ...body];

  // ── НЕРАЗЛОЖЕННЫЙ ПОТОК НЕ КОДИРУЕТСЯ (ATOM-07-02, маскировка отказа) ─────────────────────────
  //
  // ГДЕ БЫЛ ДЕФЕКТ (замер 2026-11-07, §3.181). При отказе раскладки конвейер зовёт эту функцию на
  // ДИАГНОСТИЧЕСКОМ потоке (`options.diagnosticFlow`), где носители сохранили ВИРТУАЛЬНЫЕ номера
  // регистров, — это сделано ЧЕСТНО, чтобы перепись отказов (носители/стадии) не пропала под отказом.
  // Но кодирование шло и здесь: кодировщик упирался в первый же виртуальный номер и бросал
  // `«movts»: базовых регистров 32 … %b[32]`, то есть ОТКАЗ ПОДМЕНЯЛСЯ ИСКЛЮЧЕНИЕМ, а причина
  // (недостаток вытеснений) не называлась. Замер: та же зелёная программа с безобидным балластом из
  // 24 операторов падала `%b[32]`, с 64 — `регистр 70 не выражается полем оболочки`; замена литерала
  // (`131 → 3`) сохраняла `%b[32]`, то есть литерал был не при чём.
  //
  // ПОЧЕМУ НЕ КОДИРОВАТЬ БЕЗОПАСНО. Кодирование стоит ПОСЛЕ цикла, который собирает отказы носителей
  // (`refused`/`refusedSteps` растут только там), и после него в этой функции НЕ ДОБАВЛЯЕТСЯ ни одной
  // записи отказа — только стражи места и статики, которые читают `bytes.length` (с пустыми байтами
  // они молчат, и это верно: длина кода неразложенного потока не имеет смысла). Байты этого образа
  // наружу не уходят ВООБЩЕ: `src/e2k/guards/loweredUnchecked.ts` гасит их под отказом раскладки
  // (буква D13 — «числа под отказом не существует»), и второй потребитель
  // (`src/e2k/e2kRealRun.ts`) не кодирует диагностический поток, а считает по нему приборы.
  // Поэтому пустые байты здесь не отнимают ни одного наблюдения и снимают ровно одну ложь.
  const chunks =
    options.diagnosticFlow === true ? [] : instructions.map((instruction) => encoder.encode(instruction));
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  // ── СТОРОЖ МЕСТА: ГРАНИЦА — СТРАНИЦА, А НЕ АДРЕС (замер 2026-09-29, §3.90.7) ─────────────────
  //
  // Писать программа вправе только туда, где НЕТ КОДА, и запрет проходит **по страницам**: QEMU
  // делает страницу переведённого кода защищённой (`src/e2k/elfMinimal.ts`), поэтому запись разрядов
  // в ТУ ЖЕ страницу, где лежит код, кончается `QEMU internal SIGSEGV {code=ACCERR}` — даже если до
  // адреса площадки код не дошёл.
  //
  // ЗАМЕР (три программы, один и тот же путь):
  //
  // | программа | конец кода | страница площадки (0x101000) | модель |
  // |---|---|---|---|
  // | `48-память-выделение` | `0x1008d0` | свободна | код 0, вывод есть |
  // | 28 сайтов печати (прежняя редакция этого сторожа считала их «влезающими»!) | `0x101c60` | **занята кодом** | **139**, ACCERR на `0x101ecb` |
  // | запись `49` как задумана (склейка 50 байт) | `0x101480` | **занята кодом** | **139**, ACCERR на `0x101ecb` |
  //
  // Отсюда же снимается ОГОВОРКА прежней редакции: замер §3.40.6 («ACCERR на 0x101ec5 при 4384 байтах
  // от `MINIMAL_BASE`» = `0x101120`) — тот же случай: код вошёл в страницу площадки, а до самой
  // площадки не дошёл. Граница сторожа была адресной, а настоящая — страничная; сторож, отказывающий
  // верному и пропускающий неверное, — один и тот же класс дефекта.
  //
  // ГДЕ НАЧИНАЕТСЯ КОД — ПРОВЕРЕНО ЗАГОЛОВКАМИ ELF, И ЭТО `MINIMAL_BASE` (2026-09-28,
  // `.tmp/osnova-elf-address.ts`): `e_entry = 0x100000`, единственный `PT_LOAD` несёт
  // `p_offset = 0x1000` при `p_vaddr = 0x100000` — то есть `0x1000` это смещение `.text` **в файле**,
  // а не в памяти.
  const writeTargets: { readonly what: string; readonly address: number }[] = [];
  if (prints) {
    writeTargets.push({ what: 'площадка печати', address: printAreaOf(heapAddress) });
  }
  if (strings.bufferAddress !== undefined) {
    writeTargets.push({ what: 'статический буфер склейки', address: strings.bufferAddress });
  }
  for (const address of options.spilledAddresses ?? []) {
    writeTargets.push({ what: `слот вытеснения ${address.toString(16)}`, address });
  }
  if (arenaUsed) writeTargets.push({ what: 'арена', address: ARENA_BASE });
  if (usesArrayHeap(code, invokeNames)) {
    writeTargets.push({ what: 'куча массивов', address: heapAddress });
  }
  // ОТЧЁТ О ХВОСТЕ — наружу, к построению ELF: куча, арена и вся область записи лежат ВЫШЕ кода, и
  // без `extraMemory` первое же обращение к ним встало бы исключением. Число одно на всю область
  // записи (`src/e2k/elfMinimal.ts#WRITE_ZONE_EXTRA_MEMORY`): страница площадки/слотов и страница
  // кучи с ареной. Образ, который НИКУДА не пишет, обходится началом хвоста.
  const arenaReport = {
    used: arenaUsed,
    extraMemory: writeTargets.length > 0 ? WRITE_ZONE_EXTRA_MEMORY : HEAP_OFFSET,
  };
  if (writeTargets.length > 0) {
    const pageOf = (address: number): number => address - (address % WRITE_PAGE_BYTES);
    const barrier = writeTargets.reduce((lowest, target) => Math.min(lowest, pageOf(target.address)), Number.MAX_SAFE_INTEGER);
    const lowest = writeTargets.reduce((first, target) => (pageOf(target.address) < pageOf(first.address) ? target : first));
    const codeEnd = MINIMAL_BASE + bytes.length;
    if (codeEnd > barrier) {
      throw new PrintCallRefusal(
        `место записи: код образа кончается на ${codeEnd.toString(16)} (кода ${String(bytes.length)} байт), а ` +
          `страница записи начинается на ${barrier.toString(16)} — в неё попадает «${lowest.what}» ` +
          `(${lowest.address.toString(16)}). Это НАЧАЛО СЕГМЕНТА ДАННЫХ (код ` +
          '`R|X`, данные `R|W` — `src/e2k/elfMinimal.ts#DATA_SEGMENT_BASE`): сегменты не имеют права ' +
          'накладываться, поэтому код не может дойти до этого адреса. Граница названа числом: ' +
          '64 КиБ кода при нынешней раскладке (замер 2026-09-30: 300 сайтов печати — кода 63 840, ' +
          'конец 0x10f960 — собираются; 320 — отказ). Разбор — docs/hardware-debt.md §3.93',
      );
    }
  }
  // ── СТАТИЧЕСКИЕ БАЙТЫ СТРОК: дописать в образ там, где их ждут адреса ──────────────────────────
  //
  // Адреса блобов выведены из конца образа (`printArea − размер`), поэтому байты обязаны лежать
  // РОВНО по этим адресам: между кодом и блобом — нули. Если код дорос до блоба, это НАЗВАННЫЙ ОТКАЗ
  // с числами: молчаливая порча строк (или команд) — ровно тот класс, который здесь недопустим.
  //
  // ГДЕ ОБРАЗ В ПАМЯТИ — ИЗМЕРЕНО, и это `MINIMAL_BASE`, а не `+ 0x1000`: `0x1000` — смещение `.text`
  // в ФАЙЛЕ (`IMAGE_TEXT_OFFSET`), а `PT_LOAD` кладёт его по `vaddr = base`. Проба с дампом памяти
  // (`.tmp/osnova-image-dump.ts`): по `0x101000` гость видит нули, а по `0x100000` — первые байты
  // своей программы (`01 ff fd …` = `setbn`). Поэтому смещение статики считается от `MINIMAL_BASE`.
  if (strings.blobs.length > 0) {
    const staticOffset = strings.staticStart - MINIMAL_BASE;
    if (staticOffset < bytes.length) {
      throw new PrintCallRefusal(
        `строки: код образа — ${String(bytes.length)} байт, а статические байты строк начинаются на смещении ` +
          `${String(staticOffset)} (адрес ${strings.staticStart.toString(16)}): код дорос до них. ` +
          'Статическая область лежит под площадкой печати, и сдвинуть её некуда — там куча; ' +
          'строки придётся укоротить или печатать их иначе (docs/hardware-debt.md §3.48)',
      );
    }
    const withStatics = new Uint8Array(staticOffset + staticBytesOf(strings));
    withStatics.set(bytes, 0);
    for (const blob of strings.blobs) {
      withStatics.set(Uint8Array.from(blob.bytes), blob.address - MINIMAL_BASE);
    }
    return { bytes: withStatics, refused, refusedSteps, arena: arenaReport };
  }
  return { bytes, refused, refusedSteps, arena: arenaReport };
}
