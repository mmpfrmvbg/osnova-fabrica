/**
 * Сторож артефактов: закоммиченный `.osvbc.json` обязан совпадать со свежей сборкой.
 *
 * # Дыра, ради которой он написан
 *
 * `src/self-host/bootstrap-hash.test.ts` сторожит дрейф только у self-host. У
 * фикстур рантайма и у приложений сторожа не было **никого**, поэтому два дефекта
 * прожили незамеченными:
 *
 * 1. `apps/chat/chat.osvbc.json` — **1959 байт против 3464** у свежей сборки.
 *    Это поставляемый байткод: его собирает инструкция `docs/termux-setup.md`
 *    (`npx tsx src/cli.ts compile apps/chat/chat.osnova -o apps/chat/chat.osvbc.json`),
 *    то есть по инструкции уезжал бы устаревший артефакт;
 * 2. рядом лежал `apps/chat/чат.osvbc.json` — артефакт БЕЗ исходника: имя модуля
 *    вместо имени файла, и ни одна ссылка на него не указывает.
 *
 * # Что проверяется
 *
 * Для каждой пары «`.osnova` + одноимённый `.osvbc.json`» в репозитории сборка
 * повторяется ровно так, как её делает `osnova compile`: `compileSource(текст,
 * { filename: basename })` и `JSON.stringify(module, null, 2)`. Расхождение —
 * красное. Сборка идёт В ПАМЯТИ: сторож ничего не пишет и чужих хешей не меняет.
 *
 * Отдельно проверяются **осиротевшие артефакты** — `.osvbc.json` без исходника.
 * Это тот же класс дрейфа (артефакт отстал от дерева), и он обязан быть виден, а
 * не найден руками. Известный осиротевший назван исключением с причиной; каждое
 * исключение обязано объяснять существующий файл, иначе оно прикрывает пустоту.
 *
 * # Негативный контроль
 *
 * Порча любого артефакта (подмена байта) краснит свою проверку; проверено
 * мутацией `apps/chat/chat.osvbc.json` с восстановлением из копии по sha256.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { execFileSync } from "child_process";
import { compileSource } from "../compiler/compiler";

const ROOT = path.resolve(__dirname, "..", "..");

const sha256 = (text: string): string => crypto.createHash("sha256").update(text, "utf-8").digest("hex");

/**
 * Отслеживаемые git файлы по шаблону — и только они.
 *
 * Почему не обход файловой системы: в рабочем дереве лежит мусор (например,
 * `src/self-host/gen*.osvbc.json`, не отслеживаемые никем), и сторож краснел бы
 * на нём у каждого. «В репозитории» — значит в git. `-z` снимает вопрос
 * кодировки: имена с кириллицей приходят байтами, а не в кавычках-экранировании.
 */
function trackedFiles(pattern: string): string[] {
  const out = execFileSync("git", ["ls-files", "-z", pattern], {
    cwd: ROOT,
    maxBuffer: 64 * 1024 * 1024,
  }) as Buffer;
  return out
    .toString("utf-8")
    .split("\u0000")
    .filter((name) => name !== "")
    .map((name) => path.join(ROOT, name))
    .sort();
}

const SOURCES = trackedFiles("*.osnova");
/**
 * Артефакты, которые есть и в репозитории, И на диске.
 *
 * Проверка на существование обязательна: `git ls-files` перечисляет ИНДЕКС, и
 * удалённый, но ещё не закоммиченный файл продолжал бы числиться артефактом —
 * сторож краснел бы на собственной уборке.
 */
const ARTIFACTS = trackedFiles("*.osvbc.json").filter((file) => fs.existsSync(file));

/** Пары «исходник + соседний артефакт». */
const PAIRS = SOURCES.map((src) => ({ src, artifact: src.replace(/\.osnova$/u, ".osvbc.json") })).filter(
  (p) => fs.existsSync(p.artifact),
);

/** Артефакты без исходника рядом. */
const ORPHANS = ARTIFACTS.filter((a) => !fs.existsSync(a.replace(/\.osvbc\.json$/u, ".osnova")));

/** Отслеживаемые манифесты приложений. */
const MANIFESTS = trackedFiles("*.osapp.yaml").filter((file) => fs.existsSync(file));

