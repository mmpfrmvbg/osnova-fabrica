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
import { realOpcode, type RealSlot } from "./e2k-real";
import { JUMP_CARRIER, carrierForm, carrierFormOf, jumpCommands, layoutOf, secondPass, CONDITIONAL_JUMP_CARRIERS } from "./twoPassLayout";
import { comparisonMnemonicOf, pairPredicates } from "./predicatePairing";
import { lowerArrayCall } from "./arrayRuntime";
import { allocateProgram, type ProcedureAllocation } from "./regAlloc";
import type { ShellEmitResult } from "./emitterOracle";
import { RegVM } from "../runtime/vm/reginterpreter";
import { createDefaultInvokeHandler, type StackValue } from "../runtime/vm/interpreter";
import { resolveEntryIndex } from "../oracle/parity";
import { isRegPacket, type RegInstruction, type RegModule } from "../runtime/vm/regcode";

const reg = (index: number): Operand => ({ kind: "reg", index });
const imm = (value: number): Operand => ({ kind: "imm", value });

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
  "IR.call": "не реализовано в e2k-real: вызов — управляющий слог CS (opcodes/e2k-dis.c:1895)",
  "IR.ret": "не реализовано в e2k-real: возврат — управляющий слог CS (opcodes/e2k-dis.c:1895)",
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
    "не понижается: IR-деление вещественное, документированное деление e2k (SDIVs/x, UDIVs/x) — целочисленное",
  "IR.rem":
    "не понижается: IR-остаток вещественный, документированный (UMODx, SMODx) — целочисленный",
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
  | { readonly ok: false; readonly reason: string };

/**
 * Результат понижения носителя: одна команда или **серия** команд.
 *
 * Серия нужна там, где операции e2k не хватает одной команды: `IR.jmp` — это
 * `disp %ctpr1, <смещение>` **и** `ct %ctpr1` (см. {@link lowerCarrier}).
 */
