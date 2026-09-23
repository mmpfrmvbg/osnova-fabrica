/**
 * Промпт кодогенерации: правила языка и few-shot.
 *
 * Пункт 1.6 требований (`redeclare_var` — 82 случая, самая частая семантическая
 * ошибка): лечится правилом в промпте, а не языком. Здесь проверяется, что
 * правило сформулировано ЯВНО и подкреплено примером, а не только строкой в дампе
 * запрещённых паттернов.
 *
 * Заодно проверяется канон форм: после БЛОК 1 v2 канон — `для` и `поймать`;
 * промпт, учащий `для_каждого`/`иначе_попытка`, тратит токены и учит
 * устаревшему написанию.
 */
import { describe, it, expect } from "vitest";
import { buildOsnovaPrompt } from "./buildOsnovaPrompt";
import { compileSource } from "../compiler/compiler";

const prompt = buildOsnovaPrompt("посчитай сумму чисел из списка");

describe("промпт кодогенерации: правило redeclare_var", () => {
  it("правило повторного `пусть` сформулировано явно, с парой НЕЛЬЗЯ/ПРАВИЛЬНО", () => {
    expect(prompt).toContain("повторное объявление");
    expect(prompt, "должна быть показана ошибка").toMatch(/НЕЛЬЗЯ:[^\n]*пусть сумма = 0/);
    expect(prompt, "должна быть показана замена").toMatch(/ПРАВИЛЬНО:[^\n]*сумма = 0/);
  });

  it("few-shot: накопление объявляет переменную через `пусть` ровно один раз", () => {
    const marker = "// Пример: накопление";
    expect(prompt, "нужен пример на накопление").toContain(marker);
    const example = prompt.split(marker)[1]?.split("// Пример")[0] ?? "";
    expect(
      (example.match(/пусть сумма/g) ?? []).length,
      "в примере переменная объявляется один раз",
    ).toBe(1);
    expect(example, "дальше — присваивание без пусть").toMatch(/^\s*сумма = сумма \+/m);
  });

  it("промпт учит канону форм: `для`, `поймать`", () => {
    expect(prompt, "канон перебора").toContain("для ч в");
    expect(prompt, "канон catch").toContain("поймать");
  });
});


describe("промпт кодогенерации: правило undeclared_var (пункт 1.7 требований)", () => {
  // Самая частая семантическая диагностика на датасете — 106 (снимок
  // 2026-09-23, 3611 исходников). Лечится правилом в промпте, не языком:
  // компилятор уже говорит точно («используется без объявления через пусть»),
  // но модель не видит правила заранее.

  it("правило «объявлять до первого использования» сформулировано явно", () => {
    expect(prompt).toContain("до первого использования");
    expect(prompt, "нужна пара НЕЛЬЗЯ").toMatch(/НЕЛЬЗЯ:[^\n]*индекс/);
    expect(prompt, "нужна пара ПРАВИЛЬНО").toMatch(/ПРАВИЛЬНО:[^\n]*пусть индекс/);
  });

  it("few-shot: объявление идёт раньше использования и пример компилируется", () => {
    const marker = "// Пример: объявление до использования";
    expect(prompt, "нужен few-shot").toContain(marker);
    const lines = prompt.split("\n");
    const start = lines.findIndex((l) => l.includes(marker));
    const block: string[] = [];
    for (let i = start + 1; i < lines.length; i++) {
      if ((lines[i] ?? "").trim() === "") break;
      block.push(lines[i]!);
    }
    const example = block.join("\n");
    const decl = example.indexOf("пусть индекс");
    const use = example.indexOf("индекс = индекс");
    expect(decl, "в примере есть объявление").toBeGreaterThanOrEqual(0);
    expect(use, "в примере есть использование без пусть").toBeGreaterThanOrEqual(0);
    expect(decl, "объявление раньше использования").toBeLessThan(use);

    // Главное: пример — рабочая программа, а не текст «похожий на код».
    const cr = compileSource(example, { filename: "пример.osnova" });
    expect(cr.lexerErrors).toEqual([]);
    expect(cr.parserErrors.map((e) => e.message)).toEqual([]);
    expect(cr.semanticErrors.map((e) => e.kind)).not.toContain("undeclared_var");
    expect(cr.compilerSuccess).toBe(true);
  });
});
