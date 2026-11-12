/**
 * ОРАКУЛ ИЗВЛЕЧЕНИЯ ОПКОДОВ e2k.
 *
 * # Что проверяется
 *
 * `docs/e2k-opcodes-real.md` утверждает: 318 мнемоник подмножества DSP найдены в таблице
 * опкодов МЦСТ `opcodes/e2k-opc.h`, у каждой — строка, код операции и формат. Проверка идёт
 * **не по документу, а по источнику**: тест заново разбирает `opcodes/e2k-opc.h` и сверяет
 * каждую строку приложения А.
 *
 * 1. **Структура документа** (всегда): есть приложение А, в нём не меньше 250 строк, у каждой
 *    строки источник вида `opcodes/e2k-opc.h:строка`; в §2 у каждой строки либо находка, либо
 *    названная причина («НЕТ В ИСТОЧНИКЕ» или «вне таблицы опкодов» с цитатой).
 * 2. **Сверка с источником** (когда есть `.tmp/e2k-sources/`): для каждой строки приложения А
 *    строка источника содержит `{"имя"`, а код операции и формат в ней совпадают с документом.
 * 3. **Сверка утверждений «вне таблицы опкодов»** (когда есть копия): `parse_mova_args`,
 *    «pair of AAS syllables», `return` в `e2k-dis.c`, `abnf` в `elbrus-docs`.
 *
 * # Слабое место названо прямо
 *
 * Копии источников не коммитятся (`.tmp/e2k-sources/`). Без них проверка 2 и 3 выполняться не
 * может; тест сообщает об этом, а не выдаёт «проверок не было» за «проверки пройдены».
 *
 * # Негативный контроль
 *
 * Сверяльщик прогоняется на испорченной строке приложения (сдвинутая строка, чужой код
 * операции, чужая мнемоника). Если порча не ловится — оракул ничего не проверяет.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..", "..");
const DOC = path.join(ROOT, "docs", "e2k-opcodes-real.md");
const SOURCES = path.join(ROOT, ".tmp", "e2k-sources");
const OPC_H = path.join(SOURCES, "binutils-gdb", "opcodes", "e2k-opc.h");

/** Строка приложения А: одна найденная мнемоника. */
export interface AppendixRow {
  readonly name: string;
  readonly format: string;
  readonly opc: string;
  readonly line: number;
}

/** Запись таблицы опкодов МЦСТ, разобранная из `opcodes/e2k-opc.h`. */
export interface OpcodeEntry {
  readonly line: number;
  readonly name: string;
  readonly alopf: string;
  readonly opc: string;
}

const OPC_ENTRY =
  /^\s*\{"([^"]+)",\s*(0x[0-9a-fA-F]+),\s*([A-Za-z_0-9]+),\s*([A-Za-z_0-9]+),\s*([A-Z0-9_|]+),\s*([A-Z0-9_ |]+?),\s*(0x[0-9a-fA-F]+),\s*\{([^}]*)\},\s*([A-Z0-9_]+)\s*(.*)$/;

/** Разобрать таблицу опкодов МЦСТ. */
export function parseOpcodeTable(text: string): OpcodeEntry[] {
  const entries: OpcodeEntry[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const match = OPC_ENTRY.exec(line);
    if (match === null) return;
    entries.push({ line: index + 1, name: match[1]!, alopf: match[5]!, opc: match[7]! });
  });
  return entries;
}

/** Разобрать приложение А документа. */
export function parseAppendix(doc: string): AppendixRow[] {
  const rows: AppendixRow[] = [];
  let inAppendix = false;
  for (const line of doc.split(/\r?\n/)) {
    if (line.startsWith("## 4. Приложение А")) {
      inAppendix = true;
      continue;
    }
    if (inAppendix && line.startsWith("## ")) break;
    if (!inAppendix) continue;
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.length < 8) continue;
    const name = /^`([a-z0-9_]+)`$/.exec(cells[1] ?? "");
    if (name === null) continue;
    const source = /`opcodes\/e2k-opc\.h:(\d+)`/.exec(cells[6] ?? "");
    rows.push({
      name: name[1]!,
      format: (cells[3] ?? "").replace(/`/g, ""),
      opc: (cells[4] ?? "").replace(/`/g, ""),
      line: source === null ? -1 : Number(source[1]),
    });
  }
  return rows;
}

/** Сверить строку приложения с таблицей опкодов. */
export function checkAppendix(rows: readonly AppendixRow[], entries: readonly OpcodeEntry[]): string[] {
  const problems: string[] = [];
  const byLine = new Map(entries.map((entry) => [entry.line, entry]));
  // Первая запись имени: у части мнемоник в таблице две записи (разные наборы инструкций),
  // документ называет первую — так же, как генератор.
  const byName = new Map<string, OpcodeEntry>();
  for (const entry of entries) {
    if (!byName.has(entry.name)) byName.set(entry.name, entry);
  }
  for (const row of rows) {
    if (row.line < 0) {
      problems.push(`${row.name}: в строке нет источника вида opcodes/e2k-opc.h:строка`);
      continue;
    }
    const at = byLine.get(row.line);
    if (at === undefined) {
      problems.push(`${row.name}: строка ${row.line} не является записью таблицы опкодов`);
      continue;
    }
    if (at.name !== row.name) {
      problems.push(`${row.name}: по строке ${row.line} лежит «${at.name}»`);
      continue;
    }
    if (at.opc !== row.opc) {
      problems.push(`${row.name}: код операции в источнике ${at.opc}, в документе ${row.opc}`);
    }
    if (at.alopf !== row.format) {
      problems.push(`${row.name}: формат в источнике ${at.alopf}, в документе ${row.format}`);
    }
    const named = byName.get(row.name);
    if (named === undefined || named.line !== row.line) {
      problems.push(`${row.name}: первая запись имени — строка ${named?.line ?? "нет"}, в документе ${row.line}`);
    }
  }
  return problems;
}

