/**
 * ПЛАНИРОВЩИК КОМАНД e2k (`AsmInstruction`) — ОБЪЯВЛЕННЫЙ КОНТРАКТ.
 *
 * # Зачем отдельный модуль
 *
 * `src/vliw/reorderScheduler.ts` работает на `RegInstruction` — носителях IR, а не на командах
 * e2k: это его тип входа (`:37`), и из `../e2k` он не импортирует ничего. Поэтому перестановка
 * **не может** быть вызвана в `src/e2k/e2kRealRun.ts` — тип не совпадает, и это факт, а не пробел
 * в вызове (`docs/e2k-reorder-effect.md` §1).
 *
 * # Статус: ЛАТЕНТНОСТИ, КАНАЛЫ И ПАКЕТЫ РЕАЛИЗОВАНЫ (шаги 2.2–2.3)
 *
 * Кластеры АЛУ — сознательный no-op, причина и точка вставки названы ({@link CLUSTERS_ARE_NOOP}).
 *
 * Файл объявляет контракт и **отказывает названно**. Так оракул
 * (`src/e2k/asmScheduler.test.ts`) собирается и краснеет **по проверкам**, а не по «модуль не
 * найден»: у проекта это разные вещи — «Cannot find module» доказывает отсутствие модуля, а не
 * чувствительность оракула (`docs/verification-debt.md:158-163`).
 *
 * # Что уже есть в проекте для этой работы (не выдумано)
 *
 * | что нужно | где лежит |
 * |---|---|
 * | что команда читает и пишет (по слотам формы) | `src/e2k/widePacker.ts` — `registersOf` |
 * | можно ли команду положить в широкую команду и почему нет | `src/e2k/widePacker.ts` — `packetableRefusal` |
 * | допустимые каналы команды | `src/e2k/e2k-real.ts` — `realOpcode(mnemonic).channels` |
 * | длительность по классу операции | `src/vliw/e2kDevices.ts` — `latencyFor` / `opClassOf` |
 * | задержки носителей IR (для сверки) | `src/e2k/latencyMap.ts` — `ticksOfCarrier` |
 */

import type { AsmInstruction } from './backend';
import { realOpcode } from './e2k-real';
import { latencyFor, type OpClass } from '../vliw/e2kDevices';
import { buildAsmDependencyGraph, type AsmGraphOptions } from './asmGraph';
import { registersOf } from './widePacker';

/**
 * КЛАССЫ ОПЕРАЦИЙ: откуда берутся и почему не из `opClassOf`.
 *
 * `opClassOf` (`src/vliw/e2kDevices.ts`) разбирает **опкоды Основа** (`add`, `rem`, `move`), а не
 * мнемоники e2k: `opClassOf("rem")` даёт `fdiv32`. Здесь на входе мнемоники e2k (`adds`, `muls`),
 * поэтому класс берётся по ним, а длительность — из той же модели (`latencyFor`).
 *
 * Источник соответствия — руководство МЦСТ, стр. 71: «**Fp** вещественные операции сложения и
 * умножения `fadd`, `fmul`, **а также целочисленные операции `mul`**» (`e2kDevices.ts:295-296`).
 * Поэтому `muls` — класс `fp` (4 такта), а не `int`.
 */
export function classOfMnemonic(mnemonic: string): OpClass {
  switch (mnemonic) {
    case 'muls':
    case 'muld':
      return 'fp';
    case 'cmplsb':
    case 'cmplesb':
    case 'cmpesb':
      return 'cmp_to_logic';
    case 'movts':
    case 'adds':
    case 'subs':
    case 'ands':
    case 'ors':
      return 'int';
    default:
      // Неизвестная мнемоника — минимальная длительность модели, и это названо, а не угадано.
      return 'int';
  }
}

/**
 * КЛАСТЕРЫ АЛУ — ЯВНЫЙ NO-OP.
 *
 * В расписании **не учитываются**, и это не забывчивость: предпочтение кластера измерено как
 * no-op — «пересечений стало 24 → 25, такты не изменились (1130 → 1130)»
 * (`src/vliw/e2kDevices.ts:104-107`), причина названа там же (узлы выдаются почти в порядке
 * программы). Штраф за переход между кластерами в модели равен нулю
 * (`docs/hardware-debt.md` §3.2; `reorderScheduler.ts:303-312` возвращает 0).
 *
 * **Точка вставки, если появится величина:** здесь, при выборе канала — сравнивать кластер
 * производителя (`clusterOf(channel)`) с кластером потребителя и прибавлять штраф к `readyAt`.
 */
