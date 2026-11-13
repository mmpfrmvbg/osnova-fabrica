/**
 * ИМЕНОВАННЫЕ ССЫЛКИ НА КОД: `` `путь#СИМВОЛ` `` и `` `путь#СИМВОЛ:запись` ``.
 *
 * # Дефект, ради которого это написано
 *
 * Документы ссылались на код **номером строки** — `` `src/e2k/e2k-real.ts:266-267` ``. Номер строки
 * не является именем: любая вставка **выше** цели сдвигает её молча, и ссылка начинает указывать на
 * чужой код. Измерено 2026-09-27: из **25** таких ссылок в `docs/e2k-*.md` **17** уже указывали на
 * постороннее (`movts` → `subd`, поля литералов → `immediateOf`, форма `0xdc` → `ssWord`), ещё 3
 * разъехались частично. Хуже того, тот же приём держал **якоря оракула**:
 * `src/scripts/e2kAddressLoading.audit.test.ts` хранил абсолютные номера и дважды краснел от чужой
 * вставки выше якоря (пересчёт 2026-09-27: +176) — агент, добавивший строку в `e2k-real.ts`, ломал
 * прогон не по своей вине.
 *
 * # Что здесь вместо номера
 *
 * Целью ссылки становится **имя в файле**: объявление символа (переменная, функция, класс, тип,
 * метод, поле, импорт) либо заголовок раздела для `.md`. Имя не сдвигается при вставках — поэтому
 * ссылка не гниёт. Если у цели есть **запись** (`REAL_OPCODES` → `movts`), проверяется, что запись
 * лежит **внутри** найденной цели, а не просто где-то в файле.
 *
 * # Границы объявления
 *
 * Тело цели — от строки объявления до парной закрывающей скобки (`(`/`[`/`{`). Скобки считаются с
 * пропуском строк, блочных комментариев и строковых литералов. **Названное ограничение:** подстановки
 * внутри шаблонных строк (`${…}`) считаются частью строки, а регулярные литералы не распознаются
 * вовсе. Если парная скобка не найдена, границы объявляются **неизвестными** — это названный отказ,
 * а не тихое «сойдёт»: `symbolRegion` возвращает `undefined`, и проверка краснеет с причиной.
 *
 * # Чего это НЕ проверяет
 *
 * Что символ означает то же, что о нём говорит документ. Это сторож **исчезновения и сдвига цели**,
 * а не доказательство смысла: смысл доказывается замером, а не ссылкой.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Корень репозитория (на два уровня выше `src/scripts`). */
export const ROOT = path.resolve(__dirname, "..", "..");

/** Именованная ссылка, собранная из текста. */
export interface CodeRef {
  /** Как написано в документе, включая обратные кавычки. */
  readonly raw: string;
  /** Путь от корня репозитория. */
  readonly file: string;
  /** Имя цели: объявление символа или заголовок раздела. */
  readonly symbol: string;
  /** Запись внутри цели, если ссылка её называет. */
  readonly entry?: string;
}

/** Границы цели в файле; строки нумеруются с единицы, обе включительно. */
export interface Region {
  readonly from: number;
  readonly to: number;
}

/** Пути, которые этот модуль считает **своими**; чужой источник (`elbrus-docs/…`) сюда не попадает. */
const OWN_ROOTS: readonly string[] = ["src/", "docs/", "tools/"];

