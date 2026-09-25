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
const ARTIFACTS = trackedFiles("*.osvbc.json");

/** Пары «исходник + соседний артефакт». */
const PAIRS = SOURCES.map((src) => ({ src, artifact: src.replace(/\.osnova$/u, ".osvbc.json") })).filter(
  (p) => fs.existsSync(p.artifact),
);

/** Артефакты без исходника рядом. */
const ORPHANS = ARTIFACTS.filter((a) => !fs.existsSync(a.replace(/\.osvbc\.json$/u, ".osnova")));

/**
 * Осиротевшие артефакты, которые объяснены. Причина обязана быть содержательной:
 * «так исторически сложилось» причиной не является.
 *
 * Здесь два РАЗНЫХ случая, и путать их нельзя:
 *   • рукописная фикстура — её источник не компилятор, дрейфовать не от чего
 *     (это же различие проводит `src/self-host/bootstrap-hash.test.ts`);
 *   • артефакт-продукт компилятора без исходника — дрейф возможен, и решение
 *     (удалить или оставить) принимает владелец плоскости.
 */
const KNOWN_ORPHANS: ReadonlyArray<{ name: string; reason: string }> = [
  {
    name: "apps/chat/чат.osvbc.json",
    reason:
      "байткод чата, сохранённый под именем МОДУЛЯ («чат»), а не файла; исходника чат.osnova нет, ссылок на файл нет ни в коде, ни в документах. Это артефакт-продукт компилятора (version 1, moduleName «чат»), поэтому решение (удалить или оставить) — за владельцем плоскости приложений; до решения файл назван здесь, чтобы новые сироты не появлялись молча",
  },
  {
    name: "src/runtime/fixtures/notifications.osvbc.json",
    reason:
      "фикстура без источника .osnova; ссылок на файл не нашлось ни в коде, ни в документах, ни в соседнем notifications.osapp.yaml. ВНЕ моей плоскости (src/runtime/fixtures/** — владельца фикстур): назван, чтобы не пропасть, решение за ним",
  },
  {
    name: "src/runtime/fixtures/viewer.osvbc.json",
    reason:
      "фикстура без источника .osnova; упомянута в docs/golden-app-viewer.md. ВНЕ моей плоскости: названа, решение за владельцем фикстур",
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

describe("артефакты без исходника названы, а не найдены руками", () => {
  it("каждый осиротевший артефакт объяснён", () => {
    const unexplained = ORPHANS.map(rel).filter((name) => !KNOWN_ORPHANS.some((k) => k.name === name));
    expect(unexplained, "артефакты без исходника рядом — назовите их причиной").toEqual([]);
  });

  it("нет устаревших исключений: каждое объясняет существующий файл", () => {
    const present = new Set(ORPHANS.map(rel));
    const stale = KNOWN_ORPHANS.filter((k) => !present.has(k.name)).map((k) => k.name);
    expect(stale, "исключение прикрывает файл, которого больше нет").toEqual([]);
  });
});
