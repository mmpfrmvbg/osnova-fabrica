/**
 * List scheduling с перестановкой для **регистрового** кода.
 *
 * ## Почему перестановка возможна только здесь
 *
 * Стековый байткод Основа держит операнды на общем стеке: перестановка двух
 * инструкций, если между ними есть `push`/`pop`, меняет смысл программы. Именно
 * поэтому `scheduler.ts` и `regScheduler.ts` упаковывают **in-order**, а
 * `scheduler.ts` прямо это документирует: «любая перестановка ломала порядок
 * push/pop».
 *
 * В регистровой форме инструкция сама говорит, что читает и что пишет
 * (`add d, a, b`), поэтому перестановка независимых инструкций ничего не ломает.
 * Ради этого регистровое ядро и строилось (`docs/vliw-reg-plan.md`).
 *
 * ## Что делает этот файл
 *
 * В отличие от {@link ./regScheduler.scheduleRegCode} (in-order упаковка), здесь
 * инструкции выдаются тогда, когда **готовы их операнды**, и порядок выдачи
 * следует этой готовности, а не порядку программы. Отсюда:
 *
 * - снятие in-order: инструкция из конца блока может быть выдана раньше
 *   инструкции из начала, если она ни от чего не зависит;
 * - задержки: момент готовности = такт выдачи + длительность операции (стр. 71);
 * - пустые такты (`nop`) вставляются только там, где перестановкой их закрыть
 *   нельзя.
 *
 * ## Гарантии корректности
 *
 * Граф из {@link ./regGraph} содержит не только RAW, но и WAR/WAW, а также
 * цепочку эффектов. Поэтому любая топологическая сортировка этого графа
 * корректна по построению: перезаписи регистров не обгоняют чтения, а
 * `obj.set`/`invoke`/`throw` сохраняют относительный порядок.
 * {@link validateRegSchedule} это проверяет явно, а не предполагает.
 */

import type { RegInstruction } from "../runtime/vm/regcode";
import {
  DOMAIN_PENALTY,
  channelsForClass,
  clusterOf,
  type AluCluster,
  type ChannelId,
  type OpClass,
} from "./e2kDevices";
import {
  buildRegDependencyGraph,
  type RegGraph,
  type RegGraphOptions,
} from "./regGraph";

/**
 * Класс операции e2k для **регистровой** инструкции.
 *
 * Отображение наше: в руководстве МЦСТ (стр. 71–72) перечислены классы операций
 * e2k, а не операции Основа. Выведено из описаний — см. `opClassOf` в
 * `e2kDevices.ts` для стекового варианта; здесь то же самое, но по `RegInstruction`.
 */
export function regOpClass(ins: RegInstruction): OpClass {
  switch (ins.op) {
    case "add":
    case "sub":
    case "and":
    case "or":
    case "not":
    case "move":
    case "const":
    case "const.true":
    case "const.false":
    case "const.null":
    case "try_begin":
    case "try_end":
      return "int";
    case "mul":
      // Стр. 71: «Fp … а также целочисленные операции mul».
      return "fp";
    case "div":
    case "rem":
      return "fdiv32";
    case "eq":
    case "ne":
    case "lt":
    case "le":
    case "gt":
    case "ge":
      return "cmp_to_logic";
    case "obj.get":
      // Настоящее чтение из памяти; уровень кэша считаем L1, как обещает
      // документ про планировщик (стр. 71).
      return "ld_l1";
    case "obj.set":
      // Запись в поле объекта — устройство с ST (только АЛУ2 и АЛУ5, стр. 56).
      return "store";
    case "obj.new":
      return "int";
    case "jmp":
    case "jmp_if":
    case "jmp_if_not":
      return "disp_to_ct";
    case "ret":
      return "return_to_ct";
    case "call":
    case "invoke":
      return "to_ct";
    case "throw":
      return "to_ct";
    default:
      return "int";
  }
}

/** Является ли операция классом, требующим устройства передачи управления. */
function isControlReg(ins: RegInstruction): boolean {
  return (
    ins.op === "jmp" ||
    ins.op === "jmp_if" ||
    ins.op === "jmp_if_not" ||
    ins.op === "ret"
  );
}

