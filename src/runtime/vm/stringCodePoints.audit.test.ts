/**
 * ОРАКУЛ НА КЛАСС: ЕДИНИЦА ДЛИНЫ И ИНДЕКСАЦИИ СТРОК — КОДОВАЯ ТОЧКА.
 *
 * **Решение владельца 2026-09-28 (принято):** длина и индексация строк считаются кодовыми
 * точками. До этого VM считала единицы UTF-16 (JS `String.length`), и это было ИЗМЕРЕНО и
 * записано в канон §13.6 — то есть канон говорил одно, а владелец решил другое; здесь и в
 * `stringUnits.ts` решение исполнено, канон обновлён.
 *
 * **Почему оракул, а не набор проверок.** Различие единиц видно только на различающих случаях:
 * для BMP (ASCII, кириллица) обе единицы дают одно и то же число, поэтому обычные примеры
 * «зелены при любой реализации». Свидетелем взят **Python**: он отдаёт кодовые точки, он не
 * зависит от нашей реализации и его ответ нельзя подогнать, не тронув эталон.
 *
 * **Канал эталона пиннится, и это не украшение.** На этом хосте stdout Python по умолчанию
 * **cp1251**, и печать эмодзи падает `UnicodeEncodeError` — то есть незапинненный эталон
 * ломается на первом же не-BMP символе, и это выглядело бы дефектом строк, а не канала.
 * Поэтому `PYTHONIOENCODING=utf-8` ставится в окружение запуска, а вывод берётся в
 * ASCII-экранировании (`ensure_ascii`), где кодировка канала уже ни при чём.
 *
 * **Чего оракул НЕ делает.** Не проверяет представление на цели (там байты UTF-8, §3.47) и не
 * проверяет `examples/**`: корпус перегенерации не подлежит (чужая плоскость), и не-BMP в нём
 * нет вовсе (замер: 0 файлов).
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { compileSource } from "../../compiler/compiler";
import { VM } from "./interpreter";
import { codePointIndexOf, codePointLength, codePointSlice, compareCodePoints } from "./stringUnits";

/** Сетка: случай, программа языка и ожидание (оно же — ответ Python). */
interface Case {
  readonly label: string;
  readonly body: string;
  /** Индекс величины в массиве эталона Python (порядок задаётся эталоном). */
  readonly index: number;
}

const CASES: readonly Case[] = [
  { label: 'длина("")', body: 'вернуть система.строка.длина("")', index: 0 },
  { label: 'длина("abc")', body: 'вернуть система.строка.длина("abc")', index: 1 },
  { label: 'длина("Аня")', body: 'вернуть система.строка.длина("Аня")', index: 2 },
  { label: 'длина("Привет, мир")', body: 'вернуть система.строка.длина("Привет, мир")', index: 3 },
  { label: 'длина("🙂")', body: 'вернуть система.строка.длина("🙂")', index: 4 },
  { label: 'длина("и"+U+0306)', body: 'вернуть система.строка.длина("и\u0306")', index: 5 },
  { label: 'длина(семья)', body: 'вернуть система.строка.длина("👨‍👩‍👧")', index: 6 },
  { label: 'подстрока("🙂",0,1)', body: 'вернуть система.строка.подстрока("🙂", 0, 1)', index: 7 },
  { label: 'подстрока("🙂x",1,2)', body: 'вернуть система.строка.подстрока("🙂x", 1, 2)', index: 8 },
  { label: 'подстрока("🙂x",0,2)', body: 'вернуть система.строка.подстрока("🙂x", 0, 2)', index: 9 },
  { label: 'подстрока("Аня",0,1)', body: 'вернуть система.строка.подстрока("Аня", 0, 1)', index: 10 },
  { label: 'подстрока("Аня",1,3)', body: 'вернуть система.строка.подстрока("Аня", 1, 3)', index: 11 },
  { label: 'подстрока("abc",1,3)', body: 'вернуть система.строка.подстрока("abc", 1, 3)', index: 12 },
  { label: 'подстрока("🙂",1,0)', body: 'вернуть система.строка.подстрока("🙂", 1, 0)', index: 13 },
  { label: 'найти("🙂x","x")', body: 'вернуть система.строка.найти("🙂x", "x")', index: 14 },
  { label: 'найти("🙂x","🙂")', body: 'вернуть система.строка.найти("🙂x", "🙂")', index: 15 },
  { label: 'найти("Аня","ня")', body: 'вернуть система.строка.найти("Аня", "ня")', index: 16 },
  { label: 'найти("abc","z")', body: 'вернуть система.строка.найти("abc", "z")', index: 17 },
  { label: '"🙂" > "\\uFFFD"', body: 'вернуть "🙂" > "\uFFFD"', index: 18 },
  { label: '"🙂" < "\\uFFFD"', body: 'вернуть "🙂" < "\uFFFD"', index: 19 },
  { label: '"🙂" > "z"', body: 'вернуть "🙂" > "z"', index: 20 },
  { label: '"Аня" > "А"', body: 'вернуть "Аня" > "А"', index: 21 },
  { label: '"abc" == "abc"', body: 'вернуть "abc" == "abc"', index: 22 },
  { label: 'содержит("🙂x","x")', body: 'вернуть система.строка.содержит("🙂x", "x")', index: 23 },
  { label: 'разделить → длина[0]', body: 'пусть части = система.строка.разделить("🙂,x", ",")\n  вернуть система.строка.длина(части[0])', index: 24 },
];

