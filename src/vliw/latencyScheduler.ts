/**
 * Планировщик VLIW с учётом длительностей операций (задержек).
 *
 * ## Что это добавляет
 *
 * Прежние планировщики (`scheduler.ts` для стекового кода, `regScheduler.ts` для
 * регистрового) упаковывали инструкции, зная только **тип слота** и зависимости.
 * Длительности операций не учитывались: `e2kModel.ts` прямо писал «все операции
 * 1 такт». Это неверно и, что важнее, не проверяемо.
 *
 * Руководство МЦСТ (стр. 71–72) даёт таблицу длительностей и прямо формулирует
 * задачу: «при размещении очередной операции в широкой команде выдержать
 * длительности операций-предшественников, которые вырабатывают ее аргументы».
 * На стр. 70 показано, как это выглядит в реальном ассемблере e2k — явным `nop`:
 *
 * ```
 * { ! T=1
 *   nop 4          ! явная задержка
 *   shls,0 %r2, 0x3, %r8
 *   shls,1 %r0, 0x4, %r10
 * }
 * ```
 *
 * Этот планировщик ставит **ровно такую** задержку: если потребитель не может
 * стартовать раньше, чем результат производителя готов, между ними вставляются
 * пустые пакеты.
 *
 * ## Модель времени
 *
 * Всё считается в **полутактах** (целое число), потому что таблица содержит
 * дробную задержку `logic->logic = 0.5` (стр. 71: «в некоторых случаях источник
 * andp и потребитель andp можно спланировать в одном такте (но не более двух
 * зависимых), поэтому длина задержки andp - andp трактуется как 0.5 такта»).
 *
 * Значения на выходе возвращаются в тактах как `number`.
 *
 * ## Чего здесь сознательно нет
 *
 * - **Переупорядочивания.** Планировщик идёт по программе сверху вниз. Это
 *   сохраняет порядок эффектов (`invoke`, `obj.set`, `throw`) без отдельного
 *   барьера и повторяет решение `regScheduler.ts`. Перестановка независимых
 *   операций требует доказательства независимости по эффектам — это следующий
 *   шаг, и он не должен смешиваться с учётом задержек.
 * - **Модели памяти.** Уровень кэша для чтения считается L1, как обещает
 *   документ про реальный планировщик: «Планировщик всегда будет планировать
 *   чтение из L1, если только от программиста не было подсказки не обращаться по
 *   чтению в L1» (стр. 71). Это отмечено в {@link ./e2kDevices.opClassOf}.
 */

import {
  CHANNELS,
  DOMAIN_PENALTY,
  E2K_ISSUE_WIDTH,
  channelsFor,
  latencyFor,
  opClassOf,
  type ChannelId,
  type ConsumerKind,
  type OpClass,
} from "./e2kDevices";
import { buildDependencyGraph, type DependencyGraphOptions } from "./dependencyGraph";
import type { RawInstruction } from "../runtime/vm/bytecode";

/** Один запланированный слот пакета. */
export interface ScheduledSlot {
  /** Индекс инструкции в исходном линейном коде. */
  index: number;
  /** Опкод. */
  op: string;
  /** Класс операции e2k и её длительность в тактах. */
  opClass: OpClass;
  latency: number;
  /** Канал, на который она назначена. */
  channel: ChannelId;
}

/** Один пакет (широкая команда) в расписании. */
export interface ScheduledPacket {
  /**
   * Время выдачи в тактах от начала участка. Растёт на число пустых тактов,
   * которые пришлось вставить: так выглядит `nop` в ассемблере e2k (стр. 70).
   */
  issueAt: number;
  /** Пустых тактов вставлено прямо перед этим пакетом. */
  nopsBefore: number;
  /** Заполненные каналы; индексы — позиции в {@link ALL_CHANNELS}. */
  slots: ScheduledSlot[];
}

/** Результат планирования с учётом задержек. */
export interface LatencyScheduleResult {
  packets: ScheduledPacket[];
  /** Ближайшее время готовности результата каждой инструкции (в тактах). */
  readyAt: number[];
  /** Общее время выполнения участка в тактах (issue последнего пакета + 1). */
  cycles: number;
  /** Сколько тактов потеряно на пустые пакеты. */
  nopCycles: number;
  /** Сколько инструкций упаковано. */
  instructionCount: number;
  /** Сколько тактов инструкций размещено (заполненных слотов). */
  placedSlots: number;
  /** Тактов на инструкцию: чем меньше, тем плотнее расписание. */
  cpi: number;
  /** Ширина одной широкой команды e2k (24), не ширина пакета Основа. */
  issueWidth: number;
}