/**
 * Границы линейных участков: позиции, с которых начинается участок.
 *
 * Перестановка законна только внутри участка — переносить инструкцию через
 * метку перехода или через терминатор нельзя. Границы те же, что у in-order
 * планировщика (`regScheduler.ts`): цели переходов, `try_begin` и позиция сразу
 * после терминатора.
 *
 * @param offsetBase абсолютный индекс, которому соответствует `code[0]`.
 *
 * ## Зачем `offsetBase` (найденный дефект)
 *
 * `off` у `jmp*`/`try_begin` в регистровом модуле — **абсолютный индекс по всему
 * `module.code`**, а не по переданному массиву. Когда планируется одна процедура
 * (срез модуля), её переходы указывают на абсолютные позиции.
 *
 * Первая версия трактовала `off` как индекс внутри среза. На модуле из четырёх
 * процедур это давало неверные границы: у процедуры `#2`, начинающейся с 34,
 * `jmp off=36` — это индекс 70 в модуле, то есть вообще вне её тела. Участки
 * строились неправильно, планировщик переставлял инструкции через реальные
 * границы, и программа считала `1041` вместо `1049`.
 *
 * Поэтому база передаётся явно: цель перехода переводится в индекс внутри
 * массива как `off - offsetBase`. По умолчанию база `0` — планирование целого
 * модуля, где `off` и так совпадает с индексом.
 */
export function linearRegionStarts(
  code: readonly RegInstruction[],
  offsetBase = 0,
): Set<number> {
  const starts = new Set<number>([0, code.length]);
  /** Абсолютная цель → индекс внутри `code`, если она внутри массива. */
  const localize = (abs: number): number | undefined => {
    const local = abs - offsetBase;
    return local >= 0 && local <= code.length ? local : undefined;
  };
  for (let i = 0; i < code.length; i++) {
    const ins = code[i]!;
    if (ins.op === "jmp" || ins.op === "jmp_if" || ins.op === "jmp_if_not") {
      const local = localize(ins.off);
      if (local !== undefined) starts.add(local);
    }
    if (ins.op === "try_begin") {
      // Интерпретатор, войдя в пакет с `try_begin`, продолжит исполнять
      // остальные слоты уже в другом состоянии обработчиков — см.
      // `regScheduler.ts`. Поэтому участок начинается и в теле, и в обработчике.
      starts.add(i);
      const local = localize(ins.off);
      if (local !== undefined) starts.add(local);
    }
    if (isControlReg(ins)) {
      // Терминатор (`jmp*`, `ret`) закрывает участок: переставлять через него
      // нельзя, и сам он обязан остаться последним. Для `ret` это ещё и
      // семантическое требование — возврат наблюдает все эффекты до него.
      // Дефект был найден оракулом эквивалентности на `storage_demo.osnova`:
      // `ret` получал пустой список предшественников и выдавался первым.
      starts.add(i);
      starts.add(i + 1);
    }
  }
  return starts;
}

/** Разбить код на линейные участки (индексы начала включительно, конца — нет). */
export function splitLinearRegions(
  code: readonly RegInstruction[],
  offsetBase = 0,
): Array<{ start: number; end: number }> {
  const starts = [...linearRegionStarts(code, offsetBase)]
    .filter((p) => p >= 0 && p <= code.length)
    .sort((a, b) => a - b);
  const regions: Array<{ start: number; end: number }> = [];
  for (let k = 0; k < starts.length - 1; k++) {
    const start = starts[k]!;
    const end = starts[k + 1]!;
    if (end > start) regions.push({ start, end });
  }
  return regions;
}

/** Один слот в расписании перестановки. */
export interface ReorderedSlot {
  /** Индекс инструкции в исходном линейном коде. */
  index: number;
  op: string;
  opClass: OpClass;
  latency: number;
  channel: ChannelId;
}

/** Один пакет расписания перестановки. */
export interface ReorderedPacket {
  issueAt: number;
  nopsBefore: number;
  slots: ReorderedSlot[];
}

export interface ReorderMetrics {
  instructionCount: number;
  packetCount: number;
  /** Тактов от начала до готовности последнего результата. */
  cycles: number;
  /** Пустых тактов вставлено. */
  nopCycles: number;
  /** Тактов на инструкцию: меньше — плотнее. */
  cpi: number;
  /** Инструкций на пакет. */
  ilp: number;
  /** Заполненность каналов: `ilp / E2K_ISSUE_WIDTH`. */
  utilization: number;
  /**
   * Насколько перестановка помогла: `(inOrderCycles - cycles) / inOrderCycles`.
   * Считается по тому же графу в in-order режиме, см. {@link inOrderBaselineCycles}.
   */
  gain: number;
  /** Тактов у in-order планирования того же кода (база сравнения). */
  inOrderCycles: number;
}

export interface ReorderResult {
  packets: ReorderedPacket[];
  /** Порядок выдачи: индексы инструкций в порядке исполнения. */
  order: number[];
  /** Такт выдачи каждой инструкции (по исходному индексу). */
  issueAt: number[];
  /** Такт готовности результата каждой инструкции (по исходному индексу). */
  readyAt: number[];
  metrics: ReorderMetrics;
  /** Разбивка по линейным участкам: границы и такты (для отчётов и отладки). */
  regions?: Array<{
    start: number;
    end: number;
    baseAt: number;
    inOrderCycles: number;
    cycles: number;
    nopCycles: number;
  }>;
}

