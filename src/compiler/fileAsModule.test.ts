/**
 * БЛОК 3, пункт 1: **файл = модуль**.
 *
 * # Что решено
 *
 * Шапка `модуль имя` перестаёт быть обязательной: файл сам является модулем, а имя
 * берётся из имени файла (`привет.osnova` → модуль «привет»). Legacy-форма
 * `модуль имя … конец_модуля` принимается без изменений — тот же приём, что с
 * `конец_X` (БЛОК 1 v2): канон новый, legacy работает.
 *
 * # Замер, определивший трактовку пункта 1.3 (2026-09-19, до правки)
 *
 * | корпус | число |
 * |---|---|
 * | файлов `.osnova` всего | 68 |
 * | с шапкой `модуль имя` | 68 |
 * | с `конец_модуля` | 11 |
 * | **с шапкой БЕЗ закрытия модуля** | **57** |
 *
 * Файлов без шапки в корпусе не было ни одного. Отсюда решение владельца: сделать
 * «шапка без `конец_модуля`» **ошибкой** значило бы обрушить 57 из 68 файлов
 * корпуса и 46 файлов оракулов, то есть нарушить два собственных критерия блока
 * («legacy принимается», «npm test — 0 падений»). Поэтому:
 *
 * | случай | что это | поведение |
 * |---|---|---|
 * | нет шапки | **канон**: файл = модуль | компилируется, имя из файла |
 * | `модуль имя … конец_модуля` | legacy | принимается |
 * | `модуль имя` без закрытия | legacy-толерантность (корпус) | принимается; **предупреждение** по флагу |
 * | `конец_модуля` без шапки | **смешение**: закрытие без открытия | **ошибка** с точной причиной |
 *
 * Предупреждение — информационное, как и предупреждение об устаревшем `конец`:
 * по умолчанию молчит (корпус не мигрирован), включается `warnDeprecated` /
 * `--warn-deprecated`, на `compilerSuccess` не влияет.
 *
 * # Негативный контроль (1.5)
 *
 * Приём без шапки — несущая проверка, а не украшение: на компиляторе ДО этой
 * правки файл без `модуль` отвергался ошибкой «Ожидается 'модуль'» и `module`
 * был `null`. Проверки ниже падают и на старом компиляторе, и на любом, где
 * приём снят или имя модуля перестало браться из файла.
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compileSource } from "./compiler";
import { parse } from "./parser";
import type { ParseOptions, ParseWarning } from "./parser";
import { tokenize } from "./lexer";

/**
 * Вид предупреждения о смешении форм.
 *
 * Сравнение идёт по строке намеренно: оракул обязан быть красным **по поведению**
 * на компиляторе, где этого вида ещё нет, а не по типам.
 */
const KIND_MODULE_HEADER_WITHOUT_CLOSER = "module_header_without_closer";

function isModuleHeaderWarning(w: ParseWarning): boolean {
  return (w.kind as string) === KIND_MODULE_HEADER_WITHOUT_CLOSER;
}

/** Разбор с именем файла: имя файла — единственный источник имени модуля. */
function parseAs(src: string, filename?: string) {
  const { tokens } = tokenize(src);
  const options: ParseOptions = filename === undefined ? {} : { filename };
  return parse(tokens, options);
}

/** Тело без шапки: файл сам является модулем (канон). */
const HEADERLESS = ["процедура главная()", "  вернуть 0", "конец_процедуры"].join("\n");

/** Legacy: шапка + каноническое закрытие. */
const LEGACY_CLOSED = [
  "модуль привет",
  "процедура главная()",
  "  вернуть 0",
  "конец_процедуры",
  "конец_модуля",
].join("\n");

/** Legacy корпуса: шапка + одиночный `конец` (БЛОК 1 v2). */
const LEGACY_BARE_END = ["модуль t", "процедура главная()", "  вернуть 0", "конец", "конец"].join("\n");

/** Legacy корпуса БЕЗ закрытия модуля — 57 из 68 файлов (замер 2026-09-19). */
const LEGACY_UNCLOSED = ["модуль t", "процедура главная()", "  вернуть 0", "конец_процедуры"].join("\n");

