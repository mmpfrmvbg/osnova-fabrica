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
import { compileSource } from "../compiler/compiler";
import { deprecatedClosingsOf } from "./deprecatedEnds";
import {
  E2K_LAYERS,
  EXAMPLE_DIR_RE,
  readBoundaries,
  readExamples,
  renderIndex,
  type Example,
} from "./examplesIndex";
import { MultiReturnRefusal, buildE2kImage } from "./e2kProgramRun";
import { formatValue, runProgramOnVm } from "./programRunner";

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
const EXPECTED_EXAMPLES = 44;
const EXPECTED_E2K = 24;

/**
 * СЧЁТЧИК ЛЕГАСИ-ЗАКРЫТИЙ: сколько в корпусе закрытий одиночным `конец`.
 *
 * Считает тот же механизм, что отчёт корпуса (`src/scripts/deprecatedEnds.ts`) —
 * предупреждения компилятора вида `deprecated_closer`. Пример №1 пришёл из линии
 * e2k текстом без изменения, и три его `конец` здесь названы числом: это долг, а
 * не образец. Новые примеры пишутся каноном, поэтому число может только
 * уменьшаться — как 73 → 1 в учебнике.
 */
const EXPECTED_LEGACY_CLOSERS = 3;

const examples: Example[] = readExamples(ROOT);
const boundaries = readBoundaries(ROOT);

