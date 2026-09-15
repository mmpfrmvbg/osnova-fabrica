/**
 * СИМУЛЯТОР НА ВНУТРЕННЕЙ ОБОЛОЧКЕ ПРОЕКТА (не симулятор e2k).
 *
 * # Паспорт
 *
 * | поле | значение |
 * |---|---|
 * | имя | `simulatorShell` — **оболочка**, а не e2k |
 * | статус | **ДОПУЩЕНИЕ** |
 * | источник | `docs/vliw-e2k-model.md` (глава 6, стр. 71–72; глава 12, стр. 194) и `src/vliw/e2kDevices.ts`; отображение носителей — `src/e2k/latencyMap.ts` |
 * | ограничение | **не валидировано на железе**: такты посчитаны по модели, а не измерены; штраф за переход между кластерами АЛУ принят нулевым (`docs/hardware-debt.md` §3.2) |
 *
 * **Это не симулятор e2k.** Исполняется код на оболочке: 10-байтовые слова, несущие
 * **носители IR** (`IR.*`) — наши имена, которых в руководстве МЦСТ нет и быть не может
 * (`docs/e2k-emitter-shell.md`). Ни одна документированная мнемоника e2k здесь не исполняется.
 *
 * # Что делает симулятор
 *
 * ```
 * байты оболочки → Encoder.decode → носители IR → порядок исполнения → шаги → такты
 * ```
 *
 * 1. **{@link decodeShellProgram}** — байты → носители (через `Encoder.decode`, а не через «свой»
 *    разбор). Карта размещения проверяется; код берётся **только** из байтов, из артефакта —
 *    метаданные (пул констант, процедуры, имена вызовов).
 * 2. **{@link ShellSimulator.step}** — исполнение одного носителя. Состояние: регистровые файлы
 *    кадров, стек вызовов, пул констант. Семантика — **та же, что у регистровой VM**
 *    (`src/runtime/vm/reginterpreter.ts`): расхождение ловится оракулом на пяти ядрах
 *    (совпадение и с независимым эталоном, и с самой VM).
 * 3. **такты** — по модели задержек; правило целиком в {@link TICK_MODEL}.
 * 4. **{@link ShellSimulator.run}** — прогон до завершения.
 *
 * # Чего симулятор НЕ делает
 *
 * - не упаковывает операции в широкую команду: оболочка однослотовая, одна инструкция — один
 *   такт выдачи (`docs/e2k-emitter-shell.md` §4.5);
 * - не назначает каналы и кластеры АЛУ: штраф за переход между кластерами принят нулевым
 *   (`docs/hardware-debt.md` §3.2), считать нечего;
 * - не проверяет семантику e2k: её не с чем сверять, железа и ISA-справочника нет;
 * - не утверждает, что такты совпадут с железом: **модель не валидирована**.
 */

import type { AsmInstruction, Encoder } from './backend';
import { toRegInstruction } from './emitterRoundtrip';
import type { ShellImage } from './emitterOracle';
import { CLASS_LATENCY, latencyEntry, type LatencyClass, type MappingSource } from './latencyMap';
import { getInvokeArgCount, isKnownInvoke } from '../runtime/vm/invokeRegistry';
import type { InvokeHandler, StackValue } from '../runtime/vm/interpreter';
import { createDefaultInvokeHandler } from '../runtime/vm/interpreter';
import { resolveEntryIndex } from '../oracle/parity';
import type { RegInstruction, RegProcedure } from '../runtime/vm/regcode';

