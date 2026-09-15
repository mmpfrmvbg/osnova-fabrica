/**
 * Объединённый конвейер VLIW: перестановка и упаковка в одной сборке модуля.
 *
 * ## Зачем отдельный модуль
 *
 * Перестановка (`reorderEquivalence.applyReorderToWholeModule`) и упаковка
 * (`packetPacker.packInstructions`) проверены по отдельности, но **вместе не
 * запускались ни разу**. Обе меняют структуру модуля, обе пересчитывают
 * абсолютные адреса `off` и `codeOffset`, обе оперируют регистрами. Стык —
 * отдельное место для дефекта класса «абсолютный адрес против локального»,
 * поэтому у него отдельный оракул (`docs/vliw-packing.md`).
 *
 * ## Четыре конфигурации
 *
 * | id | что делает |
 * | --- | --- |
 * | `linear` | исходный код как есть (эталон) |
 * | `reorder` | перестановка независимых операций, без пакетов |
 * | `packets` | упаковка соседних инструкций, без перестановки |
 * | `reorder+packets` | перестановка, затем упаковка результата |
 *
 * ## Как конфигурации становятся сравнимыми
 *
 * Перестановка отдаёт ГЛУБОКИЕ КОПИИ инструкций, поэтому по объекту связать
 * переставленную инструкцию с исходной нельзя. Сравнивать конфигурации нужно по
 * исходным инструкциям — иначе «тот же набор исполненных инструкций» проверялся
 * бы по содержимому, а содержимое `jmp*` меняется вместе с адресом (и это
 * законно).
 *
 * Поэтому каждая конфигурация отдаёт `keys`: `keys[элемент][слот]` = индекс
 * инструкции в **исходном** линейном модуле. Оракул сравнивает именно их.
 *
 * ## Что конвейер НЕ делает
 *
 * Он не подключён к компилятору и CLI: собирает модуль для измерений и тестов.
 * Подключение к рабочему пути — отдельное решение владельца (`OSNOVA_VLIW_PACKETS`
 * по образцу `OSNOVA_VLIW_REORDER`, golden-тесты дважды).
 */

import type { RegInstruction, RegModule } from "../runtime/vm/regcode";
import { isRegPacket } from "../runtime/vm/regcode";
import { applyReorderToWholeModule } from "./reorderEquivalence";
import type { ReorderOptions } from "./reorderScheduler";
import { packInstructions, type PackDefects } from "./packetPacker";
import type { MachineModel } from "./packetVerifier";

/** Идентификатор конфигурации конвейера. */
export type VliwConfigId = "linear" | "reorder" | "packets" | "reorder+packets";

/** Человекочитаемое имя конфигурации. */
const TITLES: Record<VliwConfigId, string> = {
  linear: "линейно",
  reorder: "перестановка",
  packets: "упаковка",
  "reorder+packets": "перестановка + упаковка",
};

/** Собранный модуль одной конфигурации вместе с метриками и картой инструкций. */
export interface VliwConfig {
  id: VliwConfigId;
  title: string;
  /** Модуль конфигурации. */
  module: RegModule;
  /**
   * `keys[элемент][слот]` = индекс инструкции в **исходном** линейном модуле.
   * Благодаря этому конфигурации сравнимы между собой.
   */
  keys: number[][];
  /** Инструкций в исходном модуле. */
  instructions: number;
  /** Элементов кода в этой конфигурации. */
  elements: number;
  /** Элементов с двумя и более слотами. */
  widePackets: number;
  /** Плотность упаковки: инструкций на элемент кода. */
  density: number;
  /** Сколько процедур переставлено (0 для конфигураций без перестановки). */
  proceduresReordered: number;
  /** Изменился ли порядок выдачи хотя бы в одной процедуре. */
  orderChanged: boolean;
  /** Адреса, которые не удалось пересчитать (должно быть пусто). */
  unmappedAddresses: number[];
  /** Внутренние нарушения инвариантов конвейера (должно быть пусто). */
  problems: string[];
}

/** Требует линейный модуль: конвейер работает по коду «одна инструкция — один элемент». */
function requireLinear(module: RegModule): RegInstruction[] {
  const instructions: RegInstruction[] = [];
  for (const el of module.code) {
    if (isRegPacket(el)) {
      throw new Error(
        "vliw(конвейер): ожидается линейный модуль без пакетов; " +
          "распакуйте или возьмите исходный код компилятора",
      );
    }
    instructions.push(el as RegInstruction);
  }
  return instructions;
}

function metric(
  id: VliwConfigId,
  module: RegModule,
  keys: number[][],
  instructions: number,
  extra: Partial<VliwConfig> = {},
): VliwConfig {
  const elements = module.code.length;
  return {
    id,
    title: TITLES[id],
    module,
    keys,
    instructions,
    elements,
    widePackets: module.code.filter(isRegPacket).length,
    density: elements > 0 ? instructions / elements : 0,
    proceduresReordered: 0,
    orderChanged: false,
    unmappedAddresses: [],
    problems: [],
    ...extra,
  };
}

/**
 * Инъекция дефектов КОНВЕЙЕРА — только для негативного контроля стыка.
 *
 * Дефекты упаковщика (`PackDefects`) проверяют, что gate краснеет на снятом
 * правиле внутри упаковки. Здесь проверяется другое: что gate замечает ошибку
 * **сборки конвейера** — то, чего не было ни в одной из проверенных по отдельности
 * частей.
 */
