/**
 * ЭМИТТЕР НА ВНУТРЕННЕЙ ОБОЛОЧКЕ (не эмиттер e2k).
 *
 * # Что он делает
 *
 * `RegModule` + `module.atoms` → поток 10-байтовых инструкций оболочки, карта размещения и
 * паспорт выхода. Инструкции едут **носителями IR** (`IR.*`): операции регистрового IR не
 * соответствуют документированным операциям e2k (пул констант, имя хост-вызова, абсолютный
 * адрес перехода, вещественное деление) — обоснование и границы в `docs/e2k-emitter-shell.md`.
 *
 * **Это код на оболочке, а не e2k.** Кодировки e2k в руководстве МЦСТ нет
 * (`docs/e2k-encoding-raw.md` §1.7), поэтому выход помечается паспортом со статусом
 * `ДОПУЩЕНИЕ`, а не выдаётся за машинный код целевой архитектуры.
 *
 * # Непреложные правила
 *
 * | # | правило |
 * |---|---|
 * | 2.1 | `optimizable` читается **только** из `module.atoms`; разметка вызывающего игнорируется |
 * | 2.2 | `optimizable: true` → перестановка внутри участка атома |
 * | 2.3 | `optimizable: false` → порядок сохраняется (упаковки на этой оболочке нет: одно слово — одна операция) |
 * | 2.4 | через границу атома — никогда |
 * | 2.5 | непустой `verifyAtomRegions` → останов, а не «почти работает» |
 *
 * # Чего эмиттер не делает
 *
 * Не упаковывает несколько операций в одно слово (в оболочке нет широкой команды), не
 * назначает каналы выдачи (модель устройства не используется), не понижает IR в
 * документированные операции e2k (такого понижения у проекта нет) и не проверяет семантику —
 * это делает сквозной прогон (`src/e2k/emitterRoundtrip.ts`).
 */

import type { AsmInstruction, Encoder, Operand } from "./backend";
import { isIrCarrier } from "./shell";
import {
  EmitterRefusalError,
  SHELL_IMAGE_FORMAT,
  SHELL_IMAGE_VERSION,
  assertEmitResult,
  type EmitReport,
  type PlacementEntry,
  type RegionReport,
  type ShellEmitResult,
  type ShellImage,
} from "./emitterOracle";
import { verifyAtomRegions } from "../compiler/atomRegions";
import { isRegPacket, type RegAtomRegion, type RegInstruction, type RegModule } from "../runtime/vm/regcode";
import { scheduleRegWithReorder } from "../vliw/reorderScheduler";

/** Инъекция дефектов — ТОЛЬКО для негативного контроля. */
export interface EmitterDefects {
  /** 4.1 — не ограничивать перестановку границами атома (переставлять через границу). */
  ignoreAtomBoundaries?: boolean;
  /** 4.2 — брать `optimizable` из разметки вызывающего, а не из `module.atoms`. */
  trustCallerFlags?: boolean;
  /** 4.3 — не отвергать инструкции без носителя, а подставлять `IR.move`. */
  allowUnsupported?: boolean;
}

/** Опции эмиссии. */
export interface EmitOptions {
  /**
   * Разметка **вызывающего**. Её флаги эмиттер игнорирует (правило 2.1): параметр принимается
   * только чтобы проверка «взято из `module.atoms`, а не от вызывающего» была измеримой.
   */
  callerAtoms?: readonly RegAtomRegion[];
  /** Дефекты — только для негативного контроля. */
  defects?: EmitterDefects;
}

/**
 * Соответствие операции IR её носителю.
 *
 * Экспортируется, потому что обратный разбор (`src/e2k/emitterRoundtrip.ts`) обязан
 * пользоваться **той же** таблицей: две таблицы разошлись бы, и круг «байты → IR» перестал бы
 * проверять что-либо.
 */