/** Эталон на Python: список величин в порядке `CASES[].index`. */
const PYTHON_GRID = `
import json, sys
e = "\\U0001F642"
fam = "\\U0001F468\\u200D\\U0001F469\\u200D\\U0001F467"
repl = "\\uFFFD"
values = [
  len(""), len("abc"), len("Аня"), len("Привет, мир"), len(e), len("и\\u0306"), len(fam),
  e[0:1], (e + "x")[1:2], (e + "x")[0:2], "Аня"[0:1], "Аня"[1:3], "abc"[1:3], e[1:0],
  (e + "x").find("x"), (e + "x").find(e), "Аня".find("ня"), "abc".find("z"),
  e > repl, e < repl, e > "z", "Аня" > "А", "abc" == "abc",
  "x" in (e + "x"), len((e + ",x").split(",")[0]),
]
print(json.dumps(values, ensure_ascii=True))
`;

function pythonAvailable(): boolean {
  try {
    execFileSync("python", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Запуск эталона с ПИННЕННЫМ каналом (UTF-8) — см. шапку файла. */
function pythonGrid(): unknown[] {
  const raw = execFileSync("python", ["-c", PYTHON_GRID], {
    encoding: "utf-8",
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  return JSON.parse(raw) as unknown[];
}

async function runOsnova(body: string): Promise<unknown> {
  const source = ["модуль ОракулТочек", "процедура главная()", `  ${body}`, "конец", "конец", ""].join("\n");
  const compiled = compileSource(source, { filename: "оракул-точек.osnova" });
  expect(compiled.compilerSuccess, compiled.semanticErrors.map((e) => e.message).join("; ")).toBe(true);
  expect(compiled.module, "модуль собран").not.toBeNull();
  const vm = new VM(compiled.module!, { maxSteps: 5000 });
  return await vm.runProcedure(vm.findProcedureIndex("главная"), []);
}

const HAS_PYTHON = pythonAvailable();
if (!HAS_PYTHON) {
  console.log(
    "[оракул точек] Python не найден — дифференциальная сверка НЕ ВЫПОЛНЕНА " +
      "(это «не проверено», а не «пройдено»); семантические привязки ниже исполняются всегда",
  );
}

describe("кодовые точки против эталона Python (канал пиннится к UTF-8)", () => {
  it.skipIf(!HAS_PYTHON)("дифференциальная сверка: сетка 25 случаев — расхождений ноль", async () => {
    const reference = pythonGrid();
    expect(reference).toHaveLength(CASES.length);
    const divergent: string[] = [];
    for (const item of CASES) {
      const ours = await runOsnova(item.body);
      const theirs = reference[item.index];
      if (ours !== theirs) {
        divergent.push(`${item.label}: наш ${JSON.stringify(ours)}, Python ${JSON.stringify(theirs)}`);
      }
    }
    expect(
      divergent,
      `единица строки разошлась с эталоном (кодовые точки):\n  ${divergent.join("\n  ")}`,
    ).toEqual([]);
  });

  it("вход эталона проверяется: список сверок непустой и каждый индекс занят один раз", () => {
    // Иначе «0 расхождений» могло бы значить «0 сверок».
    expect(CASES.length).toBeGreaterThan(20);
    const used = CASES.map((c) => c.index).sort((a, b) => a - b);
    expect(used).toEqual([...Array(CASES.length).keys()]);
  });

  it.skipIf(!HAS_PYTHON)("канал эталона пиннится: не-BMP переживает круг через UTF-8", () => {
    // Если канал не запиннить, эмодзи роняет печать Python (на этом хосте — cp1251), и падал бы
    // не наш ответ, а эталон. Проверяем именно пиннинг: тот же символ туда и обратно.
    const raw = execFileSync(
      "python",
      ["-c", 'import sys, json; print(json.dumps("\\U0001F642\\u0306", ensure_ascii=True))'],
      { encoding: "utf-8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } },
    );
    expect(JSON.parse(raw), "не-BMP и комбинирующий символ прошли канал целиком").toBe("🙂\u0306");
  });
});

describe("семантика кодовых точек: привязки без внешнего эталона (исполняются всегда)", () => {
  it("длина: BMP как была, не-BMP — по кодовым точкам", async () => {
    expect(await runOsnova('вернуть система.строка.длина("")')).toBe(0);
    expect(await runOsnova('вернуть система.строка.длина("abc")')).toBe(3);
    expect(await runOsnova('вернуть система.строка.длина("Аня")')).toBe(3);
    expect(await runOsnova('вернуть система.строка.длина("Привет, мир")')).toBe(11);
    expect(await runOsnova('вернуть система.строка.длина("🙂")')).toBe(1);
    expect(await runOsnova('вернуть система.строка.длина("👨‍👩‍👧")')).toBe(5);
    expect(await runOsnova('вернуть система.строка.длина("и\u0306")')).toBe(2);
  });

  it("подстрока не рвёт пару и считает края по кодовым точкам", async () => {
    expect(await runOsnova('вернуть система.строка.подстрока("🙂", 0, 1)')).toBe("🙂");
    expect(await runOsnova('вернуть система.строка.подстрока("🙂x", 1, 2)')).toBe("x");
    expect(await runOsnova('вернуть система.строка.подстрока("🙂x", 0, 2)')).toBe("🙂x");
    expect(await runOsnova('вернуть система.строка.подстрока("Аня", 1, 3)')).toBe("ня");
    expect(await runOsnova('вернуть система.строка.подстрока("🙂", 1, 0)')).toBe("");
  });

  it("поиск отвечает индексом в кодовых точках", async () => {
    expect(await runOsnova('вернуть система.строка.найти("🙂x", "x")')).toBe(1);
    expect(await runOsnova('вернуть система.строка.найти("🙂x", "🙂")')).toBe(0);
    expect(await runOsnova('вернуть система.строка.найти("Аня", "ня")')).toBe(1);
    expect(await runOsnova('вернуть система.строка.найти("abc", "z")')).toBe(-1);
  });

  it("порядок строк — по кодовым точкам (класс, отличный от длины)", async () => {
    expect(await runOsnova('вернуть "🙂" > "\uFFFD"')).toBe(true);
    expect(await runOsnova('вернуть "🙂" < "\uFFFD"')).toBe(false);
    expect(await runOsnova('вернуть "🙂" > "z"')).toBe(true);
    expect(await runOsnova('вернуть "Аня" > "А"')).toBe(true);
  });
});

describe("НЕГАТИВНЫЙ КОНТРОЛЬ: оракул различает единицы, а не подтверждает любую", () => {
  it("различающие случаи: кодовые точки и UTF-16 дают РАЗНЫЕ ответы", () => {
    // Если бы единицы совпадали, этот оракул был бы зелёным при любой реализации — то есть
    // «ноль расхождений» ничего не значило бы. Вот доказательство, что случаи различают:
    expect(codePointLength("🙂"), "кодовых точек в «🙂»").toBe(1);
    expect("🙂".length, "единиц UTF-16 в «🙂»").toBe(2);
    expect(codePointLength("👨‍👩‍👧"), "кодовых точек в семье").toBe(5);
    expect("👨‍👩‍👧".length, "единиц UTF-16 в семье").toBe(8);
    expect(codePointIndexOf("🙂x", "x"), "индекс по точкам").toBe(1);
    expect("🙂x".indexOf("x"), "индекс по единицам UTF-16").toBe(2);
    expect(codePointSlice("🙂", 0, 1), "срез по точкам").toBe("🙂");
    expect("🙂".slice(0, 1), "срез по единицам UTF-16 — половина пары").toBe("\ud83d");
    expect(
      compareCodePoints("🙂", "\uFFFD") > 0,
      "по точкам эмодзи выше U+FFFD",
    ).toBe(true);
    expect("🙂" > "\uFFFD", "по единицам UTF-16 — ниже").toBe(false);
  });

  it("мутация (та же, что проверена на дереве): возврат к `s.length` краснит привязки", async () => {
    // Проверяем ВЕЛИЧИНУ, которой краснеет откат: если `длина` снова станет `s.length`,
    // эти два числа разойдутся, и привязка выше покраснеет. Здесь это закреплено числом,
    // чтобы контроль можно было перепроверить и без правки дерева.
    const points = await runOsnova('вернуть система.строка.длина("🙂")');
    expect(points, "наш ответ").toBe(codePointLength("🙂"));
    expect(points, "и он НЕ равен единицам UTF-16").not.toBe("🙂".length);
  });
});