/** Ошибка планирования: инструкцию некуда положить. */
export class LatencyScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LatencyScheduleError";
  }
}

/**
 * Планирование линейного участка с учётом длительностей операций.
 *
 * @param instructions линейный код (стековый байткод Основа)
 * @param opts те же опции, что у {@link buildDependencyGraph} (арности вызовов,
 *             чистые вызовы)
 */
export function scheduleWithLatency(
  instructions: readonly RawInstruction[],
  opts: DependencyGraphOptions = {},
): LatencyScheduleResult {
  const n = instructions.length;
  if (n === 0) {
    return {
      packets: [],
      readyAt: [],
      cycles: 0,
      nopCycles: 0,
      instructionCount: 0,
      placedSlots: 0,
      cpi: 0,
      issueWidth: E2K_ISSUE_WIDTH,
    };
  }

  // Предшественники по данным — из общего графа. Он уже умеет симуляцию стека,
  // порядок эффектов и store→load по локалам.
  const graph = buildDependencyGraph(instructions as RawInstruction[], opts);
  const preds: number[][] = Array.from({ length: n }, () => []);
  for (const [a, b] of graph.edges) preds[b]!.push(a);

  const readyAt = new Array<number>(n).fill(0);
  const packets: ScheduledPacket[] = [];
  /** Такт, с которого может быть выдан следующий новый пакет. */
  let nextIssueAt = 0;
  let nopCycles = 0;
  const consumerOf = opts.consumerKind ?? (() => "arith" as ConsumerKind);

  /** Открытый пакет: `issueAt === undefined` — пакет не открыт. */
  let openIssueAt: number | undefined;
  let openChannels = new Set<ChannelId>();
  let openSlots: ScheduledSlot[] = [];

  /**
   * Открыть пакет в такте `at`. Разрыв с предыдущим пакетом пишется как `nop` —
   * ровно так это выглядит в ассемблере e2k (стр. 70: `nop 4  ! явная задержка`).
   */
  const openAt = (at: number): void => {
    nopCycles += Math.max(0, at - nextIssueAt);
    openIssueAt = at;
    openChannels = new Set<ChannelId>();
    openSlots = [];
  };

  const close = (): void => {
    if (openIssueAt === undefined || openSlots.length === 0) return;
    // Разрыв уже учтён в nopCycles при открытии; в пакете храним его для печати.
    const prevEnd = packets.length === 0
      ? 0
      : packets[packets.length - 1]!.issueAt + 1;
    packets.push({
      issueAt: openIssueAt,
      nopsBefore: Math.max(0, openIssueAt - prevEnd),
      slots: openSlots,
    });
    nextIssueAt = openIssueAt + 1;
    openIssueAt = undefined;
    openChannels = new Set<ChannelId>();
    openSlots = [];
  };

  for (let i = 0; i < n; i++) {
    const ins = instructions[i]!;
    const op = (ins as { op: string }).op;

    // --- когда эта инструкция может быть выдана ---
    // Операнд готов к началу такта `readyAt[producer]`; потребитель может быть
    // выдан в этом же такте. Берём максимум по всем предшественникам: нельзя
    // выдать инструкцию раньше, чем готов ЕЁ САМЫЙ ПОЗДНИЙ операнд.
    let wanted = 0;
    for (const p of preds[i]!) {
      const pOp = (instructions[p] as { op: string }).op;
      const penalty = domainPenalty(opClassOf(pOp), opClassOf(op));
      wanted = Math.max(wanted, readyAt[p]! + penalty);
    }

    const cls = opClassOf(op);
    const candidates = channelsFor(op);
    if (candidates.length === 0) {
      throw new LatencyScheduleError(`нет исполнительного устройства для «${op}»`);
    }

    // Пакет, открытый в такте T, можно дополнять инструкциями, готовыми тоже в
    // такте T. Вернуться назад и заполнить пропуск нельзя: порядок программы
    // сохраняется, поэтому ранняя инструкция просто продолжает более поздний
    // пакет (так же поступает настоящий планировщик e2k, стр. 70).
    if (openIssueAt === undefined) {
      openAt(Math.max(wanted, nextIssueAt));
    } else if (wanted > openIssueAt || candidates.every((c) => openChannels.has(c))) {
      close();
      openAt(Math.max(wanted, nextIssueAt));
    }

    const issueAt = openIssueAt!;
    const channel = candidates.find((c) => !openChannels.has(c));
    if (channel === undefined) {
      throw new LatencyScheduleError(
        `инструкция «${op}» (#${i}) не помещается: все каналы (${candidates.join(", ")}) заняты`,
      );
    }
    openChannels.add(channel);
    const lat = latencyFor(cls, consumerOf(i));
    openSlots.push({ index: i, op, opClass: cls, latency: lat, channel });
    // Документ (стр. 71): «если операция стоит в такте N, ее результат готов к
    // использованию в такте N+1» при длительности 1. То есть готовность =
    // такт выдачи + длительность.
    readyAt[i] = issueAt + lat;
  }
  close();

  const cycles = packets.length === 0
    ? 0
    : Math.max(
        packets[packets.length - 1]!.issueAt + 1,
        // Участок считается завершённым не когда выдан последний пакет, а когда
        // готов его результат: иначе длительность последней операции не влияла
        // бы на метрику и задержки «терялись» на выходе из блока.
        ...readyAt.slice(0, n),
      );

  return {
    packets,
    readyAt,
    cycles,
    nopCycles,
    instructionCount: n,
    placedSlots: packets.reduce((acc, p) => acc + p.slots.length, 0),
    cpi: cycles > 0 ? cycles / n : 0,
    issueWidth: E2K_ISSUE_WIDTH,
  };
}