export const CARRIER_OF_OP: Readonly<Record<string, string>> = {
  const: "IR.const",
  move: "IR.move",
  add: "IR.add",
  sub: "IR.sub",
  mul: "IR.mul",
  div: "IR.div",
  // БЛОК 2: целочисленное деление — отдельный носитель. `IR.div` вещественный и
  // потому остаётся отказом, а `IR.idiv` понижается в `sdivs` (семантика совпадает:
  // отсечение к нулю).
  idiv: "IR.idiv",
  rem: "IR.rem",
  eq: "IR.eq",
  ne: "IR.ne",
  lt: "IR.lt",
  le: "IR.le",
  gt: "IR.gt",
  ge: "IR.ge",
  and: "IR.and",
  or: "IR.or",
  not: "IR.not",
  jmp: "IR.jmp",
  jmp_if: "IR.jmp_if",
  jmp_if_not: "IR.jmp_if_not",
  call: "IR.call",
  invoke: "IR.invoke",
  ret: "IR.ret",
  // ПАРА `Результат<Т, Е>` — ДВА носителя, и это не дробление ради дробления: `call`/`ret` несут
  // ровно одно регистровое поле приёмника, а паре нужно второе место (тег + нагрузка). Поэтому
  // нагрузка едет своим носителем: при возврате — записью в клетку `1` вызываемой (`IR.ret_result`),
  // в вызывающем — чтением клетки `2·wbs + 1` (`IR.result_pick`, `docs/abi-v3-draft.md` §10.2).
  // Формы обоих — в `twoPassLayout.ts`, и берутся они из ТОГО ЖЕ списка команд, что и понижение.
  result_pick: "IR.result_pick",
};

/**
 * Операции с формой `(dst, a, b)` — арифметика и сравнения.
 *
 * Живут рядом с {@link CARRIER_OF_OP} намеренно: обратный разбор (`src/e2k/emitterRoundtrip.ts`)
 * обязан знать ровно тот же набор, а переписанный у него литералом список уже разошёлся — в нём не
 * оказалось `idiv`, и круг «байты → IR» отказывал на единственном носителе, который появился позже
 * списка (измерено `npm test`: ядро IIR не исполнялось в симуляторе оболочки).
 */
export const BINARY_OPS = [
  "add",
  "sub",
  "mul",
  "div",
  "idiv",
  "rem",
  "eq",
  "ne",
  "lt",
  "le",
  "gt",
  "ge",
  "and",
  "or",
] as const;

/** Операции IR, для которых носителя нет, и почему. */
const NO_CARRIER: Readonly<Record<string, string>> = {
  "const.true": "литеральные константы языка отражаются через пул (`const`), отдельного носителя нет",
  "const.false": "литеральные константы языка отражаются через пул (`const`), отдельного носителя нет",
  "const.null": "литеральные константы языка отражаются через пул (`const`), отдельного носителя нет",
  "obj.new": "создание объекта — операция рантайма, в документированном подмножестве её нет",
  "obj.get": "доступ к полю — операция рантайма, в документированном подмножестве её нет",
  "obj.set": "запись поля — операция рантайма, в документированном подмножестве её нет",
  try_begin: "исключения не входят в подмножество; обработчик живёт вне потока инструкций",
  try_end: "исключения не входят в подмножество",
  throw: "исключения не входят в подмножество",
};

/** Типы констант пула в порядке поля `flags` носителя `IR.const`. */
const CONST_TYPES: readonly string[] = ["i32", "f64", "str", "bool", "null"];

/**
 * Максимальное число аргументов, которое несёт носитель вызова.
 *
 * Было **2** — и это был не предел архитектуры, а нехватка поля: у записи оболочки три регистровых
 * поля (`dst`, `src1`, `src2`), из которых вызов занимает два аргументами и одно приёмником.
 * Третьему аргументу места не оставалось, и оболочка отказывала **исключением** — то есть
 * программа не компилировалась вовсе. Цена: у цели (DF) действия гномов имеют 3–5 аргументов.
 *
 * Стало **3**: третий аргумент едет своим полем `src3` (`src/e2k/encoding.ts`, 11-й байт записи).
 * Пятиоперандная форма на два аргумента не изменилась — иначе поехали бы все собранные руками
 * носители. Предел назван числом, и следующий шаг (4–5 аргументов под DF) — поднять его ещё раз.
 */
export const MAX_CALL_ARGS = 3;

/** Поля инструкций IR, нужные понижению (единый вид вместо сужения объединения). */
interface InsFields {
  d?: number;
  a?: number;
  b?: number;
  cond?: number;
  off?: number;
  v?: number;
  /** Нагрузка пары `Результат<Т, Е>` при возврате (`v` тогда — тег), `docs/abi-v3-draft.md` §10.2. */
  v2?: number;
  k?: number;
  type?: string;
  name?: string;
  fi?: number;
  argc?: number;
  args?: number[];
}

