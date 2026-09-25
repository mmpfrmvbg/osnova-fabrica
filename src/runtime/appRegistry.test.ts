/**
 * Оракул каталогов `src/runtime/*.json` и попадания реестра приложений в контекст.
 *
 * # Дефект, ради которого это написано
 *
 * `src/runtime/appRegistry.json` содержал **два одинаковых JSON-документа
 * подряд** (строки 1–20 и 21–40) и целиком не парсился:
 * «Unexpected non-whitespace character after JSON at position 630».
 * Дефект врождённый — коммит регистрации сразу добавил 40 строк.
 *
 * Почему не заметили, и это важнее самого дубля:
 *
 * 1. `loadAppRegistry` ловил ошибку разбора и **молча** отдавал `apps: []`
 *    (`src/runtime/loadRegistry.ts`), поэтому `registryToContext` не добавлял
 *    блок «Референсные приложения Основа (appRegistry)» — реестр НЕ попадал в
 *    контекст промпта, хотя коммит объявлял регистрацию;
 * 2. ни один тест не смотрел ни на `appRegistry`, ни на `registryToContext`
 *    (проверено гребом: 0 совпадений) — поэтому у дефекта не было сторожа.
 *
 * Этот файл закрывает обе дыры: проверяет разбор, проверяет, что регистрация
 * ДОШЛА до контекста, и проверяет, что пути модулей существуют на диске — это
 * ловит и класс переименований, из-за которого пути в реестрах отстают от файлов.
 *
 * # Негативный контроль
 *
 * Внизу — проверки на временном каталоге с ЗАВЕДОМО испорченным каталогом:
 * дубль документа обязан ломать и разбор, и контекст. Без него оракул, который
 * всегда зелёный, неотличим от работающего.
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadAppRegistry, loadRegistry, registryToContext } from "./loadRegistry";

/** Каталоги данных лежат рядом с этим оракулом. */
const RUNTIME_DIR = __dirname;
/** Корень репозитория: пути модулей в реестре записаны от него. */
const REPO_ROOT = path.resolve(__dirname, "..", "..");

/** Все JSON-каталоги каталога данных — список берётся с диска, а не выписан руками. */
const CATALOGS = fs
  .readdirSync(RUNTIME_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();

/**
 * Проблемы разбора файла-каталога. Пустой массив — файл разбирается целиком.
 *
 * Вынесено отдельной функцией, чтобы негативный контроль гонял ТУ ЖЕ логику на
 * испорченном файле, а не повторял её глазами.
 */
function catalogProblems(dir: string, name: string): string[] {
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) return [`${name}: файла нет`];
  try {
    JSON.parse(fs.readFileSync(file, "utf-8"));
    return [];
  } catch (e) {
    return [`${name}: ${(e as Error).message}`];
  }
}

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function tmpDirWith(name: string, text: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-catalog-"));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, name), text, "utf-8");
  return dir;
}

describe("каталоги src/runtime/*.json", () => {
  it("есть что проверять: каталоги найдены", () => {
    expect(CATALOGS.length, "JSON-каталогов в src/runtime").toBeGreaterThan(0);
  });

  for (const name of CATALOGS) {
    it(`${name} — ровно один JSON-документ`, () => {
      // Дубль документа даёт «Unexpected non-whitespace character after JSON» —
      // именно так выглядел дефект appRegistry.json.
      expect(catalogProblems(RUNTIME_DIR, name), `${name}: разбор целиком`).toEqual([]);
    });
  }
});

