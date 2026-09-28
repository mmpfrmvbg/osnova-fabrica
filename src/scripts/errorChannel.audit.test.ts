/**
 * АУДИТ КАНАЛА ОШИБОК — состязательная проверка чужих утверждений об отказах.
 *
 * **Повод.** 2026-09-28 измерено: установленный `osnova` (`dist/cli.js` ← `src/cli.ts`)
 * на семантической ошибке выходил кодом 1 с **нулём строк вывода**. Правка
 * (`src/compiler/compileDiagnostics.ts` + три точки входа) сделана, но её сторож
 * `src/compiler/compileDiagnostics.test.ts` проверяет **источник**
 * (`npx tsx src/cli.ts`), а не тот артефакт, на котором дефект был измерен, — то
 * есть точка наблюдения дефекта не покрыта ничем. Этот файл её покрывает.
 *
 * **Чем этот аудит отличается от сторожа правки.** Тот держит «печатается ли
 * причина»; этот проверяет **чужие утверждения** и ищет то, что они пропустили:
 * молчащие каналы, расхождение каталога и фактического поведения, отказы на старых
 * записях журнала, утечки. Опровержение здесь ценнее подтверждения.
 *
 * # Что именно он ловит (негативные контроли названы)
 *
 * | проверка | что краснеет |
 * |---|---|
 * | карта каналов, подпроцессом | точка входа вернула 0 **или** ноль строк с причиной на битом исходнике |
 * | то же, негативный контроль | рабочая программа напечатала диагностику или вышла не 0 |
 * | маркер утечки (строка-ловушка в исходнике) | CLI вывел текст исходника, которого не должен |
 * | реестр точек входа | файл-точка переименован/удалён — карта устарела молча |
 * | **свежесть `dist/cli.js`** | артефакт старше `src/cli.ts` или собран без модуля вывода — ровно тот дефект, ради которого писан аудит |
 * | машинный режим `--diagnostics=json` | в stdout попало что-то, кроме JSONL; код вне формы `OSN-*`; тихий успех без артефакта |
 * | каталог: покрытие | вид порождается `semantic.ts`, но не каталогизирован (и наоборот) |
 * | каталог: коды | код переиспользован, дублируется или пересекается с `OSN-RT-*` |
 * | **`blocking` против факта** | **класс:** вид каталога перестал соответствовать поведению компилятора — признак разошёлся с судьбой сборки (перечня «известных расхождений» больше нет: их ноль, и это выведено) |
 * | цепочка сравнений | число цепочки стало неверным (меряется на VM: дискриминатор даёт 10), вид снова начал стрелять по законным программам |
 * | ключевые слова | вид перестал быть достижим/недостижим — закреплено замером |
 * | журнал против схемы | отказ на записи по причине, которой раньше не было |
 * | утечки в журнале | проекция `diagnostics` понесла текст исходника |
 *
 * # Правило про `dist/`: свежесть, а не наличие
 *
 * `dist/` — локальный артефакт сборки (в `.gitignore`, отслеживаемых файлов 0),
 * поэтому **отсутствие** артефакта — не дефект, а «проверка не выполнена»: чистый
 * checkout и CI не обязаны быть красными. Красное — **несвежий** артефакт (старше
 * `src/cli.ts`, из которого собран) и молчание свежего. Так дефект, найденный
 * 2026-09-28, остаётся видимым, а не превращается в вечно зелёную строку.
 *
 * # Чего он НЕ делает
 *
 * Не проверяет `--task`/`loop`/`improve`/`resident` подпроцессом: им нужен LLM и
 * `.env`, то есть внешний ресурс (случай 12 реестра проверяемости). Их канал
 * описан в отчёте, но не закреплён здесь — это названный долг, а не забытая строка.
 *
 * # Зависимости от чужих правок (T1–T4)
 *
 * Файл импортирует `DIAGNOSTIC_KINDS`/`PHASE_CODES`/`INTERNAL_CODES` (T1),
 * `RUNTIME_CODE_TABLE` (T2), `TraceEntrySchema` (T4). Если вид, порождаемый
 * `semantic.ts`, потеряет каталожную запись, краснеют сразу два места: покрытие
 * каталога и форма кода в машинном выводе.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { compileSource, compileToBuildReport, type CompileResult } from "../compiler/compiler";
import { collectCompileDiagnostics } from "../compiler/compileDiagnostics";
import { DIAGNOSTIC_KINDS, INTERNAL_CODES } from "../compiler/diagnosticCatalogue";
import { VM } from "../runtime/vm/interpreter";
import { RUNTIME_CODE_TABLE } from "../runtime/runtimeCodes";
import { TraceEntrySchema } from "../trace/traceStore";
import { projectEntryDiagnostics } from "../trace/diagnosticsProjection";
import { LANGUAGE_REGISTRY } from "../compiler/language-registry";

const ROOT = path.resolve(__dirname, "..", "..");
const JOURNAL = path.join(ROOT, "runs", "traces.jsonl");
const INSTALLED = path.join(ROOT, "dist", "cli.js");
const SRC_CLI = path.join(ROOT, "src", "cli.ts");

/** Строка-ловушка: если она всплывёт в выводе, значит канал понёс текст исходника. */
const LEAK_MARKER = "МАРКЕР_УТЕЧКИ_9F3A2B";

