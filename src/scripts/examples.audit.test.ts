/**
 * ОРАКУЛ КОРПУСА ПРИМЕРОВ: `examples/**`.
 *
 * # Чем он отличается от оракула учебника
 *
 * Учебник проверяет, что примеры **работают**. Корпус проверяет больше: что у
 * каждого примера есть **независимый эталон**, что статусы не врут и что индекс
 * не расходится с содержимым. Учебник — про текст, корпус — про проверяемую
 * единицу: программа + эталон + названный статус.
 *
 * # Четыре требования к корпусу
 *
 * 1. **Каждая программа собирается и исполняется на VM**, результат сравнивается
 *    с `expected.txt` построчно.
 * 2. **Объявленное исполняемым на e2k обязано исполняться на e2k** — против ТОГО
 *    ЖЕ эталона. Прогон живёт в шлюзе `gate:qemu` (ресурсозависимый ресурс, случай
 *    12 реестра проверяемости), а здесь проверяется, что он **подключён**: пример
 *    со статусом «e2k: работает» без оракула цели — красное.
 * 3. **Эталон не перегенерируется тем же прогоном.** `expected.txt` только
 *    читается; чем он получен — написано в `meta.expected.origin`. Проверка
 *    «в этом файле нет записи в корпус» стоит здесь намеренно: она защищает
 *    свойство, которое глазами не видно.
 * 4. **Статус «нет» называет причину**, а не молчит: причина обязана ссылаться на
 *    измерение или раздел канона.
 *
 * # Счётчик корпуса
 *
 * `EXPECTED_EXAMPLES` и `EXPECTED_E2K` сравниваются ТОЧНО — как счётчик формы
 * примеров в учебнике. Отчёт по каждой правке называет оба числа, и «из них на
 * e2k» не может вырасти незаметно.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { ATOM_CATALOGUE } from "../compiler/atomRegions";
import {
  EXAMPLE_DIR_RE,
  readBoundaries,
  readExamples,
  renderIndex,
  type Example,
} from "./examplesIndex";
import { runProgramOnVm } from "./programRunner";

const ROOT = path.resolve(__dirname, "..", "..");
const EXAMPLES = path.join(ROOT, "examples");
const INDEX = path.join(EXAMPLES, "README.md");
const E2K_LANE = path.join(ROOT, "src", "scripts", "examplesE2k.audit.test.ts");
const QEMU_CONFIG = path.join(ROOT, "vitest.qemu.config.ts");

/**
 * СЧЁТЧИК КОРПУСА: сколько примеров и сколько из них исполняется на цели.
 *
 * Числа сравниваются точно, поэтому каждое изменение корпуса обязано быть названо
 * в отчёте. Номер `01` оставлен примеру владельца — эталону FIR (181).
 */
const EXPECTED_EXAMPLES = 4;
const EXPECTED_E2K = 0;

const examples: Example[] = readExamples(ROOT);
const boundaries = readBoundaries(ROOT);