/** Ссылка вида `` `путь#СИМВОЛ` `` или `` `путь#СИМВОЛ:запись` ``. */
const REF_PATTERN = /`([A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:ts|tsx|md))#([^`:\s]+)(?::([^`\s]+))?`/g;

/** Гниющий номер строки на файл репозитория. Отрицательный просмотр отсекает `elbrus-docs/…`. */
const RAW_LINE_PATTERN = /(?<![\w.-])((?:src|docs|tools)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|md)):(\d+)/g;

/** Экранировать текст для подстановки в регулярное выражение. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Собрать именованные ссылки из текста (документа или теста). */
export function collectCodeRefs(text: string): CodeRef[] {
  const refs: CodeRef[] = [];
  for (const match of text.matchAll(REF_PATTERN)) {
    const file = match[1]!;
    if (!OWN_ROOTS.some((root) => file.startsWith(root))) continue;
    const entry = match[3];
    refs.push({
      raw: match[0]!,
      file,
      symbol: match[2]!,
      ...(entry === undefined ? {} : { entry }),
    });
  }
  return refs;
}

/**
 * Найти в тексте ссылки «путь:номер» на файлы нашего репозитория.
 *
 * Возвращает их как есть — чтобы сторож мог назвать каждую, а не сообщить «что-то нашлось».
 */
export function findRawLineRefs(text: string): string[] {
  return [...text.matchAll(RAW_LINE_PATTERN)].map((match) => `${match[1]!}:${match[2]!}`);
}

/**
 * Каталоги, в которые индекс имён не заглядывает: чужой код, служебные каталоги git и рабочие
 * деревья агентов `.agents/worktrees` (не отслеживаются git; их копии делают имя `compiler.ts`
 * неоднозначным и краснят негативный контроль «голое имя нашего файла»).
 */
const BARE_SKIP = new Set(["node_modules", ".git", ".agents"]);

/**
 * Ссылка вида `` `compiler.ts:480` `` — имя без пути.
 *
 * Отрицательный просмотр отсекает уже названный путь: в `src/e2k/e2k-real.ts:97` перед именем
 * стоит `/`, и совпадения здесь не будет — такие ссылки ловит {@link findRawLineRefs}.
 */
const BARE_LINE_PATTERN = /(?<![\w./-])([A-Za-z0-9_-]+\.(?:ts|tsx|md)):(\d+)/g;

/** Индекс «имя файла → пути в репозитории»; строится один раз на прогон. */
let bareIndex: Map<string, string[]> | undefined;

function buildBareIndex(dir = ROOT, out = new Map<string, string[]>()): Map<string, string[]> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (BARE_SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    // Ссылки и junction'ы пропускаются: обход по ним может зациклиться (в этом дереве они есть).
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) buildBareIndex(full, out);
    else {
      const list = out.get(entry.name) ?? out.set(entry.name, []).get(entry.name)!;
      list.push(path.relative(ROOT, full).replace(/\\/g, "/"));
    }
  }
  return out;
}

/** Все файлы репозитория с таким именем (пути от корня). */
export function repoFileMatches(name: string): string[] {
  bareIndex ??= buildBareIndex();
  return bareIndex.get(name) ?? [];
}

/**
 * Названо ли голое имя **ровно одним** файлом репозитория.
 *
 * Однозначность требуется потому, что имя без пути нередко указывает на **чужой** артефакт, а не на
 * наш файл: измерено 2026-09-27 — `elbrus-docs README.md:225-227` в `docs/e2k-opcodes-real.md`
 * ссылается на руководство МЦСТ, и при этом имя `README.md` соответствует **73** файлам дерева.
 * Поэтому `compiler.ts` (единственный файл — `src/compiler/compiler.ts`) под запрет попадает, а
 * `README.md` и `interpreter.ts` (два файла: `src/runtime/vm/interpreter.ts` и
 * `src/runtime/interpreter.ts`) — нет. **Названное ограничение:** неоднозначное имя проверкой не
 * покрыто намеренно — лучше пропустить, чем покрасить честную цитату.
 */
export function isUniquelyOurs(name: string): boolean {
  return repoFileMatches(name).length === 1;
}

/**
 * Найти ссылки «имя:номер» **без пути**, которые разрешаются в **единственный** файл репозитория.
 *
 * `compiler.ts:480` — та же гниющая ссылка, что `src/compiler/compiler.ts:480`, только имя короче,
 * и прежний запрет её не видел: измерено 2026-09-27 — она стояла в каноне
 * (`docs/language-v2.md:636`), а по `docs/brainstorm/**` таких ссылок 167.
 *
 * Параметр `ours` вынесен, чтобы негативный контроль проверял **свой** прогон, а не только данные.
 */
export function findBareLineRefs(text: string, ours: (file: string) => boolean = isUniquelyOurs): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(BARE_LINE_PATTERN)) {
    if (!ours(match[1]!)) continue;
    found.push(`${match[1]!}:${match[2]!}`);
  }
  return found;
}

/**
 * Шаблон объявления символа: переменная, функция, класс, тип, метод, поле или импорт.
 *
 * **Случай, ради которого список модификаторов стал общим:** `export async function loadModule(`
 * не ловилось ни одним из шаблонов — первый знал `export`, но не знал `async`, второй знал `async`,
 * но не знал `export`. Измерено 2026-09-27 на `src/runtime/vm/interpreter.ts#loadModule` и
 * `src/runtime/goldenApps.ts#runGoldenCheck`: цель «не найдена» при живом объявлении. Порядок и
 * число модификаторов объявлению не важны, поэтому они берутся одним списком в любом порядке.
 */
