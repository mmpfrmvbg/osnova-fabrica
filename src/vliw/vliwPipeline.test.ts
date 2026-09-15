/**
 * ОРАКУЛ ОБЪЕДИНЁННОГО КОНВЕЙЕРА: перестановка и упаковка вместе.
 *
 * ## Зачем
 *
 * Перестановка и упаковка проверены по отдельности, но **вместе не запускались ни
 * разу**. Обе меняют структуру модуля, обе пересчитывают абсолютные адреса, обе
 * оперируют регистрами — то есть дефект класса «абсолютный адрес против
 * локального» мог проявиться именно на стыке. Эти тесты закрывают стык
 * структурно; эквивалентность прогонов проверяет gate (`npm run gate:pack`).
 *
 * ## Что здесь доказывается структурно
 *
 * 1. Конфигураций четыре: `linear`, `reorder`, `packets`, `reorder+packets`.
 * 2. `keys` каждой конфигурации ссылаются на **исходные** индексы инструкций —
 *    поэтому конфигурации сравнимы между собой (переставленные инструкции —
 *    глубокие копии, по объекту их с исходными не связать).
 * 3. `reorder` — перестановка: тот же НАБОР исходных индексов, порядок другой.
 * 4. `packets` порядок не меняет: последовательность исходных индексов
 *    тождественна линейной.
 * 5. `reorder+packets` сохраняет порядок `reorder` — упаковка не переставляет.
 *    Это и есть утверждение «упаковка не ломает работу перестановки».
 * 6. Исходный модуль не меняется: обе операции работают на копиях.
 */

import * as fs from "fs";
import * as path from "path";
import { describe, it, expect } from "vitest";
import { buildVliwConfigs, type VliwConfigId } from "./vliwPipeline";
import { e2kMachineModel } from "./e2kMachineModel";
import { regModuleOf } from "./regOracle";
import { isRegPacket, type RegInstruction, type RegModule } from "../runtime/vm/regcode";

const MODEL = e2kMachineModel();
const FIXTURES = path.join(__dirname, "..", "runtime", "fixtures");

const K = (d: number, k = 0): RegInstruction => ({ op: "const", d, type: "i32", k }) as RegInstruction;
const ADD = (d: number, a: number, b: number): RegInstruction => ({ op: "add", d, a, b }) as RegInstruction;
const MOVE = (d: number, a: number): RegInstruction => ({ op: "move", d, a }) as RegInstruction;
const RET = (v?: number): RegInstruction =>
  (v === undefined ? { op: "ret" } : { op: "ret", v }) as RegInstruction;

function module(code: RegInstruction[], offsets: number[] = [0]): RegModule {
  return {
    ir: "osnova-reg",
    version: 1,
    moduleName: "тест",
    constants: [1, 2, 3],
    procedures: offsets.map((codeOffset, i) => ({
      name: i === 0 ? "главная" : `п${i}`,
      codeOffset,
      argc: 0,
      vregs: 16,
      localToVreg: {},
    })),
    code,
  };
}

/** Развернуть keys в последовательность исходных индексов по слотам. */
function flattenKeys(keys: readonly number[][]): number[] {
  return keys.flat();
}

function fixture(rel: string): RegModule {
  const built = regModuleOf(fs.readFileSync(path.join(FIXTURES, rel), "utf-8"));
  if (!built) throw new Error(`фикстура не компилируется: ${rel}`);
  return built.module;
}

const CONFIGS: VliwConfigId[] = ["linear", "reorder", "packets", "reorder+packets"];

const SAMPLE: RegInstruction[] = [
  K(1, 11),
  K(2, 22),
  ADD(3, 1, 2),
  MOVE(4, 3),
  K(5, 33),
  ADD(6, 4, 5),
  RET(6),
];

