/**
 * КОРПУС ПРИМЕРОВ: чтение каталогов и сборка индекса `examples/README.md`.
 *
 * # Раскладка
 *
 * ```
 * examples/NN-имя/
 *   main.osnova      программа (точка входа); рядом — её модули, если они нужны
 *   expected.txt     эталон результата, полученный НЕЗАВИСИМО (см. meta.expected)
 *   meta.json        что показывает, статус VM, статус e2k и причина отказа
 * examples/boundaries.json  программы вне корпуса, названные честно
 * examples/README.md        индекс; генерируется этим модулем
 * ```
 *
 * # Почему индекс генерируется, а не пишется руками
 *
 * Индекс, написанный руками, расходится с корпусом молча: пример добавили, строку
 * забыли. Здесь индекс — чистая функция от каталогов и `boundaries.json`, а
 * оракул `examples.audit.test.ts` сверяет файл с её результатом. Тогда «в индексе
 * написано» и «в корпусе лежит» — одно утверждение, а не два.
 */
import * as fs from "fs";
import * as path from "path";

/** Статус возможности: `работает` или `нет` — третьего не бывает. */
export type Status = "работает" | "нет";

/** Статус на e2k; при `нет` причина обязательна (проверяется оракулом). */
export interface E2kStatus {
  status: Status;
  reason?: string;
}

/** Подпись примера. */
export interface ExampleMeta {
  /** Человеческое имя: «Сумма элементов массива». */
  name: string;
  /** Что показывает пример — одной строкой. */
  shows: string;
  /** Откуда взят, если взят из учебника или другого места дерева. */
  source?: string;
  vm: Status;
  e2k: E2kStatus;
  /**
   * Чем получен эталон `expected.txt`. Обязательное поле: эталон, полученный тем
   * же прогоном, что и проверяет, ничего не проверяет.
   */
  expected: { origin: string };
  /** Подпись по осям Атласа — идентификаторы атомов из каталога. */
  atoms?: { A?: string[]; C?: string[]; D?: string[] };
}

/** Пример корпуса: каталог, его номер и мета. */
export interface Example {
  /** Имя каталога, например `05-сумма-массива`. */
  dir: string;
  /** Число из имени каталога. */
  number: number;
  meta: ExampleMeta;
  /** Имена файлов `.osnova` в каталоге, точка входа — `main.osnova`. */
  modules: string[];
}

/** Программа вне корпуса, включённая в индекс со статусом и причиной. */
export interface Boundary {
  path: string;
  what: string;
  e2k: E2kStatus;
}

/** Имя каталога примера: `NN-имя` (номер два знака, имя из строчных букв и дефисов). */
export const EXAMPLE_DIR_RE = /^(\d{2})-([а-яё0-9-]+)$/u;

const examplesDir = (root: string): string => path.join(root, "examples");

/** Прочитать каталоги примеров в порядке номеров. Ошибки разбора — исключением. */
export function readExamples(root: string = process.cwd()): Example[] {
  const base = examplesDir(root);
  if (!fs.existsSync(base)) return [];
  const out: Example[] = [];
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const m = EXAMPLE_DIR_RE.exec(entry.name);
    if (m === null) continue;
    const full = path.join(base, entry.name);
    const metaPath = path.join(full, "meta.json");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as ExampleMeta;
    const modules = fs
      .readdirSync(full)
      .filter((f) => f.endsWith(".osnova"))
      .sort();
    out.push({ dir: entry.name, number: Number(m[1]), meta, modules });
  }
  return out.sort((a, b) => a.number - b.number);
}

/** Прочитать список границ. */
export function readBoundaries(root: string = process.cwd()): Boundary[] {
  const file = path.join(examplesDir(root), "boundaries.json");
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf-8")) as Boundary[];
}

const cell = (value: string): string => value.replace(/\|/gu, "\\|").replace(/\n/gu, " ");

/** Собрать текст индекса. Чистая функция: тот же вход — тот же выход. */
export function renderIndex(examples: Example[], boundaries: Boundary[]): string {
  const lines: string[] = [];
  lines.push("<!-- doc-status: active -->");
  lines.push("# Корпус примеров");
  lines.push("");
  lines.push("> Файл сгенерирован: `npx tsx src/scripts/examplesIndex.ts`. Руками не править —");
  lines.push("> расхождение с корпусом ловит оракул `src/scripts/examples.audit.test.ts`.");
  lines.push("");
  lines.push("Здесь лежат законченные программы: каждая собирается и исполняется, у каждой");
  lines.push("эталон результата получен **независимо** от прогона, который её проверяет.");
  lines.push("Статус `нет` у цели обязан называть причину — молчаливое «не работает»");
  lines.push("причиной не считается.");
  lines.push("");
  lines.push("## Примеры");
  lines.push("");
  lines.push("| № | Каталог | Что показывает | VM | e2k |");
  lines.push("|---|---|---|---|---|");
  for (const e of examples) {
    const e2k = e.meta.e2k.status === "работает" ? "**работает**" : "нет";
    lines.push(
      `| ${String(e.number)} | \`${cell(e.dir)}\` | ${cell(e.meta.shows)} | ${e.meta.vm} | ${e2k} |`,
    );
  }
  lines.push("");
  lines.push(`Примеров: **${String(examples.length)}**, из них исполняемых на e2k: **${String(
    examples.filter((e) => e.meta.e2k.status === "работает").length,
  )}**.`);
  lines.push("");
  lines.push("## Границы, названные честно");
  lines.push("");
  lines.push("Сюда попадают программы дерева, которые в корпус не входят: они делают то,");
  lines.push("чего язык на цели пока не умеет. Это не дефект корпуса, а честная граница.");
  lines.push("");
  lines.push("| Программа | Что делает | e2k | Причина |");
  lines.push("|---|---|---|---|");
  for (const b of boundaries) {
    lines.push(
      `| \`${cell(b.path)}\` | ${cell(b.what)} | ${b.e2k.status} | ${cell(b.e2k.reason ?? "")} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

/** Записать индекс. Возвращает текст, который записан. */
export function writeIndex(root: string = process.cwd()): string {
  const text = renderIndex(readExamples(root), readBoundaries(root));
  fs.writeFileSync(path.join(examplesDir(root), "README.md"), text, "utf-8");
  return text;
}

/* CLI: `npx tsx src/scripts/examplesIndex.ts` — пересобрать индекс. */
if (process.argv[1] !== undefined && /examplesIndex\.ts$/u.test(process.argv[1])) {
  const text = writeIndex();
  console.log(`examples/README.md обновлён: ${String(text.split("\n").length)} строк`);
}
