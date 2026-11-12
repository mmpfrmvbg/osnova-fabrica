/**
 * ОРАКУЛ ИЗВЛЕЧЕНИЯ DSP-ИНСТРУКЦИЙ: у каждой записи есть страница или пометка.
 *
 * ## Что защищается
 *
 * `docs/e2k-dsp-instructions.md` — сырые данные, на которых строится спецификация
 * подмножества. Если запись теряет страницу, спецификация начнёт ссылаться на
 * несуществующий источник, а «НЕТ В ДОКУМЕНТЕ» превратится в утверждение без
 * основания. Поэтому правило простое: **у каждой записи либо номер страницы, либо
 * явная пометка отсутствия с обоснованием, как проверено**.
 *
 * ## Почему проверка выполнима и на «сырых» таблицах
 *
 * Таблицы документа — markdown-таблицы с разделом-заголовком `## 1.x`. Проверяющая
 * функция не прячется в тесте: она вынесена в `checkEntries()`, и негативный контроль
 * кормит её **испорченным текстом** (запись без страницы), а не только настоящим
 * файлом. Так проверяется, что оракул вообще способен краснеть.
 */

import * as fs from "fs";
import * as path from "path";
import { describe, it, expect } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..");
const DOC = path.join("docs", "e2k-dsp-instructions.md");

/** Разделы, где каждая запись обязана иметь страницу. */
const PAGE_CHECKED_SECTIONS = ["1.1.", "1.2.", "1.3.", "1.4.", "1.5.", "1.6."];
/** Раздел «чего нет»: там вместо страницы — обоснование проверки. */
const ABSENCE_SECTION = "1.7.";
/** Раздел со сводкой задержек: страница названа во вводном абзаце раздела. */
const SUMMARY_SECTION = "1.8.";

interface Row {
  section: string;
  line: number;
  cells: string[];
  text: string;
}