const reg = (index: number): Operand => ({ kind: "reg", index });
const num = (value: number): Operand => ({ kind: "imm", value });

function fieldsOf(instruction: RegInstruction): InsFields {
  return instruction as unknown as InsFields;
}

function cloneInstruction(instruction: RegInstruction): RegInstruction {
  return JSON.parse(JSON.stringify(instruction)) as RegInstruction;
}

function cloneModule(module: RegModule): RegModule {
  return JSON.parse(JSON.stringify(module)) as RegModule;
}

function requireRegister(value: number | undefined, what: string): number {
  if (value === undefined || !Number.isInteger(value) || value < 0 || value > 63) {
    throw new EmitterRefusalError(
      `${what}: регистр ${String(value)} не выражается полем оболочки (шесть бит, 0..63)`,
    );
  }
  return value;
}

/** Операции, несущие абсолютный адрес перехода (его пересчитывает перестановка). */
function hasAddress(instruction: RegInstruction): boolean {
  return (
    instruction.op === "jmp" ||
    instruction.op === "jmp_if" ||
    instruction.op === "jmp_if_not" ||
    instruction.op === "try_begin"
  );
}

/**
 * Понизить инструкцию IR до инструкции оболочки (носителя).
 *
 * @throws EmitterRefusalError если операции нет носителя или её поля не выражаются
 */
