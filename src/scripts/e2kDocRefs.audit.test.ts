/**
 * СТОРОЖ ССЫЛОК ДОКУМЕНТОВ: ЦЕЛЬ — ИМЯ, А НЕ НОМЕР СТРОКИ. ОХВАТ — ВЕСЬ `docs/**`.
 *
 * # Дефект, ради которого это написано
 *
 * Документы ссылались на код номером строки — `` `src/e2k/e2k-real.ts:266-267` ``. Измерено
 * 2026-09-27: из **25** таких ссылок в `docs/e2k-*.md` **17** указывали на посторонний код
 * (`movts` → `subd`, поля литералов → `immediateOf`, форма `0xdc` → `ssWord`), ещё 3 разъехались
 * частично, и только 5 оставались верными — то есть **гнили все, просто с разной скоростью**.
 * Номер строки не имя: вставка выше цели сдвигает её молча.
 *
 * # Почему охват расширен со «линии e2k» на весь `docs/**` (2026-09-27)
 *
 * Прежний сторож проверял только `docs/e2k-*.md` и `docs/hardware-debt.md` — то есть **одну
 * плоскость**. Замер по всему `docs/**` (147 документов) нашёл **126** строк «файл:строка» в
 * 11 документах, и ещё **178** ссылок, названных **голым именем** без пути (`compiler.ts:480`),
 * которые прежний шаблон не видел вовсе: он требовал префикс `src/`, `docs/` или `tools/`.
 *
 * Причина у всех одна — «ссылка обязана резолвиться», и лечится она одним приёмом: именованной
 * целью вместо номера строки. Поэтому и сторож один.
 *
 * # Исключения названы, а не умолчаны
 *
 * У **замороженного** (`frozen`) и **разведочного** (`scratch`) документа ссылка может быть
 * исторической записью, а не указателем на живой код. Такой документ попадает в
 * {@link RAW_REF_EXCEPTIONS} **с причиной**, и сторож проверяет обоснование: файл существует,
 * реестр `docs/manifest.yaml` даёт **тот же** статус, причина написана. Смена статуса в реестре
 * (док перестал быть `frozen`) красит сторожа — исключение нельзя оставить «на всякий случай».
 *
 * # Что сторож проверяет
 *
 * | проверка | что ловит |
 * |---|---|
 * | нет ссылок «файл:строка» по всему `docs/**` вне исключений | возврат к прежнему приёму |
 * | то же для **голого** имени без пути | ссылку, которую прежний шаблон не видел |
 * | каждое исключение обосновано реестром и причиной | «исключение молча» |
 * | каждая именованная ссылка `` `файл#СИМВОЛ[:запись]` `` резолвится | удаление или переименование цели |
 * | ссылок не стало меньше порога | «ссылки исчезли» вместо «ссылки верны» |
 * | негативный контроль | что сторож вообще способен краснеть |
 *
 * # Границы названы
 *
 * - Ссылки на **чужой** источник (`elbrus-docs/README.md:129`, `binutils-gdb/…/e2k-dis.c:485`) под
 *   запрет не попадают намеренно: это цитаты из пришпиленного артефакта, и номер строки там —
 *   часть цитаты. Запрет распространяется только на файлы **нашего** репозитория.
 * - Охват — `docs/**`. Корневые `*.md` (`AGENTS.md`, `README.md`) в него **не входят**: это другая
 *   плоскость. Замер 2026-09-27: из корневых доков номер строки держит только `AGENTS.md:112`.
 * - Сторож проверяет **наличие** цели и записи в ней, а не смысл утверждения документа. Смысл
 *   доказывается замером; здесь ловится гниение ссылки.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ROOT,
  collectCodeRefs,
  declarationPattern,
  findBareLineRefs,
  findRawLineRefs,
  repoFileMatches,
  symbolRegion,
  verifyCodeRefs,
  type CodeRef,
  type FileReader,
} from "./e2kCodeRefs";
import { classify, loadManifest } from "./doc-guardian";

/**
 * Документы линии e2k — те, что ссылаются на код линии.
 *
 * Кроме `docs/e2k-*.md` сюда входит `docs/hardware-debt.md`: реестр долга ссылается на тот же код,
 * и замер 2026-09-27 нашёл в нём ещё **7** гниющих ссылок «файл:строка».
 */