/** Убрать markdown-акцент из ячейки. */
function plain(value: string): string {
  return value.replace(/[*`]/g, "").trim();
}

/** Разобрать строки таблиц с привязкой к разделу. */
export function parseRows(text: string): Row[] {
  const rows: Row[] = [];
  const lines = text.split("\n");
  let section = "(нет раздела)";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const heading = /^##\s+(\d+\.\d+\.?)/.exec(line);
    if (heading) {
      section = heading[1]!;
      continue;
    }
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map(plain);
    const body = cells.slice(1, -1);
    if (body.length === 0) continue;
    // Строка-разделитель: предыдущая разобранная строка — заголовок таблицы.
    // Признак структурный: не «в строке нет цифр» (эта эвристика отбрасывала
    // настоящую запись, у которой не оказалось цифр, — поймано негативным контролем).
    if (body.every((c) => /^:?-{2,}:?$/.test(c) || c === "")) {
      if (rows.length > 0 && rows[rows.length - 1]!.line === i) rows.pop();
      continue;
    }
    rows.push({ section, line: i + 1, cells: body, text: line });
  }
  return rows;
}

/**
 * Ссылка на страницу: одно число, диапазон или список через запятую, с
 * необязательными пометками в скобках («162 (описание), 111»).
 */
const PAGE_LIST = /^\s*\d{1,3}(\s*[–-]\s*\d{1,3})?(\s*,\s*\d{1,3}(\s*[–-]\s*\d{1,3})?)*\s*$/;

/** Есть ли в строке ссылка на страницу — отдельной ячейкой или в тексте («стр. 196»). */
function hasPage(row: Row): boolean {
  return row.cells.some((c) => {
    const withoutNotes = c.replace(/\([^)]*\)/g, "").trim();
    if (PAGE_LIST.test(withoutNotes)) return true;
    return /стр\.\s*\d{1,3}/.test(c);
  });
}

/**
 * Есть ли в строке основание: пометка отсутствия, **маркер** наличия или ссылка на
 * страницу.
 *
 * Маркер наличия — именно `ЕСТЬ:` (с двоеточием), а не любое слово «есть»: в первой
 * версии проверки фраза «может быть, есть» засчитывалась как подтверждение, и
 * негативный контроль это поймал (запись без основания не краснела).
 */
function hasEvidence(row: Row): boolean {
  const text = plain(row.text);
  return (
    /НЕТ В ДОКУМЕНТЕ/.test(text) ||
    /0 вхождений/.test(text) ||
    /не найдено|не встречается|не описана|не поддерживается/.test(text) ||
    /ЕСТЬ\s*:/.test(text) ||
    /стр\.\s*\d{1,3}/.test(text)
  );
}

/**
 * Проверить записи. Возвращает список нарушений — так функция пригодна и для
 * негативного контроля (на испорченном тексте).
 */
export function checkEntries(text: string): string[] {
  const problems: string[] = [];
  for (const row of parseRows(text)) {
    if (PAGE_CHECKED_SECTIONS.includes(row.section)) {
      if (!hasPage(row) && !hasEvidence(row)) {
        problems.push(`строка ${row.line} (раздел ${row.section}): нет страницы и нет пометки: ${row.text.slice(0, 80)}`);
      }
    } else if (row.section === ABSENCE_SECTION) {
      if (!hasEvidence(row)) {
        problems.push(`строка ${row.line} (раздел ${row.section}): нет основания (страницы или пометки): ${row.text.slice(0, 80)}`);
      }
    }
  }
  return problems;
}

function readDoc(): string {
  const full = path.join(ROOT, DOC);
  if (!fs.existsSync(full)) throw new Error(`нет файла: ${DOC}`);
  return fs.readFileSync(full, "utf-8");
}

describe("извлечение DSP-инструкций: у каждой записи есть источник", () => {
  it("документ существует и заявляет покрытие источника", () => {
    const doc = readDoc().replace(/\s+/g, " ");
    expect(doc).toContain("208 страниц");
    expect(doc, "не сказано, что нумерация — физические страницы").toMatch(/физические страницы PDF/i);
    expect(doc, "не сказано, что это не спецификация").toMatch(/не спецификацию|НЕ спецификация/i);
  });

  it("все проверяемые разделы на месте", () => {
    const doc = readDoc();
    for (const section of [...PAGE_CHECKED_SECTIONS, ABSENCE_SECTION, SUMMARY_SECTION]) {
      expect(doc, `раздел ${section}`).toContain(`## ${section}`);
    }
  });

  it("ни одна запись не осталась без страницы или пометки", () => {
    expect(checkEntries(readDoc())).toEqual([]);
  });

  it("записей в разделах инструкций достаточно для спецификации", () => {
    const rows = parseRows(readDoc()).filter((r) => PAGE_CHECKED_SECTIONS.includes(r.section));
    expect(rows.length).toBeGreaterThanOrEqual(40);
    // В каждой из шести категорий есть хотя бы одна запись.
    for (const section of PAGE_CHECKED_SECTIONS) {
      expect(rows.filter((r) => r.section === section).length, `раздел ${section}`).toBeGreaterThan(0);
    }
  });

  it("сводка задержек ссылается на таблицу 12.2 и её страницы", () => {
    const doc = readDoc().replace(/\s+/g, " ");
    expect(doc).toMatch(/таблица 12\.2/i);
    expect(doc).toMatch(/199–200|199-200/);
  });

  it("НЕГАТИВНЫЙ КОНТРОЛЬ: запись без страницы ловится", () => {
    const broken = breakLine(readDoc(), "| `ADDs/d`, `SUBs/d`", (line) =>
      // убираем номер страницы из ячейки
      line.replace(/\|\s*196\s*\|/, "| |"),
    );
    const problems = checkEntries(broken);
    expect(problems.length, "запись без страницы не поймана").toBeGreaterThan(0);
    expect(problems[0]).toMatch(/нет страницы/);
  });

  it("НЕГАТИВНЫЙ КОНТРОЛЬ: запись без основания ловится", () => {
    // Подмена целой строки, а не длинного литерала: литерал ломается от правки
    // формулировки, и негативный контроль молча перестаёт что-либо проверять
    // (именно это и случилось в первой версии этого теста).
    const broken = breakLine(
      readDoc(),
      "| **насыщение** (saturating arithmetic)",
      () => "| **насыщение** (saturating arithmetic) | может быть, есть | неизвестно | — |",
    );
    const problems = checkEntries(broken);
    expect(problems.length, "запись без основания не поймана").toBeGreaterThan(0);
    expect(problems[0]).toMatch(/нет основания/);
  });
});

/** Подменить строку, содержащую маркер, — построчно. */
function breakLine(text: string, marker: string, mutate: (line: string) => string): string {
  const lines = text.split("\n");
  const index = lines.findIndex((l) => l.includes(marker));
  if (index < 0) throw new Error(`негативный контроль: строка с маркером не найдена: ${marker}`);
  lines[index] = mutate(lines[index]!);
  return lines.join("\n");
}
