/**
 * СТОРОЖ ССЫЛОК ДОКУМЕНТОВ ЛИНИИ e2k: ЦЕЛЬ — ИМЯ, А НЕ НОМЕР СТРОКИ.
 *
 * # Дефект, ради которого это написано
 *
 * Документы ссылались на код номером строки — `` `src/e2k/e2k-real.ts:266-267` ``. Измерено
 * 2026-09-27: из **25** таких ссылок в `docs/e2k-*.md` **17** указывали на посторонний код
 * (`movts` → `subd`, поля литералов → `immediateOf`, форма `0xdc` → `ssWord`), ещё 3 разъехались
 * частично, и только 5 оставались верными — то есть **гнили все, просто с разной скоростью**.
 * Номер строки не имя: вставка выше цели сдвигает её молча.
 *
 * # Что сторож проверяет
 *
 * | проверка | что ловит |
 * |---|---|
 * | нет ссылок «файл:строка» на файлы репозитория | возврат к прежнему приёму |
 * | каждая именованная ссылка `` `файл#СИМВОЛ[:запись]` `` резолвится | удаление или переименование цели |
 * | ссылок не стало меньше порога | «ссылки исчезли» вместо «ссылки верны» |
 * | негативный контроль | что сторож вообще способен краснеть |
 *
 * # Границы названы
 *
 * Ссылки на **чужой** источник (`elbrus-docs/README.md:129`, `binutils-gdb/…/e2k-dis.c:485`) под
 * запрет не попадают намеренно: это цитаты из пришпиленного артефакта, и номер строки там — часть
 * цитаты. Запрет распространяется только на файлы **нашего** репозитория (`src/`, `docs/`, `tools/`).
 *
 * Сторож проверяет **наличие** цели и записи в ней, а не смысл утверждения документа. Смысл
 * доказывается замером; здесь ловится гниение ссылки.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ROOT,
  collectCodeRefs,
  findRawLineRefs,
  symbolRegion,
  verifyCodeRefs,
  type CodeRef,
  type FileReader,
} from "./e2kCodeRefs";

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

describe("ссылки документов линии e2k на код: цель — имя, а не номер строки", () => {
  const docs = e2kDocs();
  const texts = new Map(docs.map((file) => [file, readDoc(file)]));

  it("документы и ссылки на месте (иначе сторож проверяет пустоту)", () => {
    expect(docs.length, "документов линии e2k").toBeGreaterThanOrEqual(30);
    const total = docs.reduce((sum, file) => sum + collectCodeRefs(texts.get(file)!).length, 0);
    expect(total, "именованных ссылок в документах").toBeGreaterThanOrEqual(30);
  });

  it("в документах нет ссылок «файл:строка» на файлы репозитория", () => {
    const problems: string[] = [];
    for (const file of docs) {
      for (const raw of findRawLineRefs(texts.get(file)!)) {
        problems.push(`${file}: гниющий номер строки ${raw} — замените на «файл#СИМВОЛ[:запись]»`);
      }
    }
    expect(problems, problems.join("; ")).toEqual([]);
  });

  it("каждая именованная ссылка указывает на существующую цель", () => {
    const refs: CodeRef[] = docs.flatMap((file) => collectCodeRefs(texts.get(file)!));
    expect(refs.length, "собрано ссылок").toBeGreaterThanOrEqual(30);
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

  it("негативный контроль: сторож способен краснеть", () => {
    // 1. Запрет ловит наш файл с номером строки…
    expect(findRawLineRefs("см. `src/e2k/e2k-real.ts:266-267`")).toEqual(["src/e2k/e2k-real.ts:266"]);
    // …и НЕ трогает цитату из чужого артефакта.
    expect(findRawLineRefs("см. `elbrus-docs/README.md:461`")).toEqual([]);
    expect(findRawLineRefs("см. `binutils-gdb/opcodes/e2k-dis.c:485`")).toEqual([]);

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
    const planted = `expect(doc).toContain('src/e2k/emitterOracle` + `.ts:49');`;
    expect(pinnedLineAssertions(planted)).toEqual(["src/e2k/emitterOracle.ts:49"]);
    expect(pinnedLineAssertions("expect(doc).toContain('src/e2k/emitterOracle.ts#SHELL_IMAGE_FORMAT');")).toEqual([]);
    expect(pinnedLineAssertions("expect(doc).toContain('elbrus-docs/README.md:461');")).toEqual([]);
  });
});