function lowerInstruction(
  instruction: RegInstruction,
  module: RegModule,
  invokeNames: readonly string[],
  defects: EmitterDefects,
): AsmInstruction {
  const fields = fieldsOf(instruction);
  // Канал выдачи не назначается: модель устройства этим эмиттером не используется.
  const channel = 0;
  const op = instruction.op;
  const known = CARRIER_OF_OP[op];
  if (known === undefined) {
    if (defects.allowUnsupported !== true) {
      throw new EmitterRefusalError(
        `операция «${op}» не выражается оболочкой: ` +
          `${NO_CARRIER[op] ?? "носителя нет"} — останов, а не подстановка`,
      );
    }
    // 4.3: подстановка вместо отказа. Правдоподобный, но неверный носитель — потеря
    // обнаруживается только на уровне IR (шлюз кодировки байты считает согласованными).
    return {
      mnemonic: "IR.move",
      channel,
      operands: [reg(requireRegister(fields.d ?? 0, "подстановка")), reg(requireRegister(fields.a ?? 0, "подстановка"))],
    };
  }
  const carrier = known;

  if (op === "const" && carrier === "IR.const") {
    const type = CONST_TYPES.indexOf(fields.type ?? "");
    if (type < 0) throw new EmitterRefusalError(`const: неизвестный тип пула «${String(fields.type)}»`);
    if (fields.k === undefined) throw new EmitterRefusalError("const: в инструкции нет индекса пула");
    return {
      mnemonic: carrier,
      channel,
      operands: [reg(requireRegister(fields.d, "const")), num(fields.k), num(type)],
    };
  }

  if (op === "move") {
    return {
      mnemonic: carrier,
      channel,
      operands: [reg(requireRegister(fields.d, "move")), reg(requireRegister(fields.a, "move"))],
    };
  }

  if (op === "jmp") {
    return { mnemonic: carrier, channel, operands: [num(fields.off ?? -1)] };
  }

  if (op === "jmp_if" || op === "jmp_if_not") {
    return {
      mnemonic: carrier,
      channel,
      operands: [reg(requireRegister(fields.cond, op)), num(fields.off ?? -1)],
    };
  }

  if (op === "call" || op === "invoke") {
    const argc = fields.argc ?? 0;
    if (argc > MAX_CALL_ARGS) {
      throw new EmitterRefusalError(
        `${op}: аргументов ${argc}, носитель несёт не больше ${MAX_CALL_ARGS}`,
      );
    }
    const args = fields.args ?? [];
    let payload: number;
    if (op === "call") {
      const fi = fields.fi;
      if (fi === undefined || !Number.isInteger(fi) || fi < 0 || fi >= module.procedures.length) {
        throw new EmitterRefusalError(
          `call: индекс процедуры ${String(fi)} вне модуля (процедур ${module.procedures.length})`,
        );
      }
      payload = fi;
    } else {
      if (fields.name === undefined) throw new EmitterRefusalError("invoke: в инструкции нет имени вызова");
      const index = invokeNames.indexOf(fields.name);
      if (index < 0) throw new EmitterRefusalError(`invoke: имя «${fields.name}» отсутствует в таблице имён`);
      payload = index;
    }
    const flags = (fields.d !== undefined ? 1 : 0) | (argc << 1);
    // ПЕРВЫЕ ПЯТЬ ОПЕРАНДОВ НЕ СДВИГАЮТСЯ НИКОГДА: `flags`, два аргумента, нагрузка, приёмник.
    // Третий аргумент дописывается ШЕСТЫМ и только тогда, когда он есть, — так пятиоперандная
    // форма остаётся ровно прежней, и все собранные руками носители продолжают работать.
    const operands: Operand[] = [
      num(flags),
      reg(requireRegister(args[0] ?? 0, op)),
      reg(requireRegister(args[1] ?? 0, op)),
      num(payload),
      reg(requireRegister(fields.d ?? 0, op)),
    ];
    if (argc >= 3) operands.push(reg(requireRegister(args[2] ?? 0, op)));
    return { mnemonic: carrier, channel, operands };
  }

  if (op === "ret") {
    // ПАРА `Результат<Т, Е>` — ДРУГОЙ НОСИТЕЛЬ, а не тот же с лишним операндом: у `IR.ret` форма
    // объявлена раскладке как «необязательная запись значения + пара возврата», и менять её значило
    // бы тронуть существующий носитель. Новый носитель со своей формой — названная граница
    // (`docs/abi-v3-draft.md` §10.2, решение владельца 2026-11-05).
    if (fields.v2 !== undefined) {
      return {
        mnemonic: "IR.ret_result",
        channel,
        operands: [
          reg(requireRegister(fields.v, "ret_result")),
          reg(requireRegister(fields.v2, "ret_result")),
        ],
      };
    }
    return {
      mnemonic: carrier,
      channel,
      operands: [num(fields.v !== undefined ? 1 : 0), reg(requireRegister(fields.v ?? 0, "ret"))],
    };
  }

  if (op === "result_pick") {
    // Порядок операндов — общий для носителей: сначала ПРИЁМНИК (определение), потом источник.
    // Источник здесь — не значение, а якорь порядка (приёмник тега того же вызова), и это названо
    // в `src/e2k/e2kRealRun.ts` у самого понижения.
    return {
      mnemonic: carrier,
      channel,
      operands: [
        reg(requireRegister(fields.d, "result_pick")),
        reg(requireRegister(fields.a, "result_pick")),
      ],
    };
  }

  if (op === "not") {
    return {
      mnemonic: carrier,
      channel,
      operands: [reg(requireRegister(fields.d, "not")), reg(requireRegister(fields.a, "not"))],
    };
  }

  // Остальные операции с носителем — двухоперандные арифметические и сравнения.
  return {
    mnemonic: carrier,
    channel,
    operands: [
      reg(requireRegister(fields.d, carrier)),
      reg(requireRegister(fields.a, carrier)),
      reg(requireRegister(fields.b, carrier)),
    ],
  };
}

/** Имена хост-вызовов в порядке появления, без повторов. */
function collectInvokeNames(code: readonly RegInstruction[]): string[] {
  const names: string[] = [];
  for (const instruction of code) {
    const fields = fieldsOf(instruction);
    if (instruction.op === "invoke" && fields.name !== undefined && !names.includes(fields.name)) {
      names.push(fields.name);
    }
  }
  return names;
}

/**
 * Участки атомов.
 *
 * Правило 2.1: источник флагов — `module.atoms`. Разметка вызывающего (`callerAtoms`)
 * принимается, но **не используется**; дефект 4.2 включает её использование.
 */
function regionsOf(
  module: RegModule,
  defects: EmitterDefects,
  callerAtoms?: readonly RegAtomRegion[],
): RegAtomRegion[] {
  if (defects.ignoreAtomBoundaries === true) {
    return [
      {
        atom: module.atoms?.[0]?.atom ?? "?",
        optimizable: (module.atoms ?? []).some((region) => region.optimizable),
        procedure: -1,
        start: 0,
        end: module.code.length,
      },
    ];
  }
  const source =
    defects.trustCallerFlags === true && callerAtoms !== undefined && callerAtoms.length > 0
      ? callerAtoms
      : module.atoms;
  return [...(source ?? [])].sort((a, b) => a.start - b.start);
}