export class ReorderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReorderError";
  }
}

/** Штраф за переход между целочисленным и вещественным доменами (стр. 72). */
function regDomainPenalty(producer: OpClass, consumer: OpClass): number {
  const pFp =
    producer === "fp" || producer === "fp_combined" ||
    producer === "fdiv32" || producer === "fdiv64";
  const cInt = consumer === "int" || consumer === "int_combined" || consumer === "store";
  const pInt = producer === "int" || producer === "int_combined" || producer === "store";
  const cFp =
    consumer === "fp" || consumer === "fp_combined" ||
    consumer === "fdiv32" || consumer === "fdiv64";
  if (pFp && cInt) return DOMAIN_PENALTY.fp_to_int;
  if (pInt && cFp) return DOMAIN_PENALTY.int_to_fp;
  return 0;
}

/**
 * Штраф за то, что потребитель окажется в другом кластере, чем производитель.
 *
 * Стр. 194: «Байпас не может работать между кластерами, работая в каждом
 * отдельно». Байпас позволяет потребителю получить результат **до** записи в
 * регистровый файл; без него результат идёт через rf, то есть дольше.
 *
 * ## Почему функция возвращает 0, а не число
 *
 * Документ не даёт величины «на сколько тактов дороже через rf»: он даёт
 * таблицы `relative_latency` по фазам конвейера (стр. 193 и далее), которые мы
 * не реализовали. Придумывать число — ровно та ошибка, из-за которой в проекте
 * когда-то стояло «все операции 1 такт».
 *
 * Поэтому вместо штрафа планировщик **избегает** другого кластера: каналы
 * сортируются так, что каналы кластера производителя идут первыми
 * (`channelsForClass(..., preferCluster)`), и потребитель садится туда, где
 * байпас работает. Эта функция оставлена как точка расширения: когда таблицы
 * главы 12 будут реализованы, штраф появится здесь и станет числом.
 */
function crossClusterPenalty(
  producerCluster: AluCluster | undefined,
  consumerIndex: number,
  consumerClass: readonly OpClass[],
): number {
  void producerCluster;
  void consumerIndex;
  void consumerClass;
  return 0;
}

export interface ReorderOptions extends RegGraphOptions {
  /**
   * Как моделировать обращения к памяти (чтения `obj.get`).
   *
   * `"l1"` (по умолчанию) — документ, стр. 71: «Планировщик всегда будет
   * планировать чтение из L1, если только от программиста не было подсказки не
   * обращаться по чтению в L1». Остальные уровни — это **подсказка**, которой в
   * байткоде Основа пока нет: они нужны, чтобы оценить, что будет, если чтение
   * промахнётся мимо L1 (`l2` 11, `l3` 40, `mem` 100 тактов, стр. 71).
   */
  memoryLevel?: "l1" | "l2" | "l3" | "mem";
  /**
   * Учитывать ли кластеры АЛУ при выборе канала.
   *
   * `true` (по умолчанию) — каналы кластера производителя идут первыми, чтобы
   * байпас работал (стр. 194). `false` — каналы в естественном порядке; это
   * **baseline для сравнения**, а не рабочая настройка. Нужен, чтобы «предпочтение
   * кластера» можно было измерить, а не заявить.
   */
  respectClusters?: boolean;
  /**
   * Абсолютный индекс, которому соответствует `code[0]`.
   *
   * Нужен, когда планируется **срез модуля** (одна процедура): переходы внутри
   * него несут абсолютные адреса по всему `module.code`. Без этой базы границы
   * линейных участков строятся неверно — см. {@link linearRegionStarts}.
   *
   * `0` (по умолчанию) — планируется целый модуль, адреса совпадают с индексами.
   */
  offsetBase?: number;
}

/** Длительность чтения по уровню памяти (стр. 71). */
const MEMORY_LEVEL_LATENCY: Readonly<Record<NonNullable<ReorderOptions["memoryLevel"]>, number>> = {
  l1: 3,
  l2: 11,
  l3: 40,
  mem: 100,
};

/** Длительность класса операции с учётом выбранного уровня памяти. */
function latencyForClass(cls: OpClass, memoryLevel: ReorderOptions["memoryLevel"]): number {
  if (cls === "ld_l1") {
    const lvl = memoryLevel ?? "l1";
    return MEMORY_LEVEL_LATENCY[lvl];
  }
  return latencyOf(cls);
}

