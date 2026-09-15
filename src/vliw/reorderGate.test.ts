/**
 * Тесты флага подключения перестановки и gate.
 *
 * ## Что здесь проверяется
 *
 * 1. **Флаг по умолчанию выключен.** Это требование `docs/vliw-reg-plan.md`:
 *    «Не включать планировщик по умолчанию до зелёного оракула».
 * 2. **Флаг включается только явным значением.** `OSNOVA_VLIW_REORDER=0` — это
 *    «выключено», а не «включено»: иначе случайный ноль читался бы как согласие.
 * 3. **Gate краснеет на расхождении и зеленеет на совпадении.** Проверяется на
 *    подсунутых модулях, а не только на реальном корпусе.
 * 4. **Gate не считает успехом взаимное падение** — тот самый дефект, из-за
 *    которого в проекте уже появлялся `[OK]` на обоюдной ошибке.
 */

import { describe, it, expect } from "vitest";
import {
  REORDER_FLAG,
  clustersEnabled,
  formatGateReport,
  reorderEnabled,
  runReorderGate,
  type GateCase,
} from "./reorderGate";
import { regModuleOf } from "./regOracle";

const HELLO = `модуль главный
процедура старт()
  вернуть 42
конец
конец
`;

const INFINITE = `модуль Т
процедура главная()
  пусть i = 0
  цикл
    i = i + 1
  конец
  вернуть i
конец
конец
`;

const STORAGE = `модуль Т
процедура запуск()
  система.хранилище.записать("ключ", "значение")
  пусть v = система.хранилище.прочитать("ключ")
  система.лог.вывести(v)
  вернуть v
конец
конец
`;

function moduleOf(source: string) {
  const built = regModuleOf(source);
  if (!built) throw new Error("исходник не компилируется");
  return built.module;
}

describe("флаг перестановки: по умолчанию выключено", () => {
  it("не задан → выключено", () => {
    expect(reorderEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("пустая строка → выключено", () => {
    expect(reorderEnabled({ [REORDER_FLAG]: "" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("«0» → выключено (ноль не означает согласие)", () => {
    expect(reorderEnabled({ [REORDER_FLAG]: "0" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("«false»/«off»/«no» → выключено", () => {
    for (const v of ["false", "off", "no", "FALSE", "Off"]) {
      expect(reorderEnabled({ [REORDER_FLAG]: v } as NodeJS.ProcessEnv), v).toBe(false);
    }
  });

  it("«1»/«true»/«on»/«yes» → включено", () => {
    for (const v of ["1", "true", "on", "yes", "TRUE", " On "]) {
      expect(reorderEnabled({ [REORDER_FLAG]: v } as NodeJS.ProcessEnv), v).toBe(true);
    }
  });

  it("мусор → выключено (не включаем по неопознанному значению)", () => {
    for (const v of ["да", "enable", "2", "-1"]) {
      expect(reorderEnabled({ [REORDER_FLAG]: v } as NodeJS.ProcessEnv), v).toBe(false);
    }
  });
});

describe("флаг кластеров: по умолчанию включено (это факт из документа)", () => {
  it("не задан → включено", () => {
    expect(clustersEnabled({} as NodeJS.ProcessEnv)).toBe(true);
  });

  it("«0»/«false»/«off»/«no» → выключено (baseline для замера)", () => {
    for (const v of ["0", "false", "off", "no"]) {
      expect(clustersEnabled({ OSNOVA_VLIW_CLUSTERS: v } as NodeJS.ProcessEnv), v).toBe(false);
    }
  });

  it("«1»/«true» → включено", () => {
    for (const v of ["1", "true", "on", "yes"]) {
      expect(clustersEnabled({ OSNOVA_VLIW_CLUSTERS: v } as NodeJS.ProcessEnv), v).toBe(true);
    }
  });
});

describe("gate: зелёный на совпадении, красный на расхождении", () => {
  it("завершающаяся программа доказывает эквивалентность", async () => {
    const cases: GateCase[] = [
      { name: "hello", module: moduleOf(HELLO) },
      { name: "storage", module: moduleOf(STORAGE) },
    ];
    const report = await runReorderGate(cases);
    expect(report.passed, formatGateReport(report)).toBe(true);
    expect(report.proven).toBe(2);
    expect(report.excluded).toBe(0);
  });

  it("незавершающаяся программа исключается, но только при честном отказе", async () => {
    const cases: GateCase[] = [
      { name: "hello", module: moduleOf(HELLO) },
      { name: "infinite", module: moduleOf(INFINITE), expectNonTerminating: true },
    ];
    const report = await runReorderGate(cases, { maxSteps: 500 });
    expect(report.passed, formatGateReport(report)).toBe(true);
    expect(report.proven).toBe(1);
    expect(report.excluded).toBe(1);
    // Текст обязан говорить, что эквивалентность НЕ доказана.
    const infinite = report.cases.find((c) => c.name === "infinite")!;
    expect(infinite.message).toContain("не доказана");
  });

  it("если незавершающаяся вдруг «докажет» эквивалентность — gate краснеет", async () => {
    // Негативный контроль логики gate, а не планировщика: помечаем
    // завершающуюся программу как ожидаемо незавершающуюся. Gate обязан
    // заметить, что честного отказа не было.
    const cases: GateCase[] = [
      { name: "hello-но-помечен-как-цикл", module: moduleOf(HELLO), expectNonTerminating: true },
    ];
    const report = await runReorderGate(cases);
    expect(report.passed).toBe(false);
    const c = report.cases[0]!;
    expect(c.ok).toBe(false);
    expect(c.message).toContain("ОЖИДАЛСЯ честный отказ");
  });

  it("отчёт читается человеком: есть ИТОГ и счётчики", async () => {
    const report = await runReorderGate([{ name: "hello", module: moduleOf(HELLO) }]);
    const text = formatGateReport(report);
    expect(text).toContain("ИТОГ: GATE ЗЕЛЁНЫЙ");
    expect(text).toContain("доказано эквивалентности: 1");
    expect(text).toContain("исключено");
  });
});

describe("gate: чувствительность к порядку зависимостей", () => {
  /**
   * Gate сверяет НАБЛЮДАЕМОЕ поведение: значение, трассу вызовов и набор
   * инструкций. Поэтому он обязан ловить нарушение порядка (когда потребитель
   * получает неготовый операнд) и НЕ обязан ловить неточность таблицы
   * длительностей — задержки влияют на расписание, но не на результат.
   *
   * Негативный контроль на реальном коде делался вручную и записан в
   * `docs/vliw-e2k-model.md`: выбрасывание каждого второго ребра графа дало
   * `GATE КРАСНЫЙ`, exit 1, расхождения на 6 программах из 11.
   *
   * Здесь проверяется следствие: на программе с эффектами расхождение
   * наблюдаемой трассы обязано быть замечено.
   */
  it("программа с наблюдаемыми эффектами участвует в сверке трасс", async () => {
    const cases: GateCase[] = [{ name: "storage", module: moduleOf(STORAGE) }];
    const report = await runReorderGate(cases);
    expect(report.cases[0]!.ok).toBe(true);
    // Трасса не пуста — иначе проверка была бы зелёной на пустоте.
    expect(report.cases[0]!.message).toMatch(/трасса \d+ шагов/);
    const steps = Number(/трасса (\d+) шагов/.exec(report.cases[0]!.message)?.[1] ?? "0");
    expect(steps).toBeGreaterThan(1);
  });
});