/** Смешение: закрытие модуля без шапки. */
const CLOSER_WITHOUT_HEADER = [
  "процедура главная()",
  "  вернуть 0",
  "конец_процедуры",
  "конец_модуля",
].join("\n");

describe("1.1 файл без «модуль имя» компилируется, имя модуля = имя файла", () => {
  it("шапки нет — компиляция успешна", () => {
    const r = compileSource(HEADERLESS, { filename: "привет.osnova" });
    expect(r.lexerErrors).toEqual([]);
    expect(r.parserErrors).toEqual([]);
    expect(r.compilerSuccess).toBe(true);
    expect(r.module, "модуль собран").not.toBeNull();
  });

  it("имя модуля взято из имени файла", () => {
    const r = compileSource(HEADERLESS, { filename: "привет.osnova" });
    expect(r.module!.moduleName).toBe("привет");
  });

  it("AST: модуль ровно один и назван по файлу", () => {
    const { ast, errors } = parseAs(HEADERLESS, "привет.osnova");
    expect(errors).toEqual([]);
    expect(ast!.modules).toHaveLength(1);
    expect(ast!.modules[0]!.name).toBe("привет");
  });

  it("процедуры файла принадлежат этому модулю", () => {
    const { ast } = parseAs(HEADERLESS, "привет.osnova");
    expect(ast!.modules[0]!.procedures.map((p) => p.name)).toEqual(["главная"]);
  });
});

describe("1.2 legacy-форма «модуль имя … конец_модуля» принимается", () => {
  it("шапка + `конец_модуля`: имя из шапки, а не из файла", () => {
    const r = compileSource(LEGACY_CLOSED, { filename: "другое.osnova" });
    expect(r.parserErrors).toEqual([]);
    expect(r.compilerSuccess).toBe(true);
    expect(r.module!.moduleName, "шапка сильнее имени файла").toBe("привет");
  });

  it("шапка + одиночный `конец` (закрытие БЛОК 1 v2) принимается", () => {
    const r = compileSource(LEGACY_BARE_END, { filename: "т.osnova" });
    expect(r.parserErrors).toEqual([]);
    expect(r.compilerSuccess).toBe(true);
    expect(r.module!.moduleName).toBe("t");
  });

  it("шапка БЕЗ закрытия принимается — 57 из 68 файлов корпуса (замер 2026-09-19)", () => {
    const r = compileSource(LEGACY_UNCLOSED, { filename: "т.osnova" });
    expect(r.parserErrors, "корпус не мигрирован — это не ошибка").toEqual([]);
    expect(r.compilerSuccess).toBe(true);
    expect(r.module!.moduleName).toBe("t");
  });

  it("два модуля в файле по-прежнему разбираются как два", () => {
    const two = [
      "модуль A",
      "процедура fa()",
      "  вернуть 0",
      "конец_процедуры",
      "модуль B",
      "процедура fb()",
      "  вернуть 0",
      "конец_процедуры",
    ].join("\n");
    const { ast, errors } = parseAs(two, "два.osnova");
    expect(errors).toEqual([]);
    expect(ast!.modules.map((m) => m.name)).toEqual(["A", "B"]);
  });
});

