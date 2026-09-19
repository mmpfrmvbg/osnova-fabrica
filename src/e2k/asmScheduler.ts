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
 * # Статус: НЕ РЕАЛИЗОВАНО
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
  readonly metrics: {
    readonly cycles: number;
    readonly nopCycles: number;
    readonly packets: number;
    readonly ilp: number;
  };
}

/** Контракт планировщика: команды e2k на входе, расписание на выходе. */
export function scheduleAsm(
  commands: readonly AsmInstruction[],
  _options: { readonly memoryLevel?: 'l1' | 'l2' | 'l3' | 'mem' } = {},
): AsmScheduleResult {
  void commands;
  throw new Error(
    'планировщик команд e2k не реализован: контракт объявлен, расписание не строится. ' +
      'Планировщик для RegInstruction (src/vliw/reorderScheduler.ts) здесь неприменим — другой тип входа',
  );
}