export const CLUSTERS_ARE_NOOP =
  'кластеры АЛУ не влияют на расписание: предпочтение измерено как no-op (24 → 25 пересечений, ' +
  '1130 → 1130 тактов, src/vliw/e2kDevices.ts:104-107), штраф в модели равен нулю ' +
  '(docs/hardware-debt.md §3.2). Точка вставки штрафа — выбор канала в scheduleAsm.';

/** Контракт планировщика: команды e2k на входе, расписание на выходе. */
export function scheduleAsm(
  commands: readonly AsmInstruction[],
  options: AsmGraphOptions & { readonly memoryLevel?: 'l1' | 'l2' | 'l3' | 'mem' } = {},
): AsmScheduleResult {
  if (commands.length === 0) {
    return { order: [], packets: [], issueAt: [], readyAt: [], channels: [], metrics: { cycles: 0, nopCycles: 0, packets: 0, ilp: 0 } };
  }
  const graph = buildAsmDependencyGraph(commands, options);
  const reads = commands.map((command) => new Set(registersOf(command).reads));
  const writes = commands.map((command) => new Set(registersOf(command).writes));
  /**
   * РАЗВЕДЕНИЕ РЁБЕР — исправление шага 2.4.
   *
   * Здесь стояло одно предусловие на все четыре вида рёбер, и на реальном ядре это давало **цикл**:
   * A читает `r1` и пишет `r2`, B читает `r2` и пишет `r1` — `A → B` по RAW и `B → A` по WAR,
   * обе команды ждут друг друга, 211 команд из 920 остались без `issueAt`.
   *
   * | вид | куда идёт | почему |
   * |---|---|---|
   * | RAW | порядок выдачи | результат производителя нужен потребителю |
   * | эффект | порядок выдачи | наблюдаемый порядок нельзя менять |
   * | WAR | запрет совместной упаковки | читатель обязан прочитать **до** записи, но переставлять их можно |
   * | WAW | запрет совместной упаковки | две записи одного регистра в одном такте — неопределённый порядок |
   */
  const orderEdges: [number, number][] = [];
  const packingPairs = new Set<string>();
  for (const [from, to] of graph.edges) {
    const raw = [...writes[from]!].some((key) => reads[to]!.has(key));
    const war = [...reads[from]!].some((key) => writes[to]!.has(key));
    const waw = [...writes[from]!].some((key) => writes[to]!.has(key));
    if (raw) orderEdges.push([from, to]);
    else if (war || waw) packingPairs.add(`${from}|${to}`);
    else orderEdges.push([from, to]); // цепочка эффектов: порядок наблюдаем
  }
  const predecessors: number[][] = commands.map(() => []);
  for (const [from, to] of orderEdges) predecessors[to]!.push(from);
  /** Нельзя ли поставить эти две команды в один такт (WAR/WAW). */
  const conflicts = (a: number, b: number): boolean =>
    packingPairs.has(`${a}|${b}`) || packingPairs.has(`${b}|${a}`);

  const latency = commands.map((command) => latencyFor(classOfMnemonic(command.mnemonic)));
  const issueAt = new Array<number>(commands.length).fill(-1);
  const readyAt = new Array<number>(commands.length).fill(-1);
  const channelOf = new Array<number>(commands.length).fill(-1);
  /** Какие каналы заняты в каждом такте (по индексу такта). */
  const busy = new Map<number, Set<number>>();
  /** Кто уже поставлен в такт — для проверки запретов упаковки. */
  const tickOf = new Map<number, number[]>();
  const order: number[] = [];
  let tick = 0;

  for (let placed = 0; placed < commands.length; placed++) {
    // Кандидат — команда, все предшественники которой уже размещены.
    const candidates = commands.map((_, index) => index).filter((index) => issueAt[index] === -1);
    if (candidates.length === 0) break;
    let progressed = false;
    for (const index of candidates) {
      const ready = predecessors[index]!.reduce(
        (at, producer) => (readyAt[producer]! === -1 ? Number.POSITIVE_INFINITY : Math.max(at, readyAt[producer]!)),
        0,
      );
      if (ready === Number.POSITIVE_INFINITY) continue;
      // Канал: первый допустимый, свободный в такте `ready`; иначе команда ждёт следующий такт.
      const allowed = realOpcode(commands[index]!.mnemonic)?.channels ?? [];
      // Управляющая команда (`disp`, `ct`, `call`, `return`, `setbn`, `sdisp`) несёт слог CS/SS, а
      // не ALS: её нет в таблице ALS-опкодов, и списка каналов у неё нет вовсе. Такая команда
      // занимает **отдельный такт** — в широкую команду вместе с ALS-операциями она не встаёт.
      // Замер вскрыл это отказом на `disp` (#15) после того, как были исправлены два предыдущих
      // дефекта: предел поиска такта и индексация карты тактов индексом команды.
      if (allowed.length === 0) {
        const controlAt = Math.max(ready, tick);
        issueAt[index] = controlAt;
        readyAt[index] = controlAt + latency[index]!;
        channelOf[index] = -1; // ALS-канал не занят: слог управляющий
        tickOf.set(controlAt, [...(tickOf.get(controlAt) ?? []), index]);
        order.push(index);
        tick = controlAt + 1;
        progressed = true;
        continue;
      }
      let at = Math.max(ready, tick);
      let channel: number | undefined;
      // Поиск такта не ограничен: каналы освобождаются каждый такт, свободный найдётся.
      // Здесь стоял предел в восемь попыток, а карта тактов индексировалась **индексом команды**
      // вместо такта (`tickOf[index]` вместо `tickOf.get(at)`) — два дефекта, из-за которых на
      // реальном ядре не размещались 94 команды из 920.
      for (let attempt = 0; channel === undefined; attempt++) {
        if (attempt > 4096) {
          throw new Error(`канал не найден за 4096 тактов для команды #${index} (${commands[index]!.mnemonic})`);
        }
        const inTick = tickOf.get(at) ?? [];
        if (inTick.some((other) => conflicts(other, index))) {
          at++;
          continue;
        }
        const occupied = busy.get(at) ?? new Set<number>();
        channel = allowed.find((candidate) => !occupied.has(candidate));
        if (channel === undefined) at++;
      }
      if (channel === undefined) continue; // Нет канала и через восемь тактов — ждём следующего круга.
      issueAt[index] = at;
      readyAt[index] = at + latency[index]!;
      channelOf[index] = channel;
      if (!busy.has(at)) busy.set(at, new Set<number>());
      busy.get(at)!.add(channel);
      tickOf.set(at, [...(tickOf.get(at) ?? []), index]);
      order.push(index);
      tick = Math.max(tick, at);
      progressed = true;
    }
    if (!progressed) break; // Цикл по зависимостям — расписание не строится, отказ назван ниже.
  }

  const missing = commands.map((_, index) => index).filter((index) => issueAt[index] === -1);
  if (missing.length > 0) {
    throw new Error(
      `расписание не построено: ${missing.length} команд не размещено (цикл по зависимостям?) — ${missing.slice(0, 5).join(', ')}`,
    );
  }

  // Пакеты: команды одного такта (канал у каждой свой, это уже обеспечено выше).
  const byTick = new Map<number, number[]>();
  issueAt.forEach((at, index) => byTick.set(at, [...(byTick.get(at) ?? []), index]));
  const ticks = [...byTick.keys()].sort((a, b) => a - b);
  const packets = ticks.map((at) => byTick.get(at)!);
  const cycles = ticks.length === 0 ? 0 : ticks[ticks.length - 1]! + 1;
  const nopCycles = cycles - ticks.length;

  return {
    order,
    packets,
    issueAt,
    readyAt,
    channels: channelOf,
    metrics: {
      cycles,
      nopCycles,
      packets: packets.length,
      ilp: cycles === 0 ? 0 : commands.length / cycles,
    },
  };
}

/** Результат планирования — та же форма, что у планировщика `RegInstruction`. */
export interface AsmScheduleResult {
  /** Порядок выдачи: индексы команд в порядке исполнения. */
  readonly order: readonly number[];
  /** Пакеты: слоги одной широкой команды. */
  readonly packets: readonly (readonly number[])[];
  /** Такт выдачи каждой команды (по исходному индексу). */
  readonly issueAt: readonly number[];
  /** Такт готовности результата каждой команды (по исходному индексу). */
  readonly readyAt: readonly number[];
  /** Канал, назначенный каждой команде (по исходному индексу). */
  readonly channels: readonly number[];
  readonly metrics: {
    readonly cycles: number;
    readonly nopCycles: number;
    readonly packets: number;
    readonly ilp: number;
  };
}

/** Контракт планировщика для команд e2k — реализация выше. */