/** Битый исходник: семантическая ошибка (`undeclared_var` — блокирующий вид). */
const BROKEN_SEMANTIC = [
  "модуль ПробаКанала",
  "",
  "процедура главная()",
  `  пусть метка = "${LEAK_MARKER}"`,
  "  вернуть сумма_без_объявления",
  "конец",
  "",
  "конец",
  "",
].join("\n");

/** Битый исходник: ошибка парсера (блок `процедура` не закрыт). */
const BROKEN_PARSE = [
  "модуль ПробаКанала",
  "",
  "процедура главная()",
  `  пусть метка = "${LEAK_MARKER}"`,
  "  пусть х = 1",
  "",
].join("\n");

/** Рабочая программа — негативный контроль. */
const GOOD = [
  "модуль ПробаКанала",
  "",
  "процедура главная()",
  `  пусть метка = "${LEAK_MARKER}"`,
  "  пусть сумма = 2 + 2",
  "  вернуть сумма",
  "конец",
  "",
  "конец",
  "",
].join("\n");

/** Форма машинного кода — та же, что в `src/trace/diagnosticsProjection.ts`. */
const CODE_SHAPE = /^OSN-[A-Z]{2,4}-\d{3}$/;

/** Точка входа CLI: то, что человек запускает. `covers` — файл, который за неё отвечает. */
interface EntryPoint {
  readonly id: string;
  readonly covers: string;
  /** Аргументы запуска. Пусто — запуск через оболочку (`npx tsx …`). */
  readonly args: (file: string, extra: readonly string[]) => string[];
  /** Команда оболочки; используется, когда `args` вернул пусто. */
  readonly command: (file: string, extra: readonly string[]) => string;
}

const INSTALLED_ID = "установленный osnova (dist/cli.js)";

/**
 * Карта каналов. Каждая строка проверяется подпроцессом — импортом проверять
 * нельзя: `src/cli.ts` завершается `process.exit` на импорте, и молчащий путь
 * именно в нём.
 */
const ENTRY_POINTS: readonly EntryPoint[] = [
  {
    id: INSTALLED_ID,
    covers: "src/cli.ts",
    args: (file, extra) => [INSTALLED, "compile", file, ...extra],
    command: () => "",
  },
  {
    id: "src/cli.ts (источник dist)",
    covers: "src/cli.ts",
    args: () => [],
    command: (file, extra) =>
      `npx tsx src/cli.ts compile "${file}"${extra.length > 0 ? " " + extra.join(" ") : ""}`,
  },
  {
    id: "src/cli/index.ts (npm run osnova)",
    covers: "src/cli/index.ts",
    args: () => [],
    command: (file, extra) =>
      `npx tsx src/cli/index.ts compile "${file}"${extra.length > 0 ? " " + extra.join(" ") : ""}`,
  },
  {
    id: "src/compiler/cli.ts (osnova-compile)",
    covers: "src/compiler/cli.ts",
    args: () => [],
    command: (file, extra) =>
      `npx tsx src/compiler/cli.ts "${file}"${extra.length > 0 ? " " + extra.join(" ") : ""}`,
  },
];

interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly output: string;
  readonly lines: readonly string[];
  /** Куда компилятор кладёт байткод: нужен, чтобы «тихий успех» не значил «ничего не сделал». */
  readonly artifact: string;
}

/** Запуск точки входа подпроцессом. `node` — без оболочки, `npx tsx` — через неё. */
function run(point: EntryPoint, file: string, extra: readonly string[] = []): RunResult {
  const direct = point.args(file, extra);
  const r =
    direct.length > 0
      ? spawnSync(process.execPath, direct, { cwd: ROOT, encoding: "utf-8" })
      : spawnSync(point.command(file, extra), { shell: true, cwd: ROOT, encoding: "utf-8" });
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  const output = `${stdout}\n${stderr}`;
  return {
    status: r.status,
    stdout,
    stderr,
    output,
    lines: output.split(/\r?\n/).filter((l) => l.trim() !== ""),
    artifact: file.replace(/\.osnova$/i, ".osvbc.json"),
  };
}

const CACHE = new Map<string, RunResult>();

/** Замер точки входа на данном исходнике — ровно один раз на комбинацию. */
function measure(
  point: EntryPoint,
  label: string,
  source: string,
  extra: readonly string[] = [],
): RunResult {
  const key = `${point.id}::${label}::${extra.join(",")}`;
  const cached = CACHE.get(key);
  if (cached !== undefined) return cached;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-channel-"));
  const file = path.join(dir, `${label}.osnova`);
  fs.writeFileSync(file, source, "utf-8");
  const result = run(point, file, extra);
  CACHE.set(key, result);
  return result;
}

/**
 * Свежесть установленного артефакта. `dist/` не в git: его отсутствие — «проверка
 * не выполнена», а не дефект; несвежесть — дефект.
 */
