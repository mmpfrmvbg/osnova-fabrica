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
import { compileSource } from "../compiler/compiler";

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

/**
 * Приложения, СНЯТЫЕ из реестра до починки. Запись обязана называть ЧИСЛА: долг
 * без чисел — обещание, а не долг.
 *
 * Реестр не имеет права объявлять то, что не собирается, поэтому
 * `osnova.task_manager` из него убран, а файлы приложения остались в дереве.
 * Обратно в реестр запись возвращается тем же коммитом, где приложение начнёт
 * компилироваться и проходить golden.
 */
const PENDING: ReadonlyArray<{ id: string; dir: string; reason: string }> = [
  {
    id: "osnova.task_manager",
    dir: "apps/task-manager",
    reason:
      "снято из реестра 2026-09-26. Числа: main.osnova — 6 семантических ошибок, " +
      "tasks_core.osnova — 3 (в копии с дописанным импортом 5), filters/priorities/storage — чисто. " +
      "Три названные причины: ЗадачиЯдро.создать ожидает 4 аргумента, передано 3 (трижды); " +
      "ЗадачиПриоритеты.серверный_приоритет вызван без импорта, и такой процедуры нет " +
      "(в tasks_priorities.osnova только высокий/средний/низкий); система.строка.объединить вызвана " +
      "с 3 и 24 аргументами при argc 2 — рантайм реализован на два и обрезал бы JSON молча. " +
      "Это не патч, а переделка модели задачи: main и ядро разошлись по арности",
  },
];

/**
 * Проблемы записей реестра: путь существует И компилируется.
 *
 * Чистая функция с подставляемыми `exists` и `compileProblems` — чтобы негативный
 * контроль гонял ТУ ЖЕ логику на подставных данных (несуществующий путь,
 * некомпилируемый файл), а не повторял её глазами.
 */
function registryProblems(
  apps: ReadonlyArray<{ id: string; mainModule: string; modules: readonly string[] }>,
  exists: (relPath: string) => boolean,
  compileProblems: (relPath: string) => string[],
): string[] {
  const problems: string[] = [];
  for (const app of apps) {
    for (const relPath of [app.mainModule, ...app.modules]) {
      if (!exists(relPath)) {
        problems.push(`${app.id}: путь «${relPath}» не существует на диске`);
        continue;
      }
      for (const problem of compileProblems(relPath)) problems.push(`${app.id}: ${relPath} — ${problem}`);
    }
  }
  return problems;
}

/** Настоящая проверка компиляции: как CLI, с именем файла и его каталогом. */
function compileProblemsOf(relPath: string): string[] {
  const abs = path.join(REPO_ROOT, relPath);
  const compiled = compileSource(fs.readFileSync(abs, "utf-8"), {
    baseDir: path.dirname(abs),
    filename: path.basename(abs),
  });
  return [...compiled.lexerErrors, ...compiled.parserErrors, ...compiled.compilerErrors, ...compiled.semanticErrors].map(
    (e) => e.message,
  );
}

const existsInRepo = (relPath: string): boolean => fs.existsSync(path.join(REPO_ROOT, relPath));

describe("реестр приложений: объявленное обязано собираться", () => {
  it("каждое приложение реестра существует на диске и компилируется", () => {
    // Тот же класс, что сторож артефактов: система не имеет права объявлять то,
    // что не собирается. Ошибка называет приложение, файл и причину.
    const problems = registryProblems(loadAppRegistry().apps, existsInRepo, compileProblemsOf);
    expect(problems, "приложения реестра, которые не собираются").toEqual([]);
  });

  it("реестр не врёт: снятые приложения в нём отсутствуют, а файлы на месте", () => {
    // Пустой реестр не должен делать проверку пустой ПО ПОСТРОЕНИЮ: пустота
    // объяснена списком PENDING, и каждое его утверждение проверяется — запись
    // отсутствует в реестре, каталог существует, причина содержательна.
    const ids = new Set(loadAppRegistry().apps.map((a) => a.id));
    for (const pending of PENDING) {
      expect(ids.has(pending.id), `${pending.id} не должен числиться в реестре до починки`).toBe(false);
      expect(existsInRepo(pending.dir), `файлы ${pending.id} остаются в дереве`).toBe(true);
      expect(pending.reason.length, "долг назван числами").toBeGreaterThan(40);
    }
  });
});