/** Штраф за передачу результата между целочисленным и вещественным доменами. */
function domainPenalty(producer: OpClass, consumer: OpClass): number {
  const pFp = producer === "fp" || producer === "fp_combined" ||
    producer === "fdiv32" || producer === "fdiv64";
  const cInt = consumer === "int" || consumer === "int_combined";
  const pInt = producer === "int" || producer === "int_combined";
  const cFp = consumer === "fp" || consumer === "fp_combined" ||
    consumer === "fdiv32" || consumer === "fdiv64";
  if (pFp && cInt) return DOMAIN_PENALTY.fp_to_int;
  if (pInt && cFp) return DOMAIN_PENALTY.int_to_fp;
  return 0;
}

/** Печать расписания в виде, близком к ассемблеру e2k (для отчётов и CLI). */
export function formatSchedule(result: LatencyScheduleResult): string {
  const lines: string[] = [];
  for (const p of result.packets) {
    if (p.nopsBefore > 0) lines.push(`  nop ${p.nopsBefore}`);
    const body = p.slots
      .map((s) => `${s.channel}:${s.op}#${s.index}(L=${s.latency})`)
      .join(", ");
    lines.push(`{ T=${p.issueAt}  ${body} }`);
  }
  lines.push(
    `-- тактов: ${result.cycles}, пустых: ${result.nopCycles}, ` +
      `инструкций: ${result.instructionCount}, тактов на инструкцию: ${result.cpi.toFixed(2)}`,
  );
  return lines.join("\n");
}

export { CHANNELS };

/**
 * Корпус планировщика с задержками: программы, различающиеся классом стоимости
 * операций. Нужен, чтобы тест мог утверждать «вещественная цепочка дороже
 * целочисленной» на воспроизводимых данных, а не на одном примере.
 */
export const LATENCY_CORPUS: ReadonlyArray<{
  name: string;
  code: RawInstruction[];
}> = [
  {
    name: "целочисленная цепочка",
    code: [
      { op: "const", type: "i32", k: 0 },
      { op: "const", type: "i32", k: 1 },
      { op: "add" },
      { op: "const", type: "i32", k: 2 },
      { op: "add" },
      { op: "const", type: "i32", k: 3 },
      { op: "add" },
      { op: "ret" },
    ] as RawInstruction[],
  },
  {
    name: "вещественная цепочка (mul)",
    code: [
      { op: "const", type: "i32", k: 0 },
      { op: "const", type: "i32", k: 1 },
      { op: "mul" },
      { op: "const", type: "i32", k: 2 },
      { op: "mul" },
      { op: "const", type: "i32", k: 3 },
      { op: "mul" },
      { op: "ret" },
    ] as RawInstruction[],
  },
  {
    name: "независимые пары",
    code: [
      { op: "const", type: "i32", k: 0 },
      { op: "const", type: "i32", k: 1 },
      { op: "add" },
      { op: "const", type: "i32", k: 2 },
      { op: "const", type: "i32", k: 3 },
      { op: "add" },
      { op: "ret" },
    ] as RawInstruction[],
  },
];