/**
 * Планирование регистрового кода с перестановкой — **по линейным участкам**.
 *
 * Границы участков берутся из {@link splitLinearRegions}: перестановка через
 * метку перехода или через терминатор недопустима. Участки планируются
 * последовательно, время сквозное (такт продолжается), как в in-order
 * планировщике.
 *
 * @param code регистровый код
 * @param opts опции графа зависимостей и модели памяти
 */
export function scheduleRegWithReorder(
  code: readonly RegInstruction[],
  opts: ReorderOptions = {},
): ReorderResult {
  return scheduleRegByRegions(code, opts, scheduleGraphWithReorder);
}

/**
 * Планирование регистрового кода **в порядке программы** — по тем же участкам,
 * что и {@link scheduleRegWithReorder}, в той же форме результата.
 *
 * Нужно, чтобы счётчики и метрики двух способов планирования были сопоставимы:
 * один и тот же граф, одни и те же длительности, одна и та же форма. Разница
 * только в порядке — здесь он строго программный.
 */
export function scheduleRegInOrder(
  code: readonly RegInstruction[],
  opts: ReorderOptions = {},
): ReorderResult {
  return scheduleRegByRegions(code, opts, scheduleGraphInOrder);
}

/** Общая обвязка: разбить на участки, спланировать каждый, сшить результат. */
function scheduleRegByRegions(
  code: readonly RegInstruction[],
  opts: ReorderOptions,
  planner: (
    slice: readonly RegInstruction[],
    graph: RegGraph,
    memoryLevel: ReorderOptions["memoryLevel"],
    respectClusters: boolean,
    offsetBase: number,
  ) => ReorderResult,
): ReorderResult {
  const n = code.length;
  if (n === 0) {
    return emptyResult();
  }

  /**
   * База адресов: если планируется срез модуля, переходы внутри него несут
   * АБСОЛЮТНЫЕ адреса по всему `module.code`, а не индексы среза. Передаём базу
   * в разбиение на участки, иначе границы строятся неверно и планировщик
   * переставляет инструкции через реальные границы циклов (дефект, найденный на
   * `while.osnova`: 1041 вместо 1049).
   */
  const offsetBase = opts.offsetBase ?? 0;
  const regions = splitLinearRegions(code, offsetBase);
  const order: number[] = [];
  const issueAt = new Array<number>(n).fill(0);
  const readyAt = new Array<number>(n).fill(0);
  const packets: ReorderedPacket[] = [];

  /**
   * Смещение по такту для участка: участки идут один за другим, поэтому
   * следующий начинается не раньше, чем закончился предыдущий.
   */
  let baseAt = 0;
  let totalNops = 0;
  let inOrderTotal = 0;
  const regionInfo: NonNullable<ReorderResult["regions"]> = [];

  for (const region of regions) {
    const slice = code.slice(region.start, region.end);
    const graph = buildRegDependencyGraph(slice, opts);
    const local = planner(
      slice,
      graph,
      opts.memoryLevel ?? "l1",
      opts.respectClusters !== false,
      offsetBase + region.start,
    );

    for (const [pi, p] of local.packets.entries()) {
      packets.push({
        issueAt: p.issueAt + baseAt,
        nopsBefore: pi === 0 ? Math.max(0, p.issueAt) : p.nopsBefore,
        slots: p.slots.map((s) => ({ ...s, index: s.index + region.start })),
      });
    }
    for (let k = 0; k < slice.length; k++) {
      issueAt[region.start + k] = local.issueAt[k]! + baseAt;
      readyAt[region.start + k] = local.readyAt[k]! + baseAt;
    }
    order.push(...local.order.map((k) => k + region.start));

    regionInfo.push({
      start: region.start,
      end: region.end,
      baseAt,
      inOrderCycles: local.metrics.inOrderCycles,
      cycles: local.metrics.cycles,
      nopCycles: local.metrics.nopCycles,
    });

    totalNops += local.metrics.nopCycles;
    inOrderTotal += local.metrics.inOrderCycles;
    // Следующий участок начинается там, где закончился этот. Берём длину
    // самого участка (`cycles`), а не его in-order базу: база — эталон для
    // сравнения, а не реальное время выполнения.
    baseAt += local.metrics.cycles;
  }

  const cycles = readyAt.reduce((m, v) => Math.max(m, v), 0);
  const placed = packets.reduce((acc, p) => acc + p.slots.length, 0);

  return {
    packets,
    order,
    issueAt,
    readyAt,
    metrics: {
      instructionCount: n,
      packetCount: packets.length,
      cycles,
      nopCycles: totalNops,
      cpi: cycles > 0 ? cycles / n : 0,
      ilp: packets.length > 0 ? placed / packets.length : 0,
      utilization: packets.length > 0 ? placed / (packets.length * 24) : 0,
      gain: inOrderTotal > 0 ? (inOrderTotal - cycles) / inOrderTotal : 0,
      inOrderCycles: inOrderTotal,
    },
    regions: regionInfo,
  };
}

