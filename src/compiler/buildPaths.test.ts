/**
 * Оракул ПУТЕЙ СБОРКИ: один и тот же файл обязан давать побайтово один артефакт.
 *
 * # Дефект класса, ради которого он написан
 *
 * В репозитории три пути сборки одного файла, и два из них звали
 * `compileSource(source)` БЕЗ `filename` и `baseDir`:
 *
 * | путь | было |
 * |---|---|
 * | `src/compiler/cliCompile.ts` (компиляторный CLI) | `filename` + `baseDir` — верно |
 * | `src/cli.ts compile` (подкоманда) | **ни того, ни другого** — исправлено |
 * | `src/compiler/compile-fixtures.ts` | **ни того, ни другого** — исправлено |
 * | `src/cli/index.ts` (`npm run osnova`) | `baseDir` был, `filename` не было — исправлено |
 *
 * Последствия были два, и первое страшнее:
 *   1. под каноном «файл = модуль» файл БЕЗ шапки получал имя `вход` — то есть
 *      документированная команда пересборки записывала артефакт, расходящийся со
 *      свежей сборкой и со сторожем `artifactDrift`;
 *   2. без `baseDir` импорты разрешались от текущего каталога, и сборка
 *      многомодульного приложения падала на «Модуль не найден».
 *
 * Дефект жил незамеченным ровно потому, что шапка `модуль имя` сильнее имени
 * файла: пока шапки стояли, оба пути давали одно и то же имя. Расхождение
 * проявилось при снятии шапки — и до сих пор его не сторожил НИКТО.
 *
 * # Что проверяется
 *
 * Для каждого файла артефакт, собранный КОМПИЛЯТОРНЫМ CLI (in-process,
 * `runCompileCli`) и артефакт, собранный ПОДКОМАНДОЙ `src/cli.ts compile`
 * (настоящий процесс, как у пользователя), совпадают побайтово.
 *
 * # Негативный контроль
 *
 * Снять `filename` в любом из путей — проверка краснеет, потому что один
 * артефакт получает `moduleName: «вход»`, а другой имя файла. Проверено на
 * `src/cli.ts` до правки: расхождение воспроизводилось (проба `.tmp/build-paths.ts`).
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { runCompileCli } from "./cliCompile";

const ROOT = path.resolve(__dirname, "..", "..");

/**
 * Файлы для сверки. Намеренно разные по свойствам:
 *   • без шапки и без импортов — проверяет имя из имени файла;
 *   • без шапки и с импортами — проверяет ещё и разрешение импортов (baseDir);
 *   • фикстура рантайма — путь, которым пользуется `npm run compile:fixtures`.
 */
const FILES = [
  "apps/chat/chat.osnova",
  "apps/task-manager/main.osnova",
  "src/runtime/fixtures/todo.osnova",
];

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function tmpPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-build-paths-"));
  tmpDirs.push(dir);
  return path.join(dir, name);
}

/** Путь 1: компиляторный CLI, in-process (`src/compiler/cliCompile.ts`). */
function viaCompilerCli(file: string, out: string): string {
  const code = runCompileCli([path.join(ROOT, file), "-o", out], { out: () => {}, err: () => {} });
  expect(code, `компиляторный CLI на ${file} завершился отказом`).toBe(0);
  return fs.readFileSync(out, "utf-8");
}

/** Путь 2: подкоманда `src/cli.ts compile` — настоящий процесс, как у пользователя. */
function viaSubcommand(file: string, out: string): string {
  const r = spawnSync(`npx tsx src/cli.ts compile ${file} -o ${out}`, {
    cwd: ROOT,
    shell: true,
    encoding: "utf-8",
  });
  expect(r.status, `подкоманда на ${file}: ${r.stdout ?? ""}${r.stderr ?? ""}`).toBe(0);
  return fs.readFileSync(out, "utf-8");
}

describe("пути сборки: один файл — один артефакт", () => {
  it("файлы для сверки существуют", () => {
    for (const file of FILES) {
      expect(fs.existsSync(path.join(ROOT, file)), `${file} есть`).toBe(true);
    }
  });

  for (const file of FILES) {
    it(`${file}: компиляторный CLI и подкоманда дают один байт-в-байт артефакт`, () => {
      const a = viaCompilerCli(file, tmpPath("cli.json"));
      const b = viaSubcommand(file, tmpPath("subcommand.json"));
      // Сравниваются СЫРЫЕ тексты, а не объекты: расхождение в порядке ключей,
      // отступах или имени модуля обязано быть видно.
      expect(b, `${file}: артефакты двух путей разошлись`).toBe(a);
    }, 120_000);
  }

  it("имя модуля в артефакте — из имени файла, а не «вход»", () => {
    // Прямая проверка того, что ломалось: без `filename` здесь было бы «вход».
    const out = tmpPath("name.json");
    const text = viaCompilerCli("apps/chat/chat.osnova", out);
    const moduleName = (JSON.parse(text) as { moduleName?: string }).moduleName;
    expect(moduleName, "имя модуля файла без шапки").toBe("chat");
    expect(moduleName).not.toBe("вход");
  });
});
