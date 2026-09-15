/**
 * ОРАКУЛ СЛОЯ ЗАМЕНЫ: документ и правило изоляции.
 *
 * Защищается:
 *
 * 1. `docs/e2k-backend.md` существует и называет то, что обещает код: три файла, статусы,
 *    три исхода шлюза, пять проверок контракта, правило изоляции, негативный контроль,
 *    раздел допущений и прямую оговорку, чего тесты не доказывают.
 * 2. Перечень форм поиска в отказе заглушки (`E2K_SEARCHES`) подтверждён **сырыми данными**
 *    `docs/e2k-encoding-raw.md`, а не заявлен заново.
 * 3. **Правило изоляции по исходникам:** производственный код вне `src/e2k/` не импортирует
 *    `encoding.ts` и `shell.ts` напрямую — потребитель идёт через `backend.ts`.
 *
 * У проверки 3 есть **негативный контроль**: сканер обязан поймать подложенный импорт. Без
 * него правило осталось бы непроверенным до первого нарушения — и выглядело бы зелёным.
 */

import * as fs from "fs";
import * as path from "path";
import { describe, it, expect } from "vitest";
import { E2K_DESCRIPTION, E2K_SEARCHES, E2K_REFUSAL_REASON } from "../e2k/e2k";
import { ENCODER_IDS } from "../e2k/backend";
import { SHELL_DESCRIPTION } from "../e2k/shell";

const ROOT = path.resolve(__dirname, "..", "..");
const DOC = path.join("docs", "e2k-backend.md");
const RAW = path.join("docs", "e2k-encoding-raw.md");

function read(rel: string): string {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) throw new Error(`нет файла: ${rel}`);
  return fs.readFileSync(full, "utf-8");
}

/** Схлопнуть пробелы: markdown переносит фразы произвольно. */
function flat(rel: string): string {
  return read(rel).replace(/\s+/g, " ");
}

/** Импорт исходного слоя в обход интерфейса. */
const DIRECT_SHELL_IMPORT = /(?:^|\/)e2k\/(?:encoding|shell)$/;

/**
 * Сканер правила изоляции. Чистая функция: её же проверяет негативный контроль на
 * подложенном тексте.
 */
export function findShellCoupling(files: readonly { path: string; text: string }[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    for (const match of file.text.matchAll(/from\s+"([^"]+)"/g)) {
      const specifier = match[1]!;
      const normalised = specifier.replace(/^\.+/, "");
      if (DIRECT_SHELL_IMPORT.test(normalised)) {
        problems.push(`${file.path}: импорт «${specifier}» — потребитель обязан идти через e2k/backend`);
      }
    }
  }
  return problems;
}

/** Производственные исходники: всё в `src/`, кроме самого `src/e2k/` и тестов. */
function productionSources(): { path: string; text: string }[] {
  const root = path.join(ROOT, "src");
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "e2k" && dir === root) return [];
        return walk(full);
      }
      if (!entry.name.endsWith(".ts")) return [];
      if (entry.name.endsWith(".test.ts")) return [];
      return [full];
    });
  return walk(root).map((full) => ({
    path: path.relative(ROOT, full).replace(/\\/g, "/"),
    text: fs.readFileSync(full, "utf-8"),
  }));
}