export interface PipelineDefects {
  /**
   * Собрать `reorder+packets` из ИСХОДНОГО модуля вместо переставленного.
   *
   * Дефект правдоподобный: обе операции пересчитывают адреса, и «взять не тот
   * модуль» — ровно та ошибка, которая даёт эквивалентный, но не тот результат.
   * На 16 из 19 программ корпуса порядок перестановки отличается от линейного,
   * поэтому подмену видно.
   */
  packOriginalAfterReorder?: boolean;
}

/**
 * Собрать все четыре конфигурации конвейера для линейного модуля.
 *
 * @param module линейный регистровый модуль (исходный объект не меняется)
 * @param model модель машины для упаковки и проверки слотов
 * @param options опции перестановки (уровень памяти, кластеры, чистота вызовов)
 * @param defects инъекция дефектов упаковщика — ТОЛЬКО для негативного контроля;
 *   дефект попадает в обе упакованные конфигурации, чтобы gate ловил его и в
 *   одиночной упаковке, и в объединённой
 * @param pipelineDefects инъекция дефектов сборки конвейера — тоже только для
 *   негативного контроля
 */
export function buildVliwConfigs(
  module: RegModule,
  model: MachineModel,
  options: ReorderOptions = {},
  defects?: PackDefects,
  pipelineDefects?: PipelineDefects,
): Record<VliwConfigId, VliwConfig> {
  const instructions = requireLinear(module);
  const n = instructions.length;

  // 1. Эталон: линейный код. Ключ — собственный индекс инструкции.
  const linearKeys = instructions.map((_, i) => [i]);
  const linear = metric("linear", { ...module, code: [...module.code] }, linearKeys, n);

  // 2. Перестановка: тот же набор инструкций, порядок другой.
  const reordered = applyReorderToWholeModule(module, options);
  const originalIndex = reordered.originalIndex;
  const reorderProblems: string[] = [];
  if (originalIndex.length !== reordered.scheduled.code.length) {
    reorderProblems.push(
      `карта индексов короче кода: ${originalIndex.length} против ${reordered.scheduled.code.length}`,
    );
  }
  const reorderKeys = reordered.scheduled.code.map((_, i) => {
    const origin = originalIndex[i];
    return [origin === undefined || origin < 0 ? -1 : origin];
  });
  const sortedReorder = reorderKeys.flat().slice().sort((a, b) => a - b);
  if (sortedReorder.length !== n || sortedReorder.some((v, i) => v !== i)) {
    reorderProblems.push(`перестановка не является перестановкой индексов 0..${n - 1}`);
  }
  const reorder = metric("reorder", reordered.scheduled, reorderKeys, n, {
    proceduresReordered: reordered.proceduresScheduled,
    orderChanged: reordered.orderChanged,
    problems: reorderProblems,
  });

  // 3. Упаковка исходного кода.
  const packedOnly = packInstructions(module, model, defects);
  const packetsKeys = packedOnly.keys.map((slots) => [...slots]);
  const sortedPacked = packetsKeys.flat();
  const packetsProblems: string[] = [];
  if (sortedPacked.length !== n || sortedPacked.some((v, i) => v !== i)) {
    packetsProblems.push("упаковка изменила порядок или набор инструкций");
  }
  const packets = metric("packets", packedOnly.module, packetsKeys, n, {
    unmappedAddresses: packedOnly.unmappedAddresses,
    problems: packetsProblems,
  });

  // 4. Объединение: перестановка, затем упаковка переставленного модуля.
  const mixedUp = pipelineDefects?.packOriginalAfterReorder === true;
  const combinedSource = mixedUp ? module : reordered.scheduled;
  const packedAfterReorder = packInstructions(combinedSource, model, defects);
  const combinedKeys = packedAfterReorder.keys.map((slots) =>
    mixedUp
      ? [...slots]
      : slots.map((index) => {
          const origin = originalIndex[index];
          return origin === undefined || origin < 0 ? -1 : origin;
        }),
  );
  const combinedProblems: string[] = [];
  if (mixedUp) {
    combinedProblems.push("внесён дефект сборки: упакован исходный модуль вместо переставленного");
  }
  const flatCombined = combinedKeys.flat();
  const flatReorder = reorderKeys.flat();
  if (flatCombined.length !== flatReorder.length) {
    combinedProblems.push(
      `объединение потеряло инструкции: ${flatCombined.length} против ${flatReorder.length}`,
    );
  } else if (flatCombined.some((v, i) => v !== flatReorder[i])) {
    // Упаковка обязана только группировать соседние инструкции. Если порядок
    // разошёлся, значит упаковка переставила код — этого она делать не должна.
    combinedProblems.push("упаковка изменила порядок, заданный перестановкой");
  }
  const combined = metric(
    "reorder+packets",
    packedAfterReorder.module,
    combinedKeys,
    n,
    {
      proceduresReordered: reordered.proceduresScheduled,
      orderChanged: reordered.orderChanged,
      unmappedAddresses: packedAfterReorder.unmappedAddresses,
      problems: combinedProblems,
    },
  );
  if (combined.density + 1e-9 < packets.density) {
    combined.problems.push(
      `плотность после объединения ниже, чем от одной упаковки: ` +
        `${combined.density.toFixed(4)} против ${packets.density.toFixed(4)}`,
    );
  }

  return { linear, reorder, packets, "reorder+packets": combined };
}