export function declarationPattern(symbol: string): RegExp {
  const s = escapeRegExp(symbol);
  return new RegExp(
    [
      `^[ \\t]*(?:(?:export|declare|async|default)[ \\t]+)*(?:const|let|var|function|class|interface|type|enum)[ \\t]+${s}\\b`,
      `^[ \\t]*(?:(?:private|public|protected|static|async|override|readonly|abstract)[ \\t]+)*${s}[ \\t]*[(<]`,
      `^[ \\t]*(?:readonly[ \\t]+)?${s}[ \\t]*\\??[ \\t]*:`,
      `^[ \\t]*import[ \\t]+(?:type[ \\t]+)?\\{[^}]*\\b${s}\\b[^}]*\\}`,
    ].join("|"),
    "m",
  );
}

/** Шаблон заголовка раздела `.md` с названным номером (`### 2.3. …`). */
export function headingPattern(symbol: string): RegExp {
  return new RegExp(`^#{1,6}[ \\t]*${escapeRegExp(symbol)}(?=[ \\t.]|$)`, "m");
}

/** Число строк до позиции `index` (то есть номер строки, содержащей эту позицию). */
function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === "\n") line++;
  return line;
}

const OPENERS: Readonly<Record<string, string>> = { "(": ")", "[": "]", "{": "}" };
const CLOSERS = new Set([")", "]", "}"]);

type Mode = "code" | "line" | "block" | "single" | "double" | "template";

/**
 * Следующий символ, который видит **код**: строки, блочные и строчные комментарии пропускаются.
 *
 * Возвращает позицию и режим, из которого продолжать. Возвращает `undefined` в конце текста.
 * **Названное ограничение:** подстановки внутри шаблонных строк считаются частью строки,
 * регулярные литералы не распознаются вовсе.
 */
function nextCodeChar(text: string, i: number, mode: Mode): { index: number; mode: Mode } | undefined {
  let current: Mode = mode;
  while (i < text.length) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (current === "code") {
      if (ch === "/" && next === "/") {
        current = "line";
        i += 2;
        continue;
      }
      if (ch === "/" && next === "*") {
        current = "block";
        i += 2;
        continue;
      }
      if (ch === "'") {
        current = "single";
        i++;
        continue;
      }
      if (ch === '"') {
        current = "double";
        i++;
        continue;
      }
      if (ch === "`") {
        current = "template";
        i++;
        continue;
      }
      return { index: i, mode: current };
    }
    if (current === "line") {
      if (ch === "\n") current = "code";
      i++;
      continue;
    }
    if (current === "block") {
      if (ch === "*" && next === "/") {
        current = "code";
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    // Строковый литерал: обратная косая черта экранирует следующий символ.
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (
      (current === "single" && ch === "'") ||
      (current === "double" && ch === '"') ||
      (current === "template" && ch === "`")
    ) {
      current = "code";
    }
    i++;
  }
  return undefined;
}

/**
 * Позиция парной закрывающей скобки для открывающей в позиции `start`.
 *
 * Возвращает `undefined`, если парной скобки нет — это отказ, а не «конец файла».
 */
export function matchingBracket(text: string, start: number): number | undefined {
  const stack: string[] = [];
  let cursor = nextCodeChar(text, start, "code");
  while (cursor !== undefined) {
    const ch = text[cursor.index]!;
    if (OPENERS[ch] !== undefined) {
      stack.push(OPENERS[ch]!);
    } else if (CLOSERS.has(ch)) {
      if (stack.length === 0 || stack[stack.length - 1] !== ch) return undefined;
      stack.pop();
      if (stack.length === 0) return cursor.index;
    }
    cursor = nextCodeChar(text, cursor.index + 1, cursor.mode);
  }
  return undefined;
}

/** Строка на нулевом уровне, начинающая новое объявление, — конец предыдущего без `;`. */
const TOP_LEVEL_START = /^(?:export\s|const\s|function\s|class\s|interface\s|type\s|enum\s|let\s|var\s|\})/;

/**
 * Позиция скобки, открывающей **тело** объявления.
 *
 * Аннотация типа и список параметров телом не считаются: сначала пропускается «голова» объявления
 * (до первого `=` на нулевой глубине либо до закрытия списка параметров), и только потом берётся
 * `{` или `[` нулевой глубины. Так `export const X: T[] = [` даёт тело массива, а не `[]` из типа.
 *
 * Возвращает `undefined`, если тела нет (`readonly x?: T;`) — тогда цель равна строке объявления.
 */
