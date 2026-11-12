/**
 * Оракул АТРИБУЦИИ: ошибка называет свой файл.
 *
 * # Что было
 *
 * Импорты разворачиваются: процедуры импортируемого модуля встраиваются в AST
 * главного. Поэтому ошибка, возникшая ВНУТРИ импортируемого модуля, называлась
 * сборкой главного — измерено замером `.tmp/semantic-attribution.ts` на
 * `apps/task-manager`: `модуль 'ЗадачиПриоритеты' не найден` из
 * `tasks_core.osnova` приходила как ошибка `main.osnova`, и по сообщению нельзя
 * было понять, какой файл править.
 *
 * # Что теперь
 *
 * `Procedure.origin` проставляется при разворачивании импортов
 * (`expandModuleImports`): своим процедурам — входной файл, встроенным — файл,
 * откуда они пришли. Семантика ведёт `currentFile` по проверяемой процедуре и
 * кладёт его в `SemanticError.file`.
 *
 * # Чего здесь НЕТ
 *
 * Строк. `SemanticError.line` остаётся незаполненным: AST не несёт номеров строк
 * вовсе, и протяжка строк — отдельная работа с отдельным оракулом по набору
 * конструкций. Смешивать её с этой правкой нельзя.
 *
 * # Негативный контроль
 *
 * В файле: программа из двух файлов, ошибки в ОБОИХ, и каждая обязана назвать
 * свой. Снятие простановки `origin` в `expandModuleImports` краснит проверку
 * «ошибка из импортируемого модуля называет его файл» — проверено мутацией с
 * восстановлением из копии.
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compileSource } from "./compiler";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-attribution-"));
  dirs.push(dir);
  return dir;
}

function write(dir: string, name: string, lines: string[]): void {
  fs.writeFileSync(path.join(dir, name), lines.join("\n"), "utf-8");
}

/** Компиляция входного файла «как CLI»: с именем файла и его каталогом. */
function compileEntry(dir: string, name: string) {
  return compileSource(fs.readFileSync(path.join(dir, name), "utf-8"), {
    baseDir: dir,
    filename: name,
  });
}

describe("атрибуция семантических ошибок: файл", () => {
  /**
   * Два файла, ошибки в обоих:
   *   • в `библиотека.osnova` — вызов несуществующего модуля (ошибка ВНУТРИ импорта);
   *   • во входном `главный.osnova` — своя ошибка (вызов несуществующей процедуры).
   */
  function twoFileProgram(): string {
    const dir = tmpDir();
    write(dir, "библиотека.osnova", [
      "процедура экспорт испорченная()",
      "  вернуть НетТакогоМодуля.нет_такой_процедуры()",
      "конец_процедуры",
    ]);
    write(dir, "главный.osnova", [
      'использовать модуль Библиотека из "библиотека.osnova"',
      "",
      "процедура главная()",
      "  пусть а = Библиотека.испорченная()",
      "  вернуть нет_такой_процедуры(а)",
      "конец_процедуры",
    ]);
    return dir;
  }

  it("ошибка из ИМПОРТИРУЕМОГО модуля называет его файл, а не сборку главного", () => {
    const dir = twoFileProgram();
    const r = compileEntry(dir, "главный.osnova");

    const fromLib = r.semanticErrors.filter((e) => (e.file ?? "").includes("библиотека.osnova"));
    expect(fromLib.length, "ошибка внутри библиотека.osnova названа её файлом").toBeGreaterThan(0);
    expect(
      fromLib.some((e) => e.message.includes("НетТакогоМодуля")),
      "и это именно ошибка из библиотеки",
    ).toBe(true);
  });

  it("ошибка во ВХОДНОМ модуле называет входной файл", () => {
    const dir = twoFileProgram();
    const r = compileEntry(dir, "главный.osnova");

    const fromMain = r.semanticErrors.filter((e) => (e.file ?? "").includes("главный.osnova"));
    expect(fromMain.length, "ошибка во входном файле названа им же").toBeGreaterThan(0);
  });

  it("каждая ошибка называет файл — безымянных не остаётся", () => {
    const dir = twoFileProgram();
    const r = compileEntry(dir, "главный.osnova");
    const unnamed = r.semanticErrors.filter((e) => e.file === undefined);
    expect(unnamed.map((e) => e.message), "ошибки без файла").toEqual([]);
  });

  it("один файл без импортов: ошибка названа его именем", () => {
    const dir = tmpDir();
    write(dir, "один.osnova", ["процедура главная()", "  вернуть нет_такого()", "конец_процедуры"]);
    const r = compileEntry(dir, "один.osnova");
    expect(r.semanticErrors.length).toBeGreaterThan(0);
    expect(r.semanticErrors.every((e) => e.file === "один.osnova")).toBe(true);
  });

  it("строки пока НЕ проставлены — это отдельная работа, и она названа", () => {
    // Проверка-напоминание: если однажды строки появятся, эта проверка
    // покраснеет и заставит обновить канон и учебник — а не тихо разойдётся.
    const dir = twoFileProgram();
    const r = compileEntry(dir, "главный.osnova");
    expect(r.semanticErrors.every((e) => e.line === undefined), "line ещё не заполняется").toBe(true);
  });
});
