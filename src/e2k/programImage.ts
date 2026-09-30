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
import { ARRAY_REGISTERS, SUPPORTED_ARRAY_CALLS, arrayPrologue } from './arrayRuntime';
import { allocateProgram } from './regAlloc';
import { layoutOf, secondPass, carrierFormOf } from './twoPassLayout';
import { pairPredicates } from './predicatePairing';
import { MINIMAL_BASE, SYSCALL_WBS, WRITE_ZONE_EXTRA_MEMORY, IMAGE_TAIL_OFFSET, spillBaseOf } from './elfMinimal';
import {
  ENTRY_SYSCALL_FRAME,
  GROWN_SYSCALL_FRAME,
  SYS_EXIT,
  WINDOW_NUMBER_REGISTER,
} from './syscallRuntime';
import { defUseOf } from './liveness';
import { cfgLiveSets } from '../vliw/cfg';
import { exitPrimitives, printAreaOf } from './printPrimitives';
import { LOWERING_CODES, LoweringRefusalError, refusalOf, type LoweringRefusal } from './loweringRefusal';
import { STRING_MARK_OPERAND, isStringPrint, planStrings, staticBytesOf, stringMarksOf } from './stringPlan';
import { INNER_CALL_WBS, WINDOW_GROW_CARRIER } from './procedureCall';
import {
  ARENA_BASE,
  ARENA_REFUSAL_TEXT,
  arenaGroups,
  arenaRefusalCarriers,
  arenaReservedRegisters,
  usesArena,
} from './arenaRuntime';
import { STRING_CALLS, STRING_ARENA_CONCAT_CARRIER, STRING_ARENA_COPY_CARRIER, stringArenaCopyInstructions } from './stringRuntime';
import {
  STRING_PRINT_CLOBBERS,
  stringConcatInstructions,
  stringLengthInstructions,
  stringWriteInstructions,
} from './stringRuntime';
import {
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
  type PrintSitePlan,
} from './printCall';