/**
 * In-order планирование по готовому графу, в той же форме, что
 * {@link scheduleGraphWithReorder}.
 *
 * Модель времени та же: инструкция выдаётся не раньше готовности операндов и не
 * раньше предыдущей. Если операнды не готовы, такт пропускается — в реальном
 * e2k это выражается `nop` (стр. 193: «Задержка между источником и потребителем
 * может быть реализована размещением между ними реальных или фиктивных команд
 * (операция nop N, где N > 0)»).
 */
export function scheduleGraphInOrder(
  code: readonly RegInstruction[],
  graph: RegGraph,
  memoryLevel: ReorderOptions["memoryLevel"] = "l1",
  // Принимается ради единой сигнатуры с `scheduleGraphWithReorder` (её требует
  // общая обвязка `scheduleRegByRegions`), но в in-order планировании не
  // используется: порядок задан программой, выбирать кластер не из чего.
  respectClusters: boolean = true,
  /** Не используется: см. `scheduleGraphWithReorder`. */
  _offsetBase: number = 0,
): ReorderResult {
  void respectClusters;
  const n = code.length;
  if (n === 0) return emptyResult();

  const cls = new Array<OpClass>(n);
  const lat = new Array<number>(n);
  const channels = new Array<ChannelId[]>(n);
  for (let i = 0; i < n; i++) {
    cls[i] = regOpClass(code[i]!);
    lat[i] = latencyForClass(cls[i]!, memoryLevel);
    const ch = channelsForClass(cls[i]!);
    if (ch.length === 0) {
      throw new ReorderError(`нет исполнительного устройства для «${code[i]!.op}» (#${i})`);
    }
    channels[i] = ch;
  }

  const issueAt = new Array<number>(n).fill(0);
  const readyAt = new Array<number>(n).fill(0);
  const packets: ReorderedPacket[] = [];
  const order: number[] = [];
  let nopCycles = 0;

  let openAt: number | undefined;
  let openChannels = new Set<ChannelId>();
  let openSlots: ReorderedSlot[] = [];
  let nextFreeAt = 0;

  const close = (): void => {
    if (openAt === undefined || openSlots.length === 0) return;
    const prevEnd = packets.length === 0 ? 0 : packets[packets.length - 1]!.issueAt + 1;
    packets.push({
      issueAt: openAt,
      nopsBefore: Math.max(0, openAt - prevEnd),
      slots: openSlots,
    });
    nextFreeAt = openAt + 1;
    openAt = undefined;
    openChannels = new Set<ChannelId>();
    openSlots = [];
  };

  for (let i = 0; i < n; i++) {
    // Не раньше готовности всех предшественников (по их фактическим тактам).
    let wanted = 0;
    for (const p of graph.preds[i]!) {
      wanted = Math.max(wanted, readyAt[p]! + regDomainPenalty(cls[p]!, cls[i]!));
    }
    let at = Math.max(wanted, nextFreeAt);

    if (openAt === undefined) {
      nopCycles += Math.max(0, at - nextFreeAt);
      openAt = at;
    } else if (at > openAt || channels[i]!.every((c) => openChannels.has(c))) {
      close();
      at = Math.max(wanted, nextFreeAt);
      nopCycles += Math.max(0, at - nextFreeAt);
      openAt = at;
    }

    const ch = channels[i]!.find((c) => !openChannels.has(c));
    if (ch === undefined) {
      close();
      const retryAt = Math.max(wanted, nextFreeAt);
      nopCycles += Math.max(0, retryAt - nextFreeAt);
      openAt = retryAt;
      const retry = channels[i]!.find((c) => !openChannels.has(c))!;
      openChannels.add(retry);
      openSlots.push({
        index: i,
        op: code[i]!.op,
        opClass: cls[i]!,
        latency: lat[i]!,
        channel: retry,
      });
    } else {
      openChannels.add(ch);
      openSlots.push({
        index: i,
        op: code[i]!.op,
        opClass: cls[i]!,
        latency: lat[i]!,
        channel: ch,
      });
    }
    issueAt[i] = openAt!;
    readyAt[i] = openAt! + lat[i]!;
    order.push(i);
  }
  close();

  const cycles = readyAt.reduce((m, v) => Math.max(m, v), 0);
  const placed = packets.reduce((acc, p) => acc + p.slots.length, 0);
  const baseline = inOrderBaselineCycles(code, graph);

  return {
    packets,
    order,
    issueAt,
    readyAt,
    metrics: {
      instructionCount: n,
      packetCount: packets.length,
      cycles,
      nopCycles,
      cpi: cycles > 0 ? cycles / n : 0,
      ilp: packets.length > 0 ? placed / packets.length : 0,
      utilization: packets.length > 0 ? placed / (packets.length * 24) : 0,
      gain: baseline > 0 ? (baseline - cycles) / baseline : 0,
      inOrderCycles: baseline,
    },
  };
}

