/**
 * СКВОЗНОЙ ПРОГОН ПЯТИ DSP-ЯДЕР ЧЕРЕЗ РЕАЛЬНУЮ КОДИРОВКУ e2k.
 *
 * # Что здесь делается
 *
 * ```
 * исходник ядра → RegModule → разметка атомов → emitShell(оболочка) → носители IR
 *      → РАСКЛАДКА (firstPass: адреса, secondPass: смещения переходов — src/e2k/twoPassLayout.ts)
 *      → ПОНИЖЕНИЕ в операции e2k (таблица ниже; переход — серия disp+ct) → e2k-real.encode → байты
 *      → e2k-real.decode → сверка с исходной инструкцией
 * ```
 *
 * # Два разных вопроса, которые нельзя смешивать
 *
 * 1. **Кодируются ли инструкции ядра?** Отвечает {@link runKernelThroughRealEncoding}:
 *    сколько инструкций потока понижается до операций e2k и сколько отвергается с причиной.
 * 2. **Сохраняет ли понижение смысл?** Отвечает {@link runLoweredValues}: поток исполняется
 *    **регистровой VM** в двух видах — как есть и с понижёнными операциями, — и результаты
 *    сверяются. Понижение считается сохраняющим смысл, если числа совпали **и** предпосылки
 *    понижения подтвердились на данных (см. ниже).
 *
 * # Понижение — НАШЕ РЕШЕНИЕ, и это сказано прямо
 *
 * Носители IR (`IR.*`) — **наши имена**, а не мнемоники e2k: у операции `IR.add` нет «своего»
 * кода операции в e2k, есть **выбранная** нами операция `adds`. Соответствие опирается на
 * семантику, названную в руководстве МЦСТ (стр. 196): `ADDs/d` — «d = a + b», `SUBs/d` —
 * «d = a − b», `MULs/d` — «младшая половина произведения», `MOVTs/d` — «пересылка между
 * регистрами». Кодировка этих операций — из источников (`docs/e2k-opcodes-real.md`).
 *
 * # Серия: `IR.jmp` понижается в ДВЕ команды, а не в одну
 *
 * Переход в e2k — не одна команда: `disp %ctpr1, <смещение>` (слог CS0) **подготавливает** адрес,
 * `ct %ctpr1` (слог SS) **передаёт** управление. Ассемблер МЦСТ собирает их в две команды по
 * 8 байт даже рядом стоящими — широкой команды он не порождает (`docs/e2k-real-run.md` §2.3,
 * замер закреплён оракулом `e2kSyllables.test.ts`). Поэтому у понижения две формы результата:
 * одна команда и **серия** команд ({@link lowerCarrier}).
 *
 * Второе следствие той же природы: смещение `disp` отсчитывается **от адреса команды до адреса
 * цели** (`translate-ctp.c:74-75`), а адрес цели зависит от размеров всех команд. Значит
 * понижение перехода невозможно без раскладки — её делают `firstPass`/`secondPass` из
 * `src/e2k/twoPassLayout.ts`, а `lowerCarrier` получает готовое смещение через контекст.
 * Третье: следом за разбором `disp` нашлось, что поле **знаковое** — см. `dispOf` в
 * `src/e2k/e2k-real.ts`.
 *
 * **Предпосылки понижения названы и проверяются на данных, а не предполагаются молча:**
 *
 * | понижение | предпосылка | чем проверяется |
 * |---|---|---|
 * | `IR.move` → `movts` | значение любого типа переносится без изменения | значение на выходе |
 * | `IR.add` → `adds` | операнды — целые числа (у `IR.add` есть строковая ветвь: склейка строк) | типы операндов в прогоне |
 * | `IR.sub` → `subs` | операнды — целые числа | типы операндов в прогоне |
 * | `IR.mul` → `muls` | `MULs` даёт **младшую половину** 32-битного произведения; совпадает, пока результат укладывается в 32 бита | `Math.imul(a,b) !== a*b` в прогоне |
 * | `IR.jmp` → `disp` + `ct` | цель перехода лежит **внутри** раскладываемого потока и её адрес известен | отказ с причиной, если цель не размещена; круг через `objdump` |
 *
 * # Чего этот модуль НЕ делает
 *
 * Не исполняет реальный машинный код: эмулятора e2k нет (QEMU не собран — `docs/e2k-qemu-build.md`).
 * Байты кодируются и разбираются **своим** кодировщиком, а смысл проверяется на регистровой VM.
 * Это проверяет **согласованность понижения и кодера**, а не работу кода на e2k.
 */

import type { AsmInstruction, Encoder, Operand } from "./backend";
import { sameInstruction } from "./backend";
import { CT_COND_ALWAYS, REAL_SHORT_FORM_SIZE, realOpcode, type RealSlot } from "./e2k-real";
import { CALL_WBS, CALLEE_REGISTERS, JUMP_CARRIER, carrierForm, carrierFormOf, jumpCommands, layoutOf, secondPass, CONDITIONAL_JUMP_CARRIERS } from "./twoPassLayout";
import { callArgumentOperands } from "./shell";
import { MAX_CALL_ARGS } from "./emitterShell";
import { LOAD_CARRIER, STORE_CARRIER, loadInstructions, storeInstructions } from "./memoryAccess";
import { comparisonMnemonicOf, pairPredicates } from "./predicatePairing";
import {
  lowerArrayCall,
  arrayValuePrologue,
  ARRAY_REGISTERS,
  ARRAY_BASE_OPERAND,
  ARRAY_VALUES_CARRIER,
  ENTRY_ARRAY_BASE,
  SUPPORTED_ARRAY_CALLS,
} from "./arrayRuntime";
import { COLLECTION_ALLOC_CARRIER, COLLECTION_CALL_NAMES, collectionAllocInstructions, lowerCollectionCall } from "./collectionsRuntime";
import { SUPPORTED_MATH_CALLS, lowerMathCall } from "./mathRuntime";
import { SPILL_LOAD, SPILL_STORE } from "../vliw/spill";
import {
  ARENA_ALLOC_CARRIER,
  ARENA_INIT_CARRIER,
  ARENA_LIMIT_CARRIER,
  ARENA_POINTER_CARRIER,
  BANK_LOAD_CARRIER,
  BANK_STORE_CARRIER,
  GETSP_CARRIER,
  bankLoadInstruction,
  bankStoreInstruction,
  entryProcedureIndex,
  getspInstructions,
  windowGrowInstructions,
} from "./procedureCall";
import { ARENA_REFUSAL_CARRIER, arenaCarrierInstructions } from "./arenaRuntime";
import { REMAINDER_CARRIER, remainderInstructions } from "./remainderRuntime";
import { allocateProgram, WINDOW_REGISTERS_CALLEE, type ProcedureAllocation } from "./regAlloc";
import { LOWERING_CODES, failureOf, type LoweringFailure } from "./loweringRefusal";
import type { ShellEmitResult } from "./emitterOracle";
import { RegVM } from "../runtime/vm/reginterpreter";
import { createDefaultInvokeHandler, type StackValue } from "../runtime/vm/interpreter";
import { resolveEntryIndex } from "../oracle/parity";
import { isRegPacket, type RegInstruction, type RegModule } from "../runtime/vm/regcode";

const reg = (index: number): Operand => ({ kind: "reg", index });
const imm = (value: number): Operand => ({ kind: "imm", value });

/**
 * `movts src, dst` — оконная пересылка (короткая форма ALF2, 8 байт).
 *
 * Файл регистров — **оконный** (`%rN`): и аргументы вызова, и приёмник результата заданы в окне
 * (`WINDOW_NUMBER_REGISTER` в `src/e2k/syscallRuntime.ts` — тот же регистр, куда ABI кладёт номер
 * системного вызова, потому что `call` сдвигает окно на `2*wbs` регистров).
 */
const movts = (source: number, destination: number): AsmInstruction => ({
  mnemonic: "movts",
  channel: 0,
  operands: [
    { kind: "reg", index: source, file: "window" },
    { kind: "reg", index: destination, file: "window" },
  ],
});

/** `ldd база, смещение, приёмник` — адрес = база + смещение (`translate-al-c11.c:30-34`). */
const ldd = (base: number, offset: number, destination: number): AsmInstruction => ({
  mnemonic: "ldd",
  channel: 0,
  operands: [reg(base), reg(offset), reg(destination)],
});

/** `std значение, база, смещение` — порядок операндов текстовый, `(значение, база, смещение)`. */
const std = (value: number, base: number, offset: number): AsmInstruction => ({
  mnemonic: "std",
  channel: 2, // `st*` разрешены только в каналах 2 и 5 (opcodes/e2k-opc.h:969-984)
  operands: [reg(value), reg(base), reg(offset)],
});

// ─────────────────────────────────────────────────────────────────────────────
// ТАБЛИЦА ПОНИЖЕНИЯ
// ─────────────────────────────────────────────────────────────────────────────

/** Предпосылка понижения, проверяемая на данных прогона. */
export type LoweringAssumption =
  | "тип-значения"
  | "целые-операнды"
  | "32-битное-произведение"
  | "литерал-в-32-битах";