describe("registryToContext: реестр ДОХОДИТ до контекста", () => {
  it("блок референсных приложений появляется, когда в реестре что-то есть", () => {
    // Проверяется не текущее содержимое реестра (сейчас он пуст по решению
    // владельца), а САМ МЕХАНИЗМ: с непустым каталогом блок в контексте есть.
    // Именно он ломался молча: при `apps: []` регистрация не значила ничего.
    const ctx = registryToContext(loadRegistry(), {
      version: "1.0.0",
      apps: [
        {
          id: "osnova.example",
          name: "Пример",
          type: "cli",
          languageVersion: "2.0.0",
          mainModule: "apps/example/main.osnova",
          modules: [],
        },
      ],
    });
    expect(ctx, "блок appRegistry в контексте").toContain(
      "Референсные приложения Основа (appRegistry)",
    );
    expect(ctx).toContain("osnova.example");
    expect(ctx).toContain("apps/example/main.osnova");
  });

  it("с пустым реестром блок не появляется — и это состояние названо, а не случайно", () => {
    const ctx = registryToContext(loadRegistry(), loadAppRegistry());
    expect(ctx).not.toContain("Референсные приложения Основа (appRegistry)");
    expect(PENDING.length, "пустота объяснена списком снятых").toBeGreaterThan(0);
  });
});

describe("НЕГАТИВНЫЙ КОНТРОЛЬ: проверка реестра обязана краснеть", () => {
  const APP = { id: "osnova.x", mainModule: "apps/x/main.osnova", modules: ["apps/x/extra.osnova"] };

  it("несуществующий путь краснеет", () => {
    const problems = registryProblems([APP], () => false, () => []);
    expect(problems.length, "путь, которого нет").toBe(2);
    expect(problems.join(" ")).toContain("не существует на диске");
  });

  it("некомпилируемый файл краснеет с причиной", () => {
    const problems = registryProblems([APP], () => true, (p) =>
      p.endsWith("extra.osnova") ? ["процедура 'X' не объявлена в модуле"] : [],
    );
    expect(problems).toEqual(["osnova.x: apps/x/extra.osnova — процедура 'X' не объявлена в модуле"]);
  });

  it("чистый реестр проблем не даёт — контроль к контролю", () => {
    expect(registryProblems([APP], () => true, () => [])).toEqual([]);
  });
});

describe("негативный контроль: испорченный каталог обязан краснеть", () => {
  const GOOD = fs.readFileSync(path.join(RUNTIME_DIR, "appRegistry.json"), "utf-8");

  it("целый каталог: разбор проходит, ошибки НЕТ", () => {
    // Список приложений здесь НЕ проверяется: сейчас он пуст по решению
    // владельца (запись task-manager снята до починки, см. PENDING). Проверяется
    // разбор — то, что ломал дубль документа.
    const reg = loadAppRegistry();
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
    // И обратная сторона — на НЕПУСТОМ подставном каталоге, а не на настоящем:
    // настоящий сейчас пуст по решению владельца (см. PENDING), и требовать от
    // него блока значило бы требовать вернуть снятую запись.
    const ctx = registryToContext(loadRegistry(), {
      version: "1.0.0",
      apps: [
        {
          id: "osnova.example",
          name: "Пример",
          type: "cli",
          languageVersion: "2.0.0",
          mainModule: "apps/example/main.osnova",
          modules: [],
        },
      ],
    });
    expect(ctx, "с непустым каталогом блок на месте").toContain(
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