function emptyResult(): ReorderResult {
  return {
    packets: [],
    order: [],
    issueAt: [],
    readyAt: [],
    metrics: {
      instructionCount: 0,
      packetCount: 0,
      cycles: 0,
      nopCycles: 0,
      cpi: 0,
      ilp: 0,
      utilization: 0,
      gain: 0,
      inOrderCycles: 0,
    },
  };
}

/**
 * Ядро: планирование по готовому графу (list scheduling с задержками).
 *
 * ## Почему готовность считается динамически
 *
 * Первая версия вычисляла «момент готовности» узла один раз — как максимум по
 * **расчётным** временам предшественников, до того как они были размещены.
 * Это неверно: если предшественник сдвинулся из-за занятости канала, его
 * потребитель обязан сдвинуться вместе с ним. Ошибка ловилась тестом
 * («#16 выдан в такте 15, но операнд от #15 готов только в 16»).
 *
 * Здесь готовность считается по **фактическому** такту выдачи предшественника,
 * а моменты уточняются динамически: как только освобождается новый узел, его
 * оценка становится точной. Приоритет выбора — (оценка, исходный индекс), то
 * есть при равной готовности сохраняется порядок программы: расписание
 * детерминировано.
 *
 * Экспортируется, чтобы оракул мог переиспользовать один и тот же граф для
 * сравнения перестановки с in-order базой.
 */
