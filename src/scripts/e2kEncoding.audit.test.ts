/**
 * ОРАКУЛ КОДИРОВКИ: защита от регрессии.
 *
 * ## Что защищается
 *
 * 1. `docs/e2k-encoding-raw.md` — сырые данные: у каждой записи страница или «НЕТ В ДОКУМЕНТЕ».
 * 2. `docs/e2k-encoding.md` — спецификация: разделы 2.1–2.8.
 * 3. Кодировщик не выдаёт себя за кодировку e2k: статус обязан быть назван честно.
 * 4. Каждая операция таблицы кодировщика и каждая «некодируемая» мнемоника присутствуют в
 *    извлечении ИНСТРУКЦИЙ (`docs/e2k-dsp-instructions.md`) — правило «мнемоника скопирована
 *    посимвольно, а не придумана».
 * 5. Негативный контроль существует и назван: три дефекта и пять отказов декодирования.
 * 6. Допущения кодировки названы и привязаны к тому, чем проверяются (железо/ISA-справочник).
 */

import * as fs from "fs";
import * as path from "path";
import { describe, it, expect } from "vitest";
import { ENCODING_STATUS, NOT_ENCODABLE, OPCODES } from "../e2k/encoding";

const ROOT = path.resolve(__dirname, "..", "..");
const RAW = path.join("docs", "e2k-encoding-raw.md");
const SPEC = path.join("docs", "e2k-encoding.md");
const INSTRUCTIONS = path.join("docs", "e2k-dsp-instructions.md");
const CODEC = path.join("src", "e2k", "encoding.ts");
const NEGATIVE = path.join("src", "e2k", "encoding.negative.test.ts");

function read(rel: string): string {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) throw new Error(`нет файла: ${rel}`);
  return fs.readFileSync(full, "utf-8");
}

/** Схлопнуть пробелы: markdown переносит фразы произвольно. */
function flat(rel: string): string {
  return read(rel).replace(/\s+/g, " ");
}

describe("кодировка: сырые данные и спецификация", () => {
  it("сырые данные существуют и заявляют главный результат поиска", () => {
    const raw = flat(RAW);
    expect(raw).toContain("бинарной кодировки инструкций в документе НЕТ");
    expect(raw, "не сказано, что страницы — физические").toMatch(/физические страницы/i);
    expect(raw, "не перечислены формы поиска (метаправило)").toMatch(/формат команды/);
  });

  it("в сырых данных у каждой строки таблицы есть страница или обоснование", () => {
    /**
     * Разбор идёт по разделам: в 1.1–1.6 у строки обязана быть страница или пометка
     * отсутствия, а в 1.7 («что НЕ описано») строки по определению говорят об отсутствии —
     * там обоснованием служат «0 вхождений», «не описано», «не найдено».
     */
    const lines = read(RAW).split("\n");
    const problems: string[] = [];
    let section = "";
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const heading = /^##\s+(\d+\.\d+\.?)/.exec(line);
      if (heading) {
        section = heading[1]!;
        continue;
      }
      if (!line.startsWith("|")) continue;
      const cells = line.split("|").map((c) => c.replace(/[*`]/g, "").trim());
      const body = cells.slice(1, -1);
      if (body.length === 0) continue;
      if (body.every((c) => /^:?-{2,}:?$/.test(c) || c === "")) continue;
      if (/^\|[\s:-]+\|/.test(lines[i + 1] ?? "")) continue; // заголовок таблицы
      const text = body.join(" | ");
      const hasPage = body.some((c) => /^\d{1,3}(\s*[–-]\s*\d{1,3})?$/.test(c)) || /стр\./.test(text);
      const hasEvidence = /НЕТ В ДОКУМЕНТЕ|0 вхождений|не описано|не найдено|ФАКТ|ДОПУЩЕНИЕ/.test(text);
      if (!hasPage && !hasEvidence) problems.push(`строка ${i + 1} (раздел ${section}): ${line.slice(0, 80)}`);
    }
    expect(problems, `без страницы и без обоснования:\n${problems.join("\n")}`).toEqual([]);
  });


  it("спецификация кодировки содержит все разделы 2.1–2.8", () => {
    const spec = read(SPEC);
    for (const section of ["2.1.", "2.2.", "2.3.", "2.4.", "2.5.", "2.6.", "2.7.", "2.8."]) {
      expect(spec, `раздел ${section}`).toContain(`## ${section}`);
    }
  });

  it("спецификация называет допущения и чем они проверяются", () => {
    const spec = flat(SPEC);
    expect(spec).toMatch(/осталось допущением/i);
    expect(spec, "не сказано, чем проверяются допущения").toMatch(/ISA-справочник|проверяется только на железе/i);
    expect(spec, "не сказано, что эмиттер не выдаст код для реального e2k").toMatch(/не может выдать код для реального e2k/);
  });
});

describe("кодировщик: честность статуса и отсутствие выдуманных мнемоник", () => {
  it("кодек существует и называет свой статус: это не e2k", () => {
    expect(fs.existsSync(path.join(ROOT, CODEC)), "нет кодекa").toBe(true);
    expect(ENCODING_STATUS).toMatch(/НЕ кодировка e2k/);
  });

  it("каждая мнемоника таблицы и каждая некодируемая есть в извлечении инструкций", () => {
    const source = read(INSTRUCTIONS);
    const missing = [...OPCODES.map((o) => o.mnemonic), ...NOT_ENCODABLE].filter((m) => !source.includes(m));
    expect(missing, `нет в извлечении: ${missing.join(", ")}`).toEqual([]);
  });

  it("некодируемые операции имеют причину, а не просто перечислены", () => {
    const codec = read(CODEC);
    const block = codec.slice(codec.indexOf("NOT_ENCODABLE"), codec.indexOf("NOT_ENCODABLE") + 1400);
    expect(block, "нет объяснения причины").toMatch(/предикат|отрицани/i);
  });

  it("негативный контроль существует и назван: три дефекта и пять отказов", () => {
    const negative = flat(NEGATIVE);
    for (const label of ["дефект 1", "дефект 2", "дефект 3"]) {
      expect(negative, `нет ${label}`).toContain(label);
    }
    for (const label of ["1. усечённые", "2. неизвестный код", "3. установленный резервный бит", "4. зарезервированная форма", "5. номер канала"]) {
      expect(negative, `нет случая «${label}»`).toContain(label);
    }
    // И честная оговорка о том, чего контроль не доказывает.
    expect(negative).toMatch(/не доказывает/);
  });

  it("в спецификации подмножества кодировка не выдаётся за факт", () => {
    const subset = flat(path.join("docs", "e2k-subset-dsp.md"));
    // Спецификация подмножества описывает операции, но не их битовую кодировку.
    expect(subset, "не сказано, что бинарная кодировка отсутствует").toMatch(/бинарн|кодировк/i);
  });
});