const installedExists = fs.existsSync(INSTALLED);
const installedText = installedExists ? fs.readFileSync(INSTALLED, "utf-8") : "";
/** Артефакт обязан нести модуль единого вывода — иначе он собран из старого источника. */
const installedCarriesModule = installedText.includes("compileDiagnostics");
const installedFresh =
  installedExists &&
  installedCarriesModule &&
  fs.statSync(INSTALLED).mtimeMs >= fs.statSync(SRC_CLI).mtimeMs;

/** Точки, у которых проверяется молчание. Свежий артефакт проверяется, несвежий — нет. */
const CHECKED_POINTS: readonly EntryPoint[] = ENTRY_POINTS.filter(
  (p) => p.id !== INSTALLED_ID || installedFresh,
);
const SOURCE_POINTS: readonly EntryPoint[] = ENTRY_POINTS.filter((p) => p.id !== INSTALLED_ID);

describe("свежесть установленного артефакта dist/cli.js", () => {
  it.skipIf(!installedExists)(
    "артефакт есть, но не старше src/cli.ts и несёт модуль единого вывода " +
      "(пропуск, если dist/cli.js нет: чистый checkout и CI — это не дефект)",
    () => {
      const artifactTime = fs.statSync(INSTALLED).mtimeMs;
      const sourceTime = fs.statSync(SRC_CLI).mtimeMs;
      const artifactAt = new Date(artifactTime).toISOString();
      const sourceAt = new Date(sourceTime).toISOString();
      expect(
        artifactTime,
        `установленный osnova СТАРШЕ своего источника — он собран ${artifactAt}, ` +
          `а src/cli.ts правился ${sourceAt}. Артефакт не несёт правку: пересобрать ` +
          `\`npm run build\` (ровно дефект 2026-09-28: exit 1 с нулём строк вывода)`,
      ).toBeGreaterThanOrEqual(sourceTime);
      expect(
        installedCarriesModule,
        "dist/cli.js собран без `compileDiagnostics` — из источника, где канал причины ещё закрыт",
      ).toBe(true);
    },
  );
});

describe("карта каналов: каждая CLI-точка называет причину и возвращает ненулевой код", () => {
  it("реестр точек входа не устарел: файл, отвечающий за точку, существует", () => {
    for (const point of ENTRY_POINTS) {
      expect(
        fs.existsSync(path.join(ROOT, point.covers)),
        `точка «${point.id}» → ${point.covers}`,
      ).toBe(true);
    }
  });

  it("установленный osnova собирается из той же точки входа, что закреплена в карте", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8")) as {
      bin?: Record<string, string>;
    };
    const bin = pkg.bin ?? {};
    expect(bin.osnova, "bin.osnova").toBe("dist/cli.js");
    expect(
      ENTRY_POINTS.some((p) => p.covers === "src/cli.ts"),
      "карта обязана покрывать источник установленного osnova",
    ).toBe(true);
  });

  it("на семантической ошибке ни одна проверяемая точка не молчит", () => {
    const silent: string[] = [];
    for (const point of CHECKED_POINTS) {
      const r = measure(point, "semantic", BROKEN_SEMANTIC);
      if (r.status === 0) silent.push(`${point.id}: код возврата 0 (ожидался ненулевой)`);
      else if (r.lines.length === 0)
        silent.push(`${point.id}: exit ${r.status}, но НОЛЬ строк вывода`);
      else if (!r.output.includes("undeclared_var"))
        silent.push(`${point.id}: причина не названа (нет вида undeclared_var)`);
    }
    expect(silent, `молчащие каналы:\n  ${silent.join("\n  ")}`).toEqual([]);
  });

  it("на ошибке парсера ни одна проверяемая точка не молчит", () => {
    const silent: string[] = [];
    for (const point of CHECKED_POINTS) {
      const r = measure(point, "parse", BROKEN_PARSE);
      if (r.status === 0) silent.push(`${point.id}: код возврата 0`);
      else if (r.lines.length === 0)
        silent.push(`${point.id}: exit ${r.status}, но НОЛЬ строк вывода`);
      else if (!r.output.includes("Ожидается")) silent.push(`${point.id}: причина не названа`);
    }
    expect(silent, `молчащие каналы:\n  ${silent.join("\n  ")}`).toEqual([]);
  });

  it("рабочая программа молчит и выходит нулём — негативный контроль", () => {
    const noisy: string[] = [];
    for (const point of CHECKED_POINTS) {
      const r = measure(point, "good", GOOD);
      if (r.status !== 0) noisy.push(`${point.id}: код возврата ${r.status} (ожидался 0)`);
      for (const line of r.lines) {
        if (/\[(семантика|парсер|сборка)\]|^Парсер /.test(line)) {
          noisy.push(`${point.id}: диагностика на рабочей программе → ${line.slice(0, 80)}`);
        }
      }
      if (!fs.existsSync(r.artifact)) {
        noisy.push(`${point.id}: код 0, но байткод не записан — «тихий успех» ничего не сделал`);
      }
    }
    expect(noisy, `ложные диагностики и тихие успехи:\n  ${noisy.join("\n  ")}`).toEqual([]);
  });
});