describe("1.3 смешение форм: диагностика с точной причиной", () => {
  it("шапка без закрытия: предупреждение, а НЕ ошибка (решение владельца)", () => {
    const r = compileSource(LEGACY_UNCLOSED, { filename: "т.osnova", warnDeprecated: true });
    expect(r.compilerSuccess, "предупреждение не отказ").toBe(true);
    expect(r.module).not.toBeNull();

    const w = r.warnings.find(isModuleHeaderWarning);
    expect(w, "смешение названо").toBeDefined();
    expect(w!.line, "строка шапки").toBe(1);
    expect(w!.message, "причина называет шапку").toContain("модуль");
    expect(w!.message, "причина называет требуемое закрытие").toContain("конец_модуля");
  });

  it("по умолчанию диагностика смешения молчит (корпус не мигрирован)", () => {
    const r = compileSource(LEGACY_UNCLOSED, { filename: "т.osnova" });
    expect(r.warnings).toEqual([]);
  });

  it("закрытая legacy-форма диагностики смешения НЕ даёт", () => {
    const r = compileSource(LEGACY_CLOSED, { filename: "т.osnova", warnDeprecated: true });
    expect(r.warnings.filter(isModuleHeaderWarning)).toEqual([]);
  });

  it("`конец_модуля` без шапки — ОШИБКА с точной причиной", () => {
    const r = compileSource(CLOSER_WITHOUT_HEADER, { filename: "т.osnova" });
    expect(r.compilerSuccess).toBe(false);
    expect(r.parserErrors.length).toBeGreaterThan(0);

    const e = r.parserErrors.find((x) => x.message.includes("конец_модуля"));
    expect(e, "причина названа словом `конец_модуля`, а не общим «Ожидается 'модуль'»").toBeDefined();
    expect(e!.line, "строка закрытия").toBe(4);
  });
});

describe("1.4 имя модуля из имени файла", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["привет.osnova", "привет"],
    ["todo-service.osnova", "todo-service"],
    ["math.osnova", "math"],
    ["привет", "привет"],
    ["путь/вложенный/модуль.osnova", "модуль"],
    ["D:\\проекты\\привет.osnova", "привет"],
  ];

  for (const [filename, expected] of cases) {
    it(`${filename} → «${expected}»`, () => {
      const r = compileSource(HEADERLESS, { filename });
      expect(r.parserErrors).toEqual([]);
      expect(r.module!.moduleName).toBe(expected);
    });
  }

  it("расширение снимается, регистр расширения не важен", () => {
    expect(compileSource(HEADERLESS, { filename: "привет.OSNOVA" }).module!.moduleName).toBe("привет");
  });

  it("без имени файла компиляция не падает и имя устойчиво", () => {
    const r = compileSource(HEADERLESS);
    expect(r.parserErrors).toEqual([]);
    expect(r.compilerSuccess).toBe(true);
    expect(r.module!.moduleName, "то же имя по умолчанию, что у входного файла в compileSource").toBe(
      "вход",
    );
  });
});

describe("1.5 негативный контроль: приём без «модуль» — несущая проверка", () => {
  it("старое поведение снято: «Ожидается 'модуль'» на файле без шапки больше нет", () => {
    const r = compileSource(HEADERLESS, { filename: "контроль.osnova" });
    const messages = r.parserErrors.map((e) => e.message);
    expect(messages, "на компиляторе до правки здесь была именно эта ошибка").not.toContain(
      "Ожидается 'модуль'",
    );
    expect(r.parserErrors).toEqual([]);
  });

  it("имя модуля невозможно получить иначе, чем из файла", () => {
    const name = "особый-контроль-1";
    const r = compileSource(HEADERLESS, { filename: `${name}.osnova` });
    expect(r.module!.moduleName, "в исходнике этого имени нет — источник только имя файла").toBe(name);
  });

  it("имя файла не подменяет шапку: в шапке имя другое и оно выигрывает", () => {
    const r = compileSource(LEGACY_CLOSED, { filename: "особый-контроль-2.osnova" });
    expect(r.module!.moduleName).toBe("привет");
  });
});

/**
 * Эти проверки добавлены **пробой**, а не заданием: задание описывало файл без
 * шапки как «процедуры и всё», а файл — это ещё импорт, `тип` и `экспорт`, и
 * ошибка здесь была бы не видна на минимальном примере. Отдельно проверяется
 * цель импорта: имя модуля импортируемого файла обязано браться из имени ЭТОГО
 * файла, а не входного (`parseModuleOrThrow`).
 */