export function scheduleGraphWithReorder(
  code: readonly RegInstruction[],
  graph: RegGraph,
  memoryLevel: ReorderOptions["memoryLevel"] = "l1",
  respectClusters: boolean = true,
  /**
   * Не используется: планировщик получает уже готовый **линейный участок**, а
   * переходы (`jmp*`) внутри участка не встречаются — они и есть его границы.
   * Параметр оставлен для единой сигнатуры с in-order вариантом (её требует
   * общая обвязка `scheduleRegByRegions`).
   */
  _offsetBase: number = 0,
): ReorderResult {
  const n = code.length;
  if (n === 0) return emptyResult();

  const cls = new Array<OpClass>(n);
  const lat = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    cls[i] = regOpClass(code[i]!);
    lat[i] = latencyForClass(cls[i]!, memoryLevel);
    if (channelsForClass(cls[i]!).length === 0) {
      throw new ReorderError(`нет исполнительного устройства для «${code[i]!.op}» (#${i})`);
    }
  }

  const issueAt = new Array<number>(n).fill(-1);
  const readyAt = new Array<number>(n).fill(-1);
  const remainingPreds = graph.preds.map((p) => p.length);
  const succs: number[][] = Array.from({ length: n }, () => []);
  for (const [from, to] of graph.edges) succs[from]!.push(to);

  /** Оценка: не раньше какого такта узел может быть выдан. */
  const est = new Array<number>(n).fill(0);
  const placed = new Array<boolean>(n).fill(false);

  /**
   * Кластер, в котором выдан каждый узел. Нужен, чтобы держать зависимые
   * операции в одном кластере: байпас между кластерами не работает (стр. 194),
   * и результат пошёл бы через регистровый файл — то есть дольше.
   */
  const issuedCluster = new Array<AluCluster | undefined>(n).fill(undefined);

  /**
   * Предпочтительный кластер для узла: кластер производителя самого позднего
   * операнда. Если ни у одного предшественника кластера нет (например, это
   * `invoke` на канале СТ), предпочтения нет.
   *
   * ## Замер показал: это почти всегда no-op
   *
   * Без предпочтения (`respectClusters: false`) на тестовой программе получается
   * РОВНО то же расписание и те же 0 пересечений кластера, а на корпусе из 9
   * файлов пересечений стало 24 → 25 при неизменных тактах (1130 → 1130).
   *
   * Причина: узлы выдаются почти в порядке программы, поэтому зависимые цепочки
   * и так остаются на первых трёх АЛУ. Предпочтение срабатывает только когда
   * кластер производителя занят — редкость при таком порядке.
   *
   * Оставлено как baseline-переключатель (нужен, чтобы это можно было
   * перепроверить) и на случай, если планировщик станет агрессивнее в
   * перестановке. Честная роль знания о кластерах сейчас — ИЗМЕРЕНИЕ, см.
   * {@link ./e2kDevices.crossClusterEdges}.
   */
  const preferClusterFor = (i: number): AluCluster | undefined => {
    if (respectClusters === false) return undefined;
    let best: AluCluster | undefined;
    let bestReady = -1;
    for (const p of graph.preds[i]!) {
      const c = issuedCluster[p];
      if (c === undefined) continue;
      const r = readyAt[p]!;
      if (r > bestReady) {
        bestReady = r;
        best = c;
      }
    }
    return best;
  };

  const ready: number[] = [];
  for (let i = 0; i < n; i++) {
    if (remainingPreds[i]! === 0) ready.push(i);
  }

  const packets: ReorderedPacket[] = [];
  const order: number[] = [];
  let nopCycles = 0;
  let t = 0;

  /** Все каналы, которые узел мог бы занять в этом такте. */
  const candidatesFor = (i: number): ChannelId[] =>
    channelsForClass(cls[i]!, preferClusterFor(i));

  while (ready.length > 0) {
    const usedChannels = new Set<ChannelId>();
    const packetSlots: ReorderedSlot[] = [];
    let progressed = true;

    while (progressed) {
      progressed = false;
      let best = -1;
      let bestKey: [number, number] = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
      for (const c of ready) {
        if (est[c]! > t) continue;
        const cand = candidatesFor(c);
        if (cand.every((ch) => usedChannels.has(ch))) continue;
        // Приоритет: (оценка, индекс). Оценка уже включает штраф за другой
        // кластер, поэтому узел, которому нужен занятый кластер, «подождёт».
        const key: [number, number] = [est[c]!, c];
        if (key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
          best = c;
          bestKey = key;
        }
      }
      if (best < 0) break;

      const cand = candidatesFor(best);
      const ch = cand.find((x) => !usedChannels.has(x))!;
      usedChannels.add(ch);
      issuedCluster[best] = clusterOf(ch);
      packetSlots.push({
        index: best,
        op: code[best]!.op,
        opClass: cls[best]!,
        latency: lat[best]!,
        channel: ch,
      });
      issueAt[best] = t;
      readyAt[best] = t + lat[best]!;
      placed[best] = true;
      order.push(best);
      progressed = true;

      ready.splice(ready.indexOf(best), 1);
      for (const s of succs[best]!) {
        remainingPreds[s]!--;
        const need =
          readyAt[best]! +
          regDomainPenalty(cls[best]!, cls[s]!) +
          crossClusterPenalty(issuedCluster[best], s, cls);
        if (need > est[s]!) est[s] = need;
        if (remainingPreds[s]! === 0) ready.push(s);
      }
    }

    if (packetSlots.length > 0) {
      const prevEnd = packets.length === 0 ? 0 : packets[packets.length - 1]!.issueAt + 1;
      packets.push({
        issueAt: t,
        nopsBefore: Math.max(0, t - prevEnd),
        slots: packetSlots,
      });
      nopCycles += Math.max(0, t - prevEnd);
      t += 1;
    } else {
      let next = Number.POSITIVE_INFINITY;
      for (const c of ready) next = Math.min(next, est[c]!);
      if (!Number.isFinite(next) || next <= t) {
        throw new ReorderError(
          `расписание застряло в такте ${t}: готовых узлов ${ready.length}, все каналы заняты`,
        );
      }
      t = next;
    }
  }

  const unplaced = placed.filter((p) => !p).length;
  if (unplaced > 0) {
    throw new ReorderError(`не размещено инструкций: ${unplaced} (цикл в графе?)`);
  }

  const cycles = readyAt.reduce((m, v) => Math.max(m, v), 0);
  const inOrderCycles = inOrderBaselineCycles(code, graph);
  const placedCount = packets.reduce((acc, p) => acc + p.slots.length, 0);

  return {
    packets,
    order,
    issueAt,
    readyAt,
    metrics: {
      instructionCount: n,
      packetCount: packets.length,
      cycles,
      nopCycles,
      cpi: cycles > 0 ? cycles / n : 0,
      ilp: packets.length > 0 ? placedCount / packets.length : 0,
      utilization: packets.length > 0 ? placedCount / (packets.length * 24) : 0,
      gain: inOrderCycles > 0 ? (inOrderCycles - cycles) / inOrderCycles : 0,
      inOrderCycles,
    },
  };
}

