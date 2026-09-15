/**
 * Счётчики производительности конвейера e2k.
 *
 * ## Откуда взяты имена
 *
 * Руководство МЦСТ, гл. 5.2 (стр. 63–64) перечисляет аппаратные мониторные
 * счётчики, которые профилировщик `dprof` читает на настоящем процессоре:
 *
 * ```
 * TICKS       – все такты
 * EXEC        – исполненные команды
 * BUB_B       – блокировки конвейера на стадии B
 * BUB_E2      – блокировки конвейера на стадии E2
 * IB_NO_COMMAND – блокировки конвейера на стадии подкачки кода
 * L2_QUERY    – запросы в L2$
 * L2_HIT      – попадания в L2$
 * ```
 *
 * Смысл BUB_E2 уточняется на стр. 127 (дословно): «блокировки по темпу работы
 * памяти (BUB_E2): рекомендуется проверить темп обработки данных - сколько тактов
 * работает цикл, сколько в нем операций чтения и записи, каков размер этих
 * операций, какова локальность данных, какие данные могут быть найдены в кэше».
 * А на стр. 200 сказано, что передача данных через регистровый файл
 * «контролируется аппаратно, посредством scoreboarding’а. При попытке считывания
 * неготовых данных вырабатывается блокировка конвейера».
 *
 * ## Что моделируется, а что нет
 *
 * Счётчики считаются **симулятором** нашего расписания, а не измеряются на
 * железе. Это важно понимать: числа сопоставимы между нашими вариантами
 * планирования, но не обязаны совпадать с `dprof` на настоящем Эльбрусе.
 *
 * | Счётчик | Моделируется | Почему |
 * |---|---|---|
 * | `TICKS` | да | такт завершения участка по нашему расписанию |
 * | `EXEC` | да | число выданных инструкций |
 * | `BUB_E2` | да | такты, в которые не выдано ни одной инструкции |
 * | `BUB_B` | **нет** | стадия B — предвыборка/декодирование; наш планировщик её не моделирует |
 * | `IB_NO_COMMAND` | **нет** | подкачка кода; на линейном участке без переходов её нет |
 * | `L2_QUERY`/`L2_HIT` | **нет** | уровни кэша в байткоде Основа не выражены; см. `MemoryLevel` |
 *
 * `L2_QUERY`/`L2_HIT` можно включить, задав уровень памяти (`MemoryLevel`):
 * тогда чтения получают длительность L1/L2/L3/памяти из таблицы стр. 71.
 */

import { DOMAIN_PENALTY, E2K_ISSUE_WIDTH, type OpClass } from "./e2kDevices";
import type { ReorderResult, ReorderedPacket } from "./reorderScheduler";

/**
 * Уровень памяти для операций чтения.
 *
 * По умолчанию `l1`: руководство (стр. 71) говорит, что «планировщик всегда
 * будет планировать чтение из L1, если только от программиста не было подсказки
 * не обращаться по чтению в L1». Точной модели кэша у нас нет — это выбор уровня
 * пользователем счётчиков, а не измерение.
 */
export type MemoryLevel = "l1" | "l2" | "l3" | "mem";

/** Длительность чтения по уровню памяти (стр. 71). */
export const MEMORY_LATENCY: Readonly<Record<MemoryLevel, number>> = {
  l1: 3,
  l2: 11,
  l3: 40,
  mem: 100,
};

/**
 * Счётчики конвейера для одного участка/прогона.
 *
 * Имена намеренно совпадают с `dprof`, чтобы отчёт читался теми же словами,
 * что и на настоящем железе. Счётчики, которые мы не моделируем, помечены как
 * `null` — это честнее нуля: ноль означал бы «измерено и равно нулю».
 */
export interface PipelineCounters {
  /** Все такты. */
  TICKS: number;
  /** Исполненные команды. */
  EXEC: number;
  /** Такты, в которые не выдано ни одной инструкции. */
  BUB_E2: number;
  /** Стадия B — НЕ моделируется. */
  BUB_B: null;
  /** Подкачка кода — НЕ моделируется. */
  IB_NO_COMMAND: null;
  /** Запросы в L2$ — НЕ моделируются (см. `MemoryLevel`). */
  L2_QUERY: null;
  /** Попадания в L2$ — НЕ моделируются. */
  L2_HIT: null;
  /** Тактов на инструкцию: `TICKS / EXEC`. */
  CPI: number;
  /** Доля полезных тактов: `EXEC / TICKS`. */
  IPC: number;
}

/**
 * Насколько «широко» заполнены пакеты в среднем (инструкций на пакет).
 *
 * Это не счётчик железа, а метрика расписания — она полезна рядом со счётчиками,
 * но не должна с ними смешиваться.
 */
export function packetsFill(result: ReorderResult): number {
  const placed = result.packets.reduce((acc, p) => acc + p.slots.length, 0);
  return result.packets.length > 0 ? placed / result.packets.length : 0;
}

