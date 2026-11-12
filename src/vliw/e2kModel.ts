/**
 * Фасад модели e2k для планировщика: ширина пакета, типы слотов, маппинг
 * опкодов байткода Основа → слот.
 *
 * ## Что изменилось 2026-09-15
 *
 * До этого файл описывал выдуманную абстракцию: «4 слота I0/I1/M/B», где
 * `possibleSlots("div")` возвращал `["I0", "I1"]`. В руководстве МЦСТ (см.
 * `docs/elbrus-prog-1.2_2024-02-28.pdf`) таких имён нет, а ограничения другие:
 * деление и корень умеет **только АЛУ5**, чтение из памяти — не все АЛУ,
 * запись — только АЛУ2 и АЛУ5 (стр. 56).
 *
 * Правда о железе теперь в {@link ./e2kDevices}, а здесь — фасад, совместимый с
 * существующим форматом пакетов `.osvbc` v2.
 *
 * ## Почему `VLIW_SLOTS` остаётся 4
 *
 * Значение `4` записывается в модуль как `vliwSlots` и лежит в
 * `src/vliw/fixtures/*.osvbc.json`, `src/runtime/fixtures/vliw-example.osvbc.json`
 * и проверяется golden-прогоном (`src/runtime/goldenApps.ts` — «vliwSlots === 4»).
 * Менять его здесь значило бы сломать формат и эталоны ради числа, которое к
 * формату отношения не имеет. Реальная ширина e2k вынесена отдельно:
 * {@link E2K_ISSUE_WIDTH} = 24 позиции выдачи (6 АЛУ + СТ + 3 PL + 6 QP +
 * 4 APB + 4 LIT).
 *
 * `VLIW_SLOTS` — это **ширина пакета в текущем формате Основа**, а не ширина
 * широкой команды e2k. Разница зафиксирована здесь, чтобы её не пришлось
 * выяснять заново.
 */

import {
  ALL_CHANNELS,
  CHANNELS,
  E2K_ISSUE_WIDTH,
  channelsFor,
  opClassOf,
  type ChannelId,
} from "./e2kDevices";

export { E2K_ISSUE_WIDTH };

/**
 * Ширина VLIW-пакета в формате байткода Основа.
 *
 * НЕ равна ширине широкой команды e2k — см. заголовок файла.
 */
export const VLIW_SLOTS = 4;

/**
 * Тип слота в текущем формате Основа.
 *
 * Исторические имена `I0`/`I1`/`M`/`B` сохранены ради совместимости с
 * `src/vliw/scheduler.ts`, `regScheduler.ts` и тестами. Новый код должен
 * пользоваться {@link e2kDevices.ChannelId} — там настоящие 24 канала.
 */
export type SlotType = "I0" | "I1" | "M" | "B";

/**
 * Отображение реального канала e2k в слот формата Основа.
 *
 * Сделано по смыслу канала, а не по его номеру:
 * - целочисленные АЛУ без доступа к памяти → два ALU-слота I0/I1;
 * - АЛУ с записью в память (АЛУ2, АЛУ5) и операции чтения → M;
 * - устройство передачи управления СТ → B.
 *
 * Это отображение **сознательно теряет** различия между АЛУ внутри группы: формат
 * Основа их не различает. Различия видны в {@link channelsFor} и должны
 * учитываться при планировании по реальным каналам.
 */
export function channelToSlot(ch: ChannelId): SlotType {
  if (ch === CHANNELS.CT) return "B";
  const alu = (CHANNELS.ALU as readonly string[]).includes(ch) ? ch : null;
  if (alu === "alu2" || alu === "alu5") return "M";
  return "I0";
}

/**
 * Слоты текущего формата Основа, в которые может лечь операция.
 *
 * Отличие от прежней версии: набор выводится из **реальных возможностей
 * устройств** e2k, а не из одного лишь имени опкода. Следствия, которые видно
 * сразу:
 * - `div`/`rem` могут попасть только в слот, соответствующий АЛУ5 (`M`), и
 *   больше не «уезжают» в произвольный целочисленный слот;
 * - `obj.get`/`local.get` (чтение памяти) — только в слоты АЛУ с чтением
 *   (`I0` и `M`), но не в позицию без доступа к памяти;
 * - `jmp`/`ret`/`call`/`invoke` — всегда `B`.
 *
 * Возврат — отсортированный, без дублей.
 */
export function possibleSlots(op: string): SlotType[] {
  const real = channelsFor(op);
  const slots = new Set<SlotType>();
  for (const ch of real) slots.add(channelToSlot(ch));
  if (slots.size === 0) {
    // Операция не поддержана ни одним каналом — это ошибка модели, а не повод
    // молча вернуть пусто: планировщик обязан упасть, а не потерять инструкцию.
    throw new Error(
      `e2kModel: для операции «${op}» (класс ${opClassOf(op)}) не найдено ни одного исполнительного устройства`,
    );
  }
  // Стабильный порядок: ALU-слоты сначала, память, затем ветвление.
  const order: SlotType[] = ["I0", "I1", "M", "B"];
  return order.filter((s) => slots.has(s));
}

/**
 * Основной (предпочтительный) канал операции — по документу, а не по типу слота.
 *
 * Нужен для планирования по реальным каналам и для диагностики: видно, куда
 * именно ляжет операция и почему.
 */
export function primaryChannel(op: string): ChannelId {
  const real = channelsFor(op);
  const first = real[0];
  if (first === undefined) {
    throw new Error(`e2kModel: нет канала для операции «${op}»`);
  }
  return first;
}

/**
 * Классифицирует опкод байткода Основа по типу слота e2k (совместимость).
 *
 * @deprecated Имена `I0`/`I1`/`M`/`B` не существуют в архитектуре e2k — это
 * имена формата Основа. Функция сохранена для `src/vliw/index.ts` и
 * планировщиков; новый код должен использовать {@link channelsFor} /
 * {@link primaryChannel}, которые возвращают реальные каналы.
 *
 * Правила (жёстко закодированы, чтобы совпадать с {@link possibleSlots}):
 * - передача управления (`jmp*`, `call`, `invoke`, `ret`) → `B`;
 * - запись в память (`local.set`, `obj.set`) → `M` (только АЛУ2/АЛУ5);
 * - целочисленные и логические операции, чтение памяти → `I0`;
 * - загрузка константы → `I1`.
 *
 * Замечание о честности: прежняя версия возвращала `I1` для несуществующих
 * `global.get`/`global.set` и `M` для несуществующих `field.get`/`field.set`.
 * Таких опкодов в языке нет (см. `Op` в `src/runtime/vm/bytecode.ts`), поэтому
 * тесты на них проверяли выдумку. Здесь описан только реальный набор.
 */
export function classifyOpcode(op: string): SlotType {
  switch (op) {
    case "jmp":
    case "jmp_if":
    case "jmp_if_not":
    case "call":
    case "invoke":
    case "ret":
      return "B";
    case "local.set":
    case "obj.set":
      return "M";
    case "const":
    case "const.true":
    case "const.false":
    case "const.null":
      return "I1";
    default:
      return "I0";
  }
}

/** Сколько всего позиций выдачи у e2k (для отчётов и симулятора). */
export function issueWidth(): number {
  return ALL_CHANNELS.length;
}

export { channelsFor, opClassOf };
export type { ChannelId };
