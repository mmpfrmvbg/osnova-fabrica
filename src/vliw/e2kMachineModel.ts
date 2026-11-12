/**
 * Адаптер «модель e2k → `MachineModel` верификатора пакетов».
 *
 * ## Что здесь есть и чего здесь нет
 *
 * `e2kDevices.ts` знает **каналы** e2k и их возможности, но верификатору нужны
 * **номера слотов**: пакет в регистровом формате — это массив `slots` без
 * номеров, и проверка сводится к вопросу «существует ли раскладка инструкций по
 * слотам». Поэтому каналу нужно взаимно однозначное число.
 *
 * Нумерация — **наше внутреннее согласие, а не разметка аппарата**: номер слота
 * равен позиции канала в каноническом списке `ALL_CHANNELS`. Из документа МЦСТ
 * известно только ЧИСЛО каналов каждого типа (6 АЛУ + 1 ЦУ + 3 ПЛ + 6 КП + 4 АПБ
 * + 4 ЛИТ = 24, стр. 54–56) и то, какие операции в каких каналах допустимы
 * (стр. 56, 57). Порядок каналов внутри типа в документе не задан.
 *
 * Существенно здесь ровно одно свойство: **разные каналы получают разные
 * номера**. Тогда «две операции в один канал» становится «две операции в один
 * слот» и отвергается верификатором.
 */

import {
  ALL_CHANNELS,
  E2K_ISSUE_WIDTH,
  channelsForClass,
  type ChannelId,
} from "./e2kDevices";
import { regOpClass } from "./reorderScheduler";
import type { RegInstruction } from "../runtime/vm/regcode";
import type { MachineModel } from "./packetVerifier";

/**
 * Номер слота для канала: позиция в `ALL_CHANNELS`.
 *
 * ИСТОЧНИК состава каналов: руководство МЦСТ, стр. 54–56 (6 АЛУ + ЦУ + 3 ПЛ +
 * 6 КП + 4 АПБ + 4 ЛИТ). Нумерация слотов — наше решение (см. шапку файла).
 */
export const E2K_SLOT_OF: Readonly<Record<ChannelId, number>> = Object.freeze(
  ALL_CHANNELS.reduce<Record<string, number>>((acc, ch, index) => {
    acc[ch] = index;
    return acc;
  }, {}) as Record<ChannelId, number>,
);

/** Номер слота для канала. */
export function e2kSlotOf(channel: ChannelId): number {
  return E2K_SLOT_OF[channel];
}

/**
 * Слоты, в которые может лечь операция регистрового кода.
 *
 * Пустой массив означает «ни один канал e2k эту операцию не исполняет».
 */
export function e2kPossibleSlots(op: string): number[] {
  const ins = { op } as RegInstruction;
  return channelsForClass(regOpClass(ins)).map(e2kSlotOf);
}

/**
 * Модель машины e2k для `verifyPackets` и `packInstructions`.
 *
 * Создаётся функцией, а не константой: вызывающий не может случайно изменить
 * общую модель.
 */
export function e2kMachineModel(): MachineModel {
  return { slots: E2K_ISSUE_WIDTH, possibleSlots: e2kPossibleSlots };
}
