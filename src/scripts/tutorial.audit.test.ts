/**
 * Оракул учебника: каждый пример из `docs/tutorial/**` обязан работать.
 *
 * # Что проверяется
 *
 * 1. **Примеры исполняются.** Блок ```osnova — полная программа: компилируется и
 *    выполняется тем же путём, что `osnova run`; вывод сравнивается с блоком
 *    ```вывод, если он в учебнике приведён. Учебник, примеры которого не
 *    запускаются, — не учебник, а текст.
 * 2. **Устаревших форм нет.** В примерах запрещены `для_каждого`,
 *    `иначе_попытка`, одиночный `конец` как закрытие и `//` (из-за него
 *    `10 // 3` молча даёт `10`, а целочисленное деление пишется `div`).
 * 3. **Команды из раздела 02 работают.** Отдельная проверка запускает настоящий
 *    CLI (`compile` + `run`) — ровно те команды, что напечатаны в учебнике.
 *
 * # Соглашения разметки
 *
 * - ```` ```osnova ```` — исполняемый пример (полный модуль);
 * - «Вывод:» и ```` ```вывод ```` сразу после примера — ожидаемый вывод;
 * - первая строка `/* файл: имя.osnova *​/` — часть многомодульного примера: такие
 *   блоки не запускаются поодиночке, а собираются в каталог и запускается тот,
 *   где есть `использовать модуль` (раздел 10);
 * - фрагменты (объяснения, «как нельзя») — в блоках с другим тегом, они не исполняются.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { compileSource } from "../compiler/compiler";
import { VM, createDefaultInvokeHandler } from "../runtime/vm/interpreter";

const ROOT = path.resolve(__dirname, "..", "..");
const TUTORIAL = path.join(ROOT, "docs", "tutorial");

const FILE_DIRECTIVE = /^\/\*\s*файл:\s*(\S+)\s*\*\/$/;
/** `/* ожидается ошибка: подстрока *​/` — пример обязан упасть с этой ошибкой. */
const ERROR_DIRECTIVE = /^\/\*\s*ожидается ошибка:\s*(.+?)\s*\*\/$/;

interface Block {
  file: string;
  index: number;
  source: string;
  expected: string[] | null;
  /** Имя файла из директивы `/* файл: … *​/`, если блок — часть пакета. */
  fileName: string | null;
  /** Подстрока из `/* ожидается ошибка: … *​/` — пример обязан упасть. */
  expectError: string | null;
  /** В блоке есть шапка `модуль имя` — legacy-форма (канон: файл = модуль). */
  hasModuleHeader: boolean;
  /** Перед ограждением стоит метка `<!-- legacy-form -->`. */
  legacyMark: boolean;
}

/**
 * Метка legacy-формы. Ставится ПЕРЕД ограждением — вне самого блока, поэтому
 * разбор блоков ею не сбивается.
 *
 * Зачем метка, а не просто запрет: шапок в учебнике 73, и мгновенный запрет
 * оставил бы прогон красным на всё время конвертации. Метка делает промежуточное
 * состояние СОГЛАСОВАННЫМ (блок с шапкой обязан её нести), а счётчик работы —
 * видимым числом: сколько меток осталось, столько блоков ещё не в каноне.
 */
const LEGACY_MARK = "<!-- legacy-form -->";

/** Разобрать markdown: блоки ```osnova и (необязательный) следующий ```вывод. */
export function blocksOf(markdown: string, file: string): Block[] {
  const lines = markdown.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trim() === "```osnova") {
      const marked = i > 0 && lines[i - 1]!.trim() === LEGACY_MARK;
      const start = ++i;
      while (i < lines.length && lines[i]!.trim() !== "```") i++;
      const source = lines.slice(start, i).join("\n");
      i++;
      let j = i;
      while (j < lines.length && lines[j]!.trim() === "") j++;
      let expected: string[] | null = null;
      if (j < lines.length && /^Вывод:?\s*$/.test(lines[j]!.trim())) {
        j++;
        while (j < lines.length && lines[j]!.trim() === "") j++;
        if (j < lines.length && lines[j]!.trim() === "```вывод") {
          const outStart = ++j;
          while (j < lines.length && lines[j]!.trim() !== "```") j++;
          expected = lines.slice(outStart, j).map((l) => l.replace(/\s+$/, ""));
          i = j + 1;
        }
      }
      const firstLine = (source.split("\n")[0] ?? "").trim();
      const match = FILE_DIRECTIVE.exec(firstLine);
      const errMatch = ERROR_DIRECTIVE.exec(firstLine);
      blocks.push({
        file,
        index: blocks.length + 1,
        source,
        expected,
        fileName: match ? match[1]! : null,
        expectError: errMatch ? errMatch[1]! : null,
        // Якорь — начало СТРОКИ (флаг `m`): в четырёх блоках перед шапкой стоит
        // строка-директива (`/* ожидается ошибка: … */`, `/* файл: … */`),
        // а сама шапка всё равно открывает модуль. Без `m` счёт падал до 69.
        hasModuleHeader: /^[ \t]*модуль\s/mu.test(source),
        legacyMark: marked,
      });
      continue;
    }
    i++;
  }
  return blocks;
}

