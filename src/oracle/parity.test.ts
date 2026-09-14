/**
 * Оракул регистрового бэкенда: один `.osnova` — две VM, сверка трасс.
 *
 * Стековая VM — эталон. Эти тесты и есть определение готовности среза: пока
 * регистровый результат и трасса не совпали со стековыми, бэкенд не готов.
 * Часть кейсов задаёт `expectedReturn` — независимое от обеих VM ожидание
 * (оракул оракула): совпасть можно и на общей ошибке, а сойтись с арифметикой —
 * нельзя.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { runParity, type ParityResult } from "./parity";

/** Обёртка: падение теста, если программа вне среза регистрового бэкенда. */
async function parity(source: string, expectedReturn?: unknown): Promise<ParityResult> {
  const result = await runParity(source, {
    expectedReturn: expectedReturn as never,
  });
  if ("skipped" in result) {
    throw new Error(`Программа вне среза регистрового бэкенда: ${result.reason}`);
  }
  return result;
}

function moduleOf(body: string): string {
  return `модуль Тест\n${body}\nконец\n`;
}

describe("oracle/parity: базовые выражения", () => {
  it("первый целевой кейс: пусть x = 1 + 2 * 3; вернуть x * 4", async () => {
    const r = await parity(
      moduleOf(`
процедура главная()
  пусть x = 1 + 2 * 3
  вернуть x * 4
конец
`),
      28,
    );
    expect(r.ok, r.message).toBe(true);
    expect(r.stackValue).toBe(28);
    expect(r.regValue).toBe(28);
    expect(r.expectationFailed).toBe(false);
  });

  it("приоритет и скобки: 2 + 3 * 4 - 10 / 2", async () => {
    const r = await parity(
      moduleOf(`
процедура главная()
  вернуть 2 + 3 * 4 - 10 / 2
конец
`),
      9,
    );
    expect(r.ok, r.message).toBe(true);
    expect(r.regValue).toBe(9);
  });

  it("остаток: 17 % 5", async () => {
    const r = await parity(
      moduleOf(`
процедура главная()
  вернуть 17 % 5
конец
`),
      2,
    );
    expect(r.ok, r.message).toBe(true);
    expect(r.regValue).toBe(2);
  });

  it("дробное деление: 7 / 2", async () => {
    const r = await parity(
      moduleOf(`
процедура главная()
  вернуть 7 / 2
конец
`),
      3.5,
    );
    expect(r.ok, r.message).toBe(true);
    expect(r.regValue).toBe(3.5);
  });

  it("конкатенация строк: \"а\" + 1 + \"б\"", async () => {
    const r = await parity(
      moduleOf(`
процедура главная()
  вернуть "а" + 1 + "б"
конец
`),
      "а1б",
    );
    expect(r.ok, r.message).toBe(true);
    expect(r.regValue).toBe("а1б");
  });

  it("сравнения дают логический результат", async () => {
    const r = await parity(
      moduleOf(`
процедура главная()
  пусть a = 3
  пусть b = 5
  вернуть a < b
конец
`),
      true,
    );
    expect(r.ok, r.message).toBe(true);
    expect(r.regValue).toBe(true);
  });
});

describe("oracle/parity: переменные и присвоение", () => {
  it("присвоить перезаписывает переменную", async () => {
    const r = await parity(
      moduleOf(`
процедура главная()
  пусть x = 1
  x = x + 41
  вернуть x
конец
`),
      42,
    );
    expect(r.ok, r.message).toBe(true);
    expect(r.regValue).toBe(42);
  });

  it("переменная как выражение отдаёт свой регистр (без копии)", async () => {
    const r = await parity(
      moduleOf(`
процедура главная()
  пусть x = 7
  вернуть x
конец
`),
      7,
    );
    expect(r.ok, r.message).toBe(true);
    expect(r.regValue).toBe(7);
  });

  it("«вернуть» без значения даёт пусто, как стековая VM", async () => {
    const r = await parity(
      moduleOf(`
процедура главная()
  вернуть
конец
`),
      null,
    );
    expect(r.ok, r.message).toBe(true);
    expect(r.regValue).toBe(null);
  });
});

