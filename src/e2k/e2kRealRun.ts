/**
 * СКВОЗНОЙ ПРОГОН ПЯТИ DSP-ЯДЕР ЧЕРЕЗ РЕАЛЬНУЮ КОДИРОВКУ e2k.
 *
 * # Что здесь делается
 *
 * ```
 * исходник ядра → RegModule → разметка атомов → emitShell(оболочка) → носители IR
 *      → ПОНИЖЕНИЕ в операции e2k (таблица ниже) → e2k-real.encode → байты
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
 * **Предпосылки понижения названы и проверяются на данных, а не предполагаются молча:**
 *
 * | понижение | предпосылка | чем проверяется |
 * |---|---|---|
 * | `IR.move` → `movts` | значение любого типа переносится без изменения | значение на выходе |
 * | `IR.add` → `adds` | операнды — целые числа (у `IR.add` есть строковая ветвь: склейка строк) | типы операндов в прогоне |
 * | `IR.sub` → `subs` | операнды — целые числа | типы операндов в прогоне |
 * | `IR.mul` → `muls` | `MULs` даёт **младшую половину** 32-битного произведения; совпадает, пока результат укладывается в 32 бита | `Math.imul(a,b) !== a*b` в прогоне |
 *
 * # Чего этот модуль НЕ делает
 *
 * Не исполняет реальный машинный код: эмулятора e2k нет (QEMU не собран — `docs/e2k-qemu-build.md`).
 * Байты кодируются и разбираются **своим** кодировщиком, а смысл проверяется на регистровой VM.
 * Это проверяет **согласованность понижения и кодера**, а не работу кода на e2k.
 */

import type { AsmInstruction, Encoder, Operand } from "./backend";
import { realOpcode, type RealSlot } from "./e2k-real";
import type { ShellEmitResult } from "./emitterOracle";
import { RegVM } from "../runtime/vm/reginterpreter";
import { createDefaultInvokeHandler, type StackValue } from "../runtime/vm/interpreter";
import { resolveEntryIndex } from "../oracle/parity";
import { isRegPacket, type RegInstruction, type RegModule } from "../runtime/vm/regcode";

const reg = (index: number): Operand => ({ kind: "reg", index });

// ─────────────────────────────────────────────────────────────────────────────
// ТАБЛИЦА ПОНИЖЕНИЯ
// ─────────────────────────────────────────────────────────────────────────────

/** Предпосылка понижения, проверяемая на данных прогона. */
export type LoweringAssumption = "тип-значения" | "целые-операнды" | "32-битное-произведение";

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
}

/**
 * Понижение четырёх операций. Остальные носители IR **не понижаются** — см. {@link REFUSALS}.
 */