/**
 * РУКОПИСНЫЕ артефакты: источника `.osnova` нет, и источник им не компилятор —
 * дрейфовать не от чего. Это ЗАКОННАЯ категория, а не дефект: то же различие
 * проводит `src/self-host/bootstrap-hash.test.ts` («артефакты без парного
 * `.osnova` — рукописные фикстуры — пропускаются: их источник не компилятор»).
 *
 * Причина обязана называть, КТО файл загружает: «ссылок нет» — уже не причина,
 * а ошибка наблюдения. Ровно на ней я и споткнулся: `viewer.osvbc.json` и
 * `notifications.osvbc.json` оказались живыми — их грузят манифесты
 * (`entry.module` — имя ФАЙЛА в каталоге пакета, `vm/interpreter.ts:865`), и
 * golden их исполняет. Настоящий дефект был не в них, а в том, что у чата рядом
 * с живым `chat.osvbc.json` лежал устаревший `чат.osvbc.json`, и рантайм грузил
 * именно его.
 */
const HANDWRITTEN: ReadonlyArray<{ name: string; reason: string }> = [
  {
    name: "src/runtime/fixtures/notifications.osvbc.json",
    reason:
      "рукописная фикстура (version 1, источника .osnova нет); загружается манифестом notifications.osapp.yaml (entry.module: notifications, каталог пакета = каталог манифеста), исполняется golden",
  },
  {
    name: "src/runtime/fixtures/viewer.osvbc.json",
    reason:
      "рукописная фикстура (version 1, источника .osnova нет); загружается манифестом file-viewer.osapp.yaml (entry.module: viewer), упомянута в docs/golden-app-viewer.md, исполняется golden",
  },
  {
    name: "src/runtime/fixtures/vliw-example.osvbc.json",
    reason:
      "НЕ продукт нашего компилятора: golden читает её как модуль version 2 с vliwSlots 4 (src/runtime/goldenApps.ts:363-373), а compileSource даёт version 1. Дрейфовать от компилятора не может. ВНЕ моей плоскости: названа, решение за владельцем фикстур",
  },
  {
    name: "src/vliw/fixtures/linear-sum.osvbc.json",
    reason:
      "РУКОПИСНАЯ фикстура планировщика: источника .osnova нет нигде в репозитории, байткод читается напрямую из src/vliw/oracle.test.ts и scheduler.test.ts. Дрейфовать не от чего — компилятор эту пару не порождает",
  },
  {
    name: "src/vliw/fixtures/linear-sum.scheduled.osvbc.json",
    reason:
      "то же: рукописная фикстура расписания пакетов, читается из src/vliw/scheduler.test.ts и упомянута в docs/vliw-scheduler-plan.md",
  },
];

const rel = (p: string): string => path.relative(ROOT, p).replace(/\\/g, "/");

describe("артефакты: закоммиченный .osvbc.json совпадает со свежей сборкой", () => {
  it("есть что проверять: пары найдены", () => {
    expect(PAIRS.length, "пар .osnova + .osvbc.json").toBeGreaterThan(0);
  });

  for (const { src, artifact } of PAIRS) {
    it(`${rel(artifact)} не устарел`, () => {
      const compiled = compileSource(fs.readFileSync(src, "utf-8"), {
        filename: path.basename(src),
      });
      if (!compiled.module) {
        const errs = [...compiled.lexerErrors, ...compiled.parserErrors, ...compiled.compilerErrors].map(
          (e) => e.message,
        );
        expect.fail(`${rel(src)}: не компилируется — ${errs.join("; ")}`);
      }
      const fresh = JSON.stringify(compiled.module, null, 2);
      const onDisk = fs.readFileSync(artifact, "utf-8");
      expect(
        sha256(fresh),
        `${rel(artifact)} разошёлся со свежей сборкой ${rel(src)} ` +
          `(${String(onDisk.length)} символов против ${String(fresh.length)}). ` +
          `Пересобрать: npx tsx src/cli.ts compile ${rel(src)} -o ${rel(artifact)}`,
      ).toBe(sha256(onDisk));
    });
  }
});

describe("артефакты без исходника — рукописные, и это названо", () => {
  it("каждый артефакт без исходника объявлен рукописным", () => {
    const unexplained = ORPHANS.map(rel).filter((name) => !HANDWRITTEN.some((h) => h.name === name));
    expect(unexplained, "артефакт без .osnova — назовите его рукописным с причиной").toEqual([]);
  });

  it("нет устаревших записей: каждая объясняет существующий артефакт", () => {
    const present = new Set(ORPHANS.map(rel));
    const stale = HANDWRITTEN.filter((h) => !present.has(h.name)).map((h) => h.name);
    expect(stale, "запись прикрывает файл, которого больше нет").toEqual([]);
  });
});

/**
 * Манифесты, чей пакет лежит НЕ рядом с манифестом.
 *
 * Правило рантайма: каталог пакета — каталог манифеста, а `--package` его
 * заменяет (`src/runtime/run.ts`); `entry.module` — имя ФАЙЛА
 * `<имя>.osvbc.json` (`vm/interpreter.ts:865`). Значит манифест из
 * `src/runtime/fixtures/` может указывать на артефакт в `apps/`, и без флага он
 * не разрешается вовсе. Такие манифесты названы здесь с каталогом пакета.
 */