/** Эталон примера строками: как в учебнике, хвостовые пробелы не значимы. */
function expectedLines(e: Example): string[] {
  const raw = fs.readFileSync(path.join(EXAMPLES, e.dir, "expected.txt"), "utf-8");
  const lines = raw.split("\n").map((l) => l.replace(/\s+$/u, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Эталон примера одной строкой — для сверки с возвратом точки входа. */
const expectedValue = (e: Example): string => expectedLines(e).join("\n");

/** Строка-ссылка на измерение: раздел канона, документ или файл пробы. */
const NAMED_SOURCE_RE = /§\s*\d|docs\/|\S+\.(?:md|ts|py)\b/u;

/**
 * Точка входа примера.
 *
 * По раскладке это `main.osnova`. Но если программа в каталоге одна и названа
 * иначе (`fir.osnova`), это не дефект: в каноне имя файла = имя модуля, и
 * единственный файл однозначен. Неоднозначность (несколько файлов без
 * `main.osnova`) — дефект, и она называется.
 */
function entryOf(e: Example): string | null {
  if (e.modules.includes("main.osnova")) return "main.osnova";
  return e.modules.length === 1 ? e.modules[0]! : null;
}

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

  it("у каждого примера есть программа, expected.txt и meta.json", () => {
    const bad: string[] = [];
    for (const e of examples) {
      for (const file of ["expected.txt", "meta.json"]) {
        if (!fs.existsSync(path.join(EXAMPLES, e.dir, file))) bad.push(`${e.dir}: нет ${file}`);
      }
      if (e.modules.length === 0) bad.push(`${e.dir}: нет ни одного .osnova`);
      else if (entryOf(e) === null) {
        bad.push(`${e.dir}: нет main.osnova, а файлов несколько — точка входа неоднозначна`);
      }
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
      const via = m.expected?.via;
      if (via !== undefined && via !== "вывод" && via !== "возврат") {
        bad.push(`${e.dir}: expected.via = ${String(via)}`);
      }
      // Пример, объявленный работающим на цели, обязан отдавать результат
      // способом, который на цели существует: печати там нет (§13.12).
      if (m.e2k?.status === "работает" && (via ?? "вывод") === "вывод") {
        bad.push(`${e.dir}: объявлен работающим на e2k, но результат берётся из печати — на цели печати нет`);
      }
      // И обязан называть, ЧТО он докажет на живой машине: иначе первую сессию
      // на железе придётся тратить на придумывание утверждений.
      if (m.e2k?.status === "работает" && (m.hardware ?? "").trim().length < 15) {
        bad.push(`${e.dir}: не сказано, что пример доказывает на железе (поле hardware)`);
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
      // Расхождение обязано быть разложено по слоям: «дефект модели» без
      // разложения не доказательство (правило владельца после класса 3).
      const layer = e.meta.e2k.layer;
      if (layer === undefined || !(E2K_LAYERS as readonly string[]).includes(layer)) {
        bad.push(`${e.dir}: слой не назван или назван неверно — «${String(layer)}»`);
      }
    }
    for (const b of boundaries) {
      const reason = (b.e2k.reason ?? "").trim();
      if (reason.length < 15 || !NAMED_SOURCE_RE.test(reason)) {
        bad.push(`граница ${b.path}: причина не названа — «${reason}»`);
      }
      const layer = b.e2k.layer;
      if (layer === undefined || !(E2K_LAYERS as readonly string[]).includes(layer)) {
        bad.push(`граница ${b.path}: слой не назван или назван неверно — «${String(layer)}»`);
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

  it("заявка на атом — с гарантией и существующей проверкой, и атом есть в каталоге", () => {
    // Правило подписи: «реализует» — слишком сильно, «демонстрирует» — слишком
    // слабо. Подпись заявляет атом ВМЕСТЕ с текстом гарантии и указателем на
    // проверку; нет проверки — заявить нельзя. Пустая подпись у языкового
    // примера — норма, а не пробел.
    const known = new Set(ATOM_CATALOGUE.map((a) => a.id));
    const bad: string[] = [];
    for (const e of examples) {
      for (const claim of e.meta.atoms ?? []) {
        if (!known.has(claim.atom)) {
          bad.push(`${e.dir}: атом «${claim.atom}» не найден в каталоге 27 атомов`);
        }
        if (claim.guarantee.trim().length < 15) {
          bad.push(`${e.dir}: у атома ${claim.atom} гарантия не названа — «${claim.guarantee}»`);
        }
        if (claim.check.trim() === "" || !fs.existsSync(path.join(ROOT, claim.check))) {
          bad.push(`${e.dir}: у атома ${claim.atom} проверки нет в дереве — «${claim.check}»`);
        }
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("поле core — это ядро атома, и слов-притязаний на гарантию в нём нет", () => {
    // `core` говорит только «пример есть вычислительное ядро атома». Как только в
    // тексте появляется «обеспечивает» или «гарантирует», поле превращается в
    // заявку на гарантию — а для неё нужно поле `atoms` с проверкой гарантии.
    // Отрицание — не притязание: «гарантии не обеспечивает» это ровно то, что
    // поле обязано говорить, поэтому `не обеспечивает` из проверки исключено.
    // Границы слова `\b` здесь не годятся: в JS она ASCII-ная, а перед кириллицей
    // не срабатывает — проверено прогоном (отрицание не снималось).
    const known = new Set(ATOM_CATALOGUE.map((a) => a.id));
    const CLAIM_WORDS = ["обеспечива", "гарантиру", "гарантирует", "реализует гарантию"];
    const NEGATED = /(^|\s)не\s+(?:обеспечива|гарантиру|гарантирует)\S*/gu;
    const bad: string[] = [];
    for (const e of examples) {
      const core = e.meta.core;
      if (core === undefined) continue;
      if (!known.has(core.atom)) {
        bad.push(`${e.dir}: ядро атома «${core.atom}» не найдено в каталоге 27 атомов`);
      }
      if (core.what.trim().length < 10) bad.push(`${e.dir}: core.what не назван — «${core.what}»`);
      const text = `${core.what} ${core.note ?? ""}`.toLowerCase().replace(NEGATED, "");
      for (const word of CLAIM_WORDS) {
        if (text.includes(word)) {
          bad.push(`${e.dir}: core притязает на гарантию словами «${word}» — для гарантии нужно поле atoms с проверкой`);
        }
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("устаревшие закрытия `конец` в корпусе — счётчик, который может только уменьшаться", () => {
    // Правило счёта — метка компилятора `deprecated_closer`, тот же, которым
    // считает отчёт корпуса (`src/scripts/deprecatedEnds.ts`). Своё правило
    // разошлось бы с их числом, и оба стали бы врать по-разному.
    //
    // Компилируется КАЖДЫЙ пример в своём каталоге: многомодульный пример
    // (глава 10) склейкой текстов не разбирается — импорт ищется на диске.
    const counts: Array<{ dir: string; count: number }> = [];
    const bad: string[] = [];
    const singleFile: Array<{ file: string; text: string }> = [];
    for (const e of examples) {
      const sources = e.modules.map((m) => fs.readFileSync(path.join(EXAMPLES, e.dir, m), "utf-8"));
      const entry = entryOf(e) ?? e.modules[0]!;
      const r = compileSource(sources[e.modules.indexOf(entry)]!, {
        filename: entry,
        baseDir: path.join(EXAMPLES, e.dir),
        warnDeprecated: true,
      });
      const failed = r.lexerErrors.length > 0 || r.parserErrors.length > 0 || r.module === null;
      if (failed) bad.push(`${e.dir}: пример не разбирается — счёт закрытий невозможен`);
      counts.push({ dir: e.dir, count: failed ? 0 : r.warnings.filter((w) => w.kind === "deprecated_closer").length });
      if (e.modules.length === 1) singleFile.push({ file: e.dir, text: sources[0]! });
    }
    expect(bad, bad.join("\n")).toEqual([]);

    // Сверка механизмов: на однофайльных примерах мой счёт обязан совпасть со
    // счётом отчёта корпуса — иначе это два разных правила под одним именем.
    const theirs = deprecatedClosingsOf(singleFile).reduce((sum, r) => sum + r.count, 0);
    const mineSingle = counts
      .filter((c) => examples.find((e) => e.dir === c.dir)!.modules.length === 1)
      .reduce((sum, c) => sum + c.count, 0);
    expect(mineSingle, "мой счёт против счёта отчёта корпуса (однофайльные)").toBe(theirs);

    // Пример №1 пришёл из линии e2k текстом без изменения — три его `конец`
    // законны и названы числом. Новые примеры пишутся каноном, поэтому число
    // может только уменьшаться — как 73 → 1 в учебнике.
    expect(
      counts.reduce((sum, c) => sum + c.count, 0),
      "устаревших закрытий `конец` в корпусе",
    ).toBe(EXPECTED_LEGACY_CLOSERS);
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

  it("кит для машины не отстал от корпуса", () => {
    // Кит собирается ИЗ корпуса (`npx tsx src/scripts/e2kHardwareKit.ts`), а его
    // таблица эталонов плоская — чтобы читаться на машине, где может не быть ни
    // python, ни jq, зато есть awk. Если добавить целевой пример и не пересобрать
    // кит, машина прогонит старый набор: это обязано быть видно здесь, а не на
    // железе за неделю доступа.
    const ready = examples.filter((e) => e.meta.e2k.status === "работает").length;
    const kitReadme = path.join(ROOT, "tools", "e2k-hardware", "README.md");
    const kit = path.join(ROOT, "tools", "e2k-hardware", "expected.tsv");
    const problems: string[] = [];
    if (!fs.existsSync(kitReadme)) {
      problems.push("нет tools/e2k-hardware/README.md — порядок прогонов негде смотреть");
    }
    if (!fs.existsSync(kit)) {
      problems.push("нет tools/e2k-hardware/expected.tsv — пересобрать: npx tsx src/scripts/e2kHardwareKit.ts");
    } else {
      const rows = fs
        .readFileSync(kit, "utf-8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "").length;
      if (rows !== ready) {
        problems.push(
          `в ките ${String(rows)} строк эталонов, а целевых примеров ${String(ready)} — пересобрать: npx tsx src/scripts/e2kHardwareKit.ts`,
        );
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("границы со слоем «обвязка» действительно отклоняются обвязкой", () => {
    // Граница — не запись в списке, а работающее утверждение. Для слоя «обвязка»
    // это значит: программа обязана быть ОТКЛОНЕНА раннером с названной причиной.
    // Если обвязку «починят», а граница останется, тест покраснеет — и это
    // правильно: список границ обязан совпадать с поведением, а не с памятью.
    const bad: string[] = [];
    for (const b of boundaries.filter((x) => x.e2k.layer === "обвязка")) {
      const source = fs.readFileSync(path.join(ROOT, b.path), "utf-8");
      // Граница обязана быть ГРАНИЦЕЙ: образ не собирается, причина названа. А
      // если граница про возвраты — отказ обязан быть именно тем, что заявлен.
      const aboutReturns = /возврат/iu.test(b.e2k.reason ?? "");
      try {
        buildE2kImage(source);
        bad.push(`${b.path}: обвязка СОБРАЛА образ, хотя граница утверждает отказ — обновить границу`);
      } catch (e) {
        if (aboutReturns && !(e instanceof MultiReturnRefusal)) {
          bad.push(`${b.path}: отказ не тот, что заявлен: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
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
      const { output, value, error } = await runProgramOnVm(sources, entryOf(e) ?? "main.osnova");
      expect(error, `пример должен исполняться: ${error ?? ""}`).toBeNull();
      if (e.meta.expected.via === "возврат") {
        // Результат — возврат процедуры: печатать программа не может (на цели
        // печати нет), поэтому эталон сверяется со значением точки входа.
        expect(formatValue(value), `возврат ${e.dir}`).toBe(expectedValue(e));
        return;
      }
      expect(output.map((l) => l.replace(/\s+$/u, ""))).toEqual(expectedLines(e));
    });
  }
});
