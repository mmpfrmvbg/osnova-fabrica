/**
 * ОРАКУЛ GATE'А УПАКОВКИ: зелёная базовая линия и негативный контроль.
 *
 * Здесь негативный контроль выполняется на подмножестве корпуса и с уменьшенным
 * лимитом шагов — чтобы он шёл в `npm test`, а не только в отдельном скрипте
 * (`npm run gate:pack:negative`, там весь корпус).
 *
 * ## Главное, что проверяют эти тесты
 *
 * Какой контроль ловит какой дефект. Это не формальность:
 *
 * - RAW / WAR / WAW и совместимость со слотами **не видны прогону** (VM исполняет
 *   слоты последовательно в том же порядке), поэтому снятие этих правил не меняет
 *   результат — их ловит только `verifyPackets`;
 * - цель перехода внутри пакета `verifyPackets` увидеть не может (в упакованном
 *   коде `off` — индекс элемента), но прогон это видит: VM, войдя в пакет по
 *   адресу, исполняет слоты, стоящие до цели.
 *
 * Значит оба контроля нужны, и ни один не покрывает другой. Числа ниже — из
 * прогона негативного контроля по всему корпусу.
 */

import * as fs from "fs";
import * as path from "path";
import { describe, it, expect } from "vitest";
import { runPackGate, type PackGateCase } from "./packGate";
import { e2kMachineModel } from "./e2kMachineModel";
import { regModuleOf } from "./regOracle";

const FIXTURES = path.join(__dirname, "..", "runtime", "fixtures");

/** Подмножество корпуса: быстрое и покрывающее разные конструкции. */
const SUBSET: Array<{ file: string; entry?: string }> = [
  { file: path.join("reg-parity", "while.osnova") },
  { file: path.join("reg-parity", "try.osnova") },
  { file: "cycle-array.osnova" },
  { file: "task_stats.osnova" },
  { file: "ilp-high.osnova" },
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

describe("gate упаковки: базовая линия", () => {
  it("без дефектов gate зелёный на подмножестве корпуса", async () => {
    const report = await runPackGate(cases(), OPTIONS);
    for (const c of report.cases) expect(c.problems).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.red).toBe(0);
    expect(report.green).toBe(SUBSET.length);
  });

  it("плотность упаковки больше 1, а элементов стало меньше", async () => {
    const report = await runPackGate(cases(), OPTIONS);
    for (const c of report.cases) {
      expect(c.stats.densityAfter).toBeGreaterThan(1);
      expect(c.stats.elementsAfter).toBeLessThan(c.stats.elementsBefore);
      expect(c.stats.widePackets).toBeGreaterThan(0);
    }
  });

  it("число исполненных инструкций не меняется: упаковка — не скорость", async () => {
    // Это наблюдение, а не требование к планировщику: VM исполняет те же
    // инструкции, меняется только число элементов кода. Если оно когда-нибудь
    // разойдётся, это будет означать, что упаковка изменила поведение.
    const report = await runPackGate(cases(), OPTIONS);
    for (const c of report.cases) {
      expect(c.packedSteps).toBe(c.linearSteps);
    }
  });
});

describe("негативный контроль gate'а упаковки", () => {
  it("снятие проверки регистров ловит только верификатор", async () => {
    const report = await runPackGate(cases(), { ...OPTIONS, defects: { ignoreRegisters: true } });
    expect(report.passed).toBe(false);
    expect(report.cases.filter((c) => !c.verify.ok).length).toBeGreaterThan(0);
    // Прогон при этом совпадает: VM не видит RAW внутри пакета.
    expect(report.cases.every((c) => c.equivalent)).toBe(true);
  });

  it("снятие проверки слотов ловит только верификатор", async () => {
    const report = await runPackGate(cases(), { ...OPTIONS, defects: { ignoreSlots: true } });
    expect(report.passed).toBe(false);
    expect(report.cases.filter((c) => !c.verify.ok).length).toBeGreaterThan(0);
    expect(report.cases.every((c) => c.equivalent)).toBe(true);
  });

  it("передача управления внутри пакета ломает эквивалентность", async () => {
    const report = await runPackGate(cases(), { ...OPTIONS, defects: { ignoreControlTransfer: true } });
    expect(report.passed).toBe(false);
    // Измеренный класс дефекта: слоты после передачи управления не исполняются.
    expect(report.cases.filter((c) => !c.equivalent).length).toBeGreaterThan(0);
  });

  it("цель перехода внутри пакета ломает эквивалентность, а верификатор её не видит", async () => {
    const report = await runPackGate(cases(), { ...OPTIONS, defects: { ignoreEntryPoints: true } });
    expect(report.passed).toBe(false);
    expect(report.cases.filter((c) => !c.equivalent).length).toBeGreaterThan(0);
    // Верификатор обязан быть зелёным: этого нарушения он не видит по построению.
    expect(report.cases.every((c) => c.verify.ok)).toBe(true);
  });

  it("дефекты не срабатывают сами по себе: каждый по отдельности краснит gate", async () => {
    const variants: Array<Record<string, boolean>> = [
      { ignoreRegisters: true },
      { ignoreSlots: true },
      { ignoreControlTransfer: true },
      { ignoreEntryPoints: true },
    ];
    for (const defects of variants) {
      const report = await runPackGate(cases(), { ...OPTIONS, defects });
      expect(report.passed, `дефект ${JSON.stringify(defects)} не сделал gate красным`).toBe(false);
    }
  });
});
