/**
 * ОБРАТНОЕ ДЕКОДИРОВАНИЕ: байты оболочки → `RegModule` → регистровая VM.
 *
 * # Зачем
 *
 * Это вторая половина сквозного конвейера: `RegModule` → эмиттер → байты → **декодер** →
 * `RegModule` → VM. Круг проверяет **семантику**, а не байты: если декодированный модуль даёт
 * те же значения, что исходный, значит конвейер сохраняет смысл программы.
 *
 * # Чего круг не доказывает
 *
 * Что код корректен для e2k: оболочка — не e2k, носители IR — наши имена
 * (`docs/e2k-emitter-shell.md`). И что семантика e2k совпадает с семантикой регистровой VM:
 * это проверяется только симулятором e2k или железом, которых нет (`docs/hardware-debt.md`).
 *
 * # Код берётся ТОЛЬКО из байтов
 *
 * `module.code` восстанавливается из потока байтов; из заголовка артефакта берутся лишь
 * метаданные (пул констант, процедуры, разметка атомов). Иначе круг был бы подстановкой:
 * «декодер вернул то, что эмиттер и так положил рядом».
 */

import type { AsmInstruction, Encoder } from "./backend";
import { IR_CARRIERS } from "./shell";
import { EmitterRefusalError, type ShellImage } from "./emitterOracle";
import { CARRIER_OF_OP } from "./emitterShell";
import { RegVM } from "../runtime/vm/reginterpreter";
import { createDefaultInvokeHandler, type InvokeHandler, type StackValue } from "../runtime/vm/interpreter";
import { resolveEntryIndex } from "../oracle/parity";
import type { RegInstruction, RegModule } from "../runtime/vm/regcode";

/** Инъекция дефектов — ТОЛЬКО для негативного контроля. */
export interface RoundtripDefects {
  /**
   * 4.4 — «тождественный» разбор: декодер не разбирает носитель, а всегда возвращает одну
   * и ту же форму. Так выглядит подстановка вместо декодирования; круг обязан её заметить.
   */
  identityDecode?: boolean;
}

/** Опции разбора и прогона. */
export interface RoundtripOptions {
  defects?: RoundtripDefects;
}

/** Опции прогона декодированного модуля. */
export interface RunImageOptions extends RoundtripOptions {
  entryProcedure?: string;
  args?: StackValue[];
  maxSteps?: number;
  invokeFactory?: () => InvokeHandler;
}

/** Обратное соответствие «носитель → операция IR» (та же таблица, что у эмиттера). */
const OP_OF_CARRIER: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(CARRIER_OF_OP).map(([op, carrier]) => [carrier, op]),
);

/** Типы констант пула в порядке поля `flags` носителя `IR.const`. */
const CONST_TYPES: readonly string[] = ["i32", "f64", "str", "bool", "null"];

function operandsToArguments(
  asm: AsmInstruction,
  count: number,
  context: string,
  startIndex: number,
): number[] {
  const args: number[] = [];
  for (let index = 0; index < count; index++) {
    // У носителей вызова поле 0 — флаги, аргументы начинаются со следующего поля.
    const operand = asm.operands[startIndex + index];
    if (operand === undefined || operand.kind !== "reg") {
      throw new EmitterRefusalError(`${context}: аргумент ${index} не является регистром`);
    }
    args.push(operand.index);
  }
  return args;
}

function registerOperand(asm: AsmInstruction, index: number, context: string): number {
  const operand = asm.operands[index];
  if (operand === undefined || operand.kind !== "reg") {
    throw new EmitterRefusalError(`${context}: поле ${index} не является регистром`);
  }
  return operand.index;
}

function immediateOperand(asm: AsmInstruction, index: number, context: string): number {
  const operand = asm.operands[index];
  if (operand === undefined || operand.kind !== "imm") {
    throw new EmitterRefusalError(`${context}: поле ${index} не является числом`);
  }
  return operand.value;
}

/**
 * Восстановить инструкцию IR из инструкции оболочки.
 *
 * @throws EmitterRefusalError если инструкция не является носителем или её поля противоречивы
 */
