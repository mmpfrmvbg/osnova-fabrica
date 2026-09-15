/**
 * ПРОВЕРКА B4: можно ли по измерению подтвердить флаг optimizable у слияния CRDT?
 *
 * ## Что здесь проверяется по существу
 *
 * Владелец потребовал не оставлять утверждение «коммутативность CRDT = предусловие
 * перестановки» декларацией, а проверить на конкретном CRDT. Проверка сделана на
 * трёх вариантах одного атома B4:
 *
 * | фикстура | форма слияния | чего ожидали |
 * | --- | --- | --- |
 * | `crdt/counter-merge.osnova` | G-Counter, покомпонентный максимум по независимым репликам | есть что переставлять |
 * | `crdt/scalar-merge.osnova` | одиночный счётчик, слияние — один максимум (O(1)) | переставлять нечего |
 * | `crdt/sequence-merge.osnova` | последовательный merge: элемент зависит от предыдущего | переставлять нечего |
 *
 * ## Результат отрицательный, и это главное
 *
 * Измерено (`buildVliwConfigs`, модель e2k): плотность упаковки выросла у **всех
 * трёх** — 1.00 → 1.50 (G-Counter), 1.00 → 1.25 (O(1)-счётчик), 1.00 → 1.56
 * (зависимая цепочка). Зависимая цепочка оказалась «плотнее» O(1)-случая.
 *
 * Причина: плотность считается по **всей программе**, а не по телу атома. Вокруг
 * ядра есть служебный код (кадры, вызовы, адресация массива, инкремент цикла),
 * который пакуется независимо от того, есть ли независимость в самом слиянии.
 * Значит **плотность программы не является диагностикой оптимизируемости атома**.
 *
 * Следствие для флага: у B4 `optimizable: true` остаётся выводом из правила (три
 * вопроса), но **измерением не подтверждён**, и подтверждён быть не может, пока
 * тело атома не выделено в коде как отдельная единица. Это записано в
 * `docs/osnova-signature-spec.md` (§2.1) и `docs/osnova-signature-to-emitter.md`
 * (§3.5, пункт 6). Тест фиксирует именно это состояние знания, а не удобный вывод.
 */

import * as fs from "fs";
import * as path from "path";
import { describe, it, expect } from "vitest";
import { regModuleOf } from "./regOracle";
import { e2kMachineModel } from "./e2kMachineModel";
import { buildVliwConfigs } from "./vliwPipeline";
import { RegVM } from "../runtime/vm/reginterpreter";
import { createDefaultInvokeHandler } from "../runtime/vm/interpreter";
import { resolveEntryIndex } from "../oracle/parity";

const ROOT = path.resolve(__dirname, "..", "..");
const CRDT = path.join(ROOT, "src", "runtime", "fixtures", "crdt");
const MODEL = e2kMachineModel();

/** Ожидаемые результаты фикстур. Значения получены прогоном, а не выведены. */
const CASES: Array<{ file: string; expected: number }> = [
  { file: "counter-merge.osnova", expected: 8 },
  { file: "scalar-merge.osnova", expected: 7 },
  { file: "sequence-merge.osnova", expected: 11 },
];

function source(file: string): string {
  return fs.readFileSync(path.join(CRDT, file), "utf-8");
}

async function runValue(file: string): Promise<unknown> {
  const built = regModuleOf(source(file));
  if (!built) throw new Error(`фикстура не компилируется: ${file}`);
  const entry = resolveEntryIndex(built.module.procedures, undefined) ?? 0;
  const host = createDefaultInvokeHandler();
  const vm = new RegVM(built.module, { maxSteps: 200_000, invoke: (n, a) => host(n, a) });
  return vm.runProcedure(entry, []);
}

describe("B4: проверка на конкретных вариантах CRDT", () => {
  it("все три варианта компилируются и дают задокументированный результат", async () => {
    for (const c of CASES) {
      expect(await runValue(c.file), `${c.file}: результат изменился`).toBe(c.expected);
    }
  });

  it("плотность растёт у ВСЕХ трёх вариантов — значит она не диагностика атома", async () => {
    // Это и есть отрицательный результат проверки. Если однажды плотность начнёт
    // различать варианты (например, после выделения тела атома), этот тест упадёт
    // и заставит переписать вывод — что и требуется.
    for (const c of CASES) {
      const built = regModuleOf(source(c.file));
      if (!built) throw new Error(`фикстура не компилируется: ${c.file}`);
      const configs = buildVliwConfigs(built.module, MODEL);
      expect(configs.packets.density, `${c.file}: плотность не выросла`).toBeGreaterThan(1);
      expect(configs["reorder+packets"].density, `${c.file}: объединение ниже упаковки`).toBeGreaterThanOrEqual(
        configs.packets.density - 1e-9,
      );
    }
  });

  it("зависимая цепочка пакуется не хуже O(1)-случая — метрика не различает варианты", async () => {
    const density = (file: string): number => {
      const built = regModuleOf(source(file));
      if (!built) throw new Error(`фикстура не компилируется: ${file}`);
      return buildVliwConfigs(built.module, MODEL)["reorder+packets"].density;
    };
    const scalar = density("scalar-merge.osnova");
    const sequence = density("sequence-merge.osnova");
    // Ожидание «зависимая цепочка не пакуется, а O(1) не пакуется тем более»
    // измерением НЕ подтверждается: последовательный вариант плотнее.
    expect(sequence).toBeGreaterThanOrEqual(scalar);
  });

  it("состояние знания зафиксировано в документах, а не только в этом файле", () => {
    const spec = fs.readFileSync(path.join(ROOT, "docs", "osnova-signature-spec.md"), "utf-8").replace(/\s+/g, " ");
    expect(spec, "в спецификации нет проверки B4").toContain("B4");
    expect(spec, "не назван ни один вариант CRDT").toMatch(/G-Counter|OR-Set/i);
    expect(spec, "не записан отрицательный результат").toMatch(/не подтвержд[её]н|не является диагностик/i);
    const emitter = fs.readFileSync(path.join(ROOT, "docs", "osnova-signature-to-emitter.md"), "utf-8").replace(/\s+/g, " ");
    expect(emitter, "в интерфейсе не назван пробел «тело атома»").toMatch(/тело атома/i);
  });
});