function findBodyOpener(text: string, start: number): number | undefined {
  const stack: string[] = [];
  const firstLineEnd = text.indexOf("\n", start);
  let head = false;
  let cursor = nextCodeChar(text, start, "code");
  while (cursor !== undefined) {
    const index = cursor.index;
    const ch = text[index]!;
    if (stack.length === 0) {
      if (
        ch === "=" &&
        text[index + 1] !== "=" &&
        text[index - 1] !== "=" &&
        text[index - 1] !== "!" &&
        text[index - 1] !== "<" &&
        text[index - 1] !== ">"
      ) {
        head = true;
      } else if (OPENERS[ch] !== undefined) {
        if (head && (ch === "{" || ch === "[")) return index;
        if (!head && ch === "{") return index;
        stack.push(OPENERS[ch]!);
      } else if (ch === ";") {
        return undefined;
      } else if (index > firstLineEnd && text[index - 1] === "\n" && TOP_LEVEL_START.test(text.slice(index))) {
        return undefined;
      }
    } else if (OPENERS[ch] !== undefined) {
      stack.push(OPENERS[ch]!);
    } else if (CLOSERS.has(ch) && stack[stack.length - 1] === ch) {
      stack.pop();
    }
    cursor = nextCodeChar(text, index + 1, cursor.mode);
  }
  return undefined;
}

/** Найти границы цели: объявления символа в коде или раздела в `.md`. */
export function symbolRegion(text: string, symbol: string, markdown: boolean): Region | undefined {
  if (markdown) return headingRegion(text, symbol);
  const match = declarationPattern(symbol).exec(text);
  if (match === null) return undefined;
  const from = lineAt(text, match.index);
  const openerIndex = findBodyOpener(text, match.index);
  if (openerIndex === undefined) return { from, to: from };
  const closeIndex = matchingBracket(text, openerIndex);
  if (closeIndex === undefined) return undefined;
  return { from, to: lineAt(text, closeIndex) };
}

/** Раздел `.md`: от заголовка до следующего заголовка того же или высшего уровня. */
function headingRegion(text: string, symbol: string): Region | undefined {
  const pattern = headingPattern(symbol);
  const match = pattern.exec(text);
  if (match === null) return undefined;
  const from = lineAt(text, match.index);
  const level = (match[0].match(/^#+/) ?? ["#"])[0].length;
  const lines = text.split(/\r?\n/);
  for (let line = from; line < lines.length; line++) {
    const heading = /^(#{1,6})[ \t]/.exec(lines[line] ?? "");
    if (heading === null) continue;
    if (heading[1]!.length <= level) return { from, to: line };
  }
  return { from, to: lines.length };
}

/** Читатель файла; вынесен параметром, чтобы негативный контроль не трогал диск. */
export type FileReader = (file: string) => string | undefined;

/** Читать файл репозитория по пути от корня. */
export const readRepoFile: FileReader = (file) => {
  const full = path.join(ROOT, file);
  return fs.existsSync(full) ? fs.readFileSync(full, "utf-8") : undefined;
};

/** Проблемы ссылок: пустой список — каждая цель найдена и содержит названную запись. */
export function verifyCodeRefs(refs: readonly CodeRef[], read: FileReader = readRepoFile): string[] {
  const problems: string[] = [];
  for (const ref of refs) {
    const text = read(ref.file);
    if (text === undefined) {
      problems.push(`нет файла ${ref.file} (ссылка ${ref.raw})`);
      continue;
    }
    const markdown = /\.md$/i.test(ref.file);
    const region = symbolRegion(text, ref.symbol, markdown);
    if (region === undefined) {
      problems.push(`${ref.raw}: в ${ref.file} нет цели «${ref.symbol}» или её границы не определены`);
      continue;
    }
    if (ref.entry === undefined) continue;
    const word = new RegExp(`(?<![\\w$])${escapeRegExp(ref.entry)}(?![\\w$])`, "u");
    const lines = text.split(/\r?\n/);
    let found = false;
    for (let line = region.from; line <= region.to; line++) {
      if (word.test(lines[line - 1] ?? "")) {
        found = true;
        break;
      }
    }
    if (!found) {
      problems.push(
        `${ref.raw}: цель «${ref.symbol}» (${ref.file}:${region.from}-${region.to}) не содержит запись «${ref.entry}»`,
      );
    }
  }
  return problems;
}