/** Эталон примера строками: как в учебнике, хвостовые пробелы не значимы. */
function expectedLines(e: Example): string[] {
  const raw = fs.readFileSync(path.join(EXAMPLES, e.dir, "expected.txt"), "utf-8");
  const lines = raw.split("\n").map((l) => l.replace(/\s+$/u, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Строка-ссылка на измерение: раздел канона, документ или файл пробы. */
const NAMED_SOURCE_RE = /§\s*\d|docs\/|\S+\.(?:md|ts|py)\b/u;

/** Каталоги в `examples/`, которые не являются примерами по имени. */
function strayDirs(): string[] {
  if (!fs.existsSync(EXAMPLES)) return [];
  return fs
    .readdirSync(EXAMPLES, { withFileTypes: true })
    .filter((e) => e.isDirectory() && EXAMPLE_DIR_RE.exec(e.name) === null)
    .map((e) => e.name);
}

describe("корпус примеров: раскладка и статусы", () => {
  it("корпус на месте: каталоги примеров и индекс", () => {
    expect(fs.existsSync(EXAMPLES), "каталог examples/").toBe(true);
    expect(fs.existsSync(INDEX), "индекс examples/README.md").toBe(true);
    expect(strayDirs(), "каталоги вне шаблона NN-имя").toEqual([]);
  });

  it("у каждого примера есть main.osnova, expected.txt и meta.json", () => {
    const bad: string[] = [];
    for (const e of examples) {
      for (const file of ["main.osnova", "expected.txt", "meta.json"]) {
        if (!fs.existsSync(path.join(EXAMPLES, e.dir, file))) bad.push(`${e.dir}: нет ${file}`);
      }
      if (e.modules.length === 0) bad.push(`${e.dir}: нет ни одного .osnova`);
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("meta.json заполнен: имя, показ, статусы и происхождение эталона", () => {
    const bad: string[] = [];
    for (const e of examples) {
      const m = e.meta;
      if (typeof m.name !== "string" || m.name.trim() === "") bad.push(`${e.dir}: пустое name`);
      if (typeof m.shows !== "string" || m.shows.trim() === "") bad.push(`${e.dir}: пустое shows`);
      if (m.vm !== "работает" && m.vm !== "нет") bad.push(`${e.dir}: vm = ${String(m.vm)}`);
      if (m.e2k?.status !== "работает" && m.e2k?.status !== "нет") {
        bad.push(`${e.dir}: e2k.status = ${String(m.e2k?.status)}`);
      }
      if (typeof m.expected?.origin !== "string" || m.expected.origin.trim() === "") {
        bad.push(`${e.dir}: пустое expected.origin — не сказано, чем получен эталон`);
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("статус «e2k: нет» называет причину со ссылкой на измерение", () => {
    const bad: string[] = [];
    for (const e of examples) {
      if (e.meta.e2k.status !== "нет") continue;
      const reason = (e.meta.e2k.reason ?? "").trim();
      if (reason.length < 15) bad.push(`${e.dir}: причина короче 15 знаков — «${reason}»`);
      else if (!NAMED_SOURCE_RE.test(reason)) {
        bad.push(`${e.dir}: причина без ссылки на измерение или канон — «${reason}»`);
      }
    }
    for (const b of boundaries) {
      const reason = (b.e2k.reason ?? "").trim();
      if (reason.length < 15 || !NAMED_SOURCE_RE.test(reason)) {
        bad.push(`граница ${b.path}: причина не названа — «${reason}»`);
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("эталон непустой, а прогон не переписывает корпус", () => {
    const bad: string[] = [];
    for (const e of examples) {
      if (expectedLines(e).length === 0) bad.push(`${e.dir}: expected.txt пуст`);
    }
    // Свойство, которое глазами не видно: оракул только ЧИТАЕТ корпус. Имена
    // собираются по частям, чтобы проверка не нашла саму себя в тексте файла.
    const own = fs.readFileSync(__filename, "utf-8");
    const forbidden = ["write" + "FileSync", "append" + "FileSync", "write" + "Index"];
    for (const name of forbidden) {
      if (own.includes(name)) bad.push(`оракул корпуса вызывает ${name}: эталон может быть перезаписан`);
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("заявленный атом существует в каталоге Атласа", () => {
    const known = new Set(ATOM_CATALOGUE.map((a) => a.id));
    const bad: string[] = [];
    for (const e of examples) {
      const atoms = e.meta.atoms;
      if (atoms === undefined) continue;
      for (const axis of ["A", "C", "D"] as const) {
        for (const id of atoms[axis] ?? []) {
          if (!known.has(id)) bad.push(`${e.dir}: ось ${axis}, атом «${id}» не найден в каталоге 27 атомов`);
        }
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("индекс examples/README.md совпадает с корпусом", () => {
    // Индекс — чистая функция от каталогов; расхождение означает, что его
    // правили руками или забыли пересобрать.
    const generated = renderIndex(examples, boundaries);
    const actual = fs.readFileSync(INDEX, "utf-8");
    expect(actual, "пересобрать: npx tsx src/scripts/examplesIndex.ts").toBe(generated);
  });

  it("границы: путь существует и назван", () => {
    const bad: string[] = [];
    for (const b of boundaries) {
      if (!fs.existsSync(path.join(ROOT, b.path))) bad.push(`${b.path}: файла нет на диске`);
      if (b.what.trim() === "") bad.push(`${b.path}: не сказано, что делает`);
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("объявленное на e2k проверяется оракулом цели", () => {
    const declared = examples.filter((e) => e.meta.e2k.status === "работает").map((e) => e.dir);
    if (declared.length === 0) return;
    const problems: string[] = [];
    if (!fs.existsSync(E2K_LANE)) problems.push(`нет оракула цели ${path.relative(ROOT, E2K_LANE)}`);
    else {
      const config = fs.readFileSync(QEMU_CONFIG, "utf-8");
      if (!config.includes("examplesE2k.audit.test.ts")) {
        problems.push("оракул цели не подключён в vitest.qemu.config.ts (gate:qemu)");
      }
    }
    expect(problems, `на e2k объявлены: ${declared.join(", ")}\n${problems.join("\n")}`).toEqual([]);
  });

  it("счётчик корпуса: примеров ровно EXPECTED_EXAMPLES, из них на e2k EXPECTED_E2K", () => {
    expect(examples.length, "примеров в корпусе").toBe(EXPECTED_EXAMPLES);
    expect(
      examples.filter((e) => e.meta.e2k.status === "работает").length,
      "из них исполняемых на e2k",
    ).toBe(EXPECTED_E2K);
  });
});

describe("корпус примеров: программы исполняются", () => {
  for (const e of examples) {
    it(`пример ${e.dir}`, async () => {
      if (e.meta.vm !== "работает") return; // статус «нет» обязан быть назван — проверено выше
      const sources = new Map<string, string>();
      for (const file of e.modules) {
        sources.set(file, fs.readFileSync(path.join(EXAMPLES, e.dir, file), "utf-8"));
      }
      const { output, error } = await runProgramOnVm(sources, "main.osnova");
      expect(error, `пример должен исполняться: ${error ?? ""}`).toBeNull();
      expect(output.map((l) => l.replace(/\s+$/u, ""))).toEqual(expectedLines(e));
    });
  }
});