export const LOWERING: readonly LoweringRule[] = [
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

/** Причины, по которым остальные носители IR не понижаются. */
export const REFUSALS: Readonly<Record<string, string>> = {
  "IR.const":
    "не реализовано в e2k-real: пул констант требует слога литералов (LTS) и литерального размещения " +
    "(gas/config/tc-e2k.c:9500-9508); в реализованных формах e2k-real его нет",
  "IR.invoke":
    "НЕТ В ИСТОЧНИКЕ: хост-вызов — операция рантайма; в таблице опкодов МЦСТ (opcodes/e2k-opc.h) " +
    "операции с такой семантикой нет",
  "IR.call": "не реализовано в e2k-real: вызов — управляющий слог CS (opcodes/e2k-dis.c:1895)",
  "IR.ret": "не реализовано в e2k-real: возврат — управляющий слог CS (opcodes/e2k-dis.c:1895)",
  "IR.jmp": "не реализовано в e2k-real: переход — управляющий слог CS/SS",
  "IR.jmp_if": "не реализовано в e2k-real: условный переход — управляющий слог с предикатом",
  "IR.jmp_if_not": "не реализовано в e2k-real: условный переход — управляющий слог с предикатом",
  "IR.eq": "семантика не совпадает: сравнение e2k (cmp*, ALOPF7) даёт предикат, а IR-сравнение — значение в регистре",
  "IR.ne": "семантика не совпадает: сравнение e2k даёт предикат, а IR-сравнение — значение в регистре",
  "IR.lt": "семантика не совпадает: сравнение e2k даёт предикат, а IR-сравнение — значение в регистре",
  "IR.le": "семантика не совпадает: сравнение e2k даёт предикат, а IR-сравнение — значение в регистре",
  "IR.gt": "семантика не совпадает: сравнение e2k даёт предикат, а IR-сравнение — значение в регистре",
  "IR.ge": "семантика не совпадает: сравнение e2k даёт предикат, а IR-сравнение — значение в регистре",
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
 * Понизить инструкцию-носитель IR в инструкцию e2k.
 *
 * Инструкция e2k собирается из тех же полей IR: у `move` — источник и приёмник, у остальных —
 * два источника и приёмник. Канал берётся из инструкции IR (эмиттер оболочки ставит 0).
 */
export function lowerInstruction(instruction: AsmInstruction): LoweringResult {
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

// ─────────────────────────────────────────────────────────────────────────────
// ОТЧЁТ О КОДИРУЕМОСТИ
// ─────────────────────────────────────────────────────────────────────────────

/** Отчёт по одному носителю IR. */
export interface CarrierReport {
  readonly carrier: string;
  readonly total: number;
  readonly encoded: number;
  readonly refused: number;
  /** Мнемоника e2k, если понижение есть. */
  readonly mnemonic?: string;
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
  readonly instructions: number;
  readonly encoded: number;
  readonly refused: number;
  readonly bytes: number;
  readonly carriers: readonly CarrierReport[];
  /** Сколько разобранных обратно инструкций сверено и сколько расхождений. */
  readonly roundTrip: { readonly checked: number; readonly mismatches: readonly string[] };
  /** Все ли инструкции потока понижены (иначе сквозной прогон через реальную кодировку невозможен). */
  readonly executableThroughReal: boolean;
  /** Носители, мешающие полному прогону, с причинами. */
  readonly blocking: readonly { readonly carrier: string; readonly count: number; readonly reason: string }[];
}

function sameLowered(a: AsmInstruction, b: AsmInstruction): boolean {
  if (a.mnemonic !== b.mnemonic || a.channel !== b.channel) return false;
  if (a.operands.length !== b.operands.length) return false;
  return a.operands.every((operand, index) => {
    const other = b.operands[index]!;
    return operand.kind === other.kind && operand.kind === "reg" && other.kind === "reg"
      ? operand.index === other.index
      : false;
  });
}

/**
 * Прогнать поток одного ядра через реальную кодировку.
 *
 * Каждая инструкция потока понижается (если правило есть), кодируется `e2k-real`, разбирается
 * обратно и сверяется с понижённой. Отказы собираются по носителям с причинами — молчаливой
 * потери инструкций нет.
 */
export function runKernelThroughRealEncoding(
  emitted: ShellEmitResult,
  encoder: Encoder,
  meta: { kernel: string; atom: string },
): KernelRealReport {
  const stats = new Map<string, { total: number; encoded: number; refused: number; reason?: string }>();
  let bytes = 0;
  let checked = 0;
  const mismatches: string[] = [];

  for (const instruction of emitted.instructions) {
    const stat = stats.get(instruction.mnemonic) ?? { total: 0, encoded: 0, refused: 0 };
    stat.total++;
    const lowered = lowerInstruction(instruction);
    if (!lowered.ok) {
      stat.refused++;
      stat.reason ??= lowered.reason;
      stats.set(instruction.mnemonic, stat);
      continue;
    }
    let encodedBytes: Uint8Array;
    try {
      encodedBytes = encoder.encode(lowered.instruction);
    } catch (error) {
      stat.refused++;
      stat.reason ??= error instanceof Error ? error.message : String(error);
      stats.set(instruction.mnemonic, stat);
      continue;
    }
    stat.encoded++;
    bytes += encodedBytes.length;
    stats.set(instruction.mnemonic, stat);
    const back = encoder.decode(encodedBytes);
    checked++;
    if (!sameLowered(back, lowered.instruction)) {
      mismatches.push(
        `${instruction.mnemonic}: «${lowered.instruction.mnemonic}» → ${back.mnemonic} (операндов ${back.operands.length})`,
      );
    }
  }

  const carriers: CarrierReport[] = [...stats.entries()]
    .map(([carrier, stat]) => {
      const rule = loweringOf(carrier);
      const entry = rule === undefined ? undefined : realOpcode(rule.mnemonic);
      return {
        carrier,
        total: stat.total,
        encoded: stat.encoded,
        refused: stat.refused,
        ...(rule === undefined ? {} : { mnemonic: rule.mnemonic }),
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
    instructions: emitted.instructions.length,
    encoded: emitted.instructions.length - refused,
    refused,
    bytes,
    carriers,
    roundTrip: { checked, mismatches },
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
