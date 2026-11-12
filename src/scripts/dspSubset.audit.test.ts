/**
 * ОРАКУЛ СПЕЦИФИКАЦИИ DSP: источники, отсутствие выдуманных инструкций, выразимость ядер.
 *
 * ## Что защищается
 *
 * `docs/e2k-subset-dsp.md` — спецификация подмножества. Три вещи, которые обязаны
 * оставаться верными:
 *
 * 1. **у каждой инструкции есть источник** — страница руководства или явная пометка
 *    «НЕТ В ДОКУМЕНТЕ» с эмуляцией. Спецификация без источника — это выдумка;
 * 2. **в спецификации нет инструкций, которых нет в извлечении**
 *    (`docs/e2k-dsp-instructions.md`). Проверка идёт по мнемоникам: каждая заглавная
 *    часть каждой мнемоники обязана встречаться в извлечении;
 * 3. **все пять ядер выразимы** — FIR, IIR, БПФ, свёртка, корреляция названы, и для
 *    каждого указана его инструкционная основа.
 *
 * ## Негативный контроль встроен
 *
 * Проверяющие функции (`checkSpecSources`, `checkAgainstExtraction`) — чистые: тест
 * кормит их **испорченным текстом** (выдуманная инструкция; запись без источника) и
 * требует, чтобы нарушения были найдены. Иначе оракул был бы «зелёным потому, что ничего
 * не проверяет».
 */

import * as fs from "fs";
import * as path from "path";
import { describe, it, expect } from "vitest";
import { regModuleOf } from "../vliw/regOracle";
import { RegVM } from "../runtime/vm/reginterpreter";
import { createDefaultInvokeHandler } from "../runtime/vm/interpreter";
import { resolveEntryIndex } from "../oracle/parity";

const ROOT = path.resolve(__dirname, "..", "..");
const SPEC = path.join("docs", "e2k-subset-dsp.md");
const EXTRACTION = path.join("docs", "e2k-dsp-instructions.md");
const KERNELS_DIR = path.join(ROOT, "tests", "dsp", "kernels");

/** Разделы спецификации — по заданию их десять. */
const SECTIONS = ["2.1.", "2.2.", "2.3.", "2.4.", "2.5.", "2.6.", "2.7.", "2.8.", "2.9.", "2.10."];
/** Разделы с таблицами инструкций: в них у каждой строки обязан быть источник. */
const INSTRUCTION_SECTIONS = ["2.1.", "2.2.", "2.3.", "2.4.", "2.5.", "2.6."];
/** Пять ядер, которые спецификация обязана выражать. */
const ALGORITHMS = ["FIR", "IIR", "FFT", "свёртка", "корреляция"];

function read(rel: string): string {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) throw new Error(`нет файла: ${rel}`);
  return fs.readFileSync(full, "utf-8");
}

interface SpecRow {
  section: string;
  line: number;
  text: string;
  cells: string[];
}

