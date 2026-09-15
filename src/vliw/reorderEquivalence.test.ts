/**
 * Тесты оракула эквивалентности: линейный регистровый код против
 * переставленного — на одной `RegVM`, с одинаковым хостом.
 *
 * Это тот самый оракул, отсутствие которого в `docs/vliw-reg-plan.md` названо
 * причиной, по которой планировщик нельзя подключать в конвейер по умолчанию.
 * Он должен доказать не «расписание выглядит правильно», а «код ведёт себя так
 * же после перестановки».
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { runReorderEquivalence, applyReorderToModule } from "./reorderEquivalence";
import { regModuleOf } from "./regOracle";
import type { RegModule } from "../runtime/vm/regcode";

const FIXTURES = path.join(__dirname, "..", "runtime", "fixtures");
const PARITY = path.join(FIXTURES, "reg-parity");

function moduleOfFile(file: string): { module: RegModule; source: string } {
  const source = fs.readFileSync(file, "utf-8");
  const built = regModuleOf(source);
  expect(built, `исходник ${path.basename(file)} должен компилироваться`).not.toBeNull();
  return { module: built!.module, source };
}

/** Корпус: файлы с завершающимися программами и независимым ожиданием. */
const CORPUS: Array<{ file: string; expected: number; what: string }> = [
  { file: "while.osnova", expected: 1049, what: "пока + прервать + продолжить" },
  { file: "foreach.osnova", expected: 13075, what: "для_каждого: элемент, индекс, вложенность" },
  { file: "tuple.osnova", expected: 1541, what: "кортежи, распаковка" },
  { file: "try.osnova", expected: 11908, what: "исключения, вложенность" },
];

describe("reorderEquivalence: переставленный код ведёт себя как линейный", () => {
  for (const { file, expected, what } of CORPUS) {
    it(`${file} (${what}) → ${expected} на обеих версиях`, async () => {
      const { module } = moduleOfFile(path.join(PARITY, file));
      const report = await runReorderEquivalence(module, {});
      expect(report.linearError, `линейный прогон: ${report.linearError}`).toBeNull();
      expect(report.reorderedError, `переставленный прогон: ${report.reorderedError}`).toBeNull();
      // Независимое ожидание — не из планировщика, а из теста.
      expect(report.linearValue).toBe(expected);
      expect(report.reorderedValue).toBe(expected);
      expect(report.tracesEqual, report.message).toBe(true);
      expect(report.instructionsEqual, report.message).toBe(true);
      expect(report.ok, report.message).toBe(true);
    });
  }

  it("на func_params (реальная фикстура) эквивалентность держится", async () => {
    const { module } = moduleOfFile(path.join(FIXTURES, "func_params.osnova"));
    const report = await runReorderEquivalence(module, {});
    expect(report.linearValue).toBe(152);
    expect(report.reorderedValue).toBe(152);
    expect(report.ok, report.message).toBe(true);
  });

  it("на hello эквивалентность держится", async () => {
    const { module } = moduleOfFile(path.join(FIXTURES, "hello.osnova"));
    const report = await runReorderEquivalence(module, {});
    expect(report.reorderedValue).toBe(42);
    expect(report.ok, report.message).toBe(true);
  });
});

describe("reorderEquivalence: перестановка действительно происходит", () => {
  it("на программе с независимыми ветками порядок выдачи меняется", async () => {
    const source = `модуль Т
процедура главная()
  пусть a = 1 + 2
  пусть b = 3 + 4
  пусть c = 5 + 6
  вернуть a + b + c
конец
конец
`;
    const built = regModuleOf(source);
    expect(built).not.toBeNull();
    const { orderChanged } = applyReorderToModule(built!.module, 0, {});
    expect(orderChanged).toBe(true);
  });

  it("если порядок не изменился, эквивалентность всё равно проверяется", async () => {
    const source = `модуль Т
процедура главная()
  вернуть 7
конец
конец
`;
    const built = regModuleOf(source);
    const report = await runReorderEquivalence(built!.module, {});
    expect(report.reorderedValue).toBe(7);
    expect(report.ok, report.message).toBe(true);
  });
});

describe("reorderEquivalence: сломанное расписание ловится", () => {
  it("оракул не считает успехом случай, когда обе стороны упали одинаково", async () => {
    // Программа с бесконечным циклом: обе стороны упрутся в лимит шагов.
    // Совпадение отказа — НЕ доказательство эквивалентности, и оракул обязан
    // это сказать, а не отрапортовать «ok».
    const source = `модуль Т
процедура главная()
  пусть i = 0
  цикл
    i = i + 1
  конец
  вернуть i
конец
конец
`;
    const built = regModuleOf(source);
    expect(built).not.toBeNull();
    const report = await runReorderEquivalence(built!.module, { maxSteps: 500 });
    expect(report.linearError).not.toBeNull();
    expect(report.reorderedError).not.toBeNull();
    expect(report.ok).toBe(false);
    expect(report.message).toContain("эквивалентность не доказана");
  });

  it("сравниваются мультимножества инструкций, а не порядок", async () => {
    const { module } = moduleOfFile(path.join(PARITY, "foreach.osnova"));
    const report = await runReorderEquivalence(module, {});
    // Планировщик переставляет — порядок может отличаться, но набор обязан
    // совпасть и длины совпадают.
    expect(report.linearInstructions.length).toBe(report.reorderedInstructions.length);
    expect(report.instructionsEqual).toBe(true);
  });
});
