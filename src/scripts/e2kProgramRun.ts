/**
 * ПРОГОН ПРОГРАММЫ ИЗ КОРПУСА НА ЦЕЛИ e2k (через модель QEMU).
 *
 * # Зачем это отдельным модулем
 *
 * Оракул корпуса обязан проверять **сквозную** единицу: одна программа, два
 * исполнения, один эталон — на VM и на цели. VM-половина живёт в
 * `./programRunner`, а здесь — половина цели: собрать регистровый IR, разложить
 * регистры и адреса, связать пары «сравнение + переход», понизить носители в
 * операции e2k, собрать ELF и **исполнить** его в модели.
 *
 * Результат программы виден снаружи как **код возврата** `exit`: возврата
 * процедуры в e2k-бэкенде ещё нет, поэтому регистр `IR.ret` читается, и его
 * значение уходит в `exit(<результат>)`.
 *
 * # Чего модуль НЕ делает
 *
 * Не доказывает, что так поведёт себя железо: QEMU — модель. И не берётся за
 * программы с печатью или вызовом процедуры: `система.лог.вывести` на цель не
 * понижен, а вызов упирается в окно вызываемой (§3.24).
 *
 * # Про повтор
 *
 * Конвейер собран из тех же шагов, что оракул цели владельца
 * (`src/e2k/e2kArraysQemu.test.ts`): собирать его копией — цена того, что
 * `src/e2k/**` заморожен и экспортировать оттуда нечего. Когда плоскость
 * откроется, вызов конвейера должен стать ОДНИМ на оба оракула.
 */
import * as fs from "fs";
import * as path from "path";
import { getEncoder, type AsmInstruction, type Operand } from "../e2k/backend";
import { emitShell } from "../e2k/emitterShell";
import { annotateAtomRegions } from "../compiler/atomRegions";
import { regModuleOf } from "../vliw/regOracle";
import { lowerCarrier } from "../e2k/e2kRealRun";
import { ARRAY_REGISTERS, arrayPrologue } from "../e2k/arrayRuntime";
import { allocateProgram } from "../e2k/regAlloc";
import { layoutOf, secondPass } from "../e2k/twoPassLayout";
import { pairPredicates } from "../e2k/predicatePairing";
import { buildElfFromCode, MINIMAL_BASE, SYSCALL_WBS } from "../e2k/elfMinimal";
import { SYS_EXIT, WINDOW_NUMBER_REGISTER } from "../e2k/syscallRuntime";
import { buildShim, runInQemu } from "./e2kQemuExec";

const ROOT = path.resolve(__dirname, "..", "..");
/** Куча — отдельная страница: запись в страницу кода даёт ACCERR. */
const HEAP_OFFSET = 0x2000;
const encoder = getEncoder("e2k");
const shellEncoder = getEncoder("internal-shell");

const imm = (value: number): Operand => ({ kind: "imm", value });
const base = (index: number): Operand => ({ kind: "reg", index });
const window_ = (index: number): Operand => ({ kind: "reg", index, file: "window" });

/** Готов ли шлюз: без шима и модели прогон невозможен, и причина называется. */
export function shimAvailable(): boolean {
  return buildShim() !== undefined;
}

/** Причина недоступности шлюза — для отчёта оракула. */
export const SHIM_REASON =
  "шим не собран: в WSL-дистрибутиве нет компилятора C (docs/e2k-qemu-run.md §2.5)";

/** Образ программы: байты, отказы понижения и число занятых регистров. */
export interface E2kImage {
  bytes: Uint8Array;
  refused: string[];
  used: number;
}

/**
 * ОТКАЗ ОБВЯЗКИ: в программе больше одного возврата со значением.
 *
 * # Почему отказ, а не попытка
 *
 * `IR.ret` в e2k-бэкенде **не понижается вовсе** — возврата процедуры там ещё
 * нет. Обвязка обходила это так: запоминала регистр возврата и отдавала его в
 * `exit(<результат>)`. Обход верен ровно тогда, когда возврат в программе ОДИН:
 * при двух возвратах исполнение после первого **проваливается** в запасной путь,
 * тот пишет в тот же регистр — и `exit` отдаёт значение неисполненной ветви.
 *
 * Замер (`.tmp/dump-carriers-two-returns.ts`, программа `если 1 > 0 → вернуть 7`,
 * затем `вернуть 0`): носители `IR.ret [1, r0]` в индексах 5 и 7, оба — в `r0`,
 * между ними `IR.const r0 = …` запасного пути; исполняется ветвь, но провал в
 * запасной путь перезаписывает `r0`, и модель честно отдаёт 0.
 *
 * Канонический регистр результата (каждый `IR.ret` перекладывает значение в
 * фиксированный регистр, `exit` читает его) этого НЕ лечит: провал перезапишет и
 * канонический регистр. Нужен поток управления — переход к блоку выхода или
 * выход прямо в точке возврата, — а он сдвигает байтовые расстояния, уже
 * посчитанные раскладкой (`layoutOf`/`secondPass`) до понижения. Поэтому здесь
 * **названный отказ**, и «дефектом модели» это больше не называется.
 */
export class MultiReturnRefusal extends Error {
  constructor(readonly returns: number) {
    super(
      `обвязка не умеет возврат из середины процедуры: возвратов со значением ${String(returns)}, ` +
        "а в e2k-бэкенде возврата процедуры нет — обход через регистр верен только при одном возврате",
    );
    this.name = "MultiReturnRefusal";
  }
}

