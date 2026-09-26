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
  /**
   * СЛОЙ, в котором живёт расхождение. Правило: расхождение, найденное через
   * обвязку, обязано быть разложено по слоям прежде, чем называться дефектом
   * модели — иначе счётчик «дефектов модели» врёт.
   */
  layer?: "обвязка" | "понижение" | "кодировка" | "модель" | "не установлено";
}

/** Слои, в которых разрешено называть расхождение. */
export const E2K_LAYERS = ["обвязка", "понижение", "кодировка", "модель", "не установлено"] as const;

/**
 * Заявка на атом Атласа.
 *
 * Правило подписи (владелец): заявлять атом можно **только вместе с текстом
 * гарантии и указателем на проверку**. Нет проверки — заявить нельзя: подпись
 * без проверки стала бы украшением, а «заявленный атом есть в каталоге» —
 * формальностью. Поэтому поля обязательные все три.
 */
export interface AtomClaim {
  /** Идентификатор атома из каталога Атласа (`A5`, `B4`, …). */
  atom: string;
  /** Какую гарантию атома пример обеспечивает — своими словами, но по существу. */
  guarantee: string;
  /** Проверка, которая это подтверждает: путь в дереве, обязан существовать. */
  check: string;
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
  expected: {
    origin: string;
    /**
     * Где искать результат программы: `вывод` (печать, по умолчанию) или
     * `возврат` (значение точки входа). Пример, который не может печатать —
     * `система.лог.вывести` на цель не понижен, — обязан отдавать результат
     * возвратом, иначе он не проверяется на цели.
     */
    via?: "вывод" | "возврат";
  };
  /** Заявки на атомы Атласа; пустая подпись — норма для языковых примеров. */
  atoms?: AtomClaim[];
  /**
   * Связь с Атласом БЕЗ заявки на гарантию: пример — вычислительное ядро атома,
   * но гарантий атома не обеспечивает.
   *
   * Зачем отдельное поле, а не `atoms`: гарантия атома A5 — «O(1) окна; сжатие с
   * точной потерей; монотонный индекс», а пятнадцать строк свёртки дают ядро, а
   * не гарантию. Заявить «обеспечивает» — превышение, переписать формулировку
   * своими словами — подмена. Поэтому здесь ЗАПРЕЩЕНЫ слова-притязания
   * («обеспечивает», «гарантирует», …): поле говорит только «это ядро атома».
   */
  core?: { atom: string; what: string; note?: string };
  /**
   * Что пример доказывает НА ЖЕЛЕЗЕ — одной строкой. Обязательно для примеров,
   * объявленных исполняемыми на e2k: сессия на живой машине должна проверять
   * заготовленное утверждение, а не придумывать его на месте.
   */
  hardware?: string;
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

/**
 * Имя каталога примера: `NN-имя` (номер два знака, имя из строчных букв —
 * кириллических или латинских, — цифр и дефисов). Латиница разрешена намеренно:
 * `01-свёртка-fir` — имя примера владельца, и переименовывать его ради шаблона
 * значило бы менять чужое имя под свой разбор.
 */
export const EXAMPLE_DIR_RE = /^(\d{2})-([а-яёa-z0-9-]+)$/u;

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
  // Порядок прогонов на живой машине живёт в ките, а не здесь: индекс называет
  // только число готовых примеров и указывает, где смотреть порядок.
  const ready = examples.filter((e) => e.meta.e2k.status === "работает");
  lines.push("## Готово к железу");
  lines.push("");
  lines.push(`Примеров, объявленных исполняемыми на цели: **${String(ready.length)}**. Что каждый`);
  lines.push("доказывает на машине — в его `meta.hardware`; состав кита и ПОРЯДОК прогонов —");
  lines.push("в `tools/e2k-hardware/README.md` (здесь не дублируется).");
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
  // Список «на железо не поедет» собирается из тех же данных, что и статусы:
  // границы плюс примеры, у которых на цели стоит «нет». Первая сессия на живой
  // машине не должна тратиться на то, что заведомо не понижается.
  const notOnTarget = examples.filter((e) => e.meta.e2k.status === "нет");
  lines.push("## Что на железо не поедет");
  lines.push("");
  lines.push("Список собран из статусов, а не написан руками: границы плюс примеры");
  lines.push("корпуса, объявленные неисполняемыми на цели. У каждого названа причина и");
  lines.push("**слой**: обвязка (наш раннер), понижение, кодировка, модель — или «не");
  lines.push("установлено». «Дефект модели» без такого разложения не доказательство.");
  lines.push("");
  lines.push("| Что | Слой | Причина |");
  lines.push("|---|---|---|");
  for (const e of notOnTarget) {
    lines.push(`| пример \`${cell(e.dir)}\` | ${cell(e.meta.e2k.layer ?? "не назван")} | ${cell(e.meta.e2k.reason ?? "")} |`);
  }
  for (const b of boundaries) {
    lines.push(`| \`${cell(b.path)}\` | ${cell(b.e2k.layer ?? "не назван")} | ${cell(b.e2k.reason ?? "")} |`);
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