const encoder = getEncoder('e2k');
const shellEncoder = getEncoder('internal-shell');

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
        refusalOf(
          LOWERING_CODES.print,
          `#${index} ${carrier.mnemonic}: у печати нет регистра значения — разделённому сайту нечего передать вызовом`,
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
      const busy = new Set<number>([...plan.saved.map((item) => item.register), argument.index, plan.scratch]);
      const zero = [0, 1, 3, 5, 7].find((register) => !busy.has(register));
      if (zero === undefined) {
        problems.push(
          refusalOf(
            LOWERING_CODES.print,
            `#${index} ${carrier.mnemonic}: разделённому сайту нужен НИЗКИЙ регистр под ноль ` +
              `(ноль рантайма %b[12] после вызова недоступен), а свободных в %b[0,1,3,5,7] нет: ` +
              `заняты ${[...busy].sort((a, b) => a - b).map((r) => `%b[${String(r)}]`).join(', ')}`,
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
        refusalOf(
          LOWERING_CODES.print,
          `#${index} ${carrier.mnemonic}: разделённый сайт не спланирован — ` +
            (error instanceof Error ? error.message : String(error)),
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
export function loweredProgram(source: string): {
  bytes: Uint8Array;
  refused: readonly LoweringRefusal[];
  used: number;
  arena: { readonly used: boolean; readonly extraMemory: number };
} {
  const built = regModuleOf(source);
  if (built === null) throw new Error('программа не компилируется');
  const annotated = annotateAtomRegions(built.module, [
    { atom: 'A5', procedures: built.module.procedures.map((procedure) => procedure.name) },
  ]);
  const emitted = emitShell(annotated, shellEncoder);
  // АРЕНА ЗАБИРАЕТ РЕГИСТРЫ СЕБЕ: указатель, предел и ключ предиката она пишет и читает в обход
  // потока носителей, поэтому раскладка не имеет права их отдать (иначе значение легло бы туда же
  // и было бы затёрто молча). Список резервируется ТОЛЬКО тогда, когда образ ареной пользуется:
  // у прочих программ он пуст, и закреплённые числа пяти ядер не двигаются.
  //
  // Решение принимается ЗДЕСЬ и ДО раскладки, а знает его планирование строк: ареной пользуется не
  // только явный `система.память.выделить`, но и **склейка сверх статического буфера**. Поэтому
  // идёт РАЗВЕДКА тем же проходом (`planStrings`) по потоку ДО раскладки — второй счётчик длин
  // разошёлся бы с планом. Разойдись разведка с потоком после раскладки, `imageOfCarriers` откажет
  // по имени (`arenaReserved`), а не соберёт образ с мусором вместо указателя арены.
  const arenaReserved =
    usesArena(emitted.instructions, emitted.image.invokeNames) ||
    planStrings(
      emitted.instructions,
      emitted.scheduled.constants,
      emitted.image.invokeNames,
      MINIMAL_BASE + HEAP_OFFSET,
    ).counts.arenaConcats > 0;
  const reserved = arenaReserved ? arenaReservedRegisters() : [];
  const allocation = allocateProgram(emitted.instructions, emitted.scheduled.procedures, { reserved });
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
      // Слово о закреплении регистров — тому, кто раскладывал: разойдись оно с нуждой образа,
      // конвейер откажет по имени, а не соберёт образ с мусором вместо указателя арены.
      arenaReserved,
    }),
    used: report.used,
  };
}

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
      SUPPORTED_ARRAY_CALLS.includes(invokeNames[payload.value] ?? '')
    );
  });
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
    const needsGrowth = body2.some((carrier) => carrier.mnemonic === 'IR.call' || isPrintCarrier(carrier, invokeNames));
    if (!needsGrowth) return;
    // ПРОЛОГ — ПЕРЕД первым носителем процедуры, а не ВМЕСТО него: `expandCarriers` заменяет
    // указанный носитель группой, поэтому первый носитель входит в группу вторым (иначе пролог
    // съел бы первую команду тела — так и случилось: у процедуры, начинавшейся с вызова,
    // вызов исчезал, и она возвращала мусор).
    const first = code[procedure.codeOffset];
    if (first === undefined) return;
    growth.set(procedure.codeOffset, [
      { mnemonic: WINDOW_GROW_CARRIER, channel: 0, operands: [] },
      first,
    ]);
  });
  return growth;
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
    /**
     * ЗАКРЕПЛЕНЫ ЛИ РЕГИСТРЫ АРЕНЫ у этого потока — слово того, кто раскладывал регистры.
     *
     * Арена пишет указатель и предел **в обход** потока носителей (`src/e2k/arenaRuntime.ts`),
     * поэтому раскладка обязана была их не отдать. Знание об этом живёт у вызывающего
     * ({@link loweredProgram} решает это ДО раскладки — по разведке планирования строк), а проверить
     * его можно только здесь, где известно, нужна ли арена на самом деле. `false` при нужной арене —
     * НАЗВАННЫЙ отказ, а не тихая порча: иначе выделение взяло бы мусор вместо указателя.
     */
    readonly arenaReserved?: boolean;
  } = {},
): {
  bytes: Uint8Array;
  refused: readonly LoweringRefusal[];
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
  const probe = arenaCall ? undefined : planStrings(code, constants, invokeNames, heapAddress);
  const arenaUsed = arenaCall || (probe?.counts.arenaConcats ?? 0) > 0;
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
        'а не программы (src/e2k/programImage.ts#loweredProgram)',
    );
  }
  const strings = arenaUsed
    ? planStrings(code, constants, invokeNames, heapAddress, { arenaRefusal: ARENA_REFUSAL_TEXT })
    : probe!;
  // СТРОКИ: литералы становятся адресами статических байтов, `длина`/`объединить` — пометками,
  // по которым ОДНИ И ТЕ ЖЕ команды считают и раскладка (форма), и понижение (байты). Планирование
  // идёт ДО всего остального: адреса блобов сдвигают сторож места, а пул констант — длину `IR.const`.
  const stringContext = { constants: strings.constants, invokeNames: strings.invokeNames };
  // Дальше весь конвейер работает с ПЕРЕПИСАННЫМ потоком и РАСШИРЕННЫМ пулом: строковый литерал —
  // это уже адрес, а не строка (`src/e2k/stringPlan.ts`).
  const context = stringContext;
  // ПРОЦЕДУРЫ: если их не назвали, поток считается ОДНОЙ процедурой — и она ТОЧКА ВХОДА. Без этой
  // записи разделённая печать (она дописывает в поток свою процедуру) оставила бы носители точки
  // входа «ничьими»: принадлежность считается как «последняя процедура, чьё смещение ≤ индекса»,
  // и её отсутствие значило бы «вызываемая» — то есть системный вызов и вызов в вызываемой.
  const declaredProcedures: readonly ProcedureOffset[] =
    options.procedures === undefined || options.procedures.length === 0
      ? [{ name: 'главная', codeOffset: 0 }]
      : options.procedures;
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
  const arenaCode = withRefusal.code;
  const baseProcedures: readonly ProcedureOffset[] = withRefusal.procedures;
  // РОСТ ОКНА: процедура, которая САМА вызывает, получает свой пролог `setwd wsz=16` + `setbn rsz=15`
  // (§3.56.5, правила 1–2) — иначе её внутренний вызов не имеет законного `wbs`. Растёт окно у той,
  // которая вызывает: точке входа оно не нужно (её вызовы идут с `wbs = 4`), листовой — тем более.
  const growthAt = windowGrowthAt(arenaCode, baseProcedures, strings.invokeNames);
  const grown = growthAt.size === 0 ? undefined : expandCarriers(arenaCode, growthAt, baseProcedures);
  const growCode = grown?.code ?? arenaCode;
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
      sharing.groupAt.size > 0 || countPrintSites(arenaCode, invokeNames) > 0 || strings.counts.prints > 0,
  });
  const plannedCode = prepared.code;
  const procedures = prepared.procedures;
  const entryAt = procedures.length === 0 ? 0 : entryProcedureIndex(procedures);
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
    const numberPlan = printPlans.get(index);
    if (numberPlan !== undefined) return withPrintSaveCount(carrier, numberPlan.saved.length);
    const stringPlan = stringPrintPlans.get(index);
    if (stringPlan === undefined) return carrier;
    // Число сохранённых — СЕДЬМОЙ пометкой носителя: шестая занята длиной строки, седьмая — адресом
    // перевода строки (`src/e2k/stringPlan.ts`), и раскладка читает их по порядку.
    const operands = [...carrier.operands];
    operands[STRING_MARK_OPERAND + 2] = imm(stringPlan.saved.length);
    return { ...carrier, operands };
  });
  // ГЛУБИНА ≥ 2: процедуры, которые САМИ вызывают (по потоку после всех вставок). Их носители
  // понижаются иначе: свой `wbs = 8` и порядок возврата «`return` → значение → `ct`» (§3.56.5, 3–5).
  const depthTwo = new Set<number>(windowGrowthAt(planned, procedures, strings.invokeNames).keys());
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
  const layout = layoutOf(planned, {
    invokeNames: strings.invokeNames,
    constants: strings.constants,
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
  ];
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
          'вытеснение в памяти из вызываемой процедуры невозможно: %b[12] при окне 16 адресуем, ' +
          'но вытеснение в процедуре идёт вместе с рантаймом, а рантайм без системного вызова не ' +
          'работает (docs/hardware-debt.md §3.51)',
      };
    }
    return undefined;
  };

  for (let index = 0; index < planned.length; index++) {
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
    // На глубине ≥ 2 (процедура с выращенным окном) носители понижаются иначе — правила 3–5 §3.56.5, §3.58.
    const procedureStart = procedures[procedureAt(procedures, index) ?? 0]?.codeOffset ?? 0;
    const onDepthTwo = inCallee && depthTwo.has(procedureStart);
    /** Выращен ли кадр этой процедуры: в нём и вызов, и системный вызов идут иначе. */
    const grownFrame = onDepthTwo;
    /** Кадр системного вызова для этого носителя: выращенный — у процедуры, иначе кадр точки входа. */
    const frame = inCallee && grownFrame ? GROWN_SYSCALL_FRAME : ENTRY_SYSCALL_FRAME;
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
      if (name === STRING_CALLS.length || name === STRING_CALLS.concat) {
        if (inCallee) {
          refused.push(
            refusalOf(
              LOWERING_CODES.runtime,
              `#${index} ${name}: строковая операция в вызываемой процедуре невозможна — её рантайм держит ` +
                'состояние в %b[10..13], а окно вызываемой — %b[0..7]',
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
      if (inCallee) {
        // Та же граница, что у статической склейки: рантайм держит состояние в `%b[10..13]`, а это
        // регистры окна вызываемой — причина названа, а не «не сработало».
        refused.push(
          refusalOf(
            LOWERING_CODES.runtime,
            `#${index} ${STRING_CALLS.concat}: склейка сверх статического буфера в вызываемой процедуре ` +
              'невозможна — её рантайм держит состояние в %b[10..13], а окно вызываемой — %b[0..7]',
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
      // На глубине ≥ 2 — свой `wbs = 8` (окно выращено прологом процедуры) и измеренный порядок
      // возврата «`return` → значение → `ct`» (§3.56.3, V3 против V2).
      ...(onDepthTwo ? { callWbs: INNER_CALL_WBS, returnAfterCall: true } : {}),
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
  if (!exitEmitted) body.push(...fallbackExit());

  const instructions: AsmInstruction[] = [...arrayPrologue(heapAddress), ...body];

  const chunks = instructions.map((instruction) => encoder.encode(instruction));
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
    return { bytes: withStatics, refused, arena: arenaReport };
  }
  return { bytes, refused, arena: arenaReport };
}
