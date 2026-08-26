import { describe, it, expect } from "vitest";
import { ALL_TOKEN_KINDS, tokenize, type TokenKind } from "./lexer";
import { getImplementedKeywords } from "./language-registry";

function kindsOf(src: string): TokenKind[] {
  return tokenize(src).tokens.map((t) => t.kind);
}

describe("lexer: ALL_TOKEN_KINDS", () => {
  it("перечень видов токенов совпадает с тем, что реально выдаёт tokenize на сводном примере", () => {
    const src = [
      "модуль M",
      'использовать модуль U из "x.osnova"',
      "тип T = a | b",
      "процедура экспорт p()",
      "процедура главная()",
      "  пусть x = 1",
      "  пусть s = \"a\"",
      "  пусть b = истина",
      "  пусть f = ложь",
      "  пусть n = пусто",
      "  если x тогда",
      "  иначе_если x тогда",
      "  иначе",
      "  конец",
      "  когда x",
      "  есть T.a",
      "  иначе",
      "  конец",
      "  попробовать",
      "  иначе_попытка e",
      "  конец",
      "  выбросить x",
      "  пока x тогда",
      "  конец",
      "  для_каждого эл в x",
      "  конец",
      "  цикл",
      "  конец",
      "  прервать",
      "  продолжить",
      "  вернуть x",
      "  пусть cmp = a == b != c < d <= e > f >= g",
      "  x += 1",
      "  x -= 1",
      "  x *= 1",
      "  x /= 1",
      "  пусть ar = a + b - c * d / e % 5",
      "  пусть l = истина и ложь или не истина",
      "  пусть t = o ?. поле",
      "  пусть arr = [1, 2]",
      "  пусть obj = { a: 1 }",
      "конец",
      "конец",
    ].join("\n");

    const { tokens, errors } = tokenize(src);
    expect(errors.length).toBe(0);
    const seen = new Set(tokens.map((t) => t.kind));
    for (const k of ALL_TOKEN_KINDS) {
      expect(seen.has(k), `отсутствует токен вида «${k}»`).toBe(true);
    }
  });
});

describe("lexer: ключевые слова из реестра", () => {
  it("каждое implemented-ключевое слово распознаётся как своё kind, не как идентификатор", () => {
    const keywords = getImplementedKeywords().map((k) => k.lexeme);
    const src = keywords.join("\n") + "\n";
    const { tokens, errors } = tokenize(src);
    expect(errors.length).toBe(0);
    const kinds = tokens
      .filter((t) => t.kind !== "конец_файла")
      .map((t) => t.kind);
    expect(kinds.length).toBe(keywords.length * 2);
    for (let i = 0; i < keywords.length; i++) {
      expect(kinds[i * 2]).toBe(keywords[i] as TokenKind);
      expect(kinds[i * 2 + 1]).toBe("новая_строка");
    }
  });
});

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

  it("составное присваивание: x += 1", () => {
    const { tokens, errors } = tokenize("x += 1\n");
    expect(errors.length).toBe(0);
    const seq = tokens
      .map((t) => t.kind)
      .filter((k) => k !== "новая_строка" && k !== "конец_файла");
    expect(seq).toEqual(["идентификатор", "+=", "число"]);
  });

  it("составное присваивание: x -= 2", () => {
    const { tokens, errors } = tokenize("x -= 2\n");
    expect(errors.length).toBe(0);
    const seq = tokens
      .map((t) => t.kind)
      .filter((k) => k !== "новая_строка" && k !== "конец_файла");
    expect(seq).toEqual(["идентификатор", "-=", "число"]);
  });

  it("ошибка лексера: неизвестный символ @", () => {
    const src = "процедура main()\n  пусть x = 1 @ 2\nконец\n";
    const { errors } = tokenize(src);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain("Неизвестный символ");
  });
});

describe("lexer: позиции и литералы", () => {
  it("перевод строки: корректная строка и столбец (1-based)", () => {
    const { tokens, errors } = tokenize("ab\n");
    expect(errors.length).toBe(0);
    const nl = tokens.find((t) => t.kind === "новая_строка");
    expect(nl).toMatchObject({ line: 1, column: 3, lexeme: "\n" });
  });

  it("строковый литерал: позиция начинается с открывающей кавычки", () => {
    const { tokens, errors } = tokenize('  "hi"\n');
    expect(errors.length).toBe(0);
    const s = tokens.find((t) => t.kind === "строка");
    expect(s).toMatchObject({ line: 1, column: 3, value: "hi" });
  });

  it("числа: целое, дробное, с ведущей точкой", () => {
    const { tokens, errors } = tokenize("1 2.5 .75\n");
    expect(errors.length).toBe(0);
    const nums = tokens.filter((t) => t.kind === "число");
    expect(nums.map((t) => t.value)).toEqual([1, 2.5, 0.75]);
  });

  it("пустой ввод — только конец_файла", () => {
    const { tokens, errors } = tokenize("");
    expect(errors.length).toBe(0);
    expect(tokens.map((t) => t.kind)).toEqual(["конец_файла"]);
  });

  it("// комментарий до конца строки", () => {
    const { errors } = tokenize("пусть x = 1 // коммент\n");
    expect(errors.length).toBe(0);
    expect(kindsOf("пусть x = 1 // коммент\n")).toContain("число");
  });
});

describe("lexer: ошибки", () => {
  it("незакрытая строка", () => {
    const { errors } = tokenize('"abc');
    expect(errors.some((e) => e.message.includes("Незакрытая"))).toBe(true);
  });

  it("неизвестный escape", () => {
    const { errors } = tokenize('"\\q"');
    expect(errors.some((e) => e.message.includes("escape"))).toBe(true);
  });
});