describe("машинный режим --diagnostics=json: в stdout только машина", () => {
  it("на битом исходнике stdout — чистый JSONL с кодами формы OSN-*", () => {
    const problems: string[] = [];
    for (const point of SOURCE_POINTS) {
      const r = measure(point, "semantic", BROKEN_SEMANTIC, ["--diagnostics=json"]);
      if (r.status === 0) problems.push(`${point.id}: код возврата 0`);
      const lines = r.stdout.split(/\r?\n/).filter((l) => l.trim() !== "");
      if (lines.length === 0) {
        problems.push(`${point.id}: в stdout ни одной записи`);
        continue;
      }
      for (const line of lines) {
        let record: Record<string, unknown>;
        try {
          record = JSON.parse(line) as Record<string, unknown>;
        } catch {
          problems.push(`${point.id}: строка stdout не JSON → ${line.slice(0, 80)}`);
          continue;
        }
        // Человеческие строки в машинный поток не попадают.
        if (/^\[|^Парсер /.test(line)) problems.push(`${point.id}: человеческая строка в stdout`);
        for (const field of ["code", "phase", "severity", "message"]) {
          if (typeof record[field] !== "string" || record[field] === "") {
            problems.push(`${point.id}: пустое поле ${field} в записи ${line.slice(0, 60)}`);
          }
        }
        // Код вида, которого нет в каталоге, остаётся пустым (решение владельца):
        // поэтому здесь проверяется не «код красивый», а «код есть» — все 15 видов
        // каталогизированы, и пустота означает расхождение каталога и компилятора.
        if (typeof record.code === "string" && !CODE_SHAPE.test(record.code)) {
          problems.push(`${point.id}: код «${record.code}» вне формы OSN-<ФАЗА>-<НОМЕР>`);
        }
      }
    }
    expect(problems, `машинный режим:\n  ${problems.join("\n  ")}`).toEqual([]);
  });

  it("на рабочей программе машинный режим молчит, но байткод записан", () => {
    const problems: string[] = [];
    for (const point of SOURCE_POINTS) {
      const r = measure(point, "good", GOOD, ["--diagnostics=json"]);
      if (r.status !== 0) problems.push(`${point.id}: код возврата ${r.status}`);
      const lines = r.stdout.split(/\r?\n/).filter((l) => l.trim() !== "");
      if (lines.length !== 0) {
        problems.push(`${point.id}: диагностик быть не должно → ${lines[0]!.slice(0, 80)}`);
      }
      // Молчание успеха обязано означать «сделано»: иначе машинный режим
      // неотличим от «ничего не произошло».
      if (!fs.existsSync(r.artifact)) problems.push(`${point.id}: байткод не записан`);
    }
    expect(problems, `тихий успех:\n  ${problems.join("\n  ")}`).toEqual([]);
  });

  it("вид вне каталога не получает выдуманного кода — запись-признак названа", () => {
    // Отказ без единой причины: запись-признак рождается в сборщике, а не в печати,
    // поэтому её видят все потребители — и строки, и JSONL, и журнал.
    const empty: CompileResult = {
      module: null,
      compilerSuccess: false,
      lexerErrors: [],
      parserErrors: [],
      compilerErrors: [],
      semanticErrors: [],
      warnings: [],
      durationMs: 0,
    };
    const records = collectCompileDiagnostics(empty);
    expect(records, "запись-признак обязана быть ровно одна").toHaveLength(1);
    expect(records[0]!.code).toBe(INTERNAL_CODES.refusalWithoutDiagnostics);
    expect(records[0]!.phase).toBe("сборка");
  });
});

describe("утечки в CLI-выводе: текст исходника остаётся в исходнике", () => {
  it("ни одна точка не печатает строку-ловушку из исходника", () => {
    const leaks: string[] = [];
    for (const point of CHECKED_POINTS) {
      for (const label of ["semantic", "parse", "good"] as const) {
        const source =
          label === "parse" ? BROKEN_PARSE : label === "good" ? GOOD : BROKEN_SEMANTIC;
        const r = measure(point, label, source);
        if (r.output.includes(LEAK_MARKER)) {
          const where = r.lines.find((l) => l.includes(LEAK_MARKER)) ?? "";
          leaks.push(`${point.id} [${label}]: ${where.slice(0, 100)}`);
        }
      }
    }
    expect(leaks, `утечки текста исходника:\n  ${leaks.join("\n  ")}`).toEqual([]);
  });
});

describe("каталог видов: покрытие, уникальность и границы пространств имён", () => {
  /** Виды, которые `src/compiler/semantic.ts` порождает на самом деле. */
  function kindsProducedBySource(): Set<string> {
    const text = fs.readFileSync(path.join(ROOT, "src", "compiler", "semantic.ts"), "utf-8");
    const found = new Set<string>();
    for (const m of text.matchAll(/kind:\s*["']([a-z_]+)["']/g)) found.add(m[1]!);
    return found;
  }

  it("каждый вид, порождаемый semantic.ts, есть в каталоге", () => {
    const produced = kindsProducedBySource();
    const catalogued = new Set(DIAGNOSTIC_KINDS.map((k) => k.kind));
    const missing = [...produced].filter((k) => !catalogued.has(k)).sort();
    expect(
      missing,
      "виды без каталожной записи — невидимы для всех, кто спрашивает «блокирует ли»",
    ).toEqual([]);
    expect(produced.size, "semantic.ts обязан порождать виды").toBeGreaterThan(0);
  });

  it("вид каталога без производителя обязан быть назван долгом, а не выдуман", () => {
    const produced = kindsProducedBySource();
    const orphans = DIAGNOSTIC_KINDS.filter((k) => !produced.has(k.kind));
    const unnamed = orphans.filter((k) => {
      const debt = "debt" in k ? k.debt : undefined;
      return typeof debt !== "string" || debt.trim() === "";
    });
    expect(
      unnamed.map((k) => k.kind),
      "запись каталога без производителя и без названной причины — выдуманный вид",
    ).toEqual([]);
    // Сегодня такой ровно один — `chained_compare`: цепочку `a < b < c`
    // разворачивает в `(a < b) и (b < c)` ПАРСЕР (канон §2.1), поэтому площадки в
    // семантике нет, а прежняя проверка била только по законным программам
    // (`(1 < 2) = истина`) и снята. Число закреплено: тихое возвращение
    // производителя или второй «осиротевший» вид видно сразу.
    expect(orphans.map((k) => k.kind)).toEqual(["chained_compare"]);
  });

  it("коды не переиспользованы и не дублируются", () => {
    const codes = DIAGNOSTIC_KINDS.map((k) => k.code);
    expect(new Set(codes).size, "уникальных кодов").toBe(codes.length);
    const bad = codes.filter((c) => !CODE_SHAPE.test(c));
    expect(bad, "коды вне формы OSN-<ФАЗА>-<НОМЕР>").toEqual([]);
  });

  it("пространства имён компилятора и VM не пересекаются", () => {
    const compiler = new Set(DIAGNOSTIC_KINDS.map((k) => k.code));
    const overlap = RUNTIME_CODE_TABLE.map((r) => r.code).filter((c) => compiler.has(c));
    expect(overlap, "код выдан дважды: и виду компилятора, и причине исполнения").toEqual([]);
    const runtime = RUNTIME_CODE_TABLE.map((r) => r.code);
    expect(new Set(runtime).size, "уникальных кодов исполнения").toBe(runtime.length);
    const badRt = runtime.filter((c) => !CODE_SHAPE.test(c));
    expect(badRt, "коды исполнения обязаны лежать в OSN-*").toEqual([]);
  });
});

describe("каталог против факта: блокирует ли вид сборку на самом деле", () => {
  const registry = LANGUAGE_REGISTRY as unknown as {
    syscalls: readonly { name: string; argc: number }[];
    keywords: readonly { lexeme: string; kind: string }[];
  };
  const syscall = registry.syscalls.find((s) => s.argc >= 1);
  const keyword = registry.keywords.find((k) => k.kind !== "block")?.lexeme;
  const syscallName = syscall?.name ?? "система.лог.вывести";
  const keywordLexeme = keyword ?? "модуль";

  const wrap = (body: string): string =>
    ["модуль ПробаВида", "", "процедура главная()", body, "конец", "", "конец", ""].join("\n");

  /**
   * Проба на каждый вид: программа, у которой этот вид — **единственная**
   * диагностика. Виды без пробы перечислены в `UNPROBED` с причиной, и это
   * проверяется: каталог не может вырасти незамеченным.
   */
  const TRIGGERS: Record<string, string> = {
    unknown_syscall: wrap("  система.такого_нет_вообще()"),
    undeclared_var: wrap("  вернуть сумма_без_объявления"),
    unknown_procedure: wrap("  несуществующая_процедура()"),
    syscall_argc: wrap(`  ${syscallName}()`),
    redeclare_var: wrap("  пусть икс = 1\n  пусть икс = 2\n  вернуть икс"),
    invented_syntax: wrap("  пусть с = структура(1)"),
    sentinel_pattern: wrap("  пусть с = пусто\n  вернуть 1"),
    break_outside_loop: wrap("  прервать"),
    continue_outside_loop: wrap("  продолжить"),
    keyword_as_identifier: wrap(`  пусть ${keywordLexeme} = 1\n  вернуть 1`),
    arg_count_mismatch: [
      "модуль ПробаВида",
      "",
      "процедура вспом(а, б)",
      "  вернуть а",
      "конец",
      "",
      "процедура главная()",
      "  вернуть вспом(1)",
      "конец",
      "",
      "конец",
      "",
    ].join("\n"),
    // Вида `chained_compare` здесь нет намеренно: цепочка `1 < 2 < 3` — сахар
    // канона §2.1, её разворачивает парсер, и вид ею не порождается. Проба вида —
    // в `UNPROBED` ниже, с названной причиной недостижимости.
    unknown_module: wrap("  вернуть НетТакогоМодуля.функция()"),
  };

  /**
   * Виды, для которых пробу из исходного текста построить не удалось. Причина
   * названа — «не пробовал» здесь не проходит.
   */
  const UNPROBED: Record<string, string> = {
    keyword_param:
      "недостижим из исходного текста: парсер отвергает любое ключевое слово в позиции " +
      "параметра (замер: 33 из 33) — до семантики дело не доходит",
    chained_compare:
      "недостижим из исходного текста с 2026-09-28: цепочку `a < b < c` разворачивает в " +
      "`(a < b) и (b < c)` ПАРСЕР (канон §2.1 объявляет её сахаром), поэтому проверка в " +
      "семантике била только по законным программам (`(1 < 2) = истина`) и снята; замер — " +
      "отдельной проверкой ниже",
    export_collision:
      "проба из исходного текста не построена: загрузчик модулей не даёт двух провайдеров " +
      "с одним именем (проверено тремя вариантами) — ветка достижима только через " +
      "`analyzeProgram` с собранным вручную Program",
  };

  /**
   * РАСХОЖДЕНИЯ «каталог против факта сборки» — выведены, а не перечислены.
   *
   * Замер 2026-09-28: прежде их было ровно два (`break_outside_loop`,
   * `continue_outside_loop` — в блокирующем списке вида нет, а программа не
   * собирается), и аудит держал их списком «известных». Список снят: признак
   * переведён по замеру, потому что вид, при котором сборка не проходит, обязан
   * идти в repair-цикл, а не печататься «советом». Проверка выведена правилом —
   * поэтому третий вид с расхождением, сдвиг признака и тихое возвращение
   * прежнего краснеют одинаково.
   *
   * Каталог принимается **параметром**: негативный контроль подсовывает сюда
   * мутированную копию, не трогая файл на диске.
   */
  function blockingDivergences(
    entries: readonly { kind: string; blocking: boolean }[],
    triggers: Record<string, string>,
  ): string[] {
    const divergences: string[] = [];
    for (const [kind, source] of Object.entries(triggers)) {
      const info = entries.find((k) => k.kind === kind);
      if (info === undefined) {
        divergences.push(`${kind}: вида нет в каталоге`);
        continue;
      }
      const report = compileToBuildReport(compileSource(source, { filename: "проба-вида.osnova" }));
      const blocksInFact = report.success === false;
      if (info.blocking !== blocksInFact) {
        divergences.push(
          `${kind}: каталог blocking=${info.blocking}, факт success=${report.success}` +
            `, module=${report.bytecode === null ? "null" : "есть"}` +
            `, compilerSuccess=${report.compilerSuccess}`,
        );
      }
    }
    return divergences;
  }

  it("у каждого вида каталога есть либо проба, либо названная причина её отсутствия", () => {
    const covered = [...Object.keys(TRIGGERS), ...Object.keys(UNPROBED)].sort();
    expect(covered).toEqual(DIAGNOSTIC_KINDS.map((k) => k.kind).sort());
  });

  it("каждая проба действительно порождает свой вид — иначе сравнение пустое", () => {
    const lifeless: string[] = [];
    for (const [kind, source] of Object.entries(TRIGGERS)) {
      const r = compileSource(source, { filename: "проба-вида.osnova" });
      if (!r.semanticErrors.some((e) => e.kind === kind)) {
        lifeless.push(
          `${kind}: порождены [${[...new Set(r.semanticErrors.map((e) => e.kind))].join(", ")}]`,
        );
      }
    }
    expect(lifeless, `пробы, не породившие свой вид:\n  ${lifeless.join("\n  ")}`).toEqual([]);
  });

  it("blocking против факта сборки: расхождений нет ни одного — класс, а не перечень", () => {
    const divergences = blockingDivergences(DIAGNOSTIC_KINDS, TRIGGERS);
    expect(
      divergences,
      `расхождения каталога и факта (каждое — повод перемерить, а не дописать в список):\n  ${divergences.join("\n  ")}`,
    ).toEqual([]);
  });

  it("негативный контроль: сдвинутый признак краснит класс — сторож не слеп", () => {
    // Тот же код, что и в проверке выше, но на мутированной КОПИИ каталога: без
    // этого «расхождений нет» неотличимо от «проверка ничего не проверяет».
    const mutated = DIAGNOSTIC_KINDS.map((entry) => ({ ...entry }));
    mutated.find((entry) => entry.kind === "break_outside_loop")!.blocking = false;
    const divergences = blockingDivergences(mutated, TRIGGERS);
    expect(divergences.map((d) => d.split(":")[0])).toEqual(["break_outside_loop"]);
  });

  it("негативный контроль: сдвинутый ЗАМЕР тоже краснит класс — вторая сторона", () => {
    // Обратная мутация: каталог чист, а проба вида из блокирующего списка
    // начинает собираться. Проверка обязана заметить это, а не только правку
    // каталога.
    const aliased: Record<string, string> = {
      ...TRIGGERS,
      unknown_syscall: wrap("  вернуть 1"),
    };
    const divergences = blockingDivergences(DIAGNOSTIC_KINDS, aliased);
    expect(divergences.map((d) => d.split(":")[0])).toEqual(["unknown_syscall"]);
  });

  it("виды без пробы названы: keyword_param недостижим, export_collision — только через API", () => {
    const reasons = Object.values(UNPROBED);
    expect(reasons.length).toBeGreaterThanOrEqual(2);
    for (const reason of reasons) {
      expect(reason.length, "причина обязана быть названа").toBeGreaterThan(20);
    }
  });
});

describe("достижимость видов: замер вместо замысла", () => {
  const registry = LANGUAGE_REGISTRY as unknown as {
    keywords: readonly { lexeme: string; kind: string }[];
  };
  const nonBlockKeywords = registry.keywords.filter((k) => k.kind !== "block").map((k) => k.lexeme);

  it("keyword_param недостижим: парсер отвергает ключевое слово в позиции параметра", () => {
    expect(nonBlockKeywords.length, "неблочных ключевых слов в реестре").toBeGreaterThan(0);
    const reached: string[] = [];
    let parserRejected = 0;
    for (const kw of nonBlockKeywords) {
      const source = [
        "модуль ПробаВида",
        "",
        `процедура вспом(${kw})`,
        "  вернуть 1",
        "конец",
        "",
        "процедура главная()",
        "  вернуть 1",
        "конец",
        "",
        "конец",
        "",
      ].join("\n");
      const r = compileSource(source, { filename: "параметр.osnova" });
      if (r.semanticErrors.some((e) => e.kind === "keyword_param")) reached.push(kw);
      else if (r.parserErrors.length > 0) parserRejected += 1;
    }
    expect(
      reached,
      `keyword_param достижим на [${reached.join(", ")}] — запись в UNPROBED устарела`,
    ).toEqual([]);
    expect(
      parserRejected,
      "проба обязана упираться в парсер — иначе она не проверяет недостижимость",
    ).toBe(nonBlockKeywords.length);
  });

  it("keyword_as_identifier достижим — негативный контроль к предыдущей проверке", () => {
    const reached: string[] = [];
    for (const kw of nonBlockKeywords) {
      const source = [
        "модуль ПробаВида",
        "",
        "процедура главная()",
        `  пусть ${kw} = 1`,
        "  вернуть 1",
        "конец",
        "",
        "конец",
        "",
      ].join("\n");
      const r = compileSource(source, { filename: "имя.osnova" });
      if (r.semanticErrors.some((e) => e.kind === "keyword_as_identifier")) reached.push(kw);
    }
    expect(reached.length, "тем же механизмом обязан ловиться соседний вид").toBeGreaterThan(0);
  });

  it("chained_compare: цепочка СЧИТАЕТСЯ (число мерено), а законное сравнение больше не названо", () => {
    const chain = (body: string): string =>
      ["модуль ПробаВида", "", "процедура главная()", body, "конец", "", "конец", ""].join("\n");
    const real = compileSource(chain("  пусть б = 1 < 2 < 3\n  вернуть 1"), {
      filename: "цепочка.osnova",
    });
    const paren = compileSource(
      chain("  если (1 < 2) = истина тогда\n    вернуть 1\n  конец\n  вернуть 0"),
      { filename: "скобки.osnova" },
    );
    // Замер 2026-09-28. Прежде здесь было закреплено ОБРАТНОЕ («настоящая цепочка
    // не названа, а законное сравнение названо ложно»): проверка в семантике
    // стреляла только по верным программам, и это был её единственный эффект.
    // Правка сняла её, а вид объявлен недостижимым.
    expect(
      [...real.semanticErrors, ...paren.semanticErrors].map((e) => e.kind),
      "вид chained_compare не порождается ничем — оба случая законны",
    ).toEqual([]);
    expect(compileToBuildReport(real).success, "цепочка обязана собираться").toBe(true);
    expect(compileToBuildReport(paren).success, "`(1 < 2) = истина` обязано собираться").toBe(true);
  });

  it("chained_compare: число цепочки ВЕРНОЕ — «тихая ложь» меряется на VM, а не выводится из сборки", async () => {
    // Худший наш класс — «программа собирается, а число неверное». Для цепочки он
    // снят замером: дискриминатор, где истинна ровно одна из трёх цепочек, даёт
    // 10, а не «истина на всё» и не левоассоциативное `(1 < 5) < 3` (оно дало бы
    // 101: `истина < 3` — истина). Сборка об этом не говорит ничего, поэтому
    // значение читается с VM.
    const source = [
      "модуль ПробаЧислаЦепочки",
      "",
      "процедура главная()",
      "  пусть а = 0",
      "  если 1 < 5 < 3",
      "    а = а + 100",
      "  конец",
      "  если 1 < 2 < 3",
      "    а = а + 10",
      "  конец",
      "  если 5 < 2 < 9",
      "    а = а + 1",
      "  конец",
      "  вернуть а",
      "конец",
      "",
      "конец",
      "",
    ].join("\n");
    const result = compileSource(source, { filename: "число-цепочки.osnova" });
    expect(result.compilerSuccess, "программа обязана собираться").toBe(true);
    const vm = new VM(result.module!, { maxSteps: 5000 });
    const value = await vm.runProcedure(vm.findProcedureIndex("главная"), []);
    expect(value, `дискриминатор цепочки: ожидалось 10 (только средняя истинна)`).toBe(10);
  });
});

describe("журнал runs/traces.jsonl против текущей схемы src/trace/**", () => {
  /** Причины отказа, существовавшие ДО правки журнала (поля T4 не трогал). */
  const PREEXISTING_REFUSAL_PATHS = ["status", "intent.appType"];

  it("схема читает журнал: отказов по причине, которой раньше не было, нет", () => {
    // Отсутствие журнала — не «пройдено» (конвенция репозитория: git недоступен →
    // проверка не выполнена, а не зелёная).
    expect(
      fs.existsSync(JOURNAL),
      `журнал ${path.relative(ROOT, JOURNAL)} — проверка не выполнена`,
    ).toBe(true);
    const raw = fs.readFileSync(JOURNAL, "utf-8");
    const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== "");
    expect(lines.length, "непустых строк в журнале").toBeGreaterThan(0);

    let parsed = 0;
    let withDiagnostics = 0;
    const refusals: string[] = [];
    const newReasons: string[] = [];

    for (let i = 0; i < lines.length; i += 1) {
      let obj: unknown;
      try {
        obj = JSON.parse(lines[i]!);
      } catch {
        refusals.push(`строка ${i + 1}: не разбирается как JSON`);
        newReasons.push(`строка ${i + 1}: JSON`);
        continue;
      }
      const record = obj as { diagnostics?: unknown };
      if (Array.isArray(record.diagnostics)) withDiagnostics += 1;
      const r = TraceEntrySchema.safeParse(obj);
      if (r.success) {
        parsed += 1;
        continue;
      }
      for (const issue of r.error.issues) {
        const where = issue.path.join(".");
        refusals.push(`строка ${i + 1}: ${where}: ${issue.message}`);
        // Запись без нового поля обязана отклоняться только по старым причинам.
        if (record.diagnostics === undefined && !PREEXISTING_REFUSAL_PATHS.includes(where)) {
          newReasons.push(`строка ${i + 1}: ${where}: ${issue.message}`);
        }
      }
    }

    // Наблюдённые числа печатаются всегда: вывод, который не показывает, что он
    // измерял, перепроверить нельзя.
    console.log(
      `[аудит журнала] строк=${lines.length} разобрано=${parsed} отказов=${refusals.length}` +
        ` записей с diagnostics=${withDiagnostics}`,
    );

    expect(
      newReasons,
      `схема отклонила записи по НОВОЙ причине (первые 5):\n  ${newReasons.slice(0, 5).join("\n  ")}`,
    ).toEqual([]);
    expect(parsed, "разобранных записей").toBeGreaterThan(0);
  });

  it("новое поле диагностики не несёт текст исходника — ни в живом журнале, ни в проекции", () => {
    // (1) живой журнал: у записей с diagnostics не должно быть многострочных значений.
    const raw = fs.readFileSync(JOURNAL, "utf-8");
    const offenders: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim() === "") continue;
      const obj = JSON.parse(line) as { runId?: string; diagnostics?: unknown };
      if (!Array.isArray(obj.diagnostics)) continue;
      for (const d of obj.diagnostics as Record<string, unknown>[]) {
        for (const [key, value] of Object.entries(d)) {
          if (typeof value === "string" && value.includes("\n")) {
            offenders.push(`${obj.runId ?? "?"}.${key}: перенос строки`);
          }
        }
      }
    }
    expect(offenders.slice(0, 5), "текст исходника в слое diagnostics").toEqual([]);

    // (2) проекция — негативный контроль к (1): пустой живой журнал ничего не
    // доказывает, поэтому проекция проверяется на реальной сборке с ловушкой.
    const result = compileSource(BROKEN_SEMANTIC, { filename: "проба.osnova" });
    const records = projectEntryDiagnostics({
      buildReport: {
        success: false,
        lexerErrors: result.lexerErrors,
        parserErrors: result.parserErrors,
        compilerErrors: result.compilerErrors,
        semanticErrors: result.semanticErrors,
        bytecode: result.module,
        compilerSuccess: result.compilerSuccess,
        durationMs: 0,
      },
    });
    expect(records.length, "проекция обязана что-то дать").toBeGreaterThan(0);
    const serialized = JSON.stringify(records);
    expect(serialized.includes(LEAK_MARKER), "проекция понесла текст исходника").toBe(false);
    for (const record of records) {
      expect(CODE_SHAPE.test(record.code), `код записи ${record.code}`).toBe(true);
    }
  });

  it("CLI печатает строки об отказе, а не зеркало дважды", () => {
    const result = compileSource(BROKEN_SEMANTIC, { filename: "проба.osnova" });
    const records = collectCompileDiagnostics(result);
    const semantic = records.filter((d) => d.phase === "семантика");
    expect(semantic.length, "структурных записей о семантике").toBeGreaterThan(0);
    // Зеркало `[semantic] …` из compilerErrors не должно стать отдельной записью.
    expect(
      records.some((d) => d.message.startsWith("[semantic] ")),
      "зеркал в записях",
    ).toBe(false);
    // И у каждой записи есть код: пустой означал бы вид вне каталога.
    const codeless = records.filter((d) => d.code === "").map((d) => `${d.phase}: ${d.message}`);
    expect(codeless, `записи без кода (вид вне каталога):\n  ${codeless.join("\n  ")}`).toEqual([]);
  });
});
