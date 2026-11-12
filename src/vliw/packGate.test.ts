/**
 * ОРАКУЛ GATE'А КОНВЕЙЕРА: четыре конфигурации, негативный контроль.
 *
 * Здесь то же, что в `npm run gate:pack`, но на подмножестве корпуса и с
 * уменьшенным лимитом шагов — чтобы это шло в `npm test`, а не только отдельным
 * скриптом.
 *
 * ## Главное, что проверяют эти тесты
 *
 * Какой контроль ловит какой дефект:
 *
 * - RAW / WAR / WAW и совместимость со слотами **не видны прогону** (VM исполняет
 *   слоты последовательно) — их ловит только `verifyPackets`;
 * - цель перехода внутри пакета `verifyPackets` увидеть не может — её ловит прогон;
 * - подмена модуля на стыке «перестановка → упаковка» не видна ни верификатору,
 *   ни сравнению с эталоном по НАБОРУ: её ловит только сравнение ПОРЯДКА с
 *   конфигурацией перестановки.
 */

import * as fs from "fs";
import * as path from "path";
import { describe, it, expect } from "vitest";
import { runPackGate, type PackGateCase } from "./packGate";
import { e2kMachineModel } from "./e2kMachineModel";
import { regModuleOf } from "./regOracle";
import type { VliwConfigId } from "./vliwPipeline";

const FIXTURES = path.join(__dirname, "..", "runtime", "fixtures");

/** Подмножество корпуса: быстрое и покрывающее разные конструкции. */
const SUBSET: Array<{ file: string; entry?: string }> = [
  { file: path.join("reg-parity", "while.osnova") },
  { file: path.join("reg-parity", "try.osnova") },
  { file: "cycle_array.osnova" },
  { file: "task_stats.osnova" },
  { file: "ilp_high.osnova" },
];

function cases(): PackGateCase[] {
  return SUBSET.map(({ file, entry }) => {
    const built = regModuleOf(fs.readFileSync(path.join(FIXTURES, file), "utf-8"));
    if (!built) throw new Error(`фикстура не компилируется: ${file}`);
    return { name: file, module: built.module, ...(entry !== undefined ? { entryProcedure: entry } : {}) };
  });
}

const MODEL = e2kMachineModel();
const OPTIONS = { model: MODEL, maxSteps: 20_000 };
const IDS: VliwConfigId[] = ["linear", "reorder", "packets", "reorder+packets"];

describe("gate конвейера: базовая линия", () => {
  it("без дефектов gate зелёный, все четыре конфигурации эквивалентны", async () => {
    const report = await runPackGate(cases(), OPTIONS);
    for (const c of report.cases) expect(c.problems).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.red).toBe(0);
    for (const c of report.cases) {
      expect(c.configs.map((x) => x.id)).toEqual(IDS);
      for (const config of c.configs) expect(config.equivalent, `${c.name}: ${config.id}`).toBe(true);
    }
  });

  it("обе упакованные конфигурации проходят verifyPackets", async () => {
    const report = await runPackGate(cases(), OPTIONS);
    for (const c of report.cases) {
      for (const id of ["packets", "reorder+packets"] as VliwConfigId[]) {
        const config = c.configs.find((x) => x.id === id)!;
        expect(config.verify, `${c.name}: ${id}`).toEqual({ ok: true });
      }
    }
  });

  it("плотность после объединения не ниже плотности от одной упаковки", async () => {
    const report = await runPackGate(cases(), OPTIONS);
    for (const c of report.cases) {
      expect(c.densityCombined, c.name).toBeGreaterThanOrEqual(c.densityPackets - 1e-9);
    }
  });

  it("плотность упаковки больше 1 в обеих упакованных конфигурациях", async () => {
    const report = await runPackGate(cases(), OPTIONS);
    for (const c of report.cases) {
      for (const id of ["packets", "reorder+packets"] as VliwConfigId[]) {
        const config = c.configs.find((x) => x.id === id)!;
        expect(config.density, `${c.name}: ${id}`).toBeGreaterThan(1);
        expect(config.widePackets, `${c.name}: ${id}`).toBeGreaterThan(0);
      }
    }
  });

  it("исполнено инструкций одинаково во всех конфигурациях: упаковка — не скорость", async () => {
    const report = await runPackGate(cases(), OPTIONS);
    for (const c of report.cases) {
      const counts = c.configs.map((x) => x.executedInstructions);
      expect(new Set(counts).size, `${c.name}: ${counts.join("/")}`).toBe(1);
    }
  });

  it("шагов VM в объединённой конфигурации не больше, чем в линейной", async () => {
    // Гарантировано конструкцией: линейная конфигурация — одна инструкция на
    // элемент, значит исполненных элементов ровно столько же, сколько инструкций,
    // а в пакете инструкций не меньше одной.
    const report = await runPackGate(cases(), OPTIONS);
    for (const c of report.cases) {
      const linear = c.configs.find((x) => x.id === "linear")!;
      const combined = c.configs.find((x) => x.id === "reorder+packets")!;
      expect(combined.elementSteps, c.name).toBeLessThanOrEqual(linear.elementSteps);
    }
  });
});

