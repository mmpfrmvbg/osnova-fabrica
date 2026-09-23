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
}

/** Разобрать markdown: блоки ```osnova и (необязательный) следующий ```вывод. */
export function blocksOf(markdown: string, file: string): Block[] {
  const lines = markdown.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trim() === "```osnova") {
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

  it("каждый исполняемый пример — полный модуль", () => {
    const bad: string[] = [];
    for (const block of allBlocks()) {
      const body = bodyOf(block);
      if (!/^\s*модуль\s+\S/.test(body)) bad.push(`${block.file} пример ${block.index}: нет «модуль …»`);
      if (!/^\s*конец_модуля\s*$/m.test(body)) bad.push(`${block.file} пример ${block.index}: нет «конец_модуля»`);
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
  it("`compile` + `run` из CLI печатают то, что обещано", () => {
    const readme = fs.readFileSync(path.join(TUTORIAL, "README.md"), "utf-8");
    const first = blocksOf(readme, "README.md")[0];
    expect(first, "в README есть исполняемый пример").toBeDefined();
    expect(first!.expected, "у первого примера показан вывод").not.toBeNull();

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-tutorial-cli-"));
    const sourceFile = path.join(dir, "привет.osnova");
    const bytecodeFile = path.join(dir, "привет.osvbc.json");
    fs.writeFileSync(sourceFile, first!.source, "utf-8");

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
    expect((run.stdout ?? "").trim().split("\n")).toEqual(first!.expected);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