export function toRegInstruction(
  asm: AsmInstruction,
  invokeNames: readonly string[],
  defects: RoundtripDefects = {},
): RegInstruction {
  const carrier = asm.mnemonic;
  if (!Object.prototype.hasOwnProperty.call(IR_CARRIERS, carrier)) {
    throw new EmitterRefusalError(`«${carrier}» не является носителем IR: разбор невозможен`);
  }
  const op = OP_OF_CARRIER[carrier]!;

  // 4.4: подстановка вместо разбора — декодер «не смотрит» на носитель и всегда отдаёт `move`.
  if (defects.identityDecode === true && carrier !== "IR.move") {
    const registerAt = (index: number): number => {
      const operand = asm.operands[index];
      return operand !== undefined && operand.kind === "reg" ? operand.index : 0;
    };
    return { op: "move", d: registerAt(0), a: registerAt(1) };
  }

  switch (op) {
    case "const": {
      const flags = immediateOperand(asm, 2, carrier);
      const type = CONST_TYPES[flags];
      if (type === undefined) throw new EmitterRefusalError(`${carrier}: неизвестный тип пула ${flags}`);
      return {
        op: "const",
        d: registerOperand(asm, 0, carrier),
        type: type as "i32" | "f64" | "str" | "bool" | "null",
        k: immediateOperand(asm, 1, carrier),
      };
    }
    case "move":
      return { op: "move", d: registerOperand(asm, 0, carrier), a: registerOperand(asm, 1, carrier) };
    case "not":
      return { op: "not", d: registerOperand(asm, 0, carrier), a: registerOperand(asm, 1, carrier) };
    case "jmp":
      return { op: "jmp", off: immediateOperand(asm, 0, carrier) };
    case "jmp_if":
    case "jmp_if_not":
      return {
        op: op,
        off: immediateOperand(asm, 1, carrier),
        cond: registerOperand(asm, 0, carrier),
      };
    case "call":
    case "invoke": {
      const flags = immediateOperand(asm, 0, carrier);
      const argc = (flags >> 1) & 0x03;
      const hasDst = (flags & 1) === 1;
      const args = operandsToArguments(asm, argc, carrier, 1);
      const payload = immediateOperand(asm, 3, carrier);
      const dst = registerOperand(asm, 4, carrier);
      // Незадействованные поля обязаны быть нулевыми — иначе байты несут то, чего в IR нет.
      for (let index = argc; index < 2; index++) {
        const unused = registerOperand(asm, 1 + index, carrier);
        if (unused !== 0) {
          throw new EmitterRefusalError(
            `${carrier}: argc=${argc}, но лишний аргумент ${index} равен ${unused} — байты противоречивы`,
          );
        }
      }
      if (!hasDst && dst !== 0) {
        throw new EmitterRefusalError(`${carrier}: результат не заявлен, но поле результата ${dst}`);
      }
      if (op === "call") {
        return { op: "call", ...(hasDst ? { d: dst } : {}), fi: payload, args, argc };
      }
      const name = invokeNames[payload];
      if (name === undefined) {
        throw new EmitterRefusalError(`${carrier}: имя вызова ${payload} отсутствует в таблице`);
      }
      return { op: "invoke", ...(hasDst ? { d: dst } : {}), name, args, argc };
    }
    case "ret": {
      const flags = immediateOperand(asm, 0, carrier);
      const value = registerOperand(asm, 1, carrier);
      if ((flags & 1) === 0) {
        if (value !== 0) {
          throw new EmitterRefusalError(`${carrier}: значения нет, но поле значения ${value}`);
        }
        return { op: "ret" };
      }
      return { op: "ret", v: value };
    }
    default: {
      // Двухоперандные арифметические операции и сравнения.
      const known = ["add", "sub", "mul", "div", "rem", "eq", "ne", "lt", "le", "gt", "ge", "and", "or"] as const;
      const binary = known.find((name) => name === op);
      if (binary === undefined) {
        throw new EmitterRefusalError(`носитель «${carrier}»: неизвестная операция IR «${op}»`);
      }
      return {
        op: binary,
        d: registerOperand(asm, 0, carrier),
        a: registerOperand(asm, 1, carrier),
        b: registerOperand(asm, 2, carrier),
      };
    }
  }
}