export type CarrierLoweringResult =
  | { readonly ok: true; readonly instructions: readonly AsmInstruction[] }
  | { readonly ok: false; readonly reason: string };

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
    return {
      ok: false,
      reason: REFUSALS[instruction.mnemonic] ?? `носитель «${instruction.mnemonic}» не описан в таблице понижения`,
    };
  }
  const entry = realOpcode(rule.mnemonic)!;
  if (rule.slots.length !== rule.fromIr.length) {
    return { ok: false, reason: `правило «${rule.carrier}»: слотов ${rule.slots.length}, источников ${rule.fromIr.length}` };
  }
  if (instruction.operands.length <= Math.max(...rule.fromIr)) {
    return {
      ok: false,
      reason:
        `«${instruction.mnemonic}»: операндов ${instruction.operands.length}, ` +
        `правило понижения читает операнд ${Math.max(...rule.fromIr)}`,
    };
  }
  const operands: Operand[] = [];
  for (const index of rule.fromIr) {
    const operand = instruction.operands[index];
    if (index === rule.literalFromIr) {
      const literal = literalOf(instruction, index, operand, rule, context);
      if (typeof literal === "string") return { ok: false, reason: literal };
      operands.push(imm(literal));
      continue;
    }
    if (operand === undefined || operand.kind !== "reg") {
      return {
        ok: false,
        reason: `«${instruction.mnemonic}»: операнд ${index} не регистр — в e2k он попал бы в поле слога`,
      };
    }
    operands.push(reg(operand.index));
  }
  if (entry.operands.length !== rule.slots.length) {
    return {
      ok: false,
      reason: `«${rule.mnemonic}»: форма ${entry.form} несёт ${entry.operands.length} операнда, правило даёт ${rule.slots.length}`,
    };
  }
  return {
    ok: true,
    instruction: { mnemonic: rule.mnemonic, channel: instruction.channel, operands },
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
  // ── Массивы: `IR.invoke` заменяется настоящими обращениями к памяти ─────────────────────────
  //
  // Семантику несёт **имя** вызова (`payload` — индекс в `invokeNames` образа оболочки,
  // `src/e2k/emitterShell.ts:255-269`), а не код операции: в таблице опкодов МЦСТ такой операции
  // нет. Рантайм массивов (`src/e2k/arrayRuntime.ts`) превращает вызов в `ldd`/`std`; всё, чего он
  // не умеет (установить, удалить, срез, строки, математика), остаётся отказом с причиной имени.
  if (instruction.mnemonic === "IR.invoke") {
    const names = context.invokeNames;
    if (names === undefined) {
      return {
        ok: false,
        reason:
          "«IR.invoke»: не передан список имён хост-вызовов (`invokeNames` образа оболочки) — " +
          "без него `payload` это число, а не операция",
      };
    }
    const payload = instruction.operands[3];
    const flags = instruction.operands[0];
    if (payload === undefined || payload.kind !== "imm" || flags === undefined || flags.kind !== "imm") {
      return { ok: false, reason: "«IR.invoke»: операнды носителя не той формы (ожидались flags и payload числами)" };
    }
    const name = names[payload.value];
    if (name === undefined) {
      return {
        ok: false,
        reason: `«IR.invoke»: в таблице имён нет записи с индексом ${payload.value} (всего имён ${names.length})`,
      };
    }
    const argc = flags.value >> 1;
    const hasDestination = (flags.value & 1) === 1;
    const args = [instruction.operands[1], instruction.operands[2]].slice(0, argc);
    const destination = instruction.operands[4];
    if (hasDestination && (destination === undefined || destination.kind !== "reg")) {
      return { ok: false, reason: `«${name}»: у носителя нет регистра-приёмника, а флаг обещает результат` };
    }
    try {
      return {
        ok: true,
        instructions: lowerArrayCall(
          name,
          args as readonly Operand[],
          hasDestination ? (destination as { index: number }).index : undefined,
        ),
      };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  const comparison = comparisonMnemonicOf(instruction.mnemonic);
  if (comparison !== undefined) {
    const predicate = context.predicate;
    if (predicate === undefined) {
      return {
        ok: false,
        reason:
          `«${instruction.mnemonic}»: сравнение понижается только ПАРОЙ с условным переходом — ` +
          "предикат, который оно пишет, читает `ct` (`SS.ctcond.psrc`), а значение в регистре предикатом " +
          "не является; сопоставление — src/e2k/predicatePairing.ts",
      };
    }
    const left = instruction.operands[1];
    const right = instruction.operands[2];
    for (const [at, operand] of [
      [1, left],
      [2, right],
    ] as const) {
      if (operand === undefined || operand.kind !== "reg") {
        return {
          ok: false,
          reason: `«${instruction.mnemonic}»: операнд ${at} не регистр — в e2k он попал бы в поле слога`,
        };
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
      return {
        ok: false,
        reason:
          `«${instruction.mnemonic}»: условный переход понижается серией «disp + ct» и требует ДВУХ ` +
          "вещей из контекста — смещения (раскладка) и кода условия `SS.ctcond` (сопоставление пары " +
          "со сравнением); иначе ни адрес цели, ни предикат взять неоткуда",
      };
    }
    return { ok: true, instructions: jumpCommands(displacement, condition) };
  }

  if (instruction.mnemonic === JUMP_CARRIER) {
    const displacement = context.displacement;
    if (displacement === undefined) return { ok: false, reason: JUMP_NEEDS_LAYOUT };
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
  /** Носители, мешающие полному прогону, с причинами. */
  readonly blocking: readonly { readonly carrier: string; readonly count: number; readonly reason: string }[];
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
  const allocation = allocateProgram(emitted.instructions, emitted.scheduled.procedures);
  const code = allocation.instructions;
  // ── Раскладка: адрес каждой инструкции, затем смещение каждого перехода ──────
  //
  // Контекст обязателен: длина `IR.invoke` зависит от имени вызова, и без списка имён носитель не
  // размещается вовсе (`carrierFormOf` возвращает причину, а не длину «на глаз»).
  const layout = layoutOf(code, { invokeNames: emitted.image.invokeNames });
  const resolved = secondPass(code, layout.addresses);
  // ── Сопоставление пар «сравнение → условный переход» ────────────────────────
  const pairing = pairPredicates(code);
  const displacementAt = new Map(resolved.displacements.map((item) => [item.index, item.disp]));
  const predicateAt = new Map(
    pairing.pairs.map((pair) => [pair.comparisonIndex, { mnemonic: pair.cmpMnemonic, index: pair.predicate }]),
  );
  const conditionAt = new Map(pairing.pairs.map((pair) => [pair.jumpIndex, pair.condition]));
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
    const lowered = lowerCarrier(code[index]!, {
      ...baseContext,
      ...(displacement === undefined ? {} : { displacement }),
      ...(predicate === undefined ? {} : { predicate }),
      ...(condition === undefined ? {} : { condition }),
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
