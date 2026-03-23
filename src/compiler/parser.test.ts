import { describe, it, expect } from "vitest";
import { tokenize } from "./lexer";
import { parse } from "./parser";
import type { Module, Stmt } from "./ast";

function parseModule(source: string) {
  const { tokens } = tokenize(source);
  const { ast, errors } = parse(tokens);
  return { ast, errors };
}

describe("parser: базовые конструкции MVP", () => {
  it("минимальный модуль с одной процедурой", () => {
    const src = [
      "модуль Тест",
      "процедура главная()",
      "  вернуть 0",
      "конец",
      "конец",
      "",
    ].join("\n");

    const { ast, errors } = parseModule(src);
    expect(errors.length).toBe(0);
    expect(ast).not.toBeNull();
    const m = ast as Module;
    expect(m.name).toBe("Тест");
    expect(m.procedures.length).toBe(1);
    expect(m.procedures[0]?.name).toBe("главная");
  });

  it("пусть + присваивание попадают в AST как Stmt", () => {
    const src = [
      "модуль t",
      "процедура main()",
      "  пусть x = 1",
      "  x = 2",
      "конец",
      "конец",
      "",
    ].join("\n");

    const { ast, errors } = parseModule(src);
    expect(errors.length).toBe(0);
    const m = ast as Module;
    const body = m.procedures[0]?.body ?? [];
    const kinds = body.map((s: Stmt) => s.kind);
    expect(kinds).toContain("пусть");
    expect(kinds).toContain("присвоить");
  });

  it("если/иначе строит IfStmt с then и else", () => {
    const src = [
      "модуль t",
      "процедура main()",
      "  пусть x = 0",
      "  если истина",
      "    x = 1",
      "  иначе",
      "    x = 2",
      "  конец",
      "  вернуть x",
      "конец",
      "конец",
      "",
    ].join("\n");

    const { ast, errors } = parseModule(src);
    expect(errors.length).toBe(0);
    const m = ast as Module;
    const body = m.procedures[0]?.body ?? [];
    const ifStmt = body.find((s: Stmt) => s.kind === "если") as Stmt | undefined;
    expect(ifStmt).toBeDefined();
  });

  it("некорректный модуль даёт parserErrors", () => {
    // нет имени модуля и процедур
    const src = "модуль\nпроцедура ()\nконец\n";
    const { errors } = parseModule(src);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("для_каждого с индексом строит AST с item/index/source", () => {
    const src = [
      "модуль t",
      "процедура main(arr)",
      "  для_каждого эл, idx в arr",
      "    вернуть idx",
      "  конец",
      "конец",
      "конец",
      "",
    ].join("\n");
    const { ast, errors } = parseModule(src);
    expect(errors.length).toBe(0);
    const m = ast as Module;
    const forEachStmt = m.procedures[0]?.body.find((s: Stmt) => s.kind === "для_каждого");
    expect(forEachStmt).toBeDefined();
    if (!forEachStmt || forEachStmt.kind !== "для_каждого") return;
    expect(forEachStmt.item).toBe("эл");
    expect(forEachStmt.index).toBe("idx");
    expect(forEachStmt.source.kind).toBe("переменная");
  });

  it("парсит пустой массив-литерал", () => {
    const src = [
      "модуль t",
      "процедура main()",
      "  пусть x = []",
      "конец",
      "конец",
      "",
    ].join("\n");

    const { ast, errors } = parseModule(src);
    expect(errors.length).toBe(0);
    const m = ast as Module;
    const letStmt = m.procedures[0]?.body.find((s: Stmt) => s.kind === "пусть");
    expect(letStmt).toBeDefined();
    if (!letStmt || letStmt.kind !== "пусть") return;
    const expr = letStmt.init;
    expect(expr.kind).toBe("массив");
    if (expr.kind !== "массив") return;
    expect(expr.elements.length).toBe(0);
  });

  it("парсит простой массив [1, 2, 3]", () => {
    const src = [
      "модуль t",
      "процедура main()",
      "  пусть x = [1, 2, 3]",
      "конец",
      "конец",
      "",
    ].join("\n");

    const { ast, errors } = parseModule(src);
    expect(errors.length).toBe(0);
    const m = ast as Module;
    const letStmt = m.procedures[0]?.body.find((s: Stmt) => s.kind === "пусть");
    expect(letStmt).toBeDefined();
    if (!letStmt || letStmt.kind !== "пусть") return;
    const expr = letStmt.init;
    expect(expr.kind).toBe("массив");
    if (expr.kind !== "массив") return;
    expect(expr.elements.length).toBe(3);
    expect(expr.elements[0]).toEqual({ kind: "число", value: 1 });
    expect(expr.elements[1]).toEqual({ kind: "число", value: 2 });
    expect(expr.elements[2]).toEqual({ kind: "число", value: 3 });
  });

  it("парсит индексирование arr[i] как вызов система.массив.получить", () => {
    const src = [
      "модуль t",
      "процедура main()",
      "  пусть arr = [10]",
      "  arr[0]",
      "конец",
      "конец",
      "",
    ].join("\n");

    const { ast, errors } = parseModule(src);
    expect(errors.length).toBe(0);
    const m = ast as Module;
    const exprStmt = m.procedures[0]?.body.find((s: Stmt) => s.kind === "выражение");
    expect(exprStmt).toBeDefined();
    if (!exprStmt || exprStmt.kind !== "выражение") return;
    const expr = exprStmt.expr;
    expect(expr.kind).toBe("вызов");
    if (expr.kind !== "вызов") return;
    expect(expr.name).toBe("система.массив.получить");
    expect(expr.args.length).toBe(2);
    expect(expr.args[0]).toEqual({ kind: "переменная", name: "arr" });
    expect(expr.args[1]).toEqual({ kind: "число", value: 0 });
  });
});