/** Устаревшие формы, которых в примерах быть не должно. */
const LEGACY: Array<{ name: string; re: RegExp }> = [
  { name: "для_каждого (канон — для)", re: /для_каждого/ },
  { name: "иначе_попытка (канон — поймать)", re: /иначе_попытка/ },
  { name: "одиночный конец (канон — конец_X)", re: /(^|[^А-Яа-я_])конец(?!_)(?![А-Яа-я_])/ },
  { name: "// (комментарий: деление — div)", re: /\/\// },
];

/**
 * СЧЁТЧИК РАБОТЫ: сколько блоков учебника ещё в legacy-форме (шапка `модуль имя`
 * с парным `конец_модуля`). Число только УМЕНЬШАЕТСЯ, и каждое уменьшение —
 * отдельная правка конвертации: проверка сравнивает точное значение, поэтому
 * забыть обновить счётчик нельзя.
 *
 * Было 73 (замер `.tmp/tutorial-blocks.ts`, разбором ограждений: греб по строкам
 * путает ограждения и блоки). Цель — 1: единственный помеченный legacy-блок в
 * `10-modules.md` как «принимается, но не нужно».
 */
const EXPECTED_LEGACY_BLOCKS = 4;

function tutorialFiles(): string[] {
  if (!fs.existsSync(TUTORIAL)) return [];
  return fs
    .readdirSync(TUTORIAL)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => path.join(TUTORIAL, f));
}

function readAll(): Array<{ file: string; markdown: string; blocks: Block[] }> {
  return tutorialFiles().map((full) => {
    const file = path.basename(full);
    const markdown = fs.readFileSync(full, "utf-8");
    return { file, markdown, blocks: blocksOf(markdown, file) };
  });
}

const allBlocks = (): Block[] => readAll().flatMap((r) => r.blocks);

/** Один запуск: одиночный пример либо собранный пакет модулей. */
interface Run {
  name: string;
  sources: Map<string, string>;
  entry: string;
  expected: string[] | null;
  expectError: string | null;
}

/** Тело примера без служебной первой строки-директивы. */
function bodyOf(block: Block): string {
  const lines = block.source.split("\n");
  const first = (lines[0] ?? "").trim();
  return FILE_DIRECTIVE.test(first) || ERROR_DIRECTIVE.test(first) ? lines.slice(1).join("\n") : block.source;
}

function runsOf(blocks: Block[]): Run[] {
  const runs: Run[] = [];
  const packages = new Map<string, Block[]>();
  for (const b of blocks) {
    if (b.fileName === null) {
      runs.push({
        name: `${b.file}: пример ${b.index}`,
        sources: new Map([["пример.osnova", bodyOf(b)]]),
        entry: "пример.osnova",
        expected: b.expected,
        expectError: b.expectError,
      });
      continue;
    }
    const key = `${b.file}`;
    const list = packages.get(key) ?? [];
    list.push(b);
    packages.set(key, list);
  }
  for (const [key, list] of packages) {
    const entryBlock = list.find((b) => b.source.includes("использовать модуль")) ?? list[0]!;
    const sources = new Map<string, string>();
    for (const b of list) sources.set(b.fileName!, bodyOf(b));
    runs.push({
      name: `${key}: пакет модулей (${list.length} файла(ов))`,
      sources,
      entry: entryBlock.fileName!,
      expected: entryBlock.expected,
      expectError: entryBlock.expectError,
    });
  }
  return runs;
}