/**
 * Эмитировать код на оболочке.
 *
 * @param module регистровый модуль с разметкой атомов (не мутируется)
 * @param encoder кодировщик оболочки (`getEncoder("internal-shell")`)
 * @throws EmitterRefusalError при непустом `verifyAtomRegions`, отсутствии носителя или
 *         нарушении границ участка
 */
export function emitShell(module: RegModule, encoder: Encoder, options: EmitOptions = {}): ShellEmitResult {
  const defects = options.defects ?? {};

  // ── 2.5. Разметка обязана быть корректной — иначе останов ────────────────────
  if (module.atoms === undefined) {
    throw new EmitterRefusalError(
      "разметка атомов отсутствует: без неё границы участков неизвестны, эмиссия остановлена",
    );
  }
  const problems = verifyAtomRegions(module);
  if (problems.length > 0) {
    throw new EmitterRefusalError(
      `разметка атомов не прошла проверку — останов до эмиссии:\n- ${problems.join("\n- ")}`,
    );
  }
  if (module.code.some((element) => isRegPacket(element))) {
    throw new EmitterRefusalError(
      "модуль содержит пакеты: эмиттер работает по линейному коду (одна инструкция — один элемент)",
    );
  }

  const code = module.code as RegInstruction[];
  const regions = regionsOf(module, defects, options.callerAtoms);
  if (regions.length === 0) {
    throw new EmitterRefusalError("участков атомов нет: эмитировать нечего");
  }

  // ── 2.1–2.4. Перестановка внутри участков, через границу — никогда ───────────
  const regionProcedureAt: number[] = new Array(code.length).fill(-1);
  const order: number[] = new Array(code.length).fill(-1);
  const reports: RegionReport[] = [];

  for (const region of regions) {
    const length = region.end - region.start;
    if (length <= 0) {
      throw new EmitterRefusalError(`участок ${region.atom}: пустой диапазон ${region.start}..${region.end}`);
    }
    const body: RegInstruction[] = [];
    const bodyToModule: number[] = [];
    for (let i = region.start; i < region.end; i++) {
      body.push(code[i]!);
      bodyToModule.push(i);
    }
    let localOrder = body.map((_, i) => i);
    if (region.optimizable) {
      // Перестановка внутри участка. `offsetBase` обязателен: адреса переходов абсолютные.
      const scheduled = scheduleRegWithReorder(body, { memoryLevel: "l1", offsetBase: region.start });
      localOrder = scheduled.order;
    }
    const sorted = [...localOrder].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i] !== i) {
        throw new EmitterRefusalError(
          `участок ${region.atom} (${region.start}..${region.end}): ` +
            "перестановка не является перестановкой индексов участка — останов",
        );
      }
    }
    const reordered = localOrder.some((value, index) => value !== index);
    if (!region.optimizable && reordered) {
      throw new EmitterRefusalError(
        `участок ${region.atom}: не оптимизируем, но порядок изменён — перестановка недопустима`,
      );
    }
    for (let pos = 0; pos < length; pos++) {
      const position = region.start + pos;
      if (order[position]! >= 0) {
        throw new EmitterRefusalError(`позиция ${position} покрыта двумя участками атомов`);
      }
      order[position] = bodyToModule[localOrder[pos]!]!;
      regionProcedureAt[position] = region.procedure;
    }
    reports.push({
      atom: region.atom,
      procedure: region.procedure,
      optimizable: region.optimizable,
      first: region.start,
      last: region.end - 1,
      reordered,
      instructions: length,
    });
  }

  const unassigned = order.findIndex((value) => value < 0);
  if (unassigned >= 0) {
    throw new EmitterRefusalError(
      `позиция ${unassigned} не покрыта ни одним участком атома: разметка неполна`,
    );
  }

  // ── Раскладка: переставить инструкции и пересчитать абсолютные адреса ─────────
  const map = new Map<number, number>();
  order.forEach((oldIndex, position) => map.set(oldIndex, position));
  const newCode: RegInstruction[] = order.map((oldIndex) => cloneInstruction(code[oldIndex]!));
  for (const instruction of newCode) {
    if (!hasAddress(instruction)) continue;
    const fields = fieldsOf(instruction);
    const mapped = fields.off === undefined ? undefined : map.get(fields.off);
    if (mapped === undefined) {
      throw new EmitterRefusalError(
        `адрес перехода ${String(fields.off)} не отображён: цель вне кода модуля — останов`,
      );
    }
    (instruction as unknown as { off: number }).off = mapped;
  }

  const scheduled = cloneModule(module);
  scheduled.code = newCode;
  // Перестановка внутри участка не сдвигает его границ, поэтому `codeOffset` процедур
  // остаётся прежним. Это проверяется, а не предполагается.
  scheduled.procedures.forEach((procedure, index) => {
    const region = regions.find((item) => item.procedure === index);
    if (region !== undefined && procedure.codeOffset !== region.start) {
      throw new EmitterRefusalError(
        `процедура «${procedure.name}»: codeOffset ${procedure.codeOffset} не совпадает ` +
          `с началом участка ${region.start}`,
      );
    }
  });

  // ── Понижение до носителей и кодирование ────────────────────────────────────
  const invokeNames = collectInvokeNames(newCode);
  const instructions = newCode.map((instruction) =>
    lowerInstruction(instruction, module, invokeNames, defects),
  );

  const size = encoder.description.instructionSize;
  if (size === null) {
    throw new EmitterRefusalError(
      `бэкенд «${encoder.description.id}» не заявляет размер инструкции — кодировать нечем`,
    );
  }
  const bytes = new Uint8Array(newCode.length * size);
  const placement: PlacementEntry[] = [];
  for (let position = 0; position < newCode.length; position++) {
    const asm = instructions[position]!;
    if (!isIrCarrier(asm.mnemonic)) {
      throw new EmitterRefusalError(
        `позиция ${position}: «${asm.mnemonic}» не является носителем IR — ` +
          "эмиттер не выдаёт документированные мнемоники под видом кода",
      );
    }
    const encoded = encoder.encode(asm);
    if (encoded.length !== size) {
      throw new EmitterRefusalError(
        `позиция ${position}: кодировщик вернул ${encoded.length} байт вместо ${size}`,
      );
    }
    bytes.set(encoded, position * size);
    const region = regions.find((item) => item.procedure === regionProcedureAt[position]);
    placement.push({
      codeIndex: order[position]!,
      position,
      start: position * size,
      end: position * size + size,
      carrier: asm.mnemonic,
      atom: region?.atom ?? "?",
      procedure: region?.procedure ?? -1,
      optimizable: region?.optimizable === true,
    });
  }

  const image: ShellImage = {
    format: SHELL_IMAGE_FORMAT,
    version: SHELL_IMAGE_VERSION,
    instructionSize: size,
    bytes,
    placement,
    invokeNames,
    frontMatter: {
      ir: module.ir,
      version: module.version,
      moduleName: module.moduleName,
      constants: module.constants,
      procedures: scheduled.procedures,
      atoms: module.atoms,
    },
    passport: {
      backendId: encoder.description.id,
      backendStatus: encoder.description.status,
      instructionSize: size,
      note:
        "КОД НА ВНУТРЕННЕЙ ОБОЛОЧКЕ ПРОЕКТА, НЕ e2k: носители IR — наши имена, соответствие " +
        "битов железу не проверено (docs/e2k-emitter-shell.md)",
    },
  };

  const report: EmitReport = {
    regions: reports,
    instructions: newCode.length,
    bytes: bytes.length,
    carriers: [...new Set(instructions.map((asm) => asm.mnemonic))].sort(),
    backendId: encoder.description.id,
    backendStatus: encoder.description.status,
    limitations: [
      "упаковки нет: одно слово оболочки несёт одну операцию, широкой команды в оболочке нет",
      "каналы выдачи не назначаются: модель устройства этим эмиттером не используется",
      "понижения в документированные операции e2k нет: IR едет носителями IR",
      "семантика эмиттером не проверяется: её проверяет сквозной прогон",
    ],
  };

  const result: ShellEmitResult = { image, instructions, scheduled, report };
  // Самопроверка до возврата: «останов, а не почти работает».
  assertEmitResult(result, module, encoder);
  return result;
}
