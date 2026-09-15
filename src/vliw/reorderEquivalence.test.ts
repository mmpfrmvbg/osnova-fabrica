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
import { isEffectInstruction, buildRegDependencyGraph } from "./regGraph";
import { scheduleGraphWithReorder, validateRegSchedule } from "./reorderScheduler";
import type { RegInstruction, RegModule } from "../runtime/vm/regcode";

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

describe("reorderEquivalence: регрессия на барьер возврата", () => {
  /**
   * Дефект, найденный этим оракулом на `storage_demo.osnova`:
   *
   * `ret` не имеет предшественников по данным — возвращаемое значение не связано
   * с эффектами, которые идут раньше. Планировщик считал его независимым, выдавал
   * ПЕРВЫМ, и процедура завершалась до того, как срабатывали
   * `система.лог.вывести` и запись в хранилище. Статическая проверка расписания
   * (`validateRegSchedule`) этого не ловила: рёбер в графе как раз и не было.
   *
   * Исправлено двумя способами:
   * 1. `isEffectInstruction("ret") === true` — возврат замыкается на цепочку
   *    эффектов и наблюдает всё, что было до него;
   * 2. `ret`/`jmp*` закрывают линейный участок, а `validateRegSchedule` теперь
   *    проверяет, что терминатор стоит последним в своём участке.
   */
  it("ret объявлен эффектом — он наблюдает всё, что было до него", () => {
    expect(isEffectInstruction({ op: "ret" } as RegInstruction)).toBe(true);
  });

  it("в графе у ret есть предшественники, если до него были эффекты", () => {
    const code = [
      { op: "const", d: 1, type: "str", k: 0 },
      { op: "invoke", name: "система.лог.вывести", args: [1], argc: 1 } as RegInstruction,
      { op: "ret" } as RegInstruction,
    ];
    const graph = buildRegDependencyGraph(code, {});
    expect(graph.preds[2]!.length).toBeGreaterThan(0);
  });

  it("терминатор всегда последний в участке", () => {
    const code = [
      { op: "const", d: 1, type: "i32", k: 0 },
      { op: "ret", v: 1 } as RegInstruction,
    ];
    const graph = buildRegDependencyGraph(code, {});
    const r = scheduleGraphWithReorder(code, graph);
    const v = validateRegSchedule(code, graph, r);
    expect(v.problems).toEqual([]);
    // ret — последняя в порядке выдачи.
    expect(r.order[r.order.length - 1]).toBe(1);
  });

  it("storage_demo: вывод в лог происходит, а не теряется", async () => {
    // Именно здесь дефект и проявлялся: ret убегал вперёд, и хост-вызов
    // «система.лог.вывести» не исполнялся вовсе.
    const { module } = moduleOfFile(path.join(FIXTURES, "storage_demo.osnova"));
    const report = await runReorderEquivalence(module, {});
    const reorderedInvokes = report.reorderedTrace.filter((s) => s.kind === "invoke");
    const linearInvokes = report.linearTrace.filter((s) => s.kind === "invoke");
    expect(reorderedInvokes.length).toBe(linearInvokes.length);
    expect(reorderedInvokes.length).toBeGreaterThan(0);
    expect(report.ok, report.message).toBe(true);
  });

  it("многоproцедурный модуль: task_stats эквивалентен", async () => {
    // Второй аспект того же дефекта: адреса процедур после перестановки нужно
    // пересчитывать для ВСЕГО модуля, иначе вызов уходит не туда.
    const { module } = moduleOfFile(path.join(FIXTURES, "task_stats.osnova"));
    expect(module.procedures.length).toBeGreaterThan(1);
    const report = await runReorderEquivalence(module, {});
    expect(report.ok, report.message).toBe(true);
    expect(report.tracesEqual).toBe(true);
  });
});

describe("reorderEquivalence: корпус проекта", () => {
  /**
   * Все фикстуры проекта, кроме оконных приложений с бесконечным `цикл`.
   *
   * Три оконных (`todo`, `micro_crm`, `game_rounds`) не завершаются ни на одной
   * из сторон, поэтому эквивалентность на них НЕ доказывается — оракул обязан
   * возвращать `ok: false` с текстом «эквивалентность не доказана», а не
   * рапортовать успех на взаимном падении.
   */
  const TERMINATING = [
    "hello.osnova",
    "func_params.osnova",
    "task_stats.osnova",
    "storage_demo.osnova",
    "блокнот.osnova",
  ];

  for (const file of TERMINATING) {
    it(`${file}: эквивалентность доказана`, async () => {
      const { module } = moduleOfFile(path.join(FIXTURES, file));
      const report = await runReorderEquivalence(module, {});
      expect(report.ok, report.message).toBe(true);
      expect(report.valuesEqual).toBe(true);
      expect(report.tracesEqual).toBe(true);
      expect(report.instructionsEqual).toBe(true);
    });
  }

  const NON_TERMINATING = ["todo.osnova", "micro_crm.osnova", "game_rounds.osnova"];

  for (const file of NON_TERMINATING) {
    it(`${file}: эквивалентность НЕ объявляется на взаимном падении`, async () => {
      const { module } = moduleOfFile(path.join(FIXTURES, file));
      const report = await runReorderEquivalence(module, { maxSteps: 2000 });
      expect(report.ok).toBe(false);
      expect(report.message).toContain("эквивалентность не доказана");
    });
  }
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