async function runProgram(sources: Map<string, string>, entry: string): Promise<{ output: string[]; error: string | null }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-tutorial-"));
  try {
    for (const [name, text] of sources) fs.writeFileSync(path.join(dir, name), text, "utf-8");
    const out: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      out.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
    try {
      const r = compileSource(sources.get(entry)!, { baseDir: dir, filename: entry });
      if (r.lexerErrors.length > 0) return { output: out, error: `лексер: ${r.lexerErrors[0]!.message}` };
      if (r.parserErrors.length > 0) return { output: out, error: `парсер: ${r.parserErrors[0]!.message}` };
      if (r.semanticErrors.length > 0) return { output: out, error: `семантика: ${r.semanticErrors[0]!.message}` };
      if (!r.module || !r.compilerSuccess) return { output: out, error: "модуль не собран" };
      const vm = new VM(r.module, { invoke: createDefaultInvokeHandler(), maxSteps: 200_000 });
      const index = (() => {
        for (const name of ["главная", "старт", "main"]) {
          try {
            return vm.findProcedureIndex(name);
          } catch {
            /* пробуем следующее имя */
          }
        }
        return 0;
      })();
      await vm.runProcedure(index, []);
      return { output: out, error: null };
    } catch (e) {
      return { output: out, error: e instanceof Error ? e.message : String(e) };
    } finally {
      spy.mockRestore();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("учебник: разметка и устаревшие формы", () => {
  it("README и ровно 15 разделов", () => {
    const files = tutorialFiles().map((f) => path.basename(f));
    expect(files, "README учебника есть").toContain("README.md");
    const chapters = files.filter((f) => /^\d\d-/.test(f));
    expect(chapters).toHaveLength(15);
    for (let n = 1; n <= 15; n++) {
      const prefix = String(n).padStart(2, "0") + "-";
      expect(chapters.some((f) => f.startsWith(prefix)), `есть раздел ${prefix}…`).toBe(true);
    }
  });

  it("в примерах нет устаревших форм", () => {
    const problems: string[] = [];
    for (const block of allBlocks()) {
      const lines = block.source.split("\n");
      for (const { name, re } of LEGACY) {
        const hit = lines.findIndex((l) => re.test(l));
        if (hit >= 0) {
          problems.push(`${block.file} пример ${block.index}: ${name} — строка «${lines[hit]!.trim()}»`);
        }
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("помеченный legacy-блок — полная legacy-форма: шапка и парный конец_модуля", () => {
    // Проверка была «каждый пример — полный модуль» и требовала шапку от ВСЕХ
    // блоков: это предположение канона до «файл = модуль». Теперь полнота модуля
    // следует из канона (модуль — сам файл), а шапка осталась обещанием метки:
    // если блок назван legacy, он обязан показывать legacy-форму целиком.
    const bad: string[] = [];
    for (const block of allBlocks()) {
      if (!block.legacyMark) continue;
      const body = bodyOf(block);
      if (!/^[ \t]*модуль\s+\S/mu.test(body)) {
        bad.push(`${block.file} пример ${block.index}: метка legacy-form без «модуль …»`);
      }
      if (!/^\s*конец_модуля\s*$/mu.test(body)) {
        bad.push(`${block.file} пример ${block.index}: метка legacy-form без «конец_модуля»`);
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("примеров достаточно (иначе проверка ничего не проверяет)", () => {
    expect(allBlocks().length).toBeGreaterThanOrEqual(30);
  });
});

describe("учебник: примеры работают", () => {
  const runs = runsOf(allBlocks());

  for (const run of runs) {
    it(run.name, async () => {
      const { output, error } = await runProgram(run.sources, run.entry);
      if (run.expectError !== null) {
        expect(error, `пример обязан упасть с ошибкой «${run.expectError}»`).not.toBeNull();
        expect(error!).toContain(run.expectError);
        return;
      }
      expect(error, `пример должен исполняться: ${error ?? ""}`).toBeNull();
      if (run.expected !== null) {
        expect(output.map((l) => l.replace(/\s+$/, ""))).toEqual(run.expected);
      }
    });
  }
});

describe("учебник: команды из раздела 02 работают", () => {
  it("`run <файл.osnova>` — одна команда: компилирует и исполняет", () => {
    const readme = fs.readFileSync(path.join(TUTORIAL, "README.md"), "utf-8");
    const first = blocksOf(readme, "README.md")[0];
    expect(first, "в README есть исполняемый пример").toBeDefined();
    expect(first!.expected, "у первого примера показан вывод").not.toBeNull();

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-tutorial-cli-"));
    const sourceFile = path.join(dir, "привет.osnova");
    fs.writeFileSync(sourceFile, first!.source, "utf-8");

    // Никакого compile: одной командой запускаем исходник.
    const run = spawnSync(`npx tsx src/cli/index.ts run ${JSON.stringify(sourceFile)}`, {
      shell: true,
      cwd: ROOT,
      encoding: "utf-8",
    });
    expect(run.status, `run: ${run.stderr ?? ""}`).toBe(0);
    expect((run.stdout ?? "").trim().split("\n")).toEqual(first!.expected);
    // И промежуточного байткода рядом не появилось — команда компилирует в память.
    expect(fs.existsSync(path.join(dir, "привет.osvbc.json")), "байткод не создаётся").toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("`compile` + `run <файл.osvbc.json>` по-прежнему работают", () => {
    const readme = fs.readFileSync(path.join(TUTORIAL, "README.md"), "utf-8");
    const first = blocksOf(readme, "README.md")[0]!;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-tutorial-cli2-"));
    const sourceFile = path.join(dir, "привет.osnova");
    const bytecodeFile = path.join(dir, "привет.osvbc.json");
    fs.writeFileSync(sourceFile, first.source, "utf-8");

    const compile = spawnSync(
      `npx tsx src/cli/index.ts compile ${JSON.stringify(sourceFile)} -o ${JSON.stringify(bytecodeFile)}`,
      { shell: true, cwd: ROOT, encoding: "utf-8" },
    );
    expect(compile.status, `compile: ${compile.stderr ?? ""}`).toBe(0);
    const run = spawnSync(`npx tsx src/cli/index.ts run ${JSON.stringify(bytecodeFile)}`, {
      shell: true,
      cwd: ROOT,
      encoding: "utf-8",
    });
    expect(run.status, `run: ${run.stderr ?? ""}`).toBe(0);
    expect((run.stdout ?? "").trim().split("\n")).toEqual(first.expected);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * ФОРМА ПРИМЕРОВ — отдельно от их исполнения.
 *
 * Канон: файл = модуль, шапка `модуль имя` не нужна (§4, §13.3). Учебник должен
 * учить канону, иначе он разъедется с языком — как разъелся до §13, где шапок не
 * было ни в одном примере, а канон их уже не требовал.
 *
 * Пока идёт конвертация, состояние СОГЛАСОВАНО меткой: блок с шапкой обязан её
 * нести, и число меток названо счётчиком. Прогон от этого не краснеет, а работа
 * видна числом.
 */
describe("учебник: форма примеров", () => {
  const legacyBlocks = (): Block[] => allBlocks().filter((b) => b.hasModuleHeader);

  it("счётчик работы: блоков в legacy-форме ровно EXPECTED_LEGACY_BLOCKS", () => {
    // Число обязано уменьшаться вместе с конвертацией: сравнивается ТОЧНОЕ
    // значение, поэтому забыть обновить счётчик нельзя.
    expect(
      legacyBlocks().length,
      "блоков с шапкой «модуль имя» (счётчик только уменьшается)",
    ).toBe(EXPECTED_LEGACY_BLOCKS);
  });

  it("каждый блок с шапкой несёт метку legacy-form", () => {
    const unmarked = legacyBlocks()
      .filter((b) => !b.legacyMark)
      .map((b) => `${b.file}: блок ${String(b.index)}`);
    expect(unmarked, "блоки с шапкой без метки — форма не названа").toEqual([]);
  });

  it("метка без legacy-блока — красное: нет устаревших исключений", () => {
    const stale = allBlocks()
      .filter((b) => b.legacyMark && !b.hasModuleHeader)
      .map((b) => `${b.file}: блок ${String(b.index)}`);
    expect(stale, "метка стоит там, где legacy-формы уже нет").toEqual([]);
  });

  it("в канонических блоках шапки и конец_модуля не встречаются", () => {
    // Обратная сторона метки: если блок НЕ помечен, он обязан быть в каноне
    // целиком — ни шапки, ни парного ей `конец_модуля`.
    const notCanonical = allBlocks()
      .filter((b) => !b.legacyMark && /^\s*конец_модуля\s*$/mu.test(b.source))
      .map((b) => `${b.file}: блок ${String(b.index)}`);
    expect(notCanonical, "конец_модуля в непомеченном блоке").toEqual([]);
  });
});