/**
 * ПРАВИЛО СЧЁТА ТАКТОВ — читать целиком, иначе число тактов означает не то, что кажется.
 *
 * Модель однослотовая и в порядке программы:
 *
 * 1. **Выдача.** Инструкция выдаётся не раньше, чем через такт после предыдущей
 *    (`issue >= lastIssue + 1`). Широкой команды в оболочке нет, поэтому ширина выдачи — 1.
 * 2. **Зависимости (RAW).** Если инструкция читает регистр, записанный раньше, её выдача
 *    откладывается до готовности результата производителя:
 *    `issue >= issue(производитель) + latency(производитель)`. Это то же правило, что на стр. 71
 *    руководства («если операция стоит в такте N, её результат готов к использованию в такте
 *    N+1» для Int) и то же, что «при попытке считывания неготовых данных вырабатывается
 *    блокировка конвейера» (стр. 200).
 * 3. **Готовность записи.** Запись в регистр готова через `issue + latency`; для `latency = 1` —
 *    со следующего такта, то есть потребитель рядом не простаивает.
 * 4. **Число тактов** — **момент готовности последнего результата**: максимум по всем
 *    исполненным инструкциям от `issue + latency - 1`. Такты без выдачи модель не скрывает:
 *    они видны как разница между числом тактов и числом инструкций.
 * 5. **Передача управления.** `IR.call` — операция без регистрового результата: значение
 *    возвращается `IR.ret`, и его готовность наступает через `latency(IR.ret)` после выдачи
 *    возврата. Дополнительного штрафа за сам переход модель не вводит: величины штрафа у нас нет
 *    (`docs/hardware-debt.md` §3.2).
 *
 * Число тактов — **модельное**: это не замер и не «реальные такты».
 */
export const TICK_MODEL =
  'однослотовая выдача (1 инструкция за такт) + ожидание готовности результата по RAW ' +
  '(issue >= issue(производителя) + latency(производителя)); число тактов = максимум ' +
  '(issue + latency - 1) по исполненным инструкциям';

/** Паспорт симулятора — машиночитаемая копия шапки файла, для аудита. */
export const SIMULATOR_PASSPORT = {
  id: 'internal-shell-simulator',
  title: 'Симулятор на внутренней оболочке проекта (не симулятор e2k)',
  status: 'ДОПУЩЕНИЕ',
  source:
    'docs/vliw-e2k-model.md (глава 6, стр. 71–72; глава 12, стр. 194); src/vliw/e2kDevices.ts; src/e2k/latencyMap.ts',
  limitation:
    'не валидировано на железе: числа тактов получены по модели, а не измерены; штраф за переход между кластерами АЛУ принят нулевым (docs/hardware-debt.md §3.2)',
  tickModel: TICK_MODEL,
} as const;

/** Ошибка симулятора: сообщение и место в порядке исполнения. */
export class ShellSimulatorError extends Error {
  constructor(
    message: string,
    public pc?: number,
    public carrier?: string,
  ) {
    super(message);
    this.name = 'ShellSimulatorError';
  }
}

/**
 * Инъекция дефектов — **только** для негативного контроля.
 *
 * Каждый дефект — отдельный прогон; процедура и `sha256` записаны в `docs/e2k-shell-ticks.md`.
 */
export interface SimulatorDefects {
  /** 4.1 — не учитывать зависимости: результаты готовы сразу, выдача подряд. */
  ignoreDependencies?: boolean;
  /** 4.2 — подменить класс задержки: носителям класса ALU дать этот класс и его длительность. */
  latencyClassOverride?: LatencyClass;
  /** 4.3 — не учитывать перестановку: исполнять исходный линейный порядок. */
  ignoreReorder?: boolean;
  /** 4.4 — подменить семантику: `add` считать как `sub`. */
  swapAddToSub?: boolean;
}

/** Порядок исполнения: как в образе (с перестановкой) или исходный линейный. */
export type ExecutionOrder = 'emitted' | 'linear';

/** Опции разбора и прогона. */
export interface ShellSimulatorOptions {
  entryProcedure?: string;
  args?: StackValue[];
  maxSteps?: number;
  invokeFactory?: () => InvokeHandler;
  order?: ExecutionOrder;
  defects?: SimulatorDefects;
}