describe("дополнение оракула: файл = модуль вместе с импортом, типом и экспортом", () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) {
      fs.rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  function tmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-file-module-"));
    dirs.push(dir);
    return dir;
  }

  function write(dir: string, name: string, lines: string[]): void {
    fs.writeFileSync(path.join(dir, name), lines.join("\n"), "utf-8");
  }

  function compileAt(dir: string, name: string) {
    return compileSource(fs.readFileSync(path.join(dir, name), "utf-8"), {
      baseDir: dir,
      filename: name,
    });
  }

  it("файл без шапки с импортом компилируется, имя — из имени файла", () => {
    const dir = tmpDir();
    write(dir, "у.osnova", ["процедура экспорт сложить(а, б)", "  вернуть а + б", "конец_процедуры"]);
    write(dir, "главный.osnova", [
      'использовать модуль У из "у.osnova"',
      "",
      "процедура главная()",
      "  вернуть У.сложить(2, 3)",
      "конец_процедуры",
    ]);
    const r = compileAt(dir, "главный.osnova");
    expect(r.parserErrors).toEqual([]);
    expect(r.compilerSuccess).toBe(true);
    expect(r.module!.moduleName).toBe("главный");
    expect(r.module!.procedures.map((p) => p.name)).toContain("У__сложить");
  });

  it("файл без шапки с `тип` компилируется", () => {
    const dir = tmpDir();
    write(dir, "типный.osnova", [
      "тип Точка { x: Число }",
      "",
      "процедура главная()",
      "  пусть т = { x: 7 }",
      "  вернуть т.x",
      "конец_процедуры",
    ]);
    const r = compileAt(dir, "типный.osnova");
    expect(r.parserErrors).toEqual([]);
    expect(r.compilerSuccess).toBe(true);
    expect(r.module!.moduleName).toBe("типный");
  });

  it("файл без шапки с `экспорт` компилируется", () => {
    const dir = tmpDir();
    write(dir, "экспортный.osnova", ["экспорт процедура дать()", "  вернуть 42", "конец_процедуры"]);
    const r = compileAt(dir, "экспортный.osnova");
    expect(r.parserErrors).toEqual([]);
    expect(r.compilerSuccess).toBe(true);
    expect(r.module!.procedures.map((p) => p.name)).toEqual(["дать"]);
  });

  it("файл без шапки, закрытый одиночным `конец`, компилируется (legacy-толерантность)", () => {
    const dir = tmpDir();
    write(dir, "одиночный.osnova", ["процедура главная()", "  вернуть 1", "конец"]);
    const r = compileAt(dir, "одиночный.osnova");
    expect(r.parserErrors).toEqual([]);
    expect(r.compilerSuccess).toBe(true);
    expect(r.module!.moduleName).toBe("одиночный");
  });

  it("ЦЕЛЬ импорта без шапки: имя модуля берётся из имени импортируемого файла", () => {
    const dir = tmpDir();
    write(dir, "у2.osnova", ["процедура экспорт удвоить(а)", "  вернуть а * 2", "конец_процедуры"]);
    write(dir, "главный2.osnova", [
      'использовать модуль У2 из "у2.osnova"',
      "",
      "процедура главная()",
      "  вернуть У2.удвоить(21)",
      "конец_процедуры",
    ]);
    const r = compileAt(dir, "главный2.osnova");
    expect(r.parserErrors, "импортируемый файл без шапки не отвергнут").toEqual([]);
    expect(r.compilerSuccess).toBe(true);
    expect(r.module!.procedures.map((p) => p.name)).toContain("У2__удвоить");
  });
});

/**
 * Пустой файл = пустой модуль — **следствие** «файл = модуль», а не отдельное
 * правило.
 *
 * # Что было до правки
 *
 * `compilerSuccess = false` при **нуле диагностик во всех фазах**: лексер молчит,
 * парсер молчит, компилятор молчит — и сборки нет. Причина: разбор пропускал
 * путь «файл = модуль», когда поток начинался сразу с `конец_файла` (пустой
 * источник, одни комментарии, одни переводы строк), модулей получалось ноль,
 * AST — `null`, и `compileSource` отказывал по `program.modules.length === 0`.
 *
 * Отказ без диагностики — худший вид отказа: по нему нельзя понять, что не так.
 * Под нормой «файл = модуль» у пустого файла есть честный ответ: это модуль с
 * именем из имени файла и пустым телом.
 *
 * # Негативный контроль
 *
 * Снять правку — краснеет здесь: проверки требуют `compilerSuccess = true` и
 * непустой `module` там, где компилятор до правки отказывал. Отдельно
 * проверяется, что «компилируется пустое» не превратилось в «компилируется
 * что угодно»: файл с посторонним словом по-прежнему отвергается.
 */
