import { describe, it, expect } from "vitest";
import { tokenize } from "./lexer";

describe("lexer: базовые конструкции MVP", () => {
  it("модуль + процедура + конец", () => {
    const src = [
      "модуль Тест",
      "процедура главная()",
      "  вернуть 0",
      "конец",
      "конец",
      "",
    ].join("\n");

    const { tokens, errors } = tokenize(src);
    const ks = tokens.map(t => t.kind);

    expect(errors.length).toBe(0);
    expect(ks).toEqual(
      expect.arrayContaining([
        "модуль",
        "идентификатор",
        "процедура",
        "идентификатор",
        "конец",
        "конец_файла",
      ]),
    );
  });

  it("литералы: число, строка, булево", () => {
    const src = [
      "процедура главная()",
      "  пусть x = 42",
      '  пусть s = "привет"',
      "  пусть b = истина",
      "конец",
      "",
    ].join("\n");

    const { tokens, errors } = tokenize(src);

    expect(errors.length).toBe(0);

    const kindsSeq = tokens.map(t => t.kind);
    expect(kindsSeq).toContain("число");
    expect(kindsSeq).toContain("строка");
    expect(kindsSeq).toContain("истина");
  });

  it("операторы: пусть r = a + b * c", () => {
    const src = "процедура main()\n  пусть r = a + b * c\nконец\n";
    const { tokens, errors } = tokenize(src);

    expect(errors.length).toBe(0);

    const seq = tokens.map(t => t.kind);
    // Найдём последовательность вокруг выражения
    const idxPlus = seq.indexOf("+");
    const idxStar = seq.indexOf("*");
    expect(idxPlus).toBeGreaterThan(0);
    expect(idxStar).toBeGreaterThan(idxPlus);
  });

  it("ошибка лексера: неизвестный символ @", () => {
    const src = "процедура main()\n  пусть x = 1 @ 2\nконец\n";
    const { errors } = tokenize(src);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain("Неизвестный символ");
  });
});