/**
 * Посчитать счётчики по расписанию.
 *
 * Модель простая и явная: пакет выдаётся в свой такт; всё время от начала до
 * завершения последнего результата — это `TICKS`; такты, в которые не выдано
 * ни одной инструкции, — `BUB_E2`.
 *
 * @param result расписание (из {@link ./reorderScheduler.scheduleRegWithReorder})
 * @param memoryLevel уровень памяти для чтений (по умолчанию L1)
 */
export function countPipeline(
  result: ReorderResult,
  memoryLevel: MemoryLevel = "l1",
): PipelineCounters {
  const packets = result.packets;
  if (packets.length === 0) {
    return {
      TICKS: 0,
      EXEC: 0,
      BUB_E2: 0,
      BUB_B: null,
      IB_NO_COMMAND: null,
      L2_QUERY: null,
      L2_HIT: null,
      CPI: 0,
      IPC: 0,
    };
  }

  const EXEC = packets.reduce((acc, p) => acc + p.slots.length, 0);

  // Такты, в которые что-то выдано.
  const issuedAt = new Set(packets.map((p) => p.issueAt));

  // Конец участка считаем «прохождением конвейера»: пакеты выдаются в свои
  // такты, а каждая операция завершается через свою длительность после выдачи.
  // Берём максимум — участок закончен, когда готов последний результат.
  //
  // ВАЖНО: длительности берутся с учётом `memoryLevel`, а не из расписания.
  // Планировщик по умолчанию планирует чтение из L1 (стр. 71), поэтому
  // расписание содержит L1-длительности; если пользователь просит уровень
  // памяти хуже, это уже другой сценарий — его и считаем.
  let TICKS = 0;
  for (const p of packets) {
    for (const s of p.slots) {
      const finish = p.issueAt + adjustedLatency(s.opClass, memoryLevel);
      if (finish > TICKS) TICKS = finish;
    }
  }

  // BUB_E2 — такты без выдачи. Учитываем только до последнего выданного пакета:
  // «хвост» после него — это полезная работа последних операций, не блокировка.
  const lastIssue = packets[packets.length - 1]!.issueAt;
  let BUB_E2 = 0;
  for (let t = 0; t < lastIssue; t++) {
    if (!issuedAt.has(t)) BUB_E2++;
  }

  return {
    TICKS,
    EXEC,
    BUB_E2,
    BUB_B: null,
    IB_NO_COMMAND: null,
    L2_QUERY: null,
    L2_HIT: null,
    CPI: EXEC > 0 ? TICKS / EXEC : 0,
    IPC: TICKS > 0 ? EXEC / TICKS : 0,
  };
}

/** Длительность операции с учётом уровня памяти для чтений. */
export function adjustedLatency(cls: OpClass, memoryLevel: MemoryLevel = "l1"): number {
  switch (cls) {
    case "ld_l1":
      return MEMORY_LATENCY[memoryLevel];
    case "ld_l2":
      return MEMORY_LATENCY.l2;
    case "ld_l3":
      return MEMORY_LATENCY.l3;
    case "ld_mem":
      return MEMORY_LATENCY.mem;
    default:
      return baseLatency(cls);
  }
}

/** Базовая длительность класса операции без поправки на уровень памяти. */
function baseLatency(cls: OpClass): number {
  switch (cls) {
    case "int":
    case "store":
    case "cmp_to_logic":
      return 1;
    case "int_combined":
    case "qual":
      return 2;
    case "fp":
      return 4;
    case "fp_combined":
      return 8;
    case "fdiv32":
      return 11;
    case "fdiv64":
      return 14;
    case "logic_to_logic":
      return 0.5;
    case "to_ct":
      return 3;
    case "disp_to_ct":
      return 5;
    case "return_to_ct":
      return 6;
    case "movtd_to_ct":
      return 9;
    default:
      return 1;
  }
}

/**
 * Текстовый отчёт по счётчикам — в формате, читаемом рядом с выводом `dprof`.
 */
export function formatCounters(c: PipelineCounters, title = ""): string {
  const head = title ? `--- ${title} ---\n` : "";
  const nulls = (v: null | number): string => (v === null ? "не моделируется" : String(v));
  return (
    head +
    `TICKS         ${c.TICKS}\n` +
    `EXEC          ${c.EXEC}\n` +
    `BUB_E2        ${c.BUB_E2}\n` +
    `BUB_B         ${nulls(c.BUB_B)}\n` +
    `IB_NO_COMMAND ${nulls(c.IB_NO_COMMAND)}\n` +
    `L2_QUERY      ${nulls(c.L2_QUERY)}\n` +
    `L2_HIT        ${nulls(c.L2_HIT)}\n` +
    `CPI           ${c.CPI.toFixed(3)}\n` +
    `IPC           ${c.IPC.toFixed(3)}`
  );
}

/**
 * Ширина выдачи e2k — вынесена сюда, чтобы отчёт по счётчикам был самодостаточным.
 */
export const ISSUE_WIDTH = E2K_ISSUE_WIDTH;

/** Штраф домена — реэкспорт, чтобы счётчики не требовали второго импорта. */
export const DOMAIN_PENALTY_REEXPORT = DOMAIN_PENALTY;

export type { ReorderedPacket };