/** Правило понижения операции IR в операцию e2k. */
export interface LoweringRule {
  /** Носитель IR (наше имя). */
  readonly carrier: string;
  /** Мнемоника e2k — копия из таблицы опкодов МЦСТ. */
  readonly mnemonic: string;
  /** Слоты e2k в порядке её операндов. */
  readonly slots: readonly RealSlot[];
  /**
   * Откуда берётся каждый слот: индекс операнда в носителе IR.
   * Носитель несёт операнды в порядке «аргументы, затем результат» (`src/e2k/emitterShell.ts`):
   * у `IR.move` это `[dst, a]`, у бинарных — `[dst, a, b]`.
   */
  readonly fromIr: readonly number[];
  /** Источник семантики e2k (руководство МЦСТ). */
  readonly semantics: string;
  /** Предпосылка, без которой соответствие неверно. */
  readonly assumption: LoweringAssumption;
  /**
   * Индекс операнда IR, который становится **литералом** e2k, а не регистром.
   *
   * У `IR.const` в этом операнде лежит **индекс пула констант** (`emitterShell.ts`: носитель несёт
   * `[d, k, type]`), поэтому значение берётся из пула — см. {@link literalFromPool}.
   */
  readonly literalFromIr?: number;
  /** Значение литерала берётся из пула констант модуля по операнду `literalFromIr`. */
  readonly literalFromPool?: boolean;
  /**
   * Обязательный канал выдачи, если форма допускает **только один**.
   *
   * Обычно канал команды берётся от носителя (его выбрал планировщик оболочки), но есть формы,
   * которые вне своего канала не кодируются вовсе: `sdivs` — только канал 5
   * (`opcodes/e2k-opc.h:69`, `ARGS_SSS`; измерено: `.tmp/idiv-channel.ts`, носитель `IR.idiv` нёс
   * канал 0, и кодировщик отказал). Так же поступает рантайм массивов: `std` он строит с каналом 2,
   * потому что `st*` разрешены только в 2 и 5.
   */
  readonly channel?: number;
}

/**
 * Понижение в **одну** команду — пять операций. Носители, которым одной команды мало
 * (`IR.jmp` — серия «подготовка + передача управления»), описаны не здесь, а в
 * {@link lowerCarrier}: их форма — серия, и размер у неё другой.
 */
export const LOWERING: readonly LoweringRule[] = [
  {
    carrier: "IR.const",
    mnemonic: "movts",
    slots: ["src2", "dst"],
    fromIr: [1, 0], // носитель несёт (d, k, type): литерал — из пула по k, приёмник — d
    semantics:
      "MOVTs/d с литералом — загрузка константы (руководство МЦСТ, стр. 196; литеральная форма — " +
      "opcodes/e2k-dis.c:445-479)",
    assumption: "литерал-в-32-битах",
    literalFromIr: 1,
    literalFromPool: true,
  },
  {
    carrier: "IR.move",
    mnemonic: "movts",
    slots: ["src2", "dst"],
    fromIr: [1, 0], // e2k: (src2 = a, dst = d); носитель несёт (dst, a)
    semantics: "MOVTs/d — пересылка между регистрами (руководство МЦСТ, стр. 196)",
    assumption: "тип-значения",
  },
  {
    carrier: "IR.add",
    mnemonic: "adds",
    slots: ["src1", "src2", "dst"],
    fromIr: [1, 2, 0], // e2k: (src1 = a, src2 = b, dst = d); носитель несёт (dst, a, b)
    semantics: "ADDs/d — d = a + b (руководство МЦСТ, стр. 196)",
    assumption: "целые-операнды",
  },
  {
    carrier: "IR.sub",
    mnemonic: "subs",
    slots: ["src1", "src2", "dst"],
    fromIr: [1, 2, 0],
    semantics: "SUBs/d — d = a − b (руководство МЦСТ, стр. 196)",
    assumption: "целые-операнды",
  },
  {
    carrier: "IR.mul",
    mnemonic: "muls",
    slots: ["src1", "src2", "dst"],
    fromIr: [1, 2, 0],
    semantics:
      "MULs/d — младшая половина произведения (руководство МЦСТ, стр. 196); кодировка — длинная форма (ALS + ALES)",
    assumption: "32-битное-произведение",
  },
  {
    // БЛОК 2: целочисленное деление языка (`div`) — семантика совпадает с формой:
    // `SDIVs` отсекает дробную часть к нулю и даёт `exc_div` при делителе 0, а
    // `IR.div` (вещественное деление) так себя не ведёт и остаётся отказом ниже.
    carrier: "IR.idiv",
    mnemonic: "sdivs",
    slots: ["src1", "src2", "dst"],
    fromIr: [1, 2, 0], // e2k: (src1 = a, src2 = b, dst = d); носитель несёт (dst, a, b)
    channel: 5, // `sdivs` кодируется ТОЛЬКО в пятом канале — измерено, см. поле `channel` правила
    semantics:
      "SDIVs — деление целых со знаком 32/32→32 с отсечением к нулю (руководство МЦСТ §10.3.3; " +
      "форма ALF1, канал только пятый — opcodes/e2k-opc.h:69, ARGS_SSS)",
    assumption: "целые-операнды",
  },
];

/** Почему `IR.jmp` не понижается в одну команду и что для него нужно. */
export const JUMP_NEEDS_LAYOUT =
  "«IR.jmp»: понижение — СЕРИЯ из двух команд (`disp %ctpr1, <смещение>` — CS0, затем `ct %ctpr1` — SS), " +
  "а смещение считает двухпроходная раскладка: адрес цели зависит от размеров всех команд, поэтому " +
  "одной командой переход не выражается и взять смещение из самой инструкции неоткуда " +
  "(src/e2k/twoPassLayout.ts; замер пары — docs/e2k-real-run.md §2.3)";

/** Почему условный переход не понижается в одну команду и что для него нужно. */
export const JUMP_IF_NEEDS_PAIR =
  "«условный переход»: `ct` читает ПРЕДИКАТ (`SS.ctcond.psrc[4:0]`), а носитель несёт условие " +
  "регистром-значением; предикат даёт только сравнение, поэтому переход понижается ПАРОЙ со " +
  "сравнением (`cmp… → %predN` + `ct ? {~}%predN`) — сопоставление в src/e2k/predicatePairing.ts";

/** Почему сравнение не понижается в одну команду и что для него нужно. */
export const COMPARISON_NEEDS_PAIR =
  "«сравнение»: e2k-сравнение (`cmp*`, форма ALF7) пишет ПРЕДИКАТ (`pdst[4:0]`), а носитель IR несёт " +
  "значение в регистре; понижение возможно только ПАРОЙ с условным переходом, который этот предикат " +
  "читает, — сопоставление в src/e2k/predicatePairing.ts";

/**
 * Почему носитель не понижается **в одну команду**.
 *
 * Таблица отвечает на вопрос «можно ли это понижение выразить одной командой e2k», а не
 * «понижается ли носитель вообще»: `IR.jmp` **понижается** серией из двух команд, а сравнения и
 * условные переходы — **парой** (сравнение кладёт результат в предикат, переход его читает).
 * Здесь стоит причина, по которой одиночная команда не годится.
 */
export const REFUSALS: Readonly<Record<string, string>> = {
  "IR.invoke":
    "НЕТ В ИСТОЧНИКЕ: хост-вызов — операция рантайма; в таблице опкодов МЦСТ (opcodes/e2k-opc.h) " +
    "операции с такой семантикой нет",
  "IR.call":
    "вызов понижается в `disp` + `call %ctpr1, wbs=4` (форма CS1 есть в кодировщике), но исполнение " +
    "в модели не подтверждено: у вызываемой процедуры окно **8** регистров против 16 у вызывающего " +
    "(измерено, `src/e2k/e2kCallWindowQemu.test.ts`), поэтому соглашение о передаче аргументов и " +
    "результата не проверено прогоном — см. docs/e2k-opcodes-real.md §7.10",
  "IR.ret":
    "возврат понижается в `return %ctpr3` (форма CS0 есть в кодировщике), но порт модели на этой " +
    "команде падает на утверждении `op_descr->is_al` (измерено, `src/e2k/e2kCallWindowQemu.test.ts`), " +
    "а системный вызов вызывающего после возврата теряет геометрию окна — см. docs/e2k-opcodes-real.md §7.10",
  "IR.jmp": JUMP_NEEDS_LAYOUT,
  "IR.jmp_if": JUMP_IF_NEEDS_PAIR,
  "IR.jmp_if_not": JUMP_IF_NEEDS_PAIR,
  "IR.eq": COMPARISON_NEEDS_PAIR,
  "IR.ne": COMPARISON_NEEDS_PAIR,
  "IR.lt": COMPARISON_NEEDS_PAIR,
  "IR.le": COMPARISON_NEEDS_PAIR,
  "IR.gt": COMPARISON_NEEDS_PAIR,
  "IR.ge": COMPARISON_NEEDS_PAIR,
  "IR.div":
    "форма ЕСТЬ (целочисленное деление e2k: `sdivs`/`udivs`/`sdivd`/`udivd` и расширенные `sdivx`/`udivx`, " +
    "канал только пятый — `opcodes/e2k-opc.h:39-74`, руководство МЦСТ §10.3.3), но семантика IR и формы " +
    "расходятся: в `src/runtime/vm/reginterpreter.ts:321` деление — **точное** (`a / b`), а `SDIVs` " +
    "**отсекает** дробную часть (`truncate toward 0`) и даёт `exc_div` при делителе 0. Подставить одну " +
    "вместо другой нельзя, и решение принято: целочисленное деление языка — **отдельная** операция `idiv` " +
    "(`IR.idiv` → `sdivs`, БЛОК 2), а `IR.div` остаётся вещественным и по-прежнему не понижается",
  // `IR.rem` БОЛЬШЕ НЕ ОТКАЗ (2026-10-02): он понижается СЕРИЕЙ `sdivs` + `muls` + `subs`
  // (`src/e2k/remainderRuntime.ts`), а не одной командой. Прежняя запись отказа говорила
  // «IR-остаток вещественный, документированный (UMODx, SMODx) — целочисленный» — и это была
  // посылка, которой нет: ОБЕ VM считают `a % b`, то есть остаток с отсечением к нулю (знак
  // делимого), — ровно то, что даёт серия. Разбор — `docs/hardware-debt.md` §3.97.
  "IR.and": "семантика не совпадает: IR-логика булева (Boolean(a && b)), e2k ands — побитовая",
  "IR.or": "семантика не совпадает: IR-логика булева, e2k ors — побитовая",
  "IR.not": "семантика не совпадает: IR-отрицание булево, документированной унарной NOT в таблице опкодов нет",
};