function plain(value: string): string {
  return value.replace(/[*`]/g, "").trim();
}

/** Разобрать таблицы спецификации с привязкой к разделу. */
export function parseSpecRows(text: string): SpecRow[] {
  const rows: SpecRow[] = [];
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
    const cells = line.split("|").map(plain).slice(1, -1);
    if (cells.length === 0) continue;
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === "")) {
      if (rows.length > 0 && rows[rows.length - 1]!.line === i) rows.pop();
      continue;
    }
    rows.push({ section, line: i + 1, text: line, cells });
  }
  return rows;
}

const PAGE_LIST = /^\s*\d{1,3}(\s*[–-]\s*\d{1,3})?(\s*,\s*\d{1,3}(\s*[–-]\s*\d{1,3})?)*\s*$/;

/** Есть ли в строке ссылка на страницу. */
function hasPage(row: SpecRow): boolean {
  return row.cells.some((c) => PAGE_LIST.test(c.replace(/\([^)]*\)/g, "").trim()));
}

/** У каждой инструкции есть источник или явная пометка отсутствия. */
export function checkSpecSources(text: string): string[] {
  const problems: string[] = [];
  for (const row of parseSpecRows(text)) {
    if (!INSTRUCTION_SECTIONS.includes(row.section)) continue;
    const hasAbsence = /НЕТ В ДОКУМЕНТЕ/.test(plain(row.text));
    if (!hasPage(row) && !hasAbsence) {
      problems.push(`строка ${row.line} (раздел ${row.section}): нет источника: ${row.text.slice(0, 80)}`);
    }
  }
  return problems;
}

/**
 * Мнемоники спецификации обязаны быть в извлечении.
 *
 * Из мнемоники берутся все заглавные фрагменты длиной ≥2 (`PFMUL_(ADD/SUB/RSUB)(s/d)` →
 * PFMUL, ADD, SUB, RSUB; `ADDs/d` → ADD; `PADD*` → PADD). Фрагмент считается найденным,
 * если встречается в извлечении сам или как семейство со звёздочкой.
 */
export function mnemonicsOf(text: string): string[] {
  const tokens = [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
  const fragments = new Set<string>();
  for (const token of tokens) {
    for (const part of token.match(/[A-Z][A-Z0-9]{1,}/g) ?? []) {
      // классы задержек и служебные имена — не мнемоники инструкций
      if (/^OUT_/.test(part) || /^(DC|RF|CT|PL|QP|APB|LIT|FP|INT|ABN|LSR|CTPR|PPFR)/.test(part)) continue;
      fragments.add(part);
    }
  }
  return [...fragments].sort();
}

export function checkAgainstExtraction(specText: string, extractionText: string): string[] {
  const missing: string[] = [];
  for (const mnemonic of mnemonicsOf(specText)) {
    const found = extractionText.includes(mnemonic) || extractionText.includes(`${mnemonic}*`);
    if (!found) missing.push(mnemonic);
  }
  return missing;
}

describe("спецификация DSP: структура, источники, отсутствие выдумок", () => {
  it("все десять разделов 2.1–2.10 на месте", () => {
    const spec = read(SPEC);
    for (const section of SECTIONS) {
      expect(spec, `раздел ${section}`).toContain(`## ${section}`);
    }
  });

  it("у каждой инструкции есть источник или пометка «НЕТ В ДОКУМЕНТЕ»", () => {
    expect(checkSpecSources(read(SPEC))).toEqual([]);
  });

  it("ни одной инструкции, которой нет в извлечении", () => {
    expect(checkAgainstExtraction(read(SPEC), read(EXTRACTION))).toEqual([]);
  });

  it("спецификация не пуста: мнемоник достаточно для пяти ядер", () => {
    const mnemonics = mnemonicsOf(read(SPEC));
    expect(mnemonics.length).toBeGreaterThanOrEqual(30);
    for (const expected of ["ADD", "MUL", "PMADDH", "SHL", "SAR", "PADD", "LDB", "STD", "SXT"]) {
      expect(mnemonics, `нет мнемоники ${expected}`).toContain(expected);
    }
  });

  it("все пять ядер названы и каждому указана инструкционная основа", () => {
    const spec = read(SPEC);
    for (const algorithm of ALGORITHMS) {
      expect(spec, `не назван алгоритм ${algorithm}`).toContain(algorithm);
    }
    // Основа: скалярный MAC собирается из умножения и сложения (§2.7, пример),
    // упакованный — PMADDH/PMADDUBSH (отдельные операции, стр. 196).
    expect(spec, "нет примера сборки скалярного MAC").toContain("ADD(acc, MULs(x, h))");
    expect(spec).toContain("PMADDH");
    expect(spec).toContain("PMADDUBSH");
  });

  it("пять ядер существуют и эталон для них зафиксирован", () => {
    for (const name of ["fir", "iir", "fft", "convolution", "correlation"]) {
      expect(fs.existsSync(path.join(KERNELS_DIR, `${name}.osnova`)), `нет ${name}.osnova`).toBe(true);
    }
    const reference = JSON.parse(read(path.join("tests", "dsp", "reference.json"))) as Record<string, unknown>;
    for (const name of ["fir", "iir", "fft", "convolution", "correlation"]) {
      expect(reference[name], `в эталоне нет ${name}`).toBeDefined();
    }
  });

  it("спецификация называет пробелы и эмуляцию, а не замалчивает их", () => {
    const spec = read(SPEC);
    for (const gap of ["насыщение", "фиксированная точка", "кольцевые буферы", "скалярный MAC"]) {
      expect(spec.toLowerCase(), `не назван пробел: ${gap}`).toContain(gap.toLowerCase());
    }
    expect(spec).toContain("НЕТ В ДОКУМЕНТЕ");
  });

  it("НЕГАТИВНЫЙ КОНТРОЛЬ: выдуманная инструкция ловится", () => {
    // Вставляем в спецификацию мнемонику, которой нет в извлечении.
    const broken = breakLine(read(SPEC), "| Умножение | `MULs/d`", (line) => `${line}\n| Выдумка | \`PMAGICFMA\` | не существует | У | \`out_1m\` | 196 | ФАКТ |`);
    const missing = checkAgainstExtraction(broken, read(EXTRACTION));
    expect(missing, "выдуманная инструкция не поймана").toContain("PMAGICFMA");
  });

  it("НЕГАТИВНЫЙ КОНТРОЛЬ: запись без источника ловится", () => {
    const broken = breakLine(read(SPEC), "| Сложение | `ADDs/d`", (line) =>
      line.replace(/\|\s*196\s*\|/, "| |"),
    );
    const problems = checkSpecSources(broken);
    expect(problems.length, "запись без источника не поймана").toBeGreaterThan(0);
    expect(problems[0]).toMatch(/нет источника/);
  });

  it("план эмиттера содержит все семь разделов 3.1–3.7", () => {
    const plan = read(path.join("docs", "e2k-emitter-plan.md"));
    for (const section of ["3.1.", "3.2.", "3.3.", "3.4.", "3.5.", "3.6.", "3.7."]) {
      expect(plan, `раздел ${section}`).toContain(`## ${section}`);
    }
    // План обязан называть вход (модуль + разметка атомов) и выход (пакеты или машинный код).
    expect(plan).toContain("module.atoms");
    expect(plan.toLowerCase()).toContain("машинный код");
    expect(plan.toLowerCase()).toContain("пакет");
    // И честно говорить, что это не эмиттер.
    expect(plan).toMatch(/это не эмиттер/i);
    // И называть долги, а не умалчивать о них.
    for (const debt of ["насыщение", "фиксированная точка", "кольцевые буферы", "таблица 12.2"]) {
      expect(plan.toLowerCase(), `долг не назван: ${debt}`).toContain(debt.toLowerCase());
    }
  });

  it("семантика `%` измерена прогоном и совпадает с записанной в документации языка", async () => {
    /**
     * Измерение, а не чтение: собираем крошечный модуль на Основе и исполняем его на
     * регистровой VM. Записанное в документации обязано совпасть с измеренным — иначе
     * документация описывает не тот язык, который есть.
     */
    const cases: Array<{ expr: string; expected: number }> = [
      { expr: "7 % 3", expected: 1 },
      { expr: "(0 - 7) % 3", expected: -1 },
      { expr: "7 % (0 - 3)", expected: 1 },
      { expr: "(0 - 7) % (0 - 3)", expected: -1 },
    ];
    for (const testCase of cases) {
      const source = `модуль Проба\n\nпроцедура главная()\n  вернуть ${testCase.expr}\nконец\n`;
      const built = regModuleOf(source);
      expect(built, `${testCase.expr}: не компилируется`).not.toBeNull();
      const entry = resolveEntryIndex(built!.module.procedures, undefined) ?? 0;
      const host = createDefaultInvokeHandler();
      const vm = new RegVM(built!.module, { maxSteps: 10_000, invoke: (n, a) => host(n, a) });
      const value = await vm.runProcedure(entry, []);
      expect(Number(value), `${testCase.expr}: измерено ${String(value)}`).toBe(testCase.expected);
    }
    // Документация обязана фиксировать ту же семантику и её отличие от Python.
    const language = read(path.join("docs", "language-v2.md"));
    expect(language, "семантика `%` не записана").toMatch(/усечением к нулю/);
    expect(language, "не сказано, чем это отличается от Python").toMatch(/Python/);
  });

  it("долги по таблицам закрыты или явно ограничены", () => {
    const extraction = read(path.join("docs", "e2k-dsp-instructions.md"));
    // 4.1: соответствие столбцов таблицы 12.2 восстановлено и записано.
    expect(extraction, "не записано соответствие столбцов 12.2").toMatch(/Соответствие столбцов — восстановлено/);
    expect(extraction, "не сказано, что осталось допущением").toMatch(/осталось допущением/i);
    // Таблицы 12.3a/b/c — восстановлены с тем же допущением.
    expect(extraction, "не описаны таблицы 12.3a/b/c").toMatch(/12\.3a/);
    // 4.2: варианты семейств проверены измерением и это свойство документа.
    const spec = read(SPEC);
    expect(spec, "не записано измерение по вариантам семейств").toMatch(/проверено измерением \(2026-09-15\)/i);
    expect(spec, "не сказано, что варианты не раскрыты документом").toMatch(/свойство документа/);
  });

  it("правила, добытые на этой работе, записаны — а не только выучены", () => {
    // 1. `/` — вещественное деление: свойство языка, об которое спотыкается каждый
    //    целочисленный алгоритм. Обязано быть в памяти и в документации языка.
    const memory = read(path.join("memory", "_index.md"));
    expect(memory, "в памяти нет правила про `/`").toMatch(/ВЕЩЕСТВЕННОЕ деление/i);
    expect(memory, "в памяти нет правила про выдуманные имена").toMatch(/ПОСИМВОЛЬНО/i);
    expect(memory, "в памяти нет метаправила о формах поиска").toMatch(/ВСЕМИ ФОРМАМИ/i);
    const language = read(path.join("docs", "language-v2.md"));
    expect(language, "в документации языка нет предупреждения о `/`").toContain("ВЕЩЕСТВЕННОЕ деление");
    expect(language, "не показан способ целочисленного деления").toContain("система.математика.остаток");

    // 2. Граница целочисленного DSP: ограничение N и отсутствие фиксированной точки.
    const candidates = read(path.join("docs", "b-task-candidates.md"));
    expect(candidates, "в кандидатах не записана граница целочисленного DSP").toMatch(
      /FFT больших N|спектральный анализ больших N/i,
    );
    expect(candidates, "не сказано, что фиксированной точки в подмножестве нет").toMatch(
      /фиксированной точки, которой в подмножестве нет|нет фиксированной/i,
    );

    // 3. Что именно НЕ извлечено из таблицы 12.2 — записано явно.
    const spec = read(SPEC);
    expect(spec, "не сказано, что таблица 12.2 извлечена частично").toMatch(
      /таблиц[аы] 12\.2 извлечен[ао] НЕ ПОЛНОСТЬЮ|извлечено НЕ ПОЛНОСТЬЮ/i,
    );
    expect(spec, "не сказано, что именно не извлечено").toMatch(/шапк|12\.3a/i);

    // 4. Обязанности Фазы 4 зафиксированы (варианты семейств, таблица 12.2, пять ядер).
    const plan = read(path.join("docs", "vliw-phases-plan.md"));
    expect(plan, "в плане нет обязанности раскрыть варианты семейств").toMatch(/раскрыть варианты семейств/i);
    expect(plan, "в плане нет обязанности воспроизвести пять ядер").toMatch(/воспроизвести пять ядер/i);
  });
});

/** Подменить строку по маркеру — построчно (устойчиво к формулировкам). */
function breakLine(text: string, marker: string, mutate: (line: string) => string): string {
  const lines = text.split("\n");
  const index = lines.findIndex((l) => l.includes(marker));
  if (index < 0) throw new Error(`негативный контроль: строка с маркером не найдена: ${marker}`);
  lines[index] = mutate(lines[index]!);
  return lines.join("\n");
}