export function e2kDocs(): string[] {
  return fs
    .readdirSync(path.join(ROOT, "docs"))
    .filter((name) => /^e2k-.*\.md$/.test(name) || name === "hardware-debt.md")
    .map((name) => `docs/${name}`)
    .sort();
}

/** Прочитать документ целиком. */
export function readDoc(file: string): string {
  return fs.readFileSync(path.join(ROOT, file), "utf-8");
}

/**
 * Все документы `docs/**` — рекурсивно, включая подкаталоги.
 *
 * Именно «все», а не «линия e2k»: замер 2026-09-27 показал, что гниющие ссылки живут и в
 * `docs/brainstorm/**`, и в каноне, и в `docs/register-ir-migration.md`.
 */
export function allDocs(dir = path.join(ROOT, "docs")): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...allDocs(full));
    else if (/\.md$/i.test(entry.name)) found.push(path.relative(ROOT, full).replace(/\\/g, "/"));
  }
  return found.sort();
}

/** Все файлы оракулов репозитория (пути от корня). */
export function testFiles(dir = path.join(ROOT, "src")): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...testFiles(full));
    else if (/\.test\.ts$/.test(entry.name)) found.push(path.relative(ROOT, full).replace(/\\/g, "/"));
  }
  return found.sort();
}

/**
 * Названное исключение из запрета: исторический номер строки допустим **с причиной**.
 *
 * `path` — файл или каталог (со слэшем на конце). `status` — статус, который обязан дать реестр:
 * исключение для дока, переставшего быть `frozen`/`scratch`, сторож красит.
 */
export interface RawRefException {
  readonly path: string;
  readonly status: "frozen" | "scratch";
  readonly reason: string;
}

/** Причина для замороженных доков — одна: они описывают прошлое состояние контура. */
const FROZEN_REASON =
  "док заморожен (весенний контур, см. AGENTS.md: пересоберётся под экосистему) — он описывает " +
  "прошлое состояние и не источник истины, поэтому его ссылки-historical: номер строки указывает " +
  "на код, каким он был при заморозке, и перевод на имена переписал бы саму запись";

/**
 * Причина для разведки: это запись сеанса, а не сверяемый документ.
 *
 * **Названное ограничение:** у 121 ссылки `docs/brainstorm/**` нет перевода на имена именно
 * потому, что документ — карта гипотез одного сеанса (2026-09-19). Существование каждой ссылки
 * проверяет свой оракул `src/scripts/brainstorm.audit.test.ts`, но он проверяет только «файл есть
 * и строка в его пределах», а не «там сказано то же»; сильное утверждение для этих документов
 * машине недоступно и объявлено в их оракуле (§«Чего этот тест НЕ проверяет»).
 */
const BRAINSTORM_REASON =
  "запись сеанса 2026-09-19 «где теряются такты»: карта гипотез со ссылками-цитатами, а не " +
  "сверяемый документ; существование ссылок проверяет свой оракул src/scripts/brainstorm.audit.test.ts";

/** Замороженные документы внутри `docs/**` — названы списком, а не выведены из реестра молча. */
const FROZEN_DOCS: readonly string[] = [
  "docs/pipeline-v1.md",
  "docs/traces-v1.md",
  "docs/doc-status-plan.md",
  "docs/llm-providers-v1.md",
  "docs/llm-routing-v1.md",
  "docs/training-llm-from-traces-v0.1.md",
  "docs/registry-v0.1.md",
  "docs/app-manifest-v0.1.md",
  "docs/osnova-forge-blueprint.md",
  "docs/forge-blueprint-audit-report.md",
  "docs/osnova-center-v1.md",
  "docs/system-services-v1.md",
];

/** Единственные документы, которым номер строки позволен, — и каждый с причиной. */
export const RAW_REF_EXCEPTIONS: readonly RawRefException[] = [
  { path: "docs/brainstorm/", status: "scratch", reason: BRAINSTORM_REASON },
  ...FROZEN_DOCS.map((file): RawRefException => ({ path: file, status: "frozen", reason: FROZEN_REASON })),
];