/** Правило понижения по носителю. */
export function loweringOf(carrier: string): LoweringRule | undefined {
  return LOWERING.find((rule) => rule.carrier === carrier);
}

/** Результат понижения одной инструкции. */
export type LoweringResult =
  | { readonly ok: true; readonly instruction: AsmInstruction }
  | LoweringFailure;

/**
 * Результат понижения носителя: одна команда или **серия** команд.
 *
 * Серия нужна там, где операции e2k не хватает одной команды: `IR.jmp` — это
 * `disp %ctpr1, <смещение>` **и** `ct %ctpr1` (см. {@link lowerCarrier}).
 */
export type CarrierLoweringResult =
  | { readonly ok: true; readonly instructions: readonly AsmInstruction[] }
  | LoweringFailure;

/** Что нужно понижению, кроме самой инструкции: пул констант модуля и смещение перехода. */
export interface LoweringContext {
  /** Пул констант модуля (`RegModule.constants`) — нужен носителю `IR.const`. */
  readonly constants?: readonly unknown[];
  /**
   * Таблица имён хост-вызовов образа оболочки (`ShellImage.invokeNames`) — нужна носителю
   * `IR.invoke`: его `payload` это **индекс** в этой таблице, а семантику несёт имя
   * (`система.массив.*`), а не код операции (`src/e2k/emitterShell.ts:255-269`).
   */
  readonly invokeNames?: readonly string[];
  /**
   * Вычисленное смещение перехода в 8-байтных единицах — результат **второго прохода** раскладки
   * (`secondPass`). Без него переход не понижается: смещение — не поле инструкции, а свойство
   * раскладки.
   */
  readonly displacement?: number;
  /**
   * Сопоставление «сравнение → предикат» для носителя-сравнения: мнемоника `cmp` и номер
   * предиката. Его даёт проход сопоставления (`src/e2k/predicatePairing.ts`) — и только он:
   * без пары сравнение не понижается, потому что значение в регистре предикатом не является.
   */
  readonly predicate?: { readonly mnemonic: string; readonly index: number };
  /**
   * Код условия передачи управления для **условного** перехода (`SS.ctcond`): `0x40` — по
   * предикату, `0x60` — по инверсному. Полярность выводит сопоставление, а не понижение.
   */
  readonly condition?: number;
  /**
   * Смещение вызова: на сколько восьмибайтных слов цель `disp` отстоит от **самой команды `disp`**
   * (она идёт после пересылок аргументов, то есть не по адресу носителя).
   *
   * Считает его конвейер: адрес цели — это адрес первой команды вызываемой процедуры, а он известен
   * только после двухпроходной раскладки. Без него вызов не понижается — с названной причиной.
   */
  readonly callDisplacement?: number;
  /**
   * ИСПОЛНЯЕТСЯ ли `IR.ret` как ВОЗВРАТ ПРОЦЕДУРЫ.
   *
   * Тогда он понижается ПАРОЙ: подготовка `return %ctpr3` плюс переход `ct %ctpr3`. Одна `return`
   * в этом порте валит утверждение (`op_descr->is_al`, статус 134), одна `ct` — ловушка (статус 9):
   * `call` стирает ctpr в пустой тег. Измерено оракулом окна (`src/e2k/e2kCallWindowQemu.test.ts`,
   * шлюз), разбор — `docs/e2k-return-port.md`. Без флага (точка входа, замеры) форма остаётся
   * прежней: там носитель не исполняется, и сдвигать закреплённые числа нечем.
   */
  readonly procedureReturn?: boolean;
  /**
   * Понижается тело ВЫЗЫВАЕМОЙ процедуры. Зачем это знать рантайму массивов: её обращения к памяти
   * идут оконной формой (`%rN`), а указатель кучи живёт в плоскости точки входа — значит `создать` и
   * `добавить` здесь обязаны отказать по имени, а не двигать чужую клетку (§3.128).
   */
  readonly inCallee?: boolean;
  /**
   * БАЗА БЛОКА РАНТАЙМА МАССИВОВ в ЭТОЙ процедуре — её выдала раскладка (`allocateProgram`,
   * поле `arrayBases`). Базы нет — обращение к массиву отказывает по имени (§3.128).
   */
  readonly arrayBase?: number;
  /**
   * ШИРИНА ОКНА ВЫЗОВА (`wbs`) в квадрословах — по умолчанию {@link CALL_WBS} (4) для точки входа.
   *
   * Внутри процедуры, которая САМА вызывает, окно выращено её прологом (`IR.window_grow`:
   * `setwd wsz=16` + `setbn rsz=15`), и тогда законная ширина — **8**: `wbs ≥ psize_q = 8` (§9.5.3)
   * и `wbs ≤ size_q = 16`. Аргументы уезжают в `%r(2·wbs) = %r16`, оттуда же принимается результат —
   * измерено в `.tmp/osnova-mainAB.ts` (V3), разбор — `docs/hardware-debt.md` §3.56.3/§3.56.5.
   */
  readonly callWbs?: number;
  /**
   * ПОРЯДОК ВОЗВРАТА НА ГЛУБИНЕ ≥ 2: `return %ctpr3` идёт ДО работы со значением.
   *
   * Измерено (V2 против V3, там же): если процедура сама делала вызов, идиом «значение → `return` →
   * `ct`» даёт ловушку `0x100088` (код 9), а «`return` → значение → `ct`» возвращает управление
   * (код 7). Причина: `call` стирает `ctpr` в пустой тег, поэтому подготовку возврата обязан сделать
   * тот, кто вызывал. Флаг ставит конвейер — по факту «в этой процедуре есть вызов».
   */
  readonly returnAfterCall?: boolean;
}

/**
 * Понизить инструкцию-носитель IR в инструкцию e2k.
 *
 * Инструкция e2k собирается из тех же полей IR: у `move` — источник и приёмник, у остальных —
 * два источника и приёмник. Канал берётся из инструкции IR (эмиттер оболочки ставит 0).
 *
 * У `IR.const` один операнд — **индекс пула констант**, а не значение: он превращается в
 * литерал e2k, и значение берётся из `context.constants`. Литералом кодируются только целые
 * (16- и 32-битные), поэтому нецелое или слишком большое значение — названный отказ, а не
 * молчаливая подстановка.
 */
export function lowerInstruction(instruction: AsmInstruction, context: LoweringContext = {}): LoweringResult {
  const rule = loweringOf(instruction.mnemonic);
  if (rule === undefined) {
    return failureOf(
      LOWERING_CODES.noForm,
      REFUSALS[instruction.mnemonic] ?? `носитель «${instruction.mnemonic}» не описан в таблице понижения`,
    );
  }
  const entry = realOpcode(rule.mnemonic)!;
  if (rule.slots.length !== rule.fromIr.length) {
    return failureOf(
      LOWERING_CODES.carrier,
      `правило «${rule.carrier}»: слотов ${rule.slots.length}, источников ${rule.fromIr.length}`,
    );
  }
  if (instruction.operands.length <= Math.max(...rule.fromIr)) {
    return failureOf(
      LOWERING_CODES.carrier,
      `«${instruction.mnemonic}»: операндов ${instruction.operands.length}, ` +
        `правило понижения читает операнд ${Math.max(...rule.fromIr)}`,
    );
  }
  const operands: Operand[] = [];
  for (const index of rule.fromIr) {
    const operand = instruction.operands[index];
    if (index === rule.literalFromIr) {
      const literal = literalOf(instruction, index, operand, rule, context);
      if (typeof literal === "string") return failureOf(LOWERING_CODES.constant, literal);
      operands.push(imm(literal));
      continue;
    }
    if (operand === undefined || operand.kind !== "reg") {
      return failureOf(
        LOWERING_CODES.carrier,
        `«${instruction.mnemonic}»: операнд ${index} не регистр — в e2k он попал бы в поле слога`,
      );
    }
    operands.push(reg(operand.index));
  }
  if (entry.operands.length !== rule.slots.length) {
    return failureOf(
      LOWERING_CODES.carrier,
      `«${rule.mnemonic}»: форма ${entry.form} несёт ${entry.operands.length} операнда, правило даёт ${rule.slots.length}`,
    );
  }
  return {
    ok: true,
    // Канал: у формы, которая вне своего канала не кодируется (`sdivs` — только пятый), он
    // закреплён правилом; иначе остаётся канал носителя (его выбрал планировщик оболочки).
    instruction: { mnemonic: rule.mnemonic, channel: rule.channel ?? instruction.channel, operands },
  };
}

/**
 * Понизить носитель IR в команды e2k — одну или серию.
 *
 * Три случая:
 *
 * | носитель | понижение | что нужно из контекста |
 * |---|---|---|
 * | `IR.jmp` | серия `disp %ctpr1, <смещение>` + `ct %ctpr1` (передать всегда) | смещение |
 * | `IR.jmp_if`/`IR.jmp_if_not` | та же серия, но `ct` несёт код условия `SS.ctcond` | смещение и код условия |
 * | сравнение (`IR.lt`…`IR.ne`) | одна команда `cmp…` с предикатом-приёмником | мнемоника и номер предиката |
 *
 * Смещение даёт раскладка, код условия и предикат — сопоставление
 * (`src/e2k/predicatePairing.ts`). Без них — отказ с причиной: ни вычислить смещение из одной
 * инструкции, ни превратить значение в предикат нельзя.
 *
 * Остальные носители понижаются одной командой — {@link lowerInstruction}.
 */