/** Длительность класса операции в тактах — из таблицы руководства. */
function latencyOf(cls: OpClass): number {
  switch (cls) {
    case "int":
      return 1;
    case "int_combined":
      return 2;
    case "store":
      return 1;
    case "fp":
      return 4;
    case "fp_combined":
      return 8;
    case "fdiv32":
      return 11;
    case "fdiv64":
      return 14;
    case "ld_l1":
      return 3;
    case "ld_l2":
      return 11;
    case "ld_l3":
      return 40;
    case "ld_mem":
      return 100;
    case "cmp_to_logic":
      return 1;
    case "logic_to_logic":
      return 0.5;
    case "qual":
      return 2;
    case "to_ct":
      return 3;
    case "disp_to_ct":
      return 5;
    case "return_to_ct":
      return 6;
    case "movtd_to_ct":
      return 9;
  }
}

/**
 * База сравнения: те же инструкции в порядке программы, с теми же задержками и
 * тем же графом. Нужна, чтобы «выигрыш» был честным — сравнение с самим собой,
 * только без перестановки.
 */
export function inOrderBaselineCycles(
  code: readonly RegInstruction[],
  graph: RegGraph,
): number {
  const n = code.length;
  const release = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (const p of graph.preds[i]!) {
      const prod = regOpClass(code[p]!);
      const cons = regOpClass(code[i]!);
      const ready = release[p]! + latencyOf(prod) + regDomainPenalty(prod, cons);
      if (ready > r) r = ready;
    }
    release[i] = r;
  }
  let at = 0;
  let lastReady = 0;
  for (let i = 0; i < n; i++) {
    const ins = code[i]!;
    const lat = latencyOf(regOpClass(ins));
    // In-order: инструкция выдаётся не раньше предыдущей и не раньше готовности.
    const issue = Math.max(release[i]!, at);
    at = issue + 1;
    lastReady = Math.max(lastReady, issue + lat);
  }
  return lastReady;
}

/**
 * Явная проверка корректности расписания — не предположение, а проверка.
 *
 * Утверждается четыре вещи:
 * 1. порядок выдачи — топологическая сортировка графа зависимостей (все рёбра
 *    идут от более раннего к более позднему);
 * 2. относительный порядок эффектов сохранён (для графа это следствие (1), но
 *    проверяем отдельно, потому что цена ошибки здесь — неверный результат);
 * 3. ни один потребитель не выдан раньше готовности своего операнда;
 * 4. **терминатор (`ret`, `jmp*`) стоит последним в своём линейном участке.**
 *
 * Пункт 4 добавлен после дефекта, найденного оракулом эквивалентности на
 * `storage_demo.osnova`: `ret` не имел предшественников по данным, планировщик
 * выдал его первым, и процедура завершалась до того, как сработали
 * `система.лог.вывести` и запись в хранилище. Пункты 1–3 этого не ловили —
 * рёбер-то как раз и не было. Такие «неявные барьеры» нужно проверять
 * структурно, а не через граф.
 */
export function validateRegSchedule(
  code: readonly RegInstruction[],
  graph: RegGraph,
  result: ReorderResult,
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const position = new Map<number, number>();
  result.order.forEach((idx, pos) => position.set(idx, pos));

  for (const [from, to] of graph.edges) {
    const pf = position.get(from);
    const pt = position.get(to);
    if (pf === undefined || pt === undefined) {
      problems.push(`ребро ${from}→${to}: узел не выдан`);
      continue;
    }
    if (pf >= pt) {
      problems.push(
        `нарушен порядок зависимостей: #${from} (поз ${pf}) должно идти раньше #${to} (поз ${pt})`,
      );
    }
  }

  // Готовность операндов: потребитель не раньше, чем готов производитель.
  for (let i = 0; i < code.length; i++) {
    for (const p of graph.preds[i]!) {
      const prod = regOpClass(code[p]!);
      const cons = regOpClass(code[i]!);
      const ready = result.readyAt[p]! + regDomainPenalty(prod, cons);
      if (result.issueAt[i]! < ready) {
        problems.push(
          `#${i} выдан в такте ${result.issueAt[i]}, но операнд от #${p} готов только в ${ready}`,
        );
      }
    }
  }

  // Терминатор обязан быть последним в своём участке.
  for (const region of splitLinearRegions(code)) {
    const inRegion = result.order.filter(
      (idx) => idx >= region.start && idx < region.end,
    );
    for (let k = 0; k < inRegion.length - 1; k++) {
      const idx = inRegion[k]!;
      const ins = code[idx]!;
      if (isControlReg(ins)) {
        problems.push(
          `терминатор «${ins.op}» (#${idx}) выдан в середине участка ` +
            `[${region.start},${region.end}) — после него стоят ещё инструкции`,
        );
      }
    }
  }

  return { ok: problems.length === 0, problems };
}