/** Исключение, покрывающее файл, либо `undefined`. */
export function exceptionFor(file: string): RawRefException | undefined {
  return RAW_REF_EXCEPTIONS.find((e) => (e.path.endsWith("/") ? file.startsWith(e.path) : file === e.path));
}

/**
 * Проблемы одного документа: гниющие номера строк — и с путём, и голым именем.
 *
 * Чистая функция над текстом: подложенный текст проверяется тем же кодом, что и настоящий документ
 * (правило проекта: негативный контроль обязан проверять **свой** прогон).
 */
export function rawRefProblems(file: string, text: string): string[] {
  if (exceptionFor(file) !== undefined) return [];
  return [...findRawLineRefs(text), ...findBareLineRefs(text)].map(
    (raw) => `${file}: гниющий номер строки ${raw} — замените на «файл#СИМВОЛ[:запись]»`,
  );
}

/** Реестр документации — тот же, что у `docs:check`: второй разбор не заводится. */
function manifest(): ReturnType<typeof loadManifest> {
  return loadManifest(path.join(ROOT, "docs", "manifest.yaml"));
}

/**
 * Утверждения вида `expect(…).toContain('…src/что-то.ts:12…')`.
 *
 * Такой тест держит **номер строки** в себе: переезд цели красит проверку при неизменном коде.
 * Измерено 2026-09-27: ровно одна такая проверка была в репозитории
 * (`src/scripts/e2kQemuRun.audit.test.ts`, `src/e2k/emitterOracle.ts:49`).
 *
 * **Названное ограничение:** строки, целиком занятые комментарием, пропускаются — иначе сторож
 * краснел бы на прозе, объясняющей сам дефект (проверено: он покраснел на первом же прогоне).
 * Комментарий в хвосте строки кода при этом не отсекается.
 */