export function lowerCarrier(instruction: AsmInstruction, context: LoweringContext = {}): CarrierLoweringResult {
  // ── Вызов и возврат ─────────────────────────────────────────────────────────
  //
  // Соглашение (наше, проверяемое по байтам и дизассемблеру, без исполнения): аргументы кладутся в
  // `%r(2*wbs + i)` **вызывающего** — вызываемая увидит их как свои `%r0`, `%r1`, потому что индекс
  // окна считается как `base_d + idx`, а `call` прибавляет `2*wbs` двоичных слов (`reg-index.h:79`,
  // `e2k_cpu_exec_ct_CALL`). Результат вызываемая оставляет в своём `%r0` — то есть в `%r(2*wbs)`
  // вызывающего. Окно вызываемой при `wbs = 4` — восемь регистров, и это ИЗМЕРЕНО в модели
  // (`src/e2k/e2kCallWindowQemu.test.ts`): процедура, которой нужно больше, вызвана быть не может,
  // и это названо в отчёте (`calleeWindow`), а не замолчано.
  if (instruction.mnemonic === "IR.call") {
    const flags = instruction.operands[0];
    if (flags === undefined || flags.kind !== "imm") {
      return failureOf(LOWERING_CODES.carrier, '«IR.call»: операнд флагов не число — арность вызова неизвестна');
    }
    const argc = flags.value >> 1;
    const hasDestination = (flags.value & 1) === 1;
    if (argc > MAX_CALL_ARGS) {
      return failureOf(
        LOWERING_CODES.runtime,
        `«IR.call»: аргументов ${String(argc)}, носитель несёт не больше ${String(MAX_CALL_ARGS)} ` +
          '(src/e2k/emitterShell.ts#MAX_CALL_ARGS)',
      );
    }
    if (context.callDisplacement === undefined) {
      return failureOf(
        LOWERING_CODES.layout,
        '«IR.call»: не передано смещение вызова — цель это адрес первой команды вызываемой процедуры, ' +
          'и он известен только после двухпроходной раскладки (src/e2k/twoPassLayout.ts)',
      );
    }
    const instructions: AsmInstruction[] = [];
    // ШИРИНА ОКНА ВЫЗОВА: 4 у точки входа, 8 у процедуры, которая вырастила окно своим прологом.
    const wbs = context.callWbs ?? CALL_WBS;
    // АРГУМЕНТЫ БЕРУТСЯ ОДНИМ ИСТОЧНИКОМ (`callArgumentOperands`): третий лежит в поле `src3`,
    // а не следом за вторым, поэтому арифметика `operands[1 + argument]` прочла бы нагрузку.
    const callArguments = callArgumentOperands(instruction);
    for (let argument = 0; argument < argc; argument++) {
      const source = callArguments[argument];
      if (source === undefined || source.kind !== "reg") {
        return failureOf(LOWERING_CODES.carrier, `«IR.call»: аргумент ${argument} не в регистре`);
      }
      instructions.push(movts(source.index, wbs * 2 + argument));
    }
    instructions.push({ mnemonic: "disp", channel: 0, operands: [imm(1), imm(context.callDisplacement)] });
    instructions.push({ mnemonic: "call", channel: 0, operands: [imm(1), imm(wbs)] });
    if (hasDestination) {
      const destination = instruction.operands[4];
      if (destination === undefined || destination.kind !== "reg") {
        return failureOf(LOWERING_CODES.carrier, '«IR.call»: флаг обещает результат, а регистра-приёмника нет');
      }
      instructions.push(movts(wbs * 2, destination.index));
    }
    return { ok: true, instructions };
  }

  if (instruction.mnemonic === "IR.zero") {
    // Ноль в регистр — одна короткая пересылка. Нужен разделённой печати: её вытеснение адресует
    // слот парой «основание + ноль», а ноль рантайма (`%b[12]`) после возврата из вызываемой
    // недоступен (окно вызывающего сужено до `%b[0..11]`, измерено `.tmp/osnova-after-call-window.ts`).
    const destination = instruction.operands[0];
    if (destination === undefined || destination.kind !== "reg") {
      return failureOf(LOWERING_CODES.carrier, '«IR.zero»: ожидался регистр-приёмник');
    }
    return {
      ok: true,
      instructions: [{ mnemonic: "movts", channel: 0, operands: [imm(0), reg(destination.index)] }],
    };
  }

  // БАНК: три носителя — указатель стека и запись/чтение постоянной памяти кадра (§3.69).
  // `IR.getsp` ставится В ТОЧКЕ ВХОДА: его приёмник — базовая форма, а в вызываемой базовая форма
  // ловушка (§3.65.1). Запись и чтение банка — всегда ОКОННОЙ формой.
  if (
    instruction.mnemonic === GETSP_CARRIER ||
    instruction.mnemonic === BANK_STORE_CARRIER ||
    instruction.mnemonic === BANK_LOAD_CARRIER
  ) {
    const operand = instruction.operands[0];
    if (operand === undefined || operand.kind !== "reg") {
      return failureOf(LOWERING_CODES.carrier, `«${instruction.mnemonic}»: ожидался регистр`);
    }
    if (instruction.mnemonic === GETSP_CARRIER) {
      return { ok: true, instructions: getspInstructions(operand.index) };
    }
    return {
      ok: true,
      instructions: [
        instruction.mnemonic === BANK_STORE_CARRIER
          ? bankStoreInstruction(operand.index)
          : bankLoadInstruction(operand.index),
      ],
    };
  }

  // АРЕНА: заведение, выделение, чтение и БЛОК ОТКАЗА (§3.88–§3.89). Возврата памяти нет — арена
  // живёт до конца программы. Команды берутся ИЗ ОДНОГО ИСТОЧНИКА с формой носителя
  // (`src/e2k/arenaRuntime.ts#arenaCarrierInstructions`): разойтись байтам и форме нечем (§3.35).
  if (
    instruction.mnemonic === ARENA_INIT_CARRIER ||
    instruction.mnemonic === ARENA_POINTER_CARRIER ||
    instruction.mnemonic === ARENA_LIMIT_CARRIER ||
    instruction.mnemonic === ARENA_ALLOC_CARRIER ||
    instruction.mnemonic === ARENA_REFUSAL_CARRIER
  ) {
    const instructions = arenaCarrierInstructions(instruction);
    if (instructions === undefined) {
      return failureOf(
        LOWERING_CODES.carrier,
        `«${instruction.mnemonic}»: операнды носителя не той формы — ` +
          "заведение ждёт два числа (база и предел), выделение — размер-регистр и регистр-приёмник, " +
          "чтение — регистр-приёмник, блок отказа — адрес и длину статического блоба от stringPlan",
      );
    }
    return { ok: true, instructions };
  }

  // РАСШИРЕНИЕ КУЧИ ПОД КОЛЛЕКЦИЮ (§3.100): `brk(0)` → база, граница блока → аргумент системного
  // вызова, `brk(граница)` → ответ. ЗАГОЛОВОК ЗДЕСЬ НЕ ПИШЕТСЯ: его ставит отдельный носитель ПОСЛЕ
  // проверки ответа — до неё запись по `[база]` уходит за границу кучи. Команды берутся ИЗ ОДНОГО
  // ИСТОЧНИКА с формой носителя (`src/e2k/collectionsRuntime.ts#collectionAllocInstructions`).
  if (instruction.mnemonic === COLLECTION_ALLOC_CARRIER) {
    const capacity = instruction.operands[0];
    const destination = instruction.operands[1];
    if (capacity === undefined || capacity.kind !== "reg" || destination === undefined || destination.kind !== "reg") {
      return failureOf(
        LOWERING_CODES.carrier,
        `«${instruction.mnemonic}»: ожидались регистр ёмкости и регистр-приёмник — их ставит сайт коллекций`,
      );
    }
    return {
      ok: true,
      instructions: collectionAllocInstructions(capacity.index, destination.index),
    };
  }

  if (instruction.mnemonic === "IR.window_grow") {
    // РОСТ ОКНА у процедуры, которая сама вызывает: `setwd` до `setbn`, по одному разу (§3.56.2).
    return { ok: true, instructions: windowGrowInstructions() };
  }

  if (instruction.mnemonic === ARRAY_VALUES_CARRIER) {
    // ПРОЛОГ ЗНАЧЕНИЙ РАНТАЙМА МАССИВОВ — в блок ЭТОЙ процедуры. Здесь носитель, а не готовая
    // команда в потоке: у вызываемой конвейер переведёт его в оконную форму вместе с остальным телом.
    const base = instruction.operands[0];
    return {
      ok: true,
      instructions: arrayValuePrologue(base !== undefined && base.kind === 'imm' ? base.value : ENTRY_ARRAY_BASE),
    };
  }

  if (instruction.mnemonic === REMAINDER_CARRIER) {
    // ОСТАТОК — СЕРИЯ из трёх команд, а не одна: документированный `SMODX` не берём (у него свой
    // дефект знака, пример `09`), а считаем остаток из целочисленного деления, которое уже
    // понижается. Команды берутся из ТОГО ЖЕ источника, что и форма раскладки
    // (`src/e2k/remainderRuntime.ts`) — разойдись они, адреса уехали бы молча (§3.35).
    const divisor = instruction.operands[2];
    const dividend = instruction.operands[1];
    const destination = instruction.operands[0];
    if (
      dividend?.kind !== 'reg' ||
      divisor?.kind !== 'reg' ||
      destination?.kind !== 'reg'
    ) {
      return failureOf(
        LOWERING_CODES.carrier,
        '«IR.rem»: операнды обязаны быть регистрами (делимое, делитель, приёмник)',
      );
    }
    return {
      ok: true,
      instructions: [...remainderInstructions(dividend.index, divisor.index, destination.index)],
    };
  }

  if (instruction.mnemonic === "IR.ret") {
    const flag = instruction.operands[0];
    if (flag === undefined || flag.kind !== "imm") {
      return failureOf(LOWERING_CODES.carrier, '«IR.ret»: операнд «есть значение» не число');
    }
    const value = instruction.operands[1];
    if (flag.value === 1 && (value === undefined || value.kind !== "reg")) {
      return failureOf(LOWERING_CODES.carrier, '«IR.ret»: флаг обещает значение, а регистра нет');
    }
    const result = flag.value === 1 ? movts((value as { index: number }).index, 0) : undefined;
    // ВОЗВРАТ ПРОЦЕДУРЫ — ПАРА, А НЕ ОДНА КОМАНДА. Измерено оракулом окна
    // (`src/e2k/e2kCallWindowQemu.test.ts`, шлюз `gate:qemu`): одна `return %ctpr3` (CS0) валит порт
    // утверждением `op_descr->is_al` (статус 134), одна `ct %ctpr3` (SS) — гостевым исключением на
    // самой `ct` (статус 9): `call` стирает ctpr в пустой тег. Управление возвращает ТОЛЬКО пара —
    // подготовка плюс переход. Это замер, а не догадка: `docs/e2k-return-port.md`, §3.24.
    //
    // ПОРЯДОК ЖЕ ЗАВИСИТ ОТ ГЛУБИНЫ (измерено `.tmp/osnova-mainAB.ts`, V2 против V3, §3.56.3):
    // если процедура САМА вызывала, между её вызовом и возвратом `ctpr` пуст, и «значение → `return`
    // → `ct`» даёт ловушку `0x100088`; работает «`return` → значение → `ct`» (код 7). У листа порядок
    // прежний — он измерен корпусом.
    const pair: AsmInstruction[] = [{ mnemonic: "return", channel: 0, operands: [imm(3)] }];
    if (context.procedureReturn === true) {
      pair.push({ mnemonic: "ct", channel: 0, operands: [imm(3), imm(CT_COND_ALWAYS)] });
    }
    const instructions: AsmInstruction[] =
      context.returnAfterCall === true && result !== undefined
        ? [pair[0]!, result, ...pair.slice(1)]
        : [...(result === undefined ? [] : [result]), ...pair];
    return { ok: true, instructions };
  }

  // ── Массивы: `IR.invoke` заменяется настоящими обращениями к памяти ─────────────────────────
  //
  // Семантику несёт **имя** вызова (`payload` — индекс в `invokeNames` образа оболочки,
  // `src/e2k/emitterShell.ts:255-269`), а не код операции: в таблице опкодов МЦСТ такой операции
  // нет. Рантайм массивов (`src/e2k/arrayRuntime.ts`) превращает вызов в `ldd`/`std`; всё, чего он
  // не умеет (установить, удалить, срез, строки, математика), остаётся отказом с причиной имени.
  if (instruction.mnemonic === "IR.invoke") {
    const names = context.invokeNames;
    if (names === undefined) {
      return failureOf(
        LOWERING_CODES.carrier,
        "«IR.invoke»: не передан список имён хост-вызовов (`invokeNames` образа оболочки) — " +
          "без него `payload` это число, а не операция",
      );
    }
    const payload = instruction.operands[3];
    const flags = instruction.operands[0];
    if (payload === undefined || payload.kind !== "imm" || flags === undefined || flags.kind !== "imm") {
      return failureOf(
        LOWERING_CODES.carrier,
        "«IR.invoke»: операнды носителя не той формы (ожидались flags и payload числами)",
      );
    }
    const name = names[payload.value];
    if (name === undefined) {
      return failureOf(
        LOWERING_CODES.carrier,
        `«IR.invoke»: в таблице имён нет записи с индексом ${payload.value} (всего имён ${names.length})`,
      );
    }
    // Арность читается ИЗ ПРИЗНАКОВ, но сами операнды берутся одним источником: у вызова с тремя
    // аргументами третий лежит в поле `src3`, а не следом за вторым.
    const hasDestination = (flags.value & 1) === 1;
    const args = callArgumentOperands(instruction);
    const destination = instruction.operands[4];
    if (hasDestination && (destination === undefined || destination.kind !== "reg")) {
      return failureOf(LOWERING_CODES.carrier, `«${name}»: у носителя нет регистра-приёмника, а флаг обещает результат`);
    }
    try {
      // ТРИ рантайма по ИМЕНИ вызова, и третий — коллекции: массивы (`src/e2k/arrayRuntime.ts`),
      // математика (`src/e2k/mathRuntime.ts` — целочисленный остаток) и коллекции на `brk`
      // (`src/e2k/collectionsRuntime.ts` — растут у границы кучи, ёмкость лежит в заголовке блока).
      // Имя, которого нет ни там, ни там, ни там, остаётся отказом с причиной: оператора `/` это не
      // касается (решение владельца). Порядок ветвей не значим: имена не пересекаются, и это
      // проверено оракулом (`src/e2k/collectionsNames.test.ts`).
      // МАССИВЫ — ОТДЕЛЬНОЙ ВЕТВЬЮ: им нужна БАЗА БЛОКА, которую выдала раскладка (операнд
      // `ARRAY_BASE_OPERAND` носителя), и признак вызываемой процедуры. Базы нет — `lowerArrayCall`
      // отказывает по имени; именно это закрывает тихий путь §3.127 (аргументы 8/9 у вызываемой).
      const destinationIndex = hasDestination ? (destination as { index: number }).index : undefined;
      if (SUPPORTED_ARRAY_CALLS.includes(name)) {
        return {
          ok: true,
          instructions: lowerArrayCall(name, args as readonly Operand[], destinationIndex, {
            ...(context.arrayBase === undefined ? {} : { base: context.arrayBase }),
            ...(context.inCallee === true ? { inCallee: true } : {}),
          }),
        };
      }
      const call = SUPPORTED_MATH_CALLS.includes(name)
        ? lowerMathCall
        : COLLECTION_CALL_NAMES.includes(name)
          ? lowerCollectionCall
          : lowerArrayCall;
      return {
        ok: true,
        instructions: call(name, args as readonly Operand[], destinationIndex),
      };
    } catch (error) {
      return failureOf(LOWERING_CODES.runtime, error instanceof Error ? error.message : String(error));
    }
  }

  // ── Чтение и запись по адресу-РЕГИСТРУ (`src/e2k/memoryAccess.ts`) ─────────────────────────────
  //
  // Отличие от вытеснения ниже: там адресуется ЛИТЕРАЛЬНЫЙ слот, и понижение само кладёт его в
  // регистр; здесь адрес приходит готовым. Носители заведены замером: `IR.spill_ld`/`IR.spill_st`
  // выразить `[база + индекс·8]` НЕ МОГУТ — их регистр-адрес затирается литералом слота.
  if (instruction.mnemonic === LOAD_CARRIER || instruction.mnemonic === STORE_CARRIER) {
    const operands = instruction.operands;
    const expected = instruction.mnemonic === LOAD_CARRIER ? 'адрес и приёмник' : 'значение и адрес';
    if (operands.length !== 2 || operands.some((operand) => operand.kind !== 'reg')) {
      return failureOf(
        LOWERING_CODES.carrier,
        `«${instruction.mnemonic}»: ожидались два регистра (${expected}), получено [${operands
          .map((operand) => operand.kind)
          .join(', ')}]`,
      );
    }
    const first = operands[0] as { index: number };
    const second = operands[1] as { index: number };
    const instructions =
      instruction.mnemonic === LOAD_CARRIER
        ? loadInstructions(first.index, second.index)
        : storeInstructions(first.index, second.index);
    return { ok: true, instructions };
  }

  // ── Вытеснение в память: чтение и запись слота (`src/vliw/spill.ts`) ─────────────────────────
  //
  // Адрес слота в e2k — **сумма двух регистров**, поля смещения в команде нет (измерено:
  // `src/e2k/e2kMemory.test.ts`, `qemu/target/e2k/tcg/translate-al-c11.c:26-34`). Поэтому адрес
  // кладётся в регистр литералом `movtd`, а смещением служит `%b[12]` — ноль рантайма массивов,
  // который никто не переписывает (сам рантайм его только читает как нулевое смещение).
  //
  // Регистры в этих носителях уже ФИЗИЧЕСКИЕ: раскладка вставляет их после того, как раздала
  // регистры (`src/e2k/regAlloc.ts`), и берёт под них регистр, свободный в точке сайта.
  if (instruction.mnemonic === SPILL_LOAD || instruction.mnemonic === SPILL_STORE) {
    const operands = instruction.operands;
    const first = operands[0];
    const second = operands[1];
    const slot = operands[2];
    if (
      first === undefined ||
      second === undefined ||
      slot === undefined ||
      first.kind !== "reg" ||
      second.kind !== "reg" ||
      slot.kind !== "imm"
    ) {
      return failureOf(
        LOWERING_CODES.carrier,
        `«${instruction.mnemonic}»: ожидались [регистр, регистр, адрес слота], получено [${operands
          .map((operand) => operand.kind)
          .join(", ")}]`,
      );
    }
    const literal: Operand = { kind: "imm64", value: BigInt(slot.value) } as Operand;
    // НУЛЕВОЙ РЕГИСТР — четвёртым операндом, если он дан. По умолчанию ноль рантайма массивов
    // (`%b[12]`), и это верно для вытеснения раскладки и рантайма. Но у РАЗДЕЛЁННОГО сайта печати
    // вытеснение идёт ПОСЛЕ вызова процедуры, а возврат из вызываемой оставляет окно уже: `%b[12]`
    // в нём недоступен — измерено, `ldd %b[4], %b[12], %b[2]` сразу после вызова даёт ловушку
    // (`.tmp/osnova-ten-trap2.ts`). Поэтому конвейер называет свой ноль в самом носителе.
    const zeroOperand = instruction.operands[3];
    const zeroRegister = zeroOperand !== undefined && zeroOperand.kind === "reg" ? zeroOperand.index : ARRAY_REGISTERS.zero;
    if (instruction.mnemonic === SPILL_LOAD) {
      // `[регистр-адреса, регистр-приёмника, слот]` → `movtd адрес, #слот` + `ldd адрес, ноль, приёмник`.
      return {
        ok: true,
        instructions: [
          { mnemonic: "movtd", channel: 0, operands: [literal, reg(first.index)] },
          ldd(first.index, zeroRegister, second.index),
        ],
      };
    }
    // `[регистр-значения, регистр-адреса, слот]` → `movtd адрес, #слот` + `std значение, адрес, ноль`.
    return {
      ok: true,
      instructions: [
        { mnemonic: "movtd", channel: 0, operands: [literal, reg(second.index)] },
        std(first.index, second.index, zeroRegister),
      ],
    };
  }

  const comparison = comparisonMnemonicOf(instruction.mnemonic);
  if (comparison !== undefined) {
    const predicate = context.predicate;
    if (predicate === undefined) {
      return failureOf(
        LOWERING_CODES.layout,
        `«${instruction.mnemonic}»: сравнение понижается только ПАРОЙ с условным переходом — ` +
          "предикат, который оно пишет, читает `ct` (`SS.ctcond.psrc`), а значение в регистре предикатом " +
          "не является; сопоставление — src/e2k/predicatePairing.ts",
      );
    }
    const left = instruction.operands[1];
    const right = instruction.operands[2];
    for (const [at, operand] of [
      [1, left],
      [2, right],
    ] as const) {
      if (operand === undefined || operand.kind !== "reg") {
        return failureOf(
          LOWERING_CODES.carrier,
          `«${instruction.mnemonic}»: операнд ${at} не регистр — в e2k он попал бы в поле слога`,
        );
      }
    }
    return {
      ok: true,
      instructions: [
        {
          mnemonic: predicate.mnemonic,
          channel: instruction.channel,
          operands: [left!, right!, { kind: "pred", index: predicate.index }],
        },
      ],
    };
  }

  if (CONDITIONAL_JUMP_CARRIERS.includes(instruction.mnemonic)) {
    const displacement = context.displacement;
    const condition = context.condition;
    if (displacement === undefined || condition === undefined) {
      return failureOf(
        LOWERING_CODES.layout,
        `«${instruction.mnemonic}»: условный переход понижается серией «disp + ct» и требует ДВУХ ` +
          "вещей из контекста — смещения (раскладка) и кода условия `SS.ctcond` (сопоставление пары " +
          "со сравнением); иначе ни адрес цели, ни предикат взять неоткуда",
      );
    }
    return { ok: true, instructions: jumpCommands(displacement, condition) };
  }

  if (instruction.mnemonic === JUMP_CARRIER) {
    const displacement = context.displacement;
    if (displacement === undefined) return failureOf(LOWERING_CODES.layout, JUMP_NEEDS_LAYOUT);
    return { ok: true, instructions: jumpCommands(displacement) };
  }

  const single = lowerInstruction(instruction, context);
  return single.ok ? { ok: true, instructions: [single.instruction] } : single;
}