describe("слой замены: документ", () => {
  it("документ существует и называет три файла слоя", () => {
    const doc = flat(DOC);
    for (const file of ["src/e2k/backend.ts", "src/e2k/shell.ts", "src/e2k/e2k.ts"]) {
      expect(doc, `нет упоминания ${file}`).toContain(file);
    }
  });

  it("документ содержит разделы 4.1–4.9", () => {
    const doc = read(DOC);
    for (const section of ["4.1.", "4.2.", "4.3.", "4.4.", "4.5.", "4.6.", "4.7.", "4.8.", "4.9."]) {
      expect(doc, `раздел ${section}`).toContain(`## ${section}`);
    }
  });

  it("смена статуса названа прямо: код на оболочке — гипотеза о e2k, а не e2k", () => {
    const doc = flat(DOC);
    expect(doc).toMatch(/гипотеза о e2k, а не e2k/i);
    expect(doc, "не сказано, что это факт о документации, а не об архитектуре").toMatch(
      /факт о \*\*доступной документации\*\*|факт о доступной документации/i,
    );
  });

  it("статусы обеих реализаций совпадают с документом", () => {
    const doc = flat(DOC);
    expect(SHELL_DESCRIPTION.status).toBe("ДОПУЩЕНИЕ");
    expect(E2K_DESCRIPTION.status).toBe("НЕТ В ДОКУМЕНТЕ");
    expect(E2K_DESCRIPTION.instructionSize).toBeNull();
    expect(doc).toContain("ДОПУЩЕНИЕ");
    expect(doc).toContain("НЕТ В ДОКУМЕНТЕ");
    expect([...ENCODER_IDS]).toContain(SHELL_DESCRIPTION.id);
    expect([...ENCODER_IDS]).toContain(E2K_DESCRIPTION.id);
  });

  it("названы три исхода шлюза и пять проверок контракта", () => {
    const doc = flat(DOC);
    for (const outcome of ["`готов`", "`отказывает`", "`нарушение`"]) {
      expect(doc, `нет исхода ${outcome}`).toContain(outcome);
    }
    for (const check of [
      "размер",
      "round-trip",
      "устойчивость",
      "инъективность",
      "чувствительность к подмене бита",
    ]) {
      expect(doc, `нет проверки «${check}»`).toContain(check);
    }
    expect(doc, "не объяснено, почему round-trip недостаточен").toMatch(/не ловит/);
  });

  it("названы правило изоляции, отсутствие умолчания и негативный контроль", () => {
    const doc = flat(DOC);
    expect(doc, "нет правила изоляции").toMatch(/Правило изоляции/);
    expect(doc, "не сказано, что умолчания у выбора бэкенда нет").toMatch(
      /по умолчанию у выбора бэкенда нет намеренно/i,
    );
    expect(doc, "не назван положительный контроль").toMatch(/положительный контроль/i);
    expect(doc, "не названо число подделок").toMatch(/шесть подделок/);
  });

  it("раздел допущений есть, и оговорка о том, чего тесты не доказывают, тоже", () => {
    const doc = flat(DOC);
    expect(doc).toMatch(/Что осталось допущением/);
    expect(doc, "нет оговорки о том, чего тесты не доказывают").toMatch(/не\*\* доказывают|не доказывают/);
    expect(doc, "не сказано, что оракул переживёт замену").toMatch(/переживающий замену/);
  });

  it("«замена — один файл» сформулирована условно, а не как обещание", () => {
    const doc = flat(DOC);
    expect(doc, "нет условной формулировки про один файл").toMatch(
      /верно \*\*только\*\* для замены реализации|верно только для замены реализации/,
    );
    expect(doc, "не сказано, что интерфейс не проверен на соответствие e2k").toMatch(
      /не\*\* утверждает, что интерфейс соответствует e2k|не утверждает, что интерфейс соответствует e2k/,
    );
    expect(doc, "не сказано, что придётся менять интерфейс и эмиттер").toMatch(
      /переписывается интерфейс|менять придётся и `backend\.ts`|переписывать придётся и `backend\.ts`/,
    );
    expect(doc, "нет правила маркировки").toMatch(/Правило маркировки/);
    // Негативный контроль самой проверки: прежняя безусловная формулировка («переписывается
    // только e2k.ts») не должна вернуться незамеченной — иначе проверка была бы декоративной.
    expect(doc, "вернулась безусловная формулировка «замена — один файл»").not.toMatch(
      /переписывается \*\*только\*\* `src\/e2k\/e2k\.ts`/,
    );
  });

  it("перечень форм поиска в отказе подтверждён сырыми данными", () => {
    const raw = read(RAW);
    const missing = E2K_SEARCHES.filter((form) => !raw.includes(form));
    expect(missing, `форм нет в ${RAW}: ${missing.join(", ")}`).toEqual([]);
    expect(E2K_REFUSAL_REASON).toContain("НЕТ В ДОКУМЕНТЕ");
    for (const form of E2K_SEARCHES) {
      expect(E2K_REFUSAL_REASON, `форма «${form}» не названа в отказе`).toContain(form);
    }
  });
});

describe("правило изоляции: потребитель идёт только через backend.ts", () => {
  it("производственный код вне src/e2k не импортирует оболочку и кодек напрямую", () => {
    const files = productionSources();
    // Проверка не должна быть пустой: «проверок не было» — не «проверки пройдены».
    expect(files.length, "сканировать нечего").toBeGreaterThan(20);
    expect(findShellCoupling(files)).toEqual([]);
  });

  it("негативный контроль: сканер ловит подложенный прямой импорт", () => {
    const couplet = [
      { path: "src/vliw/example.ts", text: 'import { decode } from "../e2k/encoding";' },
      { path: "src/vliw/other.ts", text: 'import type { Encoder } from "../e2k/shell";' },
      { path: "src/vliw/fine.ts", text: 'import { getEncoder } from "../e2k/backend";' },
    ];
    const problems = findShellCoupling(couplet);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("src/vliw/example.ts");
    expect(problems[1]).toContain("src/vliw/other.ts");
    expect(problems.join(" ")).not.toContain("fine.ts");
    // И чистый файл нарушением не считается — иначе сканер был бы красен всегда.
    expect(findShellCoupling([couplet[2]!])).toEqual([]);
  });
});

/**
 * Границы слоя: замена покрывает **кодировку**, а не модель устройства, и **сам интерфейс**
 * на соответствие e2k не проверен. Это два долга, а не один (указание владельца 2026-09-15).
 */
describe("границы слоя замены: кодировка — не модель устройства", () => {
  const DEBT = path.join("docs", "hardware-debt.md");
  const EMITTER = path.join("docs", "e2k-emitter-plan.md");

  it("в реестре долга есть раздел 3.6: кодировка заменяема, модель устройства — нет", () => {
    const debt = flat(DEBT);
    expect(debt).toContain("## 3.6.");
    expect(debt, "не сказано, что заменяется только кодировка").toContain("не модель устройства");
    expect(debt, "не сказано, что сам интерфейс не проверен").toMatch(/интерфейс `Encoder` не проверен/);
    expect(debt, "не сказано, что долга два").toMatch(/два долга, а не один|два\*\* долга, а не один/);
    expect(debt, "не назван критический путь").toMatch(/ISA-справочник, а не железо/);
    expect(debt, "не сказано, что замена кодировки второй слой не закрывает").toMatch(
      /второй слой не закрывает|не закрывается заменой/,
    );
    expect(debt, "нет оговорки, что тест соответствие интерфейса не проверяет").toMatch(
      /не проверяет\*\* и не может|не проверяет и не может/,
    );
  });

  it("план эмиттера требует маркировки «на оболочке» и записи идентификатора бэкенда", () => {
    const plan = flat(EMITTER);
    expect(plan).toContain("## 3.8.");
    expect(plan, "нет требования называть эмиттер по оболочке").toMatch(/эмиттер на внутренней оболочке/i);
    expect(plan, "формулировка «эмиттер e2k» без оговорки не запрещена").toMatch(
      /эмиттер e2k» без оговорки запрещена|без оговорки запрещена/,
    );
    expect(plan, "выход не обязан нести идентификатор бэкенда").toContain("internal-shell");
  });
});