describe("loadAppRegistry: зарегистрированное приложение", () => {
  it("ровно одно приложение, и это osnova.task_manager", () => {
    const reg = loadAppRegistry();
    expect(reg.apps.map((a) => a.id)).toEqual(["osnova.task_manager"]);
  });

  it("у приложения названы четыре модуля", () => {
    const [app] = loadAppRegistry().apps;
    expect(app, "приложение найдено").toBeDefined();
    expect(app!.modules, "модулей в реестре").toHaveLength(4);
  });

  it("каждый путь — и главный модуль, и модули — существует на диске", () => {
    // Это и есть сторож класса переименований: путь в реестре, отставший от
    // файла, обязан краснеть здесь, а не обнаруживаться руками.
    const paths = loadAppRegistry().apps.flatMap((a) => [a.mainModule, ...a.modules]);
    const missing = paths.filter((p) => !fs.existsSync(path.join(REPO_ROOT, p)));
    expect(missing, "пути реестра, которых нет на диске").toEqual([]);
  });
});

describe("registryToContext: реестр ДОХОДИТ до контекста", () => {
  it("контекст содержит блок референсных приложений и id приложения", () => {
    // Прямая проверка того, что дефект ломал: при молчаливом `apps: []` блока в
    // контексте не было, и регистрация не значила ничего.
    const ctx = registryToContext(loadRegistry(), loadAppRegistry());
    expect(ctx, "блок appRegistry в контексте").toContain(
      "Референсные приложения Основа (appRegistry)",
    );
    expect(ctx).toContain("osnova.task_manager");
    expect(ctx).toContain("apps/task-manager/main.osnova");
  });
});

describe("негативный контроль: испорченный каталог обязан краснеть", () => {
  const GOOD = fs.readFileSync(path.join(RUNTIME_DIR, "appRegistry.json"), "utf-8");

  it("целый каталог: приложения есть, ошибки НЕТ", () => {
    const reg = loadAppRegistry();
    expect(reg.apps.length, "приложения загружены").toBeGreaterThan(0);
    expect(reg.error, "у целого каталога причины нет").toBeUndefined();
  });

  it("дубль документа ломает разбор — проверка разбора это видит", () => {
    const dir = tmpDirWith("appRegistry.json", GOOD + "\n" + GOOD);
    expect(catalogProblems(dir, "appRegistry.json"), "дубль пойман").not.toEqual([]);
    // Контроль к контролю: тот же файл без дубля проблем не даёт.
    expect(catalogProblems(RUNTIME_DIR, "appRegistry.json")).toEqual([]);
  });

  it("дубль обнуляет каталог и убирает блок из контекста", () => {
    const dir = tmpDirWith("appRegistry.json", GOOD + "\n" + GOOD);
    expect(loadAppRegistry(dir).apps, "испорченный каталог не даёт приложений").toEqual([]);
    expect(registryToContext(loadRegistry(), loadAppRegistry(dir))).not.toContain(
      "Референсные приложения Основа (appRegistry)",
    );
    // И обратная сторона: с целым каталогом блок на месте.
    expect(registryToContext(loadRegistry(), loadAppRegistry())).toContain(
      "Референсные приложения Основа (appRegistry)",
    );
  });

  it("испорченный каталог НАЗЫВАЕТ причину, а не молчит", () => {
    // Раньше здесь был молчаливый `apps: []` — именно из-за него дефект с двумя
    // документами прожил незамеченным: «приложений нет» выглядело нормой.
    const dir = tmpDirWith("appRegistry.json", GOOD + "\n" + GOOD);
    const reg = loadAppRegistry(dir);
    expect(reg.apps, "падать в пайплайне нельзя — список остаётся пустым").toEqual([]);
    expect(reg.error, "причина названа").toBeTruthy();
    expect(reg.error, "причина называет файл").toContain("appRegistry.json");
    expect(reg.error, "причина — ошибка разбора, а не что-то иное").toMatch(/JSON|character|position/i);
  });

  it("отсутствующий файл каталога назван, а не проглочен", () => {
    const dir = tmpDirWith("registry.json", "{}");
    expect(catalogProblems(dir, "appRegistry.json")).toEqual(["appRegistry.json: файла нет"]);
    const reg = loadAppRegistry(dir);
    expect(reg.apps).toEqual([]);
    expect(reg.error, "нет файла — тоже названная причина").toContain("файла нет");
  });
});