describe("конвейер: четыре конфигурации", () => {
  it("строятся все четыре конфигурации с ожидаемыми идентификаторами", () => {
    const configs = buildVliwConfigs(module(SAMPLE), MODEL);
    expect(Object.keys(configs).sort()).toEqual([...CONFIGS].sort());
    for (const id of CONFIGS) expect(configs[id].id).toBe(id);
  });

  it("ни одна конфигурация не сообщает о проблемах", () => {
    const configs = buildVliwConfigs(module(SAMPLE), MODEL);
    for (const id of CONFIGS) expect(configs[id].problems, id).toEqual([]);
  });

  it("линейная конфигурация: без пакетов, плотность 1.00, keys — тождество", () => {
    const configs = buildVliwConfigs(module(SAMPLE), MODEL);
    const linear = configs.linear;
    expect(linear.module.code.some(isRegPacket)).toBe(false);
    expect(linear.density).toBeCloseTo(1, 5);
    expect(flattenKeys(linear.keys)).toEqual(SAMPLE.map((_, i) => i));
  });

  it("упаковка: есть пакеты, плотность больше 1, порядок исходных индексов сохранён", () => {
    const configs = buildVliwConfigs(module(SAMPLE), MODEL);
    const packets = configs.packets;
    expect(packets.module.code.some(isRegPacket)).toBe(true);
    expect(packets.density).toBeGreaterThan(1);
    expect(flattenKeys(packets.keys)).toEqual(SAMPLE.map((_, i) => i));
  });

  it("перестановка: без пакетов, тот же НАБОР исходных индексов", () => {
    const configs = buildVliwConfigs(module(SAMPLE), MODEL);
    const reorder = configs.reorder;
    expect(reorder.module.code.some(isRegPacket)).toBe(false);
    expect(reorder.density).toBeCloseTo(1, 5);
    expect([...flattenKeys(reorder.keys)].sort((a, b) => a - b)).toEqual(SAMPLE.map((_, i) => i));
  });

  it("объединение сохраняет порядок перестановки: упаковка не переставляет", () => {
    const configs = buildVliwConfigs(module(SAMPLE), MODEL);
    // Развёрнутая последовательность исходных индексов должна совпасть у
    // `reorder` и `reorder+packets`: упаковка только группирует соседние.
    expect(flattenKeys(configs["reorder+packets"].keys)).toEqual(flattenKeys(configs.reorder.keys));
  });

  it("объединение: элементов не больше, чем инструкций, и пакеты есть", () => {
    const configs = buildVliwConfigs(module(SAMPLE), MODEL);
    const combined = configs["reorder+packets"];
    expect(combined.module.code.some(isRegPacket)).toBe(true);
    expect(combined.elements).toBeLessThanOrEqual(combined.instructions);
    expect(combined.density).toBeGreaterThanOrEqual(1);
  });

  it("исходный модуль не меняется ни одной конфигурацией", () => {
    const m = module(SAMPLE);
    const before = JSON.parse(JSON.stringify(m));
    buildVliwConfigs(m, MODEL);
    expect(JSON.parse(JSON.stringify(m))).toEqual(before);
  });

  it("модуль с пакетами отвергается: конвейер принимает линейный код", () => {
    const packedFirst = buildVliwConfigs(module(SAMPLE), MODEL).packets.module;
    expect(() => buildVliwConfigs(packedFirst, MODEL)).toThrow(/линейн/i);
  });
});

describe("конвейер: наборы инструкций совпадают с исходными", () => {
  const files = [
    path.join("reg-parity", "while.osnova"),
    path.join("reg-parity", "try.osnova"),
    "cycle-array.osnova",
    "task_stats.osnova",
    "ilp-high.osnova",
  ];

  it("во всех конфигурациях исполнимых инструкций столько же, сколько в исходном модуле", () => {
    for (const file of files) {
      const linear = fixture(file);
      const configs = buildVliwConfigs(linear, MODEL);
      const total = flattenKeys(configs.linear.keys).length;
      for (const id of CONFIGS) {
        expect(flattenKeys(configs[id].keys).length, `${file}: ${id}`).toBe(total);
        expect([...flattenKeys(configs[id].keys)].sort((a, b) => a - b), `${file}: ${id}`).toEqual(
          Array.from({ length: total }, (_, i) => i),
        );
      }
    }
  });

  it("плотность после объединения не ниже плотности после одной упаковки", () => {
    // Требование владельца к объединённому конвейеру. Если на какой-то программе
    // оно нарушится, это должно быть видно здесь, а не в отчёте.
    for (const file of files) {
      const configs = buildVliwConfigs(fixture(file), MODEL);
      expect(configs["reorder+packets"].density, file).toBeGreaterThanOrEqual(configs.packets.density - 1e-9);
    }
  });

  it("адреса пересчитаны: непересчитанных нет", () => {
    for (const file of files) {
      const configs = buildVliwConfigs(fixture(file), MODEL);
      for (const id of CONFIGS) {
        expect(configs[id].unmappedAddresses, `${file}: ${id}`).toEqual([]);
      }
    }
  });
});