describe("негативный контроль gate'а конвейера", () => {
  it("снятие проверки регистров ловит только верификатор", async () => {
    const report = await runPackGate(cases(), { ...OPTIONS, defects: { ignoreRegisters: true } });
    expect(report.passed).toBe(false);
    expect(report.cases.filter((c) => c.configs.some((x) => !x.verify.ok)).length).toBeGreaterThan(0);
    // Прогон при этом совпадает: VM не видит RAW внутри пакета.
    expect(report.cases.every((c) => c.configs.every((x) => x.equivalent))).toBe(true);
  });

  it("снятие проверки слотов ловит только верификатор", async () => {
    const report = await runPackGate(cases(), { ...OPTIONS, defects: { ignoreSlots: true } });
    expect(report.passed).toBe(false);
    expect(report.cases.filter((c) => c.configs.some((x) => !x.verify.ok)).length).toBeGreaterThan(0);
    expect(report.cases.every((c) => c.configs.every((x) => x.equivalent))).toBe(true);
  });

  it("передача управления внутри пакета ломает эквивалентность", async () => {
    const report = await runPackGate(cases(), { ...OPTIONS, defects: { ignoreControlTransfer: true } });
    expect(report.passed).toBe(false);
    expect(report.cases.some((c) => c.configs.some((x) => !x.equivalent))).toBe(true);
  });

  it("цель перехода внутри пакета ломает эквивалентность, а верификатор её не видит", async () => {
    const report = await runPackGate(cases(), { ...OPTIONS, defects: { ignoreEntryPoints: true } });
    expect(report.passed).toBe(false);
    expect(report.cases.filter((c) => c.configs.some((x) => !x.equivalent)).length).toBeGreaterThan(0);
    expect(report.cases.every((c) => c.configs.every((x) => x.verify.ok))).toBe(true);
  });

  it("подмена модуля на стыке ловится только сравнением порядка", async () => {
    const report = await runPackGate(cases(), {
      ...OPTIONS,
      pipelineDefects: { packOriginalAfterReorder: true },
    });
    expect(report.passed).toBe(false);
    // Верификатор молчит: пакеты легальны, просто собраны не из того модуля.
    expect(report.cases.every((c) => c.configs.every((x) => x.verify.ok))).toBe(true);
    const red = report.cases.filter((c) => c.problems.some((p) => p.includes("порядок")));
    expect(red.length).toBeGreaterThan(0);
    expect(red[0]!.problems.join(" ")).toContain("порядок");
  });

  it("каждый дефект по отдельности краснит gate", async () => {
    const defectsList = [
      { ignoreRegisters: true },
      { ignoreSlots: true },
      { ignoreControlTransfer: true },
      { ignoreEntryPoints: true },
    ];
    for (const defects of defectsList) {
      const report = await runPackGate(cases(), { ...OPTIONS, defects });
      expect(report.passed, `дефект ${JSON.stringify(defects)} не сделал gate красным`).toBe(false);
    }
    const pipeline = await runPackGate(cases(), {
      ...OPTIONS,
      pipelineDefects: { packOriginalAfterReorder: true },
    });
    expect(pipeline.passed, "дефект сборки конвейера не сделал gate красным").toBe(false);
  });
});