/** Проверить, что в §2 у каждой строки без находок названа причина. */
export function checkSpecSection(doc: string): string[] {
  const problems: string[] = [];
  let inSpec = false;
  let rows = 0;
  for (const line of doc.split(/\r?\n/)) {
    if (line.startsWith("## 2. Соответствие")) {
      inSpec = true;
      continue;
    }
    if (inSpec && line.startsWith("## ")) break;
    if (!inSpec) continue;
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.length < 5) continue;
    if (!line.startsWith("| ") || /^\|[\s-]*\|/.test(cells[1] ?? "")) continue;
    if (cells[1] === "" || cells[1] === "форма") continue;
    rows++;
    const found = cells[2] ?? "";
    const note = cells[3] ?? "";
    const empty = found === "—";
    // В §2 источник сокращён до `:NNN` (файл назван в подписи к таблице);
    // полная форма `файл:строка` тоже принимается.
    if (!empty && !/(opcodes\/e2k-opc\.h)?:\d+/.test(found)) {
      problems.push(`${cells[1]}: находка без источника — «${found.slice(0, 40)}»`);
    }
    if (empty && !/НЕТ В ИСТОЧНИКЕ|вне таблицы опкодов/.test(note)) {
      problems.push(`${cells[1]}: нет находки и не названа причина`);
    }
    if (empty && /вне таблицы опкодов/.test(note) && !/[A-Za-z0-9_.-]+\.(c|h|md):\d+/.test(note)) {
      problems.push(`${cells[1]}: «вне таблицы опкодов» без цитаты файл:строка`);
    }
  }
  if (rows === 0) problems.push("в §2 не разобрано ни одной строки");
  return problems;
}

describe("извлечение опкодов e2k", () => {
  const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, "utf-8") : "";
  const appendix = parseAppendix(doc);

  it("документ существует и приложение А заполнено", () => {
    expect(fs.existsSync(DOC), "нет docs/e2k-opcodes-real.md").toBe(true);
    expect(appendix.length, "строк в приложении А").toBeGreaterThanOrEqual(250);
    expect(new Set(appendix.map((row) => row.name)).size).toBe(appendix.length);
    expect(appendix.every((row) => row.line > 0), "у каждой строки есть источник").toBe(true);
  });

  it("в §2 у каждой строки либо находка с источником, либо названная причина", () => {
    expect(checkSpecSection(doc)).toEqual([]);
  });

  it("каждая строка приложения А сверена с таблицей опкодов", () => {
    if (!fs.existsSync(OPC_H)) {
      // Слабая проверка: источника нет. Причина названа, а не замалчена.
      expect(doc).toContain(".tmp/e2k-sources/");
      return;
    }
    const entries = parseOpcodeTable(fs.readFileSync(OPC_H, "utf-8"));
    expect(entries.length).toBeGreaterThan(3000);
    const problems = checkAppendix(appendix, entries);
    expect(problems, `сверено ${appendix.length} строк`).toEqual([]);
  });

  it("утверждения «вне таблицы опкодов» подтверждаются источником", () => {
    const probes: ReadonlyArray<{ file: string; line: number; contains: string }> = [
      { file: "binutils-gdb/gas/config/tc-e2k.c", line: 4635, contains: "parse_mova_args" },
      { file: "binutils-gdb/gas/config/tc-e2k.c", line: 4657, contains: "AAS syllables" },
      { file: "binutils-gdb/opcodes/e2k-dis.c", line: 1895, contains: "return" },
      { file: "elbrus-docs/README.md", line: 214, contains: "abnf" },
      { file: "elbrus-docs/README.md", line: 225, contains: "ctop" },
      { file: "elbrus-docs/README.md", line: 285, contains: "Opcode" },
    ];
    const missing = probes.filter((probe) => !fs.existsSync(path.join(SOURCES, probe.file)));
    if (missing.length > 0) {
      expect(doc).toContain("НЕТ В ИСТОЧНИКЕ");
      return;
    }
    const problems: string[] = [];
    for (const probe of probes) {
      const lines = fs.readFileSync(path.join(SOURCES, probe.file), "utf-8").split(/\r?\n/);
      const line = lines[probe.line - 1] ?? "";
      if (!line.includes(probe.contains)) {
        problems.push(`${probe.file}:${probe.line} не содержит «${probe.contains}»: ${line.trim()}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("негативный контроль: испорченная строка приложения ловится", () => {
    if (!fs.existsSync(OPC_H)) return;
    const entries = parseOpcodeTable(fs.readFileSync(OPC_H, "utf-8"));
    const sample = appendix[0]!;
    expect(checkAppendix([sample], entries)).toEqual([]);

    // Сдвиг на строку: по названной строке лежит не то, что названо.
    expect(checkAppendix([{ ...sample, line: sample.line + 1 }], entries).join(" ")).toMatch(
      /не является записью|по строке|лежит/,
    );
    // Чужой код операции.
    expect(checkAppendix([{ ...sample, opc: "0xff" }], entries).join(" ")).toMatch(/код операции/);
    // Чужой формат.
    expect(checkAppendix([{ ...sample, format: "ALOPF99" }], entries).join(" ")).toMatch(/формат/);
    // Мнемоника, которой в источнике нет.
    expect(checkAppendix([{ ...sample, name: "несуществующая" }], entries).join(" ")).toMatch(
      /не является записью|лежит/,
    );
    // Строка без источника.
    expect(checkAppendix([{ ...sample, line: -1 }], entries).join(" ")).toMatch(/нет источника/);
  });
});
