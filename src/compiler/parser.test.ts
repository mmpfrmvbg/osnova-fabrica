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
});