describe("oracle/parity: ветвления", () => {
  it("если без иначе", async () => {
    const r = await parity(
      moduleOf(`
процедура главная()
  пусть x = 10
  если x > 5
    вернуть 1
  конец
  вернуть 0
конец
`),
      1,
    );
    expect(r.ok, r.message).toBe(true);
    expect(r.regValue).toBe(1);
  });

  it("если/иначе", async () => {
    const r = await parity(
      moduleOf(`
процедура главная()
  пусть x = 2
  если x > 5
    вернуть 1
  иначе
    вернуть 0
  конец
конец
`),
      0,
    );
    expect(r.ok, r.message).toBe(true);
    expect(r.regValue).toBe(0);
  });

  it("иначе если: цепочка веток", async () => {
    const r = await parity(
      moduleOf(`
процедура главная()
  пусть x = 7
  если x > 10
    вернуть 3
  иначе если x > 5
    вернуть 2
  иначе
    вернуть 1
  конец
конец
`),
      2,
    );
    expect(r.ok, r.message).toBe(true);
    expect(r.regValue).toBe(2);
  });

  it("присвоение внутри ветки видно после ветки", async () => {
    const r = await parity(
      moduleOf(`
процедура главная()
  пусть накопить = 1
  пусть флаг = истина
  если флаг
    накопить = накопить + 10
  конец
  вернуть накопить
конец
`),
      11,
    );
    expect(r.ok, r.message).toBe(true);
    expect(r.regValue).toBe(11);
  });

  it("короткое замыкание «и» не вычисляет правую часть при ложном левом", async () => {
    const r = await parity(
      moduleOf(`
процедура главная()
  пусть x = 0
  если ложь и x > 1
    вернуть 1
  конец
  вернуть 2
конец
`),
      2,
    );
    expect(r.ok, r.message).toBe(true);
    expect(r.regValue).toBe(2);
  });

  it("«не» эквивалентно сравнению с ложью", async () => {
    const r = await parity(
      moduleOf(`
процедура главная()
  вернуть не ложь
конец
`),
      true,
    );
    expect(r.ok, r.message).toBe(true);
    expect(r.regValue).toBe(true);
  });
});

describe("oracle/parity: процедуры и вызовы", () => {
  it("вызов процедуры с аргументами", async () => {
    const r = await parity(
      `модуль Тест
процедура сложить(а, б)
  вернуть а + б
конец

процедура главная()
  вернуть сложить(3, 5)
конец
конец
`,
      8,
    );
    expect(r.ok, r.message).toBe(true);
    expect(r.regValue).toBe(8);
  });

  it("рекурсия: факториал(5) = 120", async () => {
    const r = await parity(
      `модуль Тест
процедура факториал(н)
  если н <= 1
    вернуть 1
  конец
  вернуть н * факториал(н - 1)
конец

процедура главная()
  вернуть факториал(5)
конец
конец
`,
      120,
    );
    expect(r.ok, r.message).toBe(true);
    expect(r.regValue).toBe(120);
  });

  it("вложенные вызовы: сложить(умножить(2, 3), 4)", async () => {
    const r = await parity(
      `модуль Тест
процедура умножить(х, у)
  вернуть х * у
конец

процедура сложить(а, б)
  вернуть а + б
конец

процедура главная()
  вернуть сложить(умножить(2, 3), 4)
конец
конец
`,
      10,
    );
    expect(r.ok, r.message).toBe(true);
    expect(r.regValue).toBe(10);
  });

  it("вызов как инструкция (результат снимается)", async () => {
    const r = await parity(
      `модуль Тест
процедура шум(х)
  вернуть х
конец

процедура главная()
  шум(1)
  вернуть 42
конец
конец
`,
      42,
    );
    expect(r.ok, r.message).toBe(true);
    expect(r.regValue).toBe(42);
  });
});

describe("oracle/parity: объекты, массивы, хост-вызовы", () => {
  it("литерал объекта и поле", async () => {
    const r = await parity(
      moduleOf(`
процедура главная()
  пусть p = { х: 3, у: 4 }
  вернуть p.х * 10 + p.у
конец
`),
      34,
    );
    expect(r.ok, r.message).toBe(true);
    expect(r.regValue).toBe(34);
  });

  it("присвоение полю объекта", async () => {
    const r = await parity(
      moduleOf(`
процедура главная()
  пусть p = { х: 1, у: 2 }
  p.х = 40
  вернуть p.х + p.у
конец
`),
      42,
    );
    expect(r.ok, r.message).toBe(true);
    expect(r.regValue).toBe(42);
  });

  it("вложенный объект и доступ через хост", async () => {
    const r = await parity(
      moduleOf(`
процедура главная()
  пусть p = { координаты: { х: 7 } }
  вернуть система.объект.получить(система.объект.получить(p, "координаты"), "х")
конец
`),
      7,
    );
    expect(r.ok, r.message).toBe(true);
    expect(r.regValue).toBe(7);
  });

  it("литерал массива и системный вызов длины: трасса syscall совпадает", async () => {
    const r = await parity(
      moduleOf(`
процедура главная()
  пусть a = [1, 2, 3]
  вернуть система.массив.длина(a)
конец
`),
      3,
    );
    expect(r.ok, r.message).toBe(true);
    expect(r.regValue).toBe(3);
    // Трасса: три «добавить» + одна «длина» + возврат точки входа.
    const invokes = r.stackTrace.filter((s) => s.kind === "invoke");
    expect(invokes.map((s) => (s.kind === "invoke" ? s.name : ""))).toEqual([
      "система.массив.создать",
      "система.массив.добавить",
      "система.массив.добавить",
      "система.массив.добавить",
      "система.массив.длина",
    ]);
  });

  it("строковые syscall-вызовы совпадают по трассе", async () => {
    const r = await parity(
      moduleOf(`
процедура главная()
  вернуть система.строка.длина("привет")
конец
`),
      6,
    );
    expect(r.ok, r.message).toBe(true);
    expect(r.regValue).toBe(6);
  });
});