/** Одна инструкция оболочки в порядке исполнения. */
export interface ShellInstruction {
  /** Носитель IR (`IR.*`) — имя оболочки, не мнемоника e2k. */
  carrier: string;
  /** Операция IR за носителем (`add`, `invoke`, …). */
  op: string;
  /** Разобранная семантика операции. */
  instruction: RegInstruction;
  /** Класс задержки; `null` — «НЕТ КЛАССА». */
  latencyClass: LatencyClass | null;
  /** Такты носителя по модели. */
  latency: number;
  /** Источник отображения (для отчёта). */
  latencySource: MappingSource;
  /** Регистры-источники. */
  reads: readonly number[];
  /** Регистры-приёмники. */
  writes: readonly number[];
  /** Адрес перехода в порядке исполнения (позиция), если это переход. */
  target?: number;
  /** Позиция в порядке исполнения. */
  position: number;
  /** Индекс инструкции в исходном коде модуля (из карты размещения). */
  codeIndex: number;
}

/** Программа симулятора: инструкции в порядке исполнения и метаданные модуля. */
export interface ShellProgram {
  instructions: readonly ShellInstruction[];
  /** Точка входа — позиция в `instructions`. */
  entry: number;
  /** Позиция входа каждой процедуры (в порядке `procedures`). */
  procedureEntry: readonly number[];
  order: ExecutionOrder;
  invokeNames: readonly string[];
  constants: readonly unknown[];
  procedures: readonly RegProcedure[];
  instructionSize: number;
  /** Отличается ли порядок образа от исходного линейного (перестановка применялась). */
  reordered: boolean;
}

/** Статистика по классу задержки. */
export interface ClassStat {
  label: LatencyClass | 'НЕТ КЛАССА';
  /** Сколько инструкций класса исполнено. */
  executed: number;
  /** Суммарная занятость: сумма латентностей исполненных инструкций класса. */
  ticks: number;
  /** Сколько тактов инструкции класса простояли в ожидании результата по RAW. */
  stalls: number;
}

/** Отчёт о прогоне. */
export interface ShellTickReport {
  ticks: number;
  /** Исполнено инструкций (динамически, с учётом циклов). */
  instructions: number;
  /** Сколько инструкций в программе (статически). */
  staticInstructions: number;
  order: ExecutionOrder;
  classes: readonly ClassStat[];
  instructionSize: number;
  tickModel: string;
}

/** Результат прогона: значение процедуры и отчёт о тактах. */
export interface ShellRunResult {
  value: StackValue | undefined;
  report: ShellTickReport;
}

/** Кадр процедуры: регистровый файл, моменты готовности записей и адрес возврата. */
interface SimFrame {
  procedureIndex: number;
  returnPc: number;
  values: StackValue[];
  /** Такт, с которого значение регистра готово к чтению. */
  ready: number[];
  /** Инструкция `call`, создавшая кадр (чтобы вернуть значение в её регистр-приёмник). */
  callerInstruction?: RegInstruction;
}

const one = (value: number | undefined): number[] => (value === undefined ? [] : [value]);

/**
 * Регистры-источники и приёмники инструкции — по её семантике.
 *
 * `call` **не пишет** регистр сам: значение возвращает `IR.ret`, и готовность записи ставит
 * именно возврат. Иначе результат вызова выглядел бы готовым раньше, чем процедура вернулась.
 */
function accessOf(instruction: RegInstruction): { reads: number[]; writes: number[] } {
  switch (instruction.op) {
    case 'const':
    case 'const.true':
    case 'const.false':
    case 'const.null':
      return { reads: [], writes: one(instruction.d) };
    case 'move':
    case 'not':
      return { reads: one(instruction.a), writes: one(instruction.d) };
    case 'add':
    case 'sub':
    case 'mul':
    case 'div':
    case 'rem':
    case 'eq':
    case 'ne':
    case 'lt':
    case 'le':
    case 'gt':
    case 'ge':
    case 'and':
    case 'or':
      return { reads: [instruction.a, instruction.b], writes: [instruction.d] };
    case 'jmp':
      return { reads: [], writes: [] };
    case 'jmp_if':
    case 'jmp_if_not':
      return { reads: one(instruction.cond), writes: [] };
    case 'call':
      return { reads: [...instruction.args], writes: [] };
    case 'invoke':
      return { reads: [...instruction.args], writes: one(instruction.d) };
    case 'ret':
      return { reads: one(instruction.v), writes: [] };
    default:
      return { reads: [], writes: [] };
  }
}