/** Разбить поток на слова по размеру инструкции. */
function wordsOf(image: ShellImage): Uint8Array[] {
  const size = image.instructionSize;
  if (size <= 0) throw new EmitterRefusalError(`размер инструкции в артефакте: ${size}`);
  if (image.bytes.length % size !== 0) {
    throw new EmitterRefusalError(
      `длина потока ${image.bytes.length} не кратна размеру инструкции ${size}`,
    );
  }
  const words: Uint8Array[] = [];
  for (let offset = 0; offset < image.bytes.length; offset += size) {
    words.push(image.bytes.slice(offset, offset + size));
  }
  return words;
}

/**
 * Восстановить `RegModule` из артефакта.
 *
 * Код берётся **только** из байтов; из заголовка — метаданные (константы, процедуры, атомы).
 *
 * @throws EmitterRefusalError если карта размещения расходится с потоком или байты противоречивы
 */
export function decodeShellImage(
  image: ShellImage,
  encoder: Encoder,
  options: RoundtripOptions = {},
): RegModule {
  const defects = options.defects ?? {};
  const words = wordsOf(image);
  if (image.placement.length !== words.length) {
    throw new EmitterRefusalError(
      `карта размещения: записей ${image.placement.length}, слов в потоке ${words.length}`,
    );
  }
  const sorted = [...image.placement].sort((a, b) => a.position - b.position);
  const code: RegInstruction[] = [];
  for (let position = 0; position < words.length; position++) {
    const entry = sorted[position]!;
    if (entry.position !== position || entry.start !== position * image.instructionSize) {
      throw new EmitterRefusalError(
        `карта размещения расходится с потоком на позиции ${position}: ` +
          `запись ${entry.position}, байты ${entry.start}..${entry.end}`,
      );
    }
    const asm = encoder.decode(words[position]!);
    if (entry.carrier !== asm.mnemonic) {
      throw new EmitterRefusalError(
        `позиция ${position}: в карте носитель «${entry.carrier}», в байтах «${asm.mnemonic}»`,
      );
    }
    code.push(toRegInstruction(asm, image.invokeNames, defects));
  }

  // Переходы обязаны указывать внутрь кода: иначе модуль неисполним.
  for (const [index, instruction] of code.entries()) {
    if (
      instruction.op === "jmp" ||
      instruction.op === "jmp_if" ||
      instruction.op === "jmp_if_not"
    ) {
      if (!Number.isInteger(instruction.off) || instruction.off < 0 || instruction.off >= code.length) {
        throw new EmitterRefusalError(
          `инструкция ${index}: адрес перехода ${instruction.off} вне кода (0..${code.length - 1})`,
        );
      }
    }
  }

  return {
    ir: image.frontMatter.ir as RegModule["ir"],
    version: image.frontMatter.version,
    moduleName: image.frontMatter.moduleName,
    constants: [...image.frontMatter.constants],
    procedures: JSON.parse(JSON.stringify(image.frontMatter.procedures)) as RegModule["procedures"],
    code,
    atoms: JSON.parse(JSON.stringify(image.frontMatter.atoms)) as RegModule["atoms"],
  };
}

/**
 * Прогнать декодированный модуль на **регистровой VM**.
 *
 * Это не симулятор e2k: исполняется тот же регистровый код, что и без эмиттера, поэтому
 * проверяется сохранение семантики конвейером, а не поведение целевой архитектуры.
 */
export async function runShellImage(
  image: ShellImage,
  encoder: Encoder,
  options: RunImageOptions = {},
): Promise<StackValue | undefined> {
  const module = decodeShellImage(image, encoder, options);
  const entry = resolveEntryIndex(module.procedures, options.entryProcedure);
  const host = options.invokeFactory?.() ?? createDefaultInvokeHandler();
  const vm = new RegVM(module, {
    maxSteps: options.maxSteps ?? 200_000,
    invoke: (name, args) => host(name, args),
  });
  return vm.runProcedure(entry, options.args ?? []);
}