export function pinnedLineAssertions(text: string): string[] {
  const found: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue;
    for (const match of line.matchAll(/(?:toContain|toEqual|toBe)\(\s*(`[^`]*`|'[^']*'|"[^"]*")/g)) {
      found.push(...findRawLineRefs(match[1]!));
    }
  }
  return found;
}

describe("ссылки документов на код: цель — имя, а не номер строки; охват — весь docs/**", () => {
  const docs = allDocs();
  const e2k = e2kDocs();
  const texts = new Map(docs.map((file) => [file, readDoc(file)]));

  it("документы и ссылки на месте (иначе сторож проверяет пустоту)", () => {
    expect(docs.length, "документов в docs/**").toBeGreaterThanOrEqual(140);
    expect(e2k.length, "документов линии e2k").toBeGreaterThanOrEqual(30);
    const total = docs.reduce((sum, file) => sum + collectCodeRefs(texts.get(file)!).length, 0);
    expect(total, "именованных ссылок в документах").toBeGreaterThanOrEqual(40);
  });

  it("во всём docs/** нет ссылок «файл:строка» вне названных исключений", () => {
    const problems: string[] = [];
    for (const file of docs) problems.push(...rawRefProblems(file, texts.get(file)!));
    expect(problems, problems.join("; ")).toEqual([]);
  });

  it("в документах линии e2k нет ссылок «файл:строка» — и исключений для них тоже", () => {
    const problems: string[] = [];
    for (const file of e2k) {
      for (const raw of findRawLineRefs(texts.get(file)!)) {
        problems.push(`${file}: гниющий номер строки ${raw} — замените на «файл#СИМВОЛ[:запись]»`);
      }
      if (exceptionFor(file) !== undefined) problems.push(`${file}: линия e2k не может быть в исключениях`);
    }
    expect(problems, problems.join("; ")).toEqual([]);
  });

  it("каждое исключение обосновано: файл есть, реестр даёт тот же статус, причина написана", () => {
    const man = manifest();
    const problems: string[] = [];
    for (const exception of RAW_REF_EXCEPTIONS) {
      if (exception.reason.trim().length < 60) problems.push(`${exception.path}: причина не написана`);
      const covered = exception.path.endsWith("/")
        ? docs.filter((file) => file.startsWith(exception.path))
        : [exception.path];
      if (covered.length === 0) problems.push(`${exception.path}: исключение ни на что не указывает`);
      for (const file of covered) {
        const entry = classify(file, man);
        if (entry === null) {
          problems.push(`${file}: в реестре docs/manifest.yaml записи нет`);
          continue;
        }
        if (entry.status !== exception.status) {
          problems.push(
            `${file}: в реестре «${entry.status}», а исключение объявлено как «${exception.status}» — уберите исключение`,
          );
        }
      }
    }
    expect(problems, problems.join("; ")).toEqual([]);
  });

  it("каждая именованная ссылка указывает на существующую цель", () => {
    const refs: CodeRef[] = docs.flatMap((file) => collectCodeRefs(texts.get(file)!));
    expect(refs.length, "собрано ссылок").toBeGreaterThanOrEqual(40);
    const problems = verifyCodeRefs(refs);
    expect(problems, problems.join("; ")).toEqual([]);
  });

  it("документ, назвавший ссылку, называет и файл", () => {
    const problems: string[] = [];
    for (const file of docs) {
      const text = texts.get(file)!;
      for (const ref of collectCodeRefs(text)) {
        if (!text.includes(ref.file)) problems.push(`${file}: ссылка ${ref.raw} без имени файла`);
      }
    }
    expect(problems, problems.join("; ")).toEqual([]);
  });

  it("ни один оракул не держит ссылку «файл:строка» на файл репозитория", () => {
    const problems: string[] = [];
    for (const file of testFiles()) {
      for (const raw of pinnedLineAssertions(fs.readFileSync(path.join(ROOT, file), "utf-8"))) {
        problems.push(`${file}: проверка держит гниющий номер строки ${raw}`);
      }
    }
    expect(problems, problems.join("; ")).toEqual([]);
  });

  it("резолвер видит «export async function» — иначе цель есть, а ссылка не резолвится", () => {
    // Измерено 2026-09-27: `export async function loadModule(` не ловилось ни одним шаблоном —
    // первый знал `export`, но не `async`, второй знал `async`, но не `export`.
    expect(declarationPattern("loadModule").test("export async function loadModule(a: string) {")).toBe(true);
    expect(declarationPattern("f").test("async function f() {")).toBe(true);
    expect(declarationPattern("f").test("export function f() {")).toBe(true);
    expect(declarationPattern("f").test("function f() {")).toBe(true);
    expect(
      verifyCodeRefs([{ raw: "проба", file: "src/runtime/vm/interpreter.ts", symbol: "loadModule" }]),
      "живое объявление обязано резолвиться",
    ).toEqual([]);
  });

  it("негативный контроль: сторож способен краснеть", () => {
    // 1. Запрет ловит наш файл с номером строки…
    expect(findRawLineRefs("см. `src/e2k/e2k-real.ts:266-267`")).toEqual(["src/e2k/e2k-real.ts:266"]);
    // …и НЕ трогает цитату из чужого артефакта.
    expect(findRawLineRefs("см. `elbrus-docs/README.md:461`")).toEqual([]);
    expect(findRawLineRefs("см. `binutils-gdb/opcodes/e2k-dis.c:485`")).toEqual([]);

    // 1б. Голое имя без пути — тот же класс, и прежний шаблон его не видел.
    expect(findBareLineRefs("см. `compiler.ts:480`"), "голое имя нашего файла").toEqual(["compiler.ts:480"]);
    expect(findBareLineRefs("см. `src/compiler/compiler.ts:480`"), "путь уже поймано префиксным").toEqual([]);
    expect(findBareLineRefs("см. `e2k-dis.c:485`"), "чужое расширение").toEqual([]);
    expect(findBareLineRefs("см. `elbrus-docs/README.md:461`"), "чужой путь").toEqual([]);

    // 1г. Неоднозначное имя нашим НЕ считается: `README.md` соответствует 73 файлам дерева, и в
    //     `docs/e2k-opcodes-real.md` так назван руководство МЦСТ (`elbrus-docs README.md:225-227`).
    //     Это найденное замером ложное срабатывание первого варианта сторожа.
    expect(repoFileMatches("compiler.ts"), "compiler.ts — наш и единственный").toEqual(["src/compiler/compiler.ts"]);
    expect(repoFileMatches("README.md").length, "README.md назван не одним файлом").toBeGreaterThan(1);
    expect(findBareLineRefs("см. `README.md:225`"), "неоднозначное имя — не наше").toEqual([]);

    // …и наоборот: подложенное имя проверяется тем же кодом, что и настоящий документ.
    const onlyOurs: (name: string) => boolean = (name) => name === "compiler.ts";
    expect(findBareLineRefs("см. `README.md:225`", onlyOurs), "вне списка — не наше").toEqual([]);
    expect(findBareLineRefs("см. `compiler.ts:480`", onlyOurs), "в списке — наше").toEqual(["compiler.ts:480"]);

    // 1в. ГЛАВНОЕ: тот же код краснеет на доке ВНЕ исключений и молчит на исключении.
    const planted = "см. `src/runtime/goldenApps.ts:27` и `compiler.ts:480`";
    expect(rawRefProblems("docs/language-v2.md", planted), "канон под запретом").toHaveLength(2);
    expect(rawRefProblems("docs/register-ir-migration.md", planted), "активный док под запретом").toHaveLength(2);
    expect(rawRefProblems("docs/pipeline-v1.md", planted), "замороженный док — исключение").toEqual([]);
    expect(rawRefProblems("docs/brainstorm/00-map.md", planted), "разведка — исключение").toEqual([]);

    // 2. Исчезнувшая цель названа.
    const missing = verifyCodeRefs([{ raw: "проба", file: "src/e2k/e2k-real.ts", symbol: "НЕТ_ТАКОГО_СИМВОЛА" }]);
    expect(missing.join(" ")).toMatch(/нет цели/);

    // 3. Исчезнувшая запись внутри существующей цели названа.
    const noEntry = verifyCodeRefs([
      { raw: "проба", file: "src/e2k/e2k-real.ts", symbol: "REAL_OPCODES", entry: "нетТакойМнемоники" },
    ]);
    expect(noEntry.join(" ")).toMatch(/не содержит запись/);

    // 4. Пропавший файл назван.
    const noFile: FileReader = () => undefined;
    expect(verifyCodeRefs([{ raw: "проба", file: "src/нет/такого.ts", symbol: "X" }], noFile).join(" ")).toMatch(
      /нет файла/,
    );

    // 5. ГЛАВНОЕ: вставка строки ВЫШЕ цели ссылку не ломает — потому что цель ищется по имени.
    const shifted = `// временная вставка выше всех целей\n${texts.get("docs/e2k-literal-barriers.md")!}`;
    const sample: CodeRef[] = [{ raw: "проба", file: "src/e2k/e2k-real.ts", symbol: "REAL_OPCODES", entry: "movts" }];
    const source = fs.readFileSync(path.join(ROOT, "src/e2k/e2k-real.ts"), "utf-8");
    const regionBefore = symbolRegion(source, "REAL_OPCODES", false)!;
    const regionAfter = symbolRegion(`// вставка\n${source}`, "REAL_OPCODES", false)!;
    expect(regionAfter.from, "цель сдвинулась на строку").toBe(regionBefore.from + 1);
    expect(verifyCodeRefs(sample, () => `// вставка\n${source}`).join(" "), "ссылка сломалась от вставки").toBe("");
    expect(shifted.startsWith("// временная вставка")).toBe(true);

    // 6. Сторож оракулов ловит ТУ САМУЮ проверку, что стояла в репозитории, и не трогает
    //    законную цитату из чужого артефакта. Строка собирается из частей намеренно: иначе сторож
    //    поймал бы сам себя — и это уже наблюдалось на первом прогоне.
    const plantedLine = `expect(doc).toContain('src/e2k/emitterOracle` + `.ts:49');`;
    expect(pinnedLineAssertions(plantedLine)).toEqual(["src/e2k/emitterOracle.ts:49"]);
    expect(pinnedLineAssertions("expect(doc).toContain('src/e2k/emitterOracle.ts#SHELL_IMAGE_FORMAT');")).toEqual([]);
    expect(pinnedLineAssertions("expect(doc).toContain('elbrus-docs/README.md:461');")).toEqual([]);
  });
});