describe("oracle/parity: реальные фикстуры проекта", () => {
  const fixtures = [
    "func_params.osnova",
    "hello.osnova",
  ];

  for (const name of fixtures) {
    it(`фикстура ${name}: трассы и значения совпадают`, async () => {
      const file = path.join(__dirname, "..", "runtime", "fixtures", name);
      const source = fs.readFileSync(file, "utf-8");
      const result = await runParity(source);
      expect("skipped" in result).toBe(false);
      if ("skipped" in result) return;
      expect(result.message).toBeTruthy();
      expect(result.ok).toBe(true);
      expect(result.regValue).toEqual(result.stackValue);
    });
  }
});

/**
 * Корпус регистрового паритета: по одному файлу на конструкцию.
 *
 * `expected` задан **независимо** от обеих VM — иначе тест ловил бы только
 * расхождение бэкендов, но не общую ошибку в обоих. Файлы лежат в
 * `src/runtime/fixtures/reg-parity/`, поэтому кейс паритета можно прогнать и
 * вручную: `npx tsx src/cli.ts parity <файл>` (код возврата 0 — совпало).
 */
describe("oracle/parity: корпус конструкций (Шаг 1 регистрового ядра)", () => {
  const corpus: Array<{ file: string; expected: number; what: string }> = [
    { file: "while.osnova", expected: 1049, what: "пока + прервать + продолжить" },
    { file: "foreach.osnova", expected: 13075, what: "для_каждого: элемент, индекс, вложенность" },
    { file: "tuple.osnova", expected: 1541, what: "кортежи, распаковка в 2 и 3 имени" },
    { file: "try.osnova", expected: 11908, what: "попробовать/иначе_попытка/выбросить, вложенность, поймать" },
  ];

  for (const { file, expected, what } of corpus) {
    it(`${file} (${what}) → ${expected} на обеих VM`, async () => {
      const casePath = path.join(__dirname, "..", "runtime", "fixtures", "reg-parity", file);
      const source = fs.readFileSync(casePath, "utf-8");
      const result = await runParity(source, { expectedReturn: expected });
      expect("skipped" in result, `ожидался паритет, а не отказ: ${file}`).toBe(false);
      if ("skipped" in result) return;
      expect(result.stackValue, `стековая VM: ${result.message}`).toBe(expected);
      expect(result.ok, result.message).toBe(true);
      expect(result.regValue).toBe(expected);
      expect(result.expectationFailed).toBe(false);
    });
  }

  it("трасса корпуса foreach содержательна (системные вызовы реально сверяются)", async () => {
    const casePath = path.join(__dirname, "..", "runtime", "fixtures", "reg-parity", "foreach.osnova");
    const source = fs.readFileSync(casePath, "utf-8");
    const result = await runParity(source);
    expect("skipped" in result).toBe(false);
    if ("skipped" in result) return;
    const invokes = result.stackTrace.filter((s) => s.kind === "invoke");
    expect(invokes.length).toBeGreaterThan(10);
    expect(invokes.some((s) => s.kind === "invoke" && s.name === "система.итератор.из")).toBe(true);
    expect(invokes.some((s) => s.kind === "invoke" && s.name === "система.массив.получить")).toBe(true);
  });
});

describe("oracle/parity: вне среза — явный отказ, а не тихое расхождение", () => {
  // Регистровый бэкенд Шага 1 покрывает весь проверяемый здесь набор;
  // отказов быть не должно — тест фиксирует это как инвариант.
  const supported: Array<[string, string]> = [
    ["пока", "пусть i = 0\n  пока i < 3\n    i = i + 1\n  конец\n  вернуть i"],
    ["для_каждого", "пусть сумма = 0\n  для_каждого x в [1, 2]\n    сумма = сумма + x\n  конец\n  вернуть сумма"],
    ["кортеж", "пусть a, b = пара()\n  вернуть a + b"],
    ["попробовать", "попробовать\n    выбросить \"о\"\n  иначе_попытка e\n    вернуть 2\n  конец"],
  ];

  for (const [label, body] of supported) {
    it(`${label} — больше не отказ (паритет или честная ошибка VM)`, async () => {
      const prelude =
        label === "кортеж" ? "процедура пара()\n  вернуть 1, 2\nконец\n" : "";
      const result = await runParity(
        `модуль Тест\n${prelude}процедура главная()\n  ${body}\nконец\nконец\n`,
      );
      expect("skipped" in result, `неожиданный отказ: ${"skipped" in result ? result.reason : ""}`).toBe(false);
    });
  }
});