/** Собрать образ программы для цели. Бросает, если программа не компилируется или раскладка отказала. */
export function buildE2kImage(source: string): E2kImage {  const built = regModuleOf(source);
  if (built === null) throw new Error("программа не компилируется в регистровый IR");
  const annotated = annotateAtomRegions(built.module, [
    { atom: "A5", procedures: built.module.procedures.map((procedure) => procedure.name) },
  ]);
  const emitted = emitShell(annotated, shellEncoder);
  const allocation = allocateProgram(emitted.instructions, emitted.scheduled.procedures);
  const report = allocation.report[0]!;
  if (!report.ok) throw new Error(`раскладка отказала: ${report.reason ?? "причина не названа"}`);
  return { ...imageOfCarriers(allocation.instructions, emitted.scheduled.constants, emitted.image.invokeNames), used: report.used };
}

/** Продолжение конвейера: адреса, пары предикатов, понижение, пролог рантайма, `exit`. */
function imageOfCarriers(
  code: readonly AsmInstruction[],
  constants: readonly unknown[],
  invokeNames: readonly string[],
): { bytes: Uint8Array; refused: string[] } {
  const context = { constants, invokeNames };
  const layout = layoutOf(code, { invokeNames, constants });
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
  /** Сколько возвратов несут значение: их число решает, годится ли обход через регистр. */
  let valueReturns = 0;
  for (let index = 0; index < code.length; index++) {
    const carrier = code[index]!;
    const problem =
      layout.unplaced.find((item) => item.index === index) ??
      resolved.refusals.find((item) => item.index === index) ??
      pairing.refusals.find((item) => item.index === index);
    if (problem !== undefined) {
      refused.push(`#${String(index)} ${carrier.mnemonic}: ${problem.reason}`);
      continue;
    }
    if (carrier.mnemonic === "IR.ret") {
      const flag = carrier.operands[0];
      const value = carrier.operands[1];
      if (flag?.kind === "imm" && flag.value === 1 && value?.kind === "reg") {
        valueReturns++;
        if (returnRegister === undefined) returnRegister = value.index;
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
      refused.push(`#${String(index)} ${carrier.mnemonic}: ${lowered.reason}`);
      continue;
    }
    body.push(...lowered.instructions);
  }
  if (returnRegister === undefined) throw new Error("в программе нет возврата значения");
  // Возвратов со значением может быть несколько — и тогда обход через регистр
  // неверен (см. MultiReturnRefusal). Отказываем ДО сборки образа: тихое
  // неверное число хуже названного отказа.
  if (valueReturns > 1) throw new MultiReturnRefusal(valueReturns);

  const instructions: AsmInstruction[] = [
    ...arrayPrologue(MINIMAL_BASE + HEAP_OFFSET),
    ...body,
    {
      mnemonic: "adds",
      channel: 0,
      operands: [base(returnRegister), base(ARRAY_REGISTERS.zero), window_(WINDOW_NUMBER_REGISTER + 1)],
    },
    { mnemonic: "movts", channel: 0, operands: [imm(SYS_EXIT), window_(WINDOW_NUMBER_REGISTER)] },
    { mnemonic: "sdisp", channel: 0, operands: [imm(1), imm(0)] },
    { mnemonic: "call", channel: 0, operands: [imm(1), imm(SYSCALL_WBS)] },
  ];

  const chunks = instructions.map((instruction) => encoder.encode(instruction));
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, refused };
}

/** Результат прогона на цели: код возврата `exit` и что не понизилось. */
export interface E2kRun {
  status: number | undefined;
  refused: string[];
  used: number;
  file: string;
}

/**
 * БАЙТЫ ОБРАЗА ELF — ровно тем же вызовом, что у оракула цели владельца
 * (`src/e2k/e2kArraysQemu.test.ts`: `buildElfFromCode(bytes, MINIMAL_BASE,
 * { writable: true, extraMemory: HEAP_OFFSET })`).
 *
 * Нужно для страховки от расхождения ДВУХ конвейеров: пока конвейер живёт копией,
 * оракул сверяет образ, собранный здесь, с образом, собранным оракулом владельца
 * (хеш снят с их артефакта `.tmp/e2k-heap-fir.elf`). Расхождение образов —
 * красное: тихое расхождение двух путей сборки мы уже проходили.
 */
export function buildElfImage(source: string): Uint8Array {
  const image = buildE2kImage(source);
  return buildElfFromCode(image.bytes, MINIMAL_BASE, { writable: true, extraMemory: HEAP_OFFSET }).bytes;
}

/**
 * Исполнить программу из корпуса на цели.
 *
 * @param source текст программы (канон: файл = модуль)
 * @param fileName имя образа в `.tmp/` — по нему видно, чей прогон
 */
export function runOnE2k(source: string, fileName: string): E2kRun {
  const image = buildE2kImage(source);
  const elf = path.join(ROOT, ".tmp", fileName);
  fs.writeFileSync(elf, buildElfImage(source));
  const status = runInQemu(elf, { shim: true, timeoutMs: 20_000 })?.status ?? undefined;
  return { status, refused: image.refused, used: image.used, file: elf };
}