/**
 * Значение литерала для слота правила — либо число, либо причина отказа строкой.
 *
 * У `IR.const` операнд — индекс пула, поэтому значение берётся из `context.constants`; у прочих
 * правил с литералом (их пока нет) операнд нёс бы само число.
 */
function literalOf(
  instruction: AsmInstruction,
  index: number,
  operand: Operand | undefined,
  rule: LoweringRule,
  context: LoweringContext,
): number | string {
  if (operand === undefined || operand.kind !== "imm") {
    return `«${instruction.mnemonic}»: операнд ${index} — не число, а литерал e2k требует числа`;
  }
  if (rule.literalFromPool !== true) return operand.value;
  const poolIndex = operand.value;
  const value = context.constants?.[poolIndex];
  if (context.constants === undefined) {
    return `«${instruction.mnemonic}»: пул констант не передан, значение #${poolIndex} взять негде`;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return (
      `«${instruction.mnemonic}»: константа пула #${poolIndex} = ${String(value)} ` +
      `(тип ${typeof value}) — литералом e2k кодируются только целые 16- и 32-битные значения`
    );
  }
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// ОТЧЁТ О КОДИРУЕМОСТИ
// ─────────────────────────────────────────────────────────────────────────────

/** Отчёт по одному носителю IR. */
export interface CarrierReport {
  readonly carrier: string;
  readonly total: number;
  readonly encoded: number;
  readonly refused: number;
  /** Мнемоника e2k, если понижение — одна команда. */
  readonly mnemonic?: string;
  /** Команды понижения по порядку выдачи: у перехода их две (`disp`, `ct`). */
  readonly commands?: readonly string[];
  /** Причина отказа, если хоть одна инструкция отвергнута. */
  readonly reason?: string;
  /** Формат и код операции e2k (для отчёта). */
  readonly format?: string;
  readonly opc?: string;
}

/** Отчёт о прогоне одного ядра через реальную кодировку. */
export interface KernelRealReport {
  readonly kernel: string;
  readonly atom: string;
  /**
   * Носителей, **понижавшихся** в этом прогоне: столько осталось после устранения копий.
   *
   * Не путать с числом носителей эмиттера (`eliminated + instructions`) и с числом **команд** e2k
   * (`roundTrip.commands`): у перехода команд две, поэтому 87 команд при 90 носителях — не ошибка.
   * Три числа названы явно, потому что их смешение уже один раз прочиталось как «покрытие упало».
   */
  readonly instructions: number;
  /** Сколько носителей эмиттера снято устранением копий (знаменатель отчёта уменьшился на столько). */
  readonly eliminated: number;
  /** Сколько именно пересылок снято (часть снятых носителей — мертвые пересылки, не копии). */
  readonly removedCopies: number;
  readonly encoded: number;
  readonly refused: number;
  readonly bytes: number;
  readonly carriers: readonly CarrierReport[];
  /** Сколько разобранных обратно инструкций сверено и сколько расхождений. */
  readonly roundTrip: { readonly checked: number; readonly commands: number; readonly mismatches: readonly string[] };
  /**
   * Что дала раскладка: сколько инструкций размещено (адрес присвоен) и сколько байт занял образ.
   *
   * Сверка с `encoded`/`bytes` — не украшение: она ловит расхождение раскладки и кодирования
   * (адреса считались по таблице форм, байты — кодировщиком; если таблица врёт, числа разойдутся).
   */
  readonly layout: {
    readonly placed: number;
    readonly unplaced: number;
    readonly displacements: number;
    readonly totalBytes: number;
  };
  /** Все ли инструкции потока понижены (иначе сквозной прогон через реальную кодировку невозможен). */
  readonly executableThroughReal: boolean;
  /**
   * Раскладка регистров по процедурам (`src/e2k/regAlloc.ts`): где удалась — регистры
   * заменены на физические; где нет — отказ с пиком и конфликтами назван здесь, а не замалчивается.
   */
  readonly allocation: readonly ProcedureAllocation[];
  /**
   * Смещения процедур **после** укорочения потока (`name`, `codeOffset`).
   *
   * Смещения эмиттера оболочки к укороченному потоку неприменимы: между ними стоит устранение копий.
   */
  readonly allocationProcedures: readonly { readonly name: string; readonly codeOffset: number; readonly vregs: number }[];
  /**
   * Вызываемые процедуры и их окно: сколько регистров нужно против {@link WINDOW_REGISTERS_CALLEE}.
   *
   * `ok: false` значит «вызвать эту процедуру нельзя» — либо раскладка не удалась, либо она занимает
   * больше восьми регистров окна. Это не пожелание, а измерение: у вызываемой окно вдвое уже
   * (`src/e2k/e2kCallWindowQemu.test.ts`).
   */
  readonly calleeWindow: readonly {
    readonly procedure: string;
    readonly available: number;
    readonly needed: number;
    readonly ok: boolean;
    readonly reason?: string;
  }[];
  /** Носители, мешающие полному прогону, с причинами. */
  readonly blocking: readonly { readonly carrier: string; readonly count: number; readonly reason: string }[];
}

/**
 * Смещения вызовов: цель — адрес первой команды вызываемой процедуры, а `disp` идёт ПОСЛЕ пересылок
 * аргументов, то есть НЕ по адресу носителя.
 *
 * Возвращается отображение «индекс носителя → смещение в восьмибайтных словах». Носителя нет в
 * отображении, если адрес цели неизвестен (вызываемая процедура не размещена) — тогда понижение
 * откажет с названной причиной, а не выдумает адрес. Функция вынесена отдельно, чтобы её применяли и
 * конвейер, и оракул раскладки: одна формула в двух местах разошлась бы.
 */
export function callDisplacementsOf(
  instructions: readonly AsmInstruction[],
  procedures: readonly { readonly name: string; readonly codeOffset: number }[],
  addresses: ReadonlyMap<number, number>,
): Map<number, number> {
  const displacements = new Map<number, number>();
  instructions.forEach((instruction, index) => {
    if (instruction.mnemonic !== 'IR.call') return;
    const payload = instruction.operands[3];
    if (payload === undefined || payload.kind !== 'imm') return;
    const callee = procedures[payload.value];
    const carrierAddress = addresses.get(index);
    const targetOffset = callee === undefined ? undefined : addresses.get(callee.codeOffset);
    if (callee === undefined || carrierAddress === undefined || targetOffset === undefined) return;
    const flags = instruction.operands[0];
    const argc = flags !== undefined && flags.kind === 'imm' ? flags.value >> 1 : 0;
    const dispAddress = carrierAddress + argc * REAL_SHORT_FORM_SIZE;
    const delta = targetOffset - dispAddress;
    if (delta % REAL_SHORT_FORM_SIZE !== 0) return;
    displacements.set(index, delta / REAL_SHORT_FORM_SIZE);
  });
  return displacements;
}

/**
 * Совпадают ли понижённая инструкция и разобранная обратно.
 *
 * Делегировано общему {@link sameInstruction}: он сравнивает и **файл регистров**, а `%b[0]` и
 * `%r0` — разные ячейки (`binutils-gdb/opcodes/e2k-dis.c:416-419`). Прежняя местная сверка
 * смотрела только номер и подмену файла пропустила бы молча.
 */
function sameLowered(a: AsmInstruction, b: AsmInstruction): boolean {
  return sameInstruction(a, b);
}

/**
 * Прогнать поток одного ядра через реальную кодировку.
 *
 * Порядок: **раскладка** (первый проход — адреса, второй — смещения переходов), затем понижение
 * каждой инструкции (в одну команду или в серию — `lowerCarrier`), кодирование, разбор обратно и
 * сверка. Отказы собираются по носителям с причинами: и отказ раскладки, и отказ понижения, и
 * отказ кодировщика называют причину — молчаливой потери инструкций нет.
 *
 * `encoded` считает **инструкции IR**, а `roundTrip.commands` — команды e2k: у перехода их две,
 * и сверяются обе.
 */
export function runKernelThroughRealEncoding(
  emitted: ShellEmitResult,
  encoder: Encoder,
  meta: { kernel: string; atom: string },
): KernelRealReport {
  const stats = new Map<string, { total: number; encoded: number; refused: number; reason?: string }>();
  let bytes = 0;
  let checked = 0;
  let commands = 0;
  const mismatches: string[] = [];
  // Пул констант нужен носителю IR.const: его операнд — индекс пула, а литералу нужно значение.
  // Имена хост-вызовов обязательны: `payload` носителя `IR.invoke` — это ИНДЕКС в таблице имён
  // образа, и без неё понижение отказывает («не передан список имён»), хотя рантайм массивов умеет
  // заменять такие вызовы настоящими `ldd`/`std` (`src/e2k/arrayRuntime.ts`).
  const baseContext: LoweringContext = {
    constants: emitted.scheduled.constants,
    invokeNames: emitted.image.invokeNames,
  };

  // ── Раскладка регистров по процедурам (устранение копий + отрезки жизни) ────
  //
  // Эмиттер оболочки пишет номер vreg'а прямо в поле регистра; для ядра FIR это `%b[0..16]`, а
  // `%b[10..15]` держит рантайм массивов. Здесь копии снимаются, а оставшиеся значения
  // раскладываются по десяти свободным регистрам (`src/e2k/regAlloc.ts`); где не хватает — отказ
  // называется в отчёте, а не замалчивается. Входящие vreg'и (параметры) закреплены.
  //
  // ВАЖНО: раскладка **укорачивает** поток, поэтому двухпроходная раскладка адресов, сопоставление
  // пар и понижение идут дальше по нему, а не по `emitted.instructions`: иначе адреса, смещения
  // переходов и номера пар считались бы по другому потоку, чем тот, который кодируется. Цели
  // переходов внутри укороченного потока пересчитывает сама раскладка (`remapJumpTargets`).
  // БЛОК РАНТАЙМА МАССИВОВ ВЫДАЁТ РАСКЛАДКА, и путь оракула обязан повторять конфигурацию КОМПИЛЯТОРА
  // (§3.131). Прежде вызов стоял без опций — то есть НИ ОДНА процедура с массивами не была помечена,
  // и с §3.128 (понижение `IR.invoke` требует базы) все обращения к массивам отказывали: замер
  // 2026-10-10 показал `покрытие 372` против закреплённых `458` (`src/e2k/e2kPredicatePairs.test.ts`),
  // 86 носителей не доходили до байтов. Причина отказа была названа честно, но закреплённое число
  // мерило уже не тот поток, который выдаёт компилятор. Здесь повторено то же, что делает конвейер
  // (`src/e2k/programImage.ts#loweredProgram`): процедуры с обращениями к массивам помечены,
  // точке входа — её пул, вызываемой — `CALLEE_REGISTERS`.
  const entryAt = entryProcedureIndex(emitted.scheduled.procedures);
  const arrayProcedures = emitted.scheduled.procedures
    .map((procedure, at) => {
      const to = emitted.scheduled.procedures[at + 1]?.codeOffset ?? emitted.instructions.length;
      const usesArrays = emitted.instructions.slice(procedure.codeOffset, to).some((carrier) => {
        if (carrier.mnemonic !== 'IR.invoke') return false;
        const payload = carrier.operands[3];
        const name = payload !== undefined && payload.kind === 'imm' ? emitted.image.invokeNames[payload.value] : undefined;
        return name !== undefined && SUPPORTED_ARRAY_CALLS.includes(name);
      });
      return usesArrays ? at : undefined;
    })
    .filter((at): at is number => at !== undefined);
  const allocation = allocateProgram(emitted.instructions, emitted.scheduled.procedures, {
    arrayProcedures,
    freeFor: (at: number) => (at === entryAt ? undefined : CALLEE_REGISTERS),
  });
  const code = allocation.instructions;
  // Контекст понижения — ПО ПРОЦЕДУРАМ: базу блока знает та процедура, которой её выдала раскладка, и
  // признак вызываемой — свойство плоскости (в ней `создать`/`добавить` отказывают по имени §3.128).
  const procedureContextAt = new Map<number, { arrayBase?: number; inCallee: boolean }>();
  allocation.procedures.forEach((procedure, at) => {
    const to = allocation.procedures[at + 1]?.codeOffset ?? code.length;
    for (let index = procedure.codeOffset; index < to; index++) {
      const arrayBase = allocation.arrayBases[at];
      procedureContextAt.set(index, {
        ...(arrayBase === undefined ? {} : { arrayBase }),
        inCallee: at !== entryAt,
      });
    }
  });
  // ── Раскладка: адрес каждой инструкции, затем смещение каждого перехода ──────
  //
  // Контекст обязателен: длина `IR.invoke` зависит от имени вызова, и без списка имён носитель не
  // размещается вовсе (`carrierFormOf` возвращает причину, а не длину «на глаз»).
  // Пул констант обязателен: длина \`IR.const\` зависит от значения литерала (короткая форма 0…15).
  const layout = layoutOf(code, { invokeNames: emitted.image.invokeNames, constants: emitted.scheduled.constants });
  const resolved = secondPass(code, layout.addresses);
  // ── Сопоставление пар «сравнение → условный переход» ────────────────────────
  const pairing = pairPredicates(code);
  const displacementAt = new Map(resolved.displacements.map((item) => [item.index, item.disp]));
  const predicateAt = new Map(
    pairing.pairs.map((pair) => [pair.comparisonIndex, { mnemonic: pair.cmpMnemonic, index: pair.predicate }]),
  );
  const conditionAt = new Map(pairing.pairs.map((pair) => [pair.jumpIndex, pair.condition]));
  // ── Смещение каждого вызова ─────────────────────────────────────────────────
  //
  // Цель вызова — адрес первой команды вызываемой процедуры, а сама команда `disp` идёт ПОСЛЕ
  // пересылок аргументов. Одна формула на конвейер и на оракул — `callDisplacementsOf`.
  const callDisplacementAt = callDisplacementsOf(code, allocation.procedures, layout.addresses);
  const refusalAt = new Map<number, string>();
  for (const unplaced of layout.unplaced) refusalAt.set(unplaced.index, unplaced.reason);
  for (const refusal of resolved.refusals) refusalAt.set(refusal.index, refusal.reason);
  for (const refusal of pairing.refusals) refusalAt.set(refusal.index, refusal.reason);

  for (let index = 0; index < code.length; index++) {
    const instruction = code[index]!;
    const stat = stats.get(instruction.mnemonic) ?? { total: 0, encoded: 0, refused: 0 };
    stat.total++;
    const layoutRefusal = refusalAt.get(index);
    if (layoutRefusal !== undefined) {
      stat.refused++;
      stat.reason ??= layoutRefusal;
      stats.set(instruction.mnemonic, stat);
      continue;
    }
    const displacement = displacementAt.get(index);
    const predicate = predicateAt.get(index);
    const condition = conditionAt.get(index);
    const callDisplacement = callDisplacementAt.get(index);
    const lowered = lowerCarrier(code[index]!, {
      ...baseContext,
      ...(procedureContextAt.get(index) ?? {}),
      ...(displacement === undefined ? {} : { displacement }),
      ...(predicate === undefined ? {} : { predicate }),
      ...(condition === undefined ? {} : { condition }),
      ...(callDisplacement === undefined ? {} : { callDisplacement }),
    });
    if (!lowered.ok) {
      stat.refused++;
      stat.reason ??= lowered.reason;
      stats.set(instruction.mnemonic, stat);
      continue;
    }
    // Серия кодируется и сверяется **целиком**: иначе вторая команда пары проходила бы мимо круга.
    const encodedChunks: { command: AsmInstruction; bytes: Uint8Array }[] = [];
    let failure: string | undefined;
    for (const command of lowered.instructions) {
      try {
        encodedChunks.push({ command, bytes: encoder.encode(command) });
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        break;
      }
    }
    if (failure !== undefined) {
      stat.refused++;
      stat.reason ??= failure;
      stats.set(instruction.mnemonic, stat);
      continue;
    }
    stat.encoded++;
    stats.set(instruction.mnemonic, stat);
    checked++;
    for (const chunk of encodedChunks) {
      commands++;
      bytes += chunk.bytes.length;
      const back = encoder.decode(chunk.bytes);
      if (!sameLowered(back, chunk.command)) {
        mismatches.push(
          `${instruction.mnemonic}: «${chunk.command.mnemonic}» → ${back.mnemonic} (операндов ${back.operands.length})`,
        );
      }
    }
  }

  const carriers: CarrierReport[] = [...stats.entries()]
    .map(([carrier, stat]) => {
      const rule = loweringOf(carrier);
      // Форма берётся с ОПЕРАНДАМИ, а не по мнемонике: у `IR.invoke` длина зависит от имени вызова
      // (одна команда у «длина», девять у «добавить»), а имя лежит в операндах. Берётся первый
      // носитель этого вида — длина у всех носителей одного имени одна и та же, и это проверяет
      // `src/e2k/twoPassLayout.test.ts`.
      const sample = code.find((instruction) => instruction.mnemonic === carrier);
      const form = sample === undefined ? carrierForm(carrier) : carrierFormOf(sample, { invokeNames: emitted.image.invokeNames });
      const entry = rule === undefined ? undefined : realOpcode(rule.mnemonic);
      return {
        carrier,
        total: stat.total,
        encoded: stat.encoded,
        refused: stat.refused,
        ...(rule === undefined ? {} : { mnemonic: rule.mnemonic }),
        ...(form === undefined ? {} : { commands: form.commands.map((command) => command.mnemonic) }),
        ...(entry === undefined ? {} : { format: entry.form, opc: `0x${entry.opc.toString(16)}` }),
        ...(stat.reason === undefined ? {} : { reason: stat.reason }),
      };
    })
    .sort((a, b) => b.total - a.total || a.carrier.localeCompare(b.carrier));

  const refused = carriers.reduce((sum, carrier) => sum + carrier.refused, 0);
  const blocking = carriers
    .filter((carrier) => carrier.refused > 0)
    .map((carrier) => ({ carrier: carrier.carrier, count: carrier.refused, reason: carrier.reason ?? "не понижается" }));

  // ── Окно вызываемой процедуры ───────────────────────────────────────────────
  //
  // Вызываемая процедура получает ВОСЕМЬ регистров окна против шестнадцати у вызывающего — измерено
  // (`src/e2k/e2kCallWindowQemu.test.ts`). Значит «влезает ли процедура в окно вызываемой» — не
  // подробность, а условие того, что её вообще можно вызвать. Считается здесь, потому что вызывающих
  // видно только по носителям `IR.call`: их `payload` — индекс процедуры в модуле
  // (`src/e2k/emitterShell.ts:245-252`).
  const calledIndices = new Set<number>();
  for (const instruction of code) {
    if (instruction.mnemonic !== 'IR.call') continue;
    const payload = instruction.operands[3];
    if (payload?.kind === 'imm' && Number.isInteger(payload.value)) calledIndices.add(payload.value);
  }
  const calleeWindow = allocation.report
    .map((item, index) => ({ item, index }))
    .filter(({ index }) => calledIndices.has(index))
    .map(({ item }) => ({
      procedure: item.procedure,
      available: WINDOW_REGISTERS_CALLEE,
      needed: item.windowRegistersNeeded,
      ok: item.ok && item.fitsCalleeWindow,
      ...(item.ok
        ? item.fitsCalleeWindow
          ? {}
          : {
              reason:
                `«${item.procedure}»: нужно ${item.windowRegistersNeeded} регистров окна, а вызываемой ` +
                `доступно ${WINDOW_REGISTERS_CALLEE} (измерено: call wbs=4 уменьшает окно — ` +
                'docs/e2k-opcodes-real.md §7.10); вызвать её нельзя',
            }
        : { reason: item.reason ?? 'раскладка не удалась' }),
    }));

  return {
    kernel: meta.kernel,
    atom: meta.atom,
    instructions: code.length,
    eliminated: emitted.instructions.length - code.length,
    removedCopies: allocation.removedCopies,
    encoded: code.length - refused,
    refused,
    bytes,
    carriers,
    allocation: allocation.report,
    allocationProcedures: allocation.procedures,
    calleeWindow,
    roundTrip: { checked, commands, mismatches },
    layout: {
      placed: layout.entries.length,
      unplaced: layout.unplaced.length,
      displacements: resolved.displacements.length,
      totalBytes: layout.totalBytes,
    },
    executableThroughReal: refused === 0,
    blocking,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ПРОВЕРКА СМЫСЛА ПОНИЖЕНИЯ НА ДАННЫХ
// ─────────────────────────────────────────────────────────────────────────────

/** Имена синтетических хост-вызовов, которыми подменяются понижённые операции. */
export const SYNTHETIC = {
  move: "прогон.понижение.move",
  add: "прогон.понижение.add",
  sub: "прогон.понижение.sub",
  mul: "прогон.понижение.mul",
  // Целочисленное деление (БЛОК 2): `SDIVs` отсекает к нулю — ровно то же, что `Math.trunc` в VM.
  idiv: "прогон.понижение.idiv",
} as const;

/** Что наблюдалось при исполнении понижённых операций. */
export interface LoweringObservations {
  /** Сколько раз исполнена понижённая операция каждого вида. */
  readonly executed: Readonly<Record<string, number>>;
  /** Сколько раз результат отличался бы от IR-семантики (усечение до 32 бит). */
  readonly truncated: number;
  /** Сколько раз операнд не был целым числом (там, где понижение этого требует). */
  readonly nonInteger: number;
  /** Наибольшее |произведение|, наблюдённое на `IR.mul`. */
  readonly maxAbsProduct: number;
  /** Значение, возвращённое процедурой. */
  readonly value: StackValue | undefined;
}

/**
 * Исполнить модуль регистровой VM, заменив понижённые операции их **e2k-семантикой**.
 *
 * `IR.mul` заменяется на `Math.imul` — младшую половину 32-битного произведения (это и есть
 * `MULs`); `IR.add`/`IR.sub` — на целочисленные сложение и вычитание; `IR.move` — на пересылку.
 * Замена идёт **один к одному** по позициям кода, поэтому адреса переходов и разметка процедур
 * не сдвигаются.
 *
 * @throws если в модуле есть пакеты (замена позиций внутри пакета не определена)
 */
export async function runLoweredValues(
  module: RegModule,
  options: { maxSteps?: number; entryProcedure?: string } = {},
): Promise<LoweringObservations> {
  const code = module.code.map((element) => {
    if (isRegPacket(element)) {
      throw new Error("понижение проверяется на линейном коде: пакеты не поддержаны");
    }
    const instruction = element as RegInstruction;
    const rule = loweringOf(carrierOfOp(instruction.op));
    if (rule === undefined) return instruction;
    // `IR.const` остаётся IR-инструкцией: VM грузит константу из пула, и это ровно то, что делает
    // понижённый `movts` с литералом. Сам литерал проверяется на уровне байтов — кодированием и
    // разбором обратно (см. `runKernelThroughRealEncoding`, сверка `sameInstruction`).
    if (rule.literalFromPool === true) return instruction;
    const fields = instruction as unknown as { d?: number; a?: number; b?: number };
    const name = SYNTHETIC[rule.carrier.replace("IR.", "") as keyof typeof SYNTHETIC];
    const args = rule.assumption === "тип-значения" ? [fields.a ?? 0] : [fields.a ?? 0, fields.b ?? 0];
    return {
      op: "invoke",
      name,
      args,
      argc: args.length,
      ...(fields.d === undefined ? {} : { d: fields.d }),
    } as RegInstruction;
  });

  const counts: Record<string, number> = {};
  let truncated = 0;
  let nonInteger = 0;
  let maxAbsProduct = 0;

  const host = createDefaultInvokeHandler();
  const invoke = async (name: string, args: StackValue[]): Promise<StackValue> => {
    counts[name] = (counts[name] ?? 0) + 1;
    switch (name) {
      case SYNTHETIC.move:
        return args[0] as StackValue;
      case SYNTHETIC.add:
      case SYNTHETIC.sub: {
        const [left, right] = args;
        if (typeof left !== "number" || typeof right !== "number") nonInteger++;
        return name === SYNTHETIC.add
          ? (left as number) + (right as number)
          : (left as number) - (right as number);
      }
      case SYNTHETIC.mul: {
        const left = args[0] as number;
        const right = args[1] as number;
        if (typeof left !== "number" || typeof right !== "number") nonInteger++;
        const exact = left * right;
        const low = Math.imul(left, right);
        if (low !== exact) truncated++;
        if (Math.abs(exact) > maxAbsProduct) maxAbsProduct = Math.abs(exact);
        return low;
      }
      case SYNTHETIC.idiv: {
        // e2k-семантика `SDIVs`: отсечение К НУЛЮ (совпадает с `Math.trunc` и с IR-операцией `idiv`,
        // поэтому счётчик усечения здесь не растёт). Нулевой делитель на цели — `exc_div`, то есть
        // машинная ошибка, а не значение: называем её, а не возвращаем Infinity.
        const left = args[0] as number;
        const right = args[1] as number;
        if (typeof left !== "number" || typeof right !== "number") nonInteger++;
        if (right === 0) throw new Error("целочисленное деление на ноль: на эльбрусе это exc_div");
        return Math.trunc(left / right);
      }
      default:
        return host(name, args);
    }
  };

  const lowered: RegModule = { ...module, code: code as RegModule["code"] };
  const entry = resolveEntryIndex(lowered.procedures, options.entryProcedure) ?? 0;
  const vm = new RegVM(lowered, {
    maxSteps: options.maxSteps ?? 200_000,
    invoke,
    extraInvokes: Object.values(SYNTHETIC).map((name) => ({
      name,
      argc: name === SYNTHETIC.move ? 1 : 2,
    })),
  });
  const value = await vm.runProcedure(entry, []);
  return { executed: counts, truncated, nonInteger, maxAbsProduct, value };
}

/** Носитель IR по операции IR: обратная таблица эмиттера оболочки. */
function carrierOfOp(op: string): string {
  return `IR.${op}`;
}