/** Адрес перехода инструкции IR (позиция в потоке). */
function targetOf(instruction: RegInstruction): number | undefined {
  return instruction.op === 'jmp' || instruction.op === 'jmp_if' || instruction.op === 'jmp_if_not'
    ? instruction.off
    : undefined;
}

/** Разбить поток на слова по размеру инструкции. */
function wordsOf(image: ShellImage): Uint8Array[] {
  const size = image.instructionSize;
  if (!Number.isInteger(size) || size <= 0) {
    throw new ShellSimulatorError(`размер инструкции в артефакте: ${String(size)}`);
  }
  if (image.bytes.length % size !== 0) {
    throw new ShellSimulatorError(
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
 * Разобрать образ оболочки в программу симулятора.
 *
 * Код берётся **только из байтов**: `Encoder.decode` разбирает слово, карта размещения
 * проверяется на согласованность с потоком и с носителем. Из артефакта берутся метаданные —
 * пул констант, процедуры, таблица имён вызовов.
 *
 * @throws ShellSimulatorError если карта размещения расходится с потоком или слово не разбирается
 */
export function decodeShellProgram(
  image: ShellImage,
  encoder: Encoder,
  options: { order?: ExecutionOrder; defects?: SimulatorDefects } = {},
): ShellProgram {
  const requestedOrder: ExecutionOrder =
    options.defects?.ignoreReorder === true ? 'linear' : (options.order ?? 'emitted');
  const words = wordsOf(image);
  if (image.placement.length !== words.length) {
    throw new ShellSimulatorError(
      `карта размещения: записей ${image.placement.length}, слов в потоке ${words.length}`,
    );
  }

  // ── Код восстанавливается ТОЛЬКО из байтов ────────────────────────────────
  const positions = [...image.placement].sort((a, b) => a.position - b.position);
  const byPosition: Array<{ carrier: string; instruction: RegInstruction; codeIndex: number }> = [];
  const posToOld: number[] = [];
  const oldToPos: number[] = new Array(words.length).fill(-1);
  for (let position = 0; position < words.length; position++) {
    const entry = positions[position]!;
    if (entry.position !== position || entry.start !== position * image.instructionSize) {
      throw new ShellSimulatorError(
        `карта размещения расходится с потоком на позиции ${position}: запись ${entry.position}, байты ${entry.start}..${entry.end}`,
      );
    }
    const asm: AsmInstruction = encoder.decode(words[position]!);
    if (entry.carrier !== asm.mnemonic) {
      throw new ShellSimulatorError(
        `позиция ${position}: в карте носитель «${entry.carrier}», в байтах «${asm.mnemonic}»`,
      );
    }
    if (entry.codeIndex < 0 || entry.codeIndex >= words.length) {
      throw new ShellSimulatorError(
        `позиция ${position}: исходный индекс ${entry.codeIndex} вне кода (0..${words.length - 1})`,
      );
    }
    if (oldToPos[entry.codeIndex] !== -1) {
      throw new ShellSimulatorError(`индекс ${entry.codeIndex} встречается в карте дважды`);
    }
    oldToPos[entry.codeIndex] = position;
    posToOld[position] = entry.codeIndex;
    byPosition.push({
      carrier: asm.mnemonic,
      instruction: toRegInstruction(asm, image.invokeNames),
      codeIndex: entry.codeIndex,
    });
  }
  const missed = oldToPos.findIndex((position) => position < 0);
  if (missed >= 0) {
    throw new ShellSimulatorError(`индекс ${missed} не покрыт картой размещения`);
  }

  // ── Порядок исполнения ────────────────────────────────────────────────────
  // «emitted» — как в образе (с перестановкой), «linear» — исходный порядок модуля.
  const slotOfPosition = (position: number): number =>
    requestedOrder === 'linear' ? posToOld[position]! : position;

  const instructions: ShellInstruction[] = new Array(words.length);
  for (let position = 0; position < words.length; position++) {
    const source = byPosition[position]!;
    const entry = latencyEntry(source.carrier);
    const { reads, writes } = accessOf(source.instruction);
    const target = targetOf(source.instruction);
    const slot = slotOfPosition(position);
    instructions[slot] = {
      carrier: source.carrier,
      op: source.instruction.op,
      instruction: source.instruction,
      latencyClass: entry.latencyClass,
      latency: entry.latency,
      latencySource: entry.source,
      reads,
      writes,
      ...(target === undefined ? {} : { target: slotOfPosition(target) }),
      position: slot,
      codeIndex: source.codeIndex,
    };
  }
  for (let slot = 0; slot < instructions.length; slot++) {
    if (instructions[slot] === undefined) {
      throw new ShellSimulatorError(`позиция ${slot} осталась без инструкции`);
    }
  }

  const entryProcedure = resolveEntryIndex(image.frontMatter.procedures, undefined);
  const procedureEntry = image.frontMatter.procedures.map((procedure) =>
    slotOfPosition(oldToPos[procedure.codeOffset]!),
  );
  return {
    instructions,
    entry: procedureEntry[entryProcedure] ?? 0,
    procedureEntry,
    order: requestedOrder,
    invokeNames: [...image.invokeNames],
    constants: [...image.frontMatter.constants],
    procedures: JSON.parse(JSON.stringify(image.frontMatter.procedures)) as RegProcedure[],
    instructionSize: image.instructionSize,
    reordered: image.placement.some((entry) => entry.codeIndex !== entry.position),
  };
}

/**
 * Симулятор на оболочке: исполняет носители и считает такты по модели.
 *
 * Один экземпляр — один прогон: `step()` делает один шаг, `run()` идёт до завершения.
 */
export class ShellSimulator {
  private readonly program: ShellProgram;
  private readonly defects: SimulatorDefects;
  private readonly invoke: InvokeHandler;
  private readonly maxSteps: number;
  private readonly classStats = new Map<LatencyClass | 'НЕТ КЛАССА', ClassStat>();
  private frames: SimFrame[] = [];
  private pc: number;
  private currentIssue = 0;
  private lastIssue = 0;
  private tickCount = 0;
  private executed = 0;
  private stalls = 0;
  private lastReturn: StackValue | undefined = undefined;
  private finished = false;

  constructor(program: ShellProgram, options: ShellSimulatorOptions = {}) {
    this.program = program;
    this.defects = options.defects ?? {};
    this.invoke = options.invokeFactory?.() ?? createDefaultInvokeHandler();
    this.maxSteps = options.maxSteps ?? 1_000_000;
    const entryProcedure = resolveEntryIndex(program.procedures, options.entryProcedure);
    this.pc = program.procedureEntry[entryProcedure] ?? program.entry;
    const procedure = program.procedures[entryProcedure]!;
    this.frames = [this.createFrame(procedure, entryProcedure, -1, options.args ?? [])];
  }

  private createFrame(
    procedure: RegProcedure,
    procedureIndex: number,
    returnPc: number,
    args: StackValue[],
    callerInstruction?: RegInstruction,
  ): SimFrame {
    const size = Math.max(procedure.vregs, procedure.argc);
    const values: StackValue[] = new Array(size).fill(null);
    for (let i = 0; i < procedure.argc; i++) values[i] = args[i] ?? null;
    return {
      procedureIndex,
      returnPc,
      values,
      ready: new Array(size).fill(0),
      ...(callerInstruction === undefined ? {} : { callerInstruction }),
    };
  }

  private frame(): SimFrame {
    const frame = this.frames[this.frames.length - 1];
    if (frame === undefined) throw new ShellSimulatorError('нет активного кадра');
    return frame;
  }

  private read(index: number): StackValue {
    const frame = this.frame();
    if (index < 0 || index >= frame.values.length) {
      throw new ShellSimulatorError(`регистр вне диапазона: r${index}`, this.pc);
    }
    return frame.values[index] as StackValue;
  }

  private write(index: number, value: StackValue): void {
    const frame = this.frame();
    if (index < 0 || index >= frame.values.length) {
      throw new ShellSimulatorError(`регистр вне диапазона: r${index}`, this.pc);
    }
    frame.values[index] = value;
  }

  private writeIfAny(index: number | undefined, value: StackValue): void {
    if (index !== undefined) this.write(index, value);
  }

  /** Такты носителя с учётом подмены класса (дефект 4.2). */
  private latencyOf(instruction: ShellInstruction): number {
    const override = this.defects.latencyClassOverride;
    if (override !== undefined && instruction.latencyClass === 'ALU') {
      return CLASS_LATENCY[override];
    }
    return instruction.latency;
  }

  private labelOf(instruction: ShellInstruction): LatencyClass | 'НЕТ КЛАССА' {
    return instruction.latencyClass ?? 'НЕТ КЛАССА';
  }

  private classStat(label: LatencyClass | 'НЕТ КЛАССА'): ClassStat {
    let stat = this.classStats.get(label);
    if (stat === undefined) {
      stat = { label, executed: 0, ticks: 0, stalls: 0 };
      this.classStats.set(label, stat);
    }
    return stat;
  }

  /** Исполнение завершено. */
  get done(): boolean {
    return this.finished;
  }

  /** Число тактов по модели на текущий момент. */
  ticks(): number {
    return this.tickCount;
  }

  /** Сколько тактов простоя в ожидании результатов по RAW (модельное число). */
  stallTicks(): number {
    return this.stalls;
  }

  /**
   * Один шаг: исполнить носитель по адресу `pc`.
   *
   * @returns `true`, если исполнение продолжается; `false` — процедура верхнего уровня завершилась
   */
  async step(): Promise<boolean> {
    if (this.finished) return false;
    if (this.pc < 0 || this.pc >= this.program.instructions.length) {
      this.finished = true;
      return false;
    }
    if (this.executed >= this.maxSteps) {
      throw new ShellSimulatorError(`превышен предел шагов (${this.maxSteps})`, this.pc);
    }
    const instruction = this.program.instructions[this.pc]!;
    const latency = this.latencyOf(instruction);

    // ── 1. Момент выдачи: порядок программы + готовность источников по RAW ────
    const frame = this.frame();
    let dependencyReady = 0;
    for (const read of instruction.reads) {
      const ready = frame.ready[read] ?? 0;
      if (ready > dependencyReady) dependencyReady = ready;
    }
    const earliest = this.lastIssue + 1;
    const issue =
      this.defects.ignoreDependencies === true ? earliest : Math.max(earliest, dependencyReady);
    const stall = issue - earliest;
    this.stalls += stall;
    this.currentIssue = issue;

    // ── 2. Семантика носителя (та же, что у регистровой VM) ───────────────────
    const next = await this.execute(instruction);

    // ── 3. Готовность записей и счёт тактов ───────────────────────────────────
    const readyAt = this.defects.ignoreDependencies === true ? issue : issue + latency;
    for (const write of instruction.writes) {
      if (write >= 0 && write < frame.ready.length) frame.ready[write] = readyAt;
    }
    const end = this.defects.ignoreDependencies === true ? issue : issue + latency - 1;
    if (end > this.tickCount) this.tickCount = end;

    // ── 4. Учёт по классам ────────────────────────────────────────────────────
    const stat = this.classStat(this.labelOf(instruction));
    stat.executed++;
    stat.ticks += this.defects.ignoreDependencies === true ? 1 : latency;
    stat.stalls += stall;

    this.executed++;
    this.lastIssue = issue;

    if (next === undefined) {
      this.finished = true;
      return false;
    }
    this.pc = next;
    return true;
  }

  /**
   * Семантика одного носителя — как в `src/runtime/vm/reginterpreter.ts`.
   *
   * @returns следующая позиция или `undefined` — процедура верхнего уровня завершилась
   */
  private async execute(instruction: ShellInstruction): Promise<number | undefined> {
    const ins = instruction.instruction;
    const next = this.pc + 1;
    switch (ins.op) {
      case 'const': {
        const value = this.program.constants[ins.k];
        if (value === undefined) {
          throw new ShellSimulatorError(
            `индекс константы вне пула: ${ins.k}`,
            this.pc,
            instruction.carrier,
          );
        }
        this.write(ins.d, value as StackValue);
        return next;
      }
      case 'const.true':
        this.write(ins.d, true);
        return next;
      case 'const.false':
        this.write(ins.d, false);
        return next;
      case 'const.null':
        this.write(ins.d, null);
        return next;
      case 'move':
        this.write(ins.d, this.read(ins.a));
        return next;
      case 'add': {
        const left = this.read(ins.a);
        const right = this.read(ins.b);
        // 4.4: подмена семантики — `add` считается как `sub`.
        if (this.defects.swapAddToSub === true) {
          this.write(ins.d, (left as number) - (right as number));
          return next;
        }
        if (typeof left === 'string' || typeof right === 'string') {
          this.write(ins.d, osnovaStringify(left) + osnovaStringify(right));
          return next;
        }
        this.write(ins.d, (left as number) + (right as number));
        return next;
      }
      case 'sub':
        this.write(ins.d, (this.read(ins.a) as number) - (this.read(ins.b) as number));
        return next;
      case 'mul':
        this.write(ins.d, (this.read(ins.a) as number) * (this.read(ins.b) as number));
        return next;
      case 'div': {
        const left = this.read(ins.a) as number;
        const right = this.read(ins.b) as number;
        if (right === 0) throw new ShellSimulatorError('деление на ноль', this.pc, instruction.carrier);
        this.write(ins.d, left / right);
        return next;
      }
      case 'rem': {
        const left = this.read(ins.a) as number;
        const right = this.read(ins.b) as number;
        if (right === 0) {
          throw new ShellSimulatorError('остаток по нулю', this.pc, instruction.carrier);
        }
        this.write(ins.d, left % right);
        return next;
      }
      case 'eq':
        this.write(ins.d, this.read(ins.a) === this.read(ins.b));
        return next;
      case 'ne':
        this.write(ins.d, this.read(ins.a) !== this.read(ins.b));
        return next;
      case 'lt':
        this.write(ins.d, (this.read(ins.a) as number) < (this.read(ins.b) as number));
        return next;
      case 'le':
        this.write(ins.d, (this.read(ins.a) as number) <= (this.read(ins.b) as number));
        return next;
      case 'gt':
        this.write(ins.d, (this.read(ins.a) as number) > (this.read(ins.b) as number));
        return next;
      case 'ge':
        this.write(ins.d, (this.read(ins.a) as number) >= (this.read(ins.b) as number));
        return next;
      case 'and':
        this.write(ins.d, Boolean(this.read(ins.a) && this.read(ins.b)));
        return next;
      case 'or':
        this.write(ins.d, Boolean(this.read(ins.a) || this.read(ins.b)));
        return next;
      case 'not':
        this.write(ins.d, !this.read(ins.a));
        return next;
      case 'invoke': {
        if (!isKnownInvoke(ins.name)) {
          throw new ShellSimulatorError(
            `неизвестный хост-вызов: ${ins.name}`,
            this.pc,
            instruction.carrier,
          );
        }
        const expected = getInvokeArgCount(ins.name);
        if (ins.argc !== expected) {
          throw new ShellSimulatorError(
            `invoke ${ins.name}: ожидалось аргументов ${expected}, в коде ${ins.argc}`,
            this.pc,
            instruction.carrier,
          );
        }
        const args: StackValue[] = [];
        for (let i = 0; i < ins.argc; i++) args.push(this.read(ins.args[i] ?? -1));
        const result = await this.invoke(ins.name, args);
        this.writeIfAny(ins.d, result === undefined ? null : result);
        return next;
      }
      case 'call': {
        const callee = this.program.procedures[ins.fi];
        if (callee === undefined) {
          throw new ShellSimulatorError(
            `call: неверный индекс процедуры ${ins.fi}`,
            this.pc,
            instruction.carrier,
          );
        }
        const args: StackValue[] = [];
        for (let i = 0; i < ins.argc; i++) args.push(this.read(ins.args[i] ?? -1));
        this.frames.push(this.createFrame(callee, ins.fi, next, args, ins));
        return this.program.procedureEntry[ins.fi] ?? next;
      }
      case 'jmp':
        return instruction.target ?? next;
      case 'jmp_if':
        return this.read(ins.cond ?? -1) ? (instruction.target ?? next) : next;
      case 'jmp_if_not':
        return this.read(ins.cond ?? -1) ? next : (instruction.target ?? next);
      case 'ret': {
        const value = ins.v === undefined ? undefined : this.read(ins.v);
        const frame = this.frames.pop();
        if (frame === undefined) {
          throw new ShellSimulatorError('ret без кадра', this.pc, instruction.carrier);
        }
        if (this.frames.length === 0) {
          this.lastReturn = value === undefined ? null : value;
          return undefined;
        }
        // Возвращённое значение готово через латентность возврата — это и есть RAW-зависимость
        // потребителя от результата вызова.
        const caller = this.frame();
        const callInstruction = frame.callerInstruction;
        if (
          callInstruction !== undefined &&
          (callInstruction.op === 'call' || callInstruction.op === 'invoke') &&
          callInstruction.d !== undefined &&
          callInstruction.d < caller.ready.length
        ) {
          caller.ready[callInstruction.d] =
            this.defects.ignoreDependencies === true
              ? this.currentIssue
              : this.currentIssue + this.latencyOf(instruction);
          this.writeIfAny(callInstruction.d, value === undefined ? null : value);
        }
        return frame.returnPc;
      }
      default: {
        const unknown = ins as { op?: string };
        throw new ShellSimulatorError(
          `неизвестный носитель «${instruction.carrier}» с операцией «${unknown.op ?? '?'}»: семантика не определена`,
          this.pc,
          instruction.carrier,
        );
      }
    }
  }

  /** Прогон до завершения. */
  async run(): Promise<StackValue | undefined> {
    while (await this.step()) {
      // шаги идут до завершения процедуры верхнего уровня
    }
    return this.lastReturn;
  }

  /** Отчёт о прогоне. */
  report(): ShellTickReport {
    const classes = [...this.classStats.values()].sort(
      (a, b) => b.ticks - a.ticks || a.label.localeCompare(b.label),
    );
    return {
      ticks: this.tickCount,
      instructions: this.executed,
      staticInstructions: this.program.instructions.length,
      order: this.program.order,
      classes,
      instructionSize: this.program.instructionSize,
      tickModel: TICK_MODEL,
    };
  }
}

/** Строковое представление значения — как в регистровой VM (`add` со строками). */
function osnovaStringify(value: StackValue | undefined): string {
  if (value === true) return 'истина';
  if (value === false) return 'ложь';
  if (value === null || value === undefined) return 'пусто';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '[object]';
    }
  }
  return String(value);
}

/** Прогнать разобранную программу до завершения. */
export async function runShellProgram(
  program: ShellProgram,
  options: ShellSimulatorOptions = {},
): Promise<ShellRunResult> {
  const simulator = new ShellSimulator(program, options);
  const value = await simulator.run();
  return { value, report: simulator.report() };
}

/** Собрать программу по образу и прогнать её — короткий путь для оракулов и отчётов. */
export async function simulateShellImage(
  image: ShellImage,
  encoder: Encoder,
  options: ShellSimulatorOptions = {},
): Promise<ShellRunResult> {
  const program = decodeShellProgram(image, encoder, options);
  return runShellProgram(program, options);
}