describe("пустой файл = пустой модуль (следствие «файл = модуль»)", () => {
  /** Пустой источник, одни переводы строк, одни комментарии обоих видов. */
  const EMPTY_SOURCES: ReadonlyArray<readonly [string, string]> = [
    ["пустой источник", ""],
    ["одни переводы строк", "\n\n\n"],
    ["одни пробелы и переводы строк", "   \n\t\n  \n"],
    ["однострочный комментарий", "// ничего\n"],
    ["несколько однострочных комментариев", "// раз\n// два\n"],
    ["блочный комментарий", "/* ничего */\n"],
    ["комментарии вперемешку", "// раз\n/* два */\n\n// три\n"],
  ];

  for (const [label, source] of EMPTY_SOURCES) {
    it(`${label} — компилируется, 0 диагностик`, () => {
      const r = compileSource(source, { filename: "пустой.osnova" });
      expect(r.lexerErrors, "лексер молчит").toEqual([]);
      expect(r.parserErrors, "парсер молчит").toEqual([]);
      expect(r.compilerErrors, "компилятор молчит").toEqual([]);
      expect(r.semanticErrors, "семантика молчит").toEqual([]);
      expect(r.compilerSuccess, "сборка есть").toBe(true);
      expect(r.module, "модуль собран").not.toBeNull();
    });
  }

  it("имя модуля берётся из имени файла, тело пустое", () => {
    const r = compileSource("", { filename: "пустой.osnova" });
    expect(r.module!.moduleName).toBe("пустой");
    expect(r.module!.procedures, "процедур нет — но это список, а не отсутствие модуля").toEqual([]);
  });

  it("без имени файла — то же имя по умолчанию, что у входного файла", () => {
    const r = compileSource("");
    expect(r.compilerSuccess).toBe(true);
    expect(r.module!.moduleName).toBe("вход");
  });

  it("AST: ровно один модуль, а не ноль", () => {
    const { ast, errors } = parseAs("", "пустой.osnova");
    expect(errors).toEqual([]);
    expect(ast, "AST построен").not.toBeNull();
    expect(ast!.modules).toHaveLength(1);
    expect(ast!.modules[0]!.name).toBe("пустой");
    expect(ast!.modules[0]!.procedures).toEqual([]);
  });

  it("файл, ставший пустым ПОСЛЕ правки, не ломает сборку байткода", () => {
    const r = compileSource("\n", { filename: "пробел.osnova" });
    expect(r.module, "байткод-модуль есть").not.toBeNull();
    expect(r.module!.version, "формат модуля на месте").toBe(1);
    expect(r.module!.procedures).toEqual([]);
  });

  it("НЕГАТИВНЫЙ КОНТРОЛЬ: постороннее слово в пустом файле — по-прежнему отказ", () => {
    const r = compileSource("ерунда", { filename: "мусор.osnova" });
    expect(r.compilerSuccess, "«компилируется пустое» не значит «компилируется что угодно»").toBe(false);
    expect(r.parserErrors.length, "и отказ назван диагностикой, а не молчанием").toBeGreaterThan(0);
  });

  it("НЕГАТИВНЫЙ КОНТРОЛЬ: `конец_модуля` в пустом файле — по-прежнему отказ", () => {
    const r = compileSource("конец_модуля\n", { filename: "закрытие.osnova" });
    expect(r.compilerSuccess).toBe(false);
    expect(r.parserErrors.some((e) => e.message.includes("конец_модуля"))).toBe(true);
  });
});