const PACKAGE_DIRS: Readonly<Record<string, string>> = {
  "src/runtime/fixtures/chat.osapp.yaml": "apps/chat",
};

/** `entry.module` из манифеста: сначала ищем в блоке `entry`, иначе по всему тексту. */
function entryModuleOf(text: string): string | undefined {
  const entry = /^entry:[ \t]*$([\s\S]*?)(?=^\S|$(?![\s\S]))/mu.exec(text)?.[1];
  const scope = entry ?? text;
  return /^[ \t]+module:[ \t]*"?([^"\n]+?)"?[ \t]*$/mu.exec(scope)?.[1];
}

/**
 * Проблемы манифеста. Чистая функция: `exists` подставляется, поэтому негативный
 * контроль проверяет ТУ ЖЕ логику на подменённом `entry.module`, а не повторяет
 * её глазами.
 */
function manifestProblems(
  text: string,
  manifestRel: string,
  exists: (relPath: string) => boolean,
  handwritten: ReadonlyArray<{ name: string }>,
): string[] {
  const problems: string[] = [];
  const moduleName = entryModuleOf(text);
  if (moduleName === undefined) {
    return [`${manifestRel}: не найден entry.module`];
  }
  const dir = PACKAGE_DIRS[manifestRel] ?? path.posix.dirname(manifestRel);
  const artifactRel = `${dir}/${moduleName}.osvbc.json`;
  if (!exists(artifactRel)) {
    problems.push(
      `${manifestRel}: entry.module «${moduleName}» не разрешается в файл — нет ${artifactRel}` +
        (PACKAGE_DIRS[manifestRel] === undefined
          ? ""
          : " (каталог пакета задаётся флагом --package)"),
    );
    return problems;
  }
  const sourceRel = `${dir}/${moduleName}.osnova`;
  if (!exists(sourceRel) && !handwritten.some((h) => h.name === artifactRel)) {
    problems.push(
      `${manifestRel}: артефакт ${artifactRel} без источника ${sourceRel} и не назван рукописным — ` +
        "источник не компилятор, объявите его в HANDWRITTEN с причиной",
    );
  }
  return problems;
}

describe("манифесты: entry.module разрешается в существующий артефакт", () => {
  const exists = (relPath: string): boolean => fs.existsSync(path.join(ROOT, relPath));

  it("манифесты найдены — проверять есть что", () => {
    expect(MANIFESTS.length, "манифестов .osapp.yaml").toBeGreaterThan(0);
  });

  it("у каждого манифеста entry.module разрешается, и рукописные объявлены", () => {
    const problems = MANIFESTS.flatMap((manifest) =>
      manifestProblems(fs.readFileSync(manifest, "utf-8"), rel(manifest), exists, HANDWRITTEN),
    );
    expect(problems, "манифест указывает на файл, которого нет, или на необъявленный рукописный").toEqual(
      [],
    );
  });

  it("НЕГАТИВНЫЙ КОНТРОЛЬ: подменённый entry.module краснеет", () => {
    const manifest = path.join(ROOT, "src/runtime/fixtures/notifications.osapp.yaml");
    const good = fs.readFileSync(manifest, "utf-8");
    const clean = manifestProblems(good, "src/runtime/fixtures/notifications.osapp.yaml", exists, HANDWRITTEN);
    expect(clean, "исходный манифест чист").toEqual([]);

    const broken = good.replace(/module:\s*"?notifications"?/u, 'module: "нет_такого"');
    expect(broken, "подмена применилась").not.toBe(good);
    const problems = manifestProblems(
      broken,
      "src/runtime/fixtures/notifications.osapp.yaml",
      exists,
      HANDWRITTEN,
    );
    expect(problems.length, "подмена поймана").toBeGreaterThan(0);
    expect(problems.join(" ")).toContain("нет_такого");
  });

  it("НЕГАТИВНЫЙ КОНТРОЛЬ: рукописный артефакт, не объявленный в HANDWRITTEN, краснеет", () => {
    const manifest = path.join(ROOT, "src/runtime/fixtures/notifications.osapp.yaml");
    const text = fs.readFileSync(manifest, "utf-8");
    const problems = manifestProblems(text, "src/runtime/fixtures/notifications.osapp.yaml", exists, []);
    expect(problems.length, "необъявленный рукописный пойман").toBeGreaterThan(0);
    expect(problems.join(" ")).toContain("не назван рукописным");
  });
});
