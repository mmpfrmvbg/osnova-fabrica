import { describe, it, expect } from "vitest";
import { tokenize } from "./lexer";
import { parse } from "./parser";
import type { Program, Module, Stmt } from "./ast";

function parseProgram(source: string) {
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

    const { ast, errors } = parseProgram(src);
    expect(errors.length).toBe(0);
    expect(ast).not.toBeNull();
    const p = ast as Program;
    expect(p.modules.length).toBe(1);
    const m = p.modules[0] as Module;
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

    const { ast, errors } = parseProgram(src);
    expect(errors.length).toBe(0);
    const m = (ast as Program).modules[0] as Module;
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

    const { ast, errors } = parseProgram(src);
    expect(errors.length).toBe(0);
    const m = (ast as Program).modules[0] as Module;
    const body = m.procedures[0]?.body ?? [];
    const ifStmt = body.find((s: Stmt) => s.kind === "если") as Stmt | undefined;
    expect(ifStmt).toBeDefined();
  });

  it("некорректный модуль даёт parserErrors", () => {
    // нет имени модуля и процедур
    const src = "модуль\nпроцедура ()\nконец\n";
    const { errors } = parseProgram(src);
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
    const { ast, errors } = parseProgram(src);
    expect(errors.length).toBe(0);
    const m = (ast as Program).modules[0] as Module;
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

    const { ast, errors } = parseProgram(src);
    expect(errors.length).toBe(0);
    const m = (ast as Program).modules[0] as Module;
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

    const { ast, errors } = parseProgram(src);
    expect(errors.length).toBe(0);
    const m = (ast as Program).modules[0] as Module;
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

    const { ast, errors } = parseProgram(src);
    expect(errors.length).toBe(0);
    const m = (ast as Program).modules[0] as Module;
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

  it("парсит цепочку arr[i].поле: индекс затем доступ к полю", () => {
    const src = [
      "модуль t",
      "процедура main()",
      "  пусть arr = [{ x: 1 }]",
      "  вернуть arr[0].x",
      "конец",
      "конец",
      "",
    ].join("\n");

    const { ast, errors } = parseProgram(src);
    expect(errors.length).toBe(0);
    const m = (ast as Program).modules[0] as Module;
    const ret = m.procedures[0]?.body.find((s: Stmt) => s.kind === "вернуть");
    expect(ret?.kind).toBe("вернуть");
    if (ret?.kind !== "вернуть" || !ret.value) return;
    expect(ret.value.kind).toBe("поле");
    if (ret.value.kind !== "поле") return;
    expect(ret.value.field).toBe("x");
    expect(ret.value.object.kind).toBe("вызов");
    if (ret.value.object.kind !== "вызов") return;
    expect(ret.value.object.name).toBe("система.массив.получить");
  });

  it("одномодульный файл -> Program.modules.length === 1", () => {
    const src = [
      "модуль Один",
      "процедура главная()",
      "  вернуть 0",
      "конец",
      "конец",
      "",
    ].join("\n");

    const { ast, errors } = parseProgram(src);
    expect(errors.length).toBe(0);
    expect(ast).not.toBeNull();
    const p = ast as Program;
    expect(p.modules.length).toBe(1);
    expect(p.modules[0]?.name).toBe("Один");
  });

  it("два модуля в одном файле -> Program.modules.length === 2", () => {
    const src = [
      "модуль Первый",
      "процедура главная()",
      "конец",
      "",
      "модуль Второй",
      "процедура другая()",
      "конец",
      "",
    ].join("\n");

    const { ast, errors } = parseProgram(src);
    expect(errors.length).toBe(0);
    expect(ast).not.toBeNull();
    const p = ast as Program;
    expect(p.modules.length).toBe(2);
    expect(p.modules[0]?.name).toBe("Первый");
    expect(p.modules[1]?.name).toBe("Второй");
  });
});

describe("parser: покрытие конструкций (AST из токенов)", () => {
  it("импорт: использовать модуль … из строка", () => {
    const src = [
      'модуль M',
      'использовать модуль U из "./u.osnova"',
      "процедура p()",
      "конец",
      "конец",
    ].join("\n");
    const { ast, errors } = parseProgram(src);
    expect(errors.length).toBe(0);
    const m = (ast as Program).modules[0] as Module;
    expect(m.imports).toEqual([{ module: "U", path: "./u.osnova" }]);
  });

  it("объявление типа тип Имя { поле: тип }", () => {
    const src = [
      "модуль M",
      "тип Т { x: Число }",
      "процедура p()",
      "конец",
      "конец",
    ].join("\n");
    const { ast, errors } = parseProgram(src);
    expect(errors.length).toBe(0);
    const m = (ast as Program).modules[0] as Module;
    expect(m.typeDeclarations.length).toBe(1);
    const td = m.typeDeclarations[0];
    expect(td?.name).toBe("Т");
    expect(td?.fields).toEqual([{ name: "x", type: { name: "Число", nullable: false } }]);
  });

  it("экспорт процедура и nullable-тип в пусть", () => {
    const src = [
      "модуль M",
      "экспорт процедура f()",
      "  пусть x: ?Строка = пусто",
      "конец",
      "конец",
    ].join("\n");
    const { ast, errors } = parseProgram(src);
    expect(errors.length).toBe(0);
    const proc = (ast as Program).modules[0]?.procedures[0];
    expect(proc?.exported).toBe(true);
    const letStmt = proc?.body.find((s: Stmt) => s.kind === "пусть");
    expect(letStmt?.kind).toBe("пусть");
    if (letStmt?.kind !== "пусть") return;
    expect(letStmt.typeAnnotation).toEqual({ name: "Строка", nullable: true });
  });

  it("если / иначе_если / иначе / конец", () => {
    const src = [
      "модуль M",
      "процедура p()",
      "  если ложь",
      "    вернуть 0",
      "  иначе_если истина",
      "    вернуть 1",
      "  иначе",
      "    вернуть 2",
      "  конец",
      "конец",
      "конец",
    ].join("\n");
    const { ast, errors } = parseProgram(src);
    expect(errors.length).toBe(0);
    const ifStmt = (ast as Program).modules[0]?.procedures[0]?.body.find((s: Stmt) => s.kind === "если");
    expect(ifStmt?.kind).toBe("если");
    if (ifStmt?.kind !== "если") return;
    expect(ifStmt.elseIfClauses?.length).toBe(1);
    expect(ifStmt.elseBody?.length).toBe(1);
  });

  it("попробовать / иначе_попытка / конец", () => {
    const src = [
      "модуль M",
      "процедура p()",
      "  попробовать",
      "    вернуть 0",
      "  иначе_попытка e",
      "    вернуть 1",
      "  конец",
      "конец",
      "конец",
    ].join("\n");
    const { ast, errors } = parseProgram(src);
    expect(errors.length).toBe(0);
    const st = (ast as Program).modules[0]?.procedures[0]?.body[0];
    expect(st?.kind).toBe("попробовать");
    if (st?.kind !== "попробовать") return;
    expect(st.catchVar).toBe("e");
    expect(st.body.length).toBeGreaterThan(0);
    expect(st.catchBody.length).toBeGreaterThan(0);
  });

  it("выбросить, пока, цикл, прервать, продолжить", () => {
    const src = [
      "модуль M",
      "процедура p()",
      "  пока ложь",
      "    прервать",
      "  конец",
      "  цикл",
      "    продолжить",
      "  конец",
      "  выбросить \"err\"",
      "конец",
      "конец",
    ].join("\n");
    const { ast, errors } = parseProgram(src);
    expect(errors.length).toBe(0);
    const body = (ast as Program).modules[0]?.procedures[0]?.body ?? [];
    const kinds = body.map((s: Stmt) => s.kind);
    expect(kinds).toEqual(["пока", "цикл", "выбросить"]);
    expect(body[0]?.kind).toBe("пока");
    expect(body[1]?.kind).toBe("цикл");
    if (body[2]?.kind === "выбросить") expect(body[2].value.kind).toBe("строка");
  });

  it("выражения: объект, вызов, логика и/или/не, сравнение, унарный -", () => {
    const src = [
      "модуль M",
      "процедура p()",
      "  пусть o = { a: 1 }",
      "  пусть b = не (1 == 2) и истина или ложь",
      "  пусть c = -1 + 2 * 3",
      "конец",
      "конец",
    ].join("\n");
    const { ast, errors } = parseProgram(src);
    expect(errors.length).toBe(0);
    const body = (ast as Program).modules[0]?.procedures[0]?.body ?? [];
    expect(body.length).toBe(3);
    const o = body[0];
    if (o?.kind === "пусть" && o.init.kind === "объект") expect(o.init.entries[0]?.key).toBe("a");
  });

  it("поле_присвоить и составное +=", () => {
    const src = [
      "модуль M",
      "процедура p()",
      "  пусть o = { x: 1 }",
      "  o.x = 2",
      "  o.x += 1",
      "конец",
      "конец",
    ].join("\n");
    const { ast, errors } = parseProgram(src);
    expect(errors.length).toBe(0);
    const body = (ast as Program).modules[0]?.procedures[0]?.body ?? [];
    const assigns = body.filter((s: Stmt) => s.kind === "поле_присвоить");
    expect(assigns.length).toBe(2);
  });

  it("синтаксическая ошибка: message, line, expected", () => {
    const src = "модуль M\nпроцедура ()\nконец\nконец\n";
    const { tokens } = tokenize(src);
    const { errors } = parse(tokens);
    expect(errors.length).toBeGreaterThan(0);
    const e = errors[0];
    expect(e?.message).toBeDefined();
    expect(e?.line).toBeGreaterThan(0);
    expect(e?.expected?.length).toBeGreaterThan(0);
  });
});

describe("parser: переносы строк и восстановление (границы для repair)", () => {
  it("выражение после бинарного оператора может продолжиться на следующей строке", () => {
    const src = [
      "модуль M",
      "процедура p()",
      "  пусть x = 1 +",
      "    2",
      "конец",
      "конец",
      "",
    ].join("\n");
    const { ast, errors } = parseProgram(src);
    expect(errors.length).toBe(0);
    const letStmt = (ast as Program).modules[0]?.procedures[0]?.body.find((s: Stmt) => s.kind === "пусть");
    expect(letStmt?.kind).toBe("пусть");
    if (letStmt?.kind !== "пусть") return;
    expect(letStmt.init).toEqual({
      kind: "бинарное",
      op: "+",
      left: { kind: "число", value: 1 },
      right: { kind: "число", value: 2 },
    });
  });

  it("инициализатор пусть после переноса сразу после '='", () => {
    const src = [
      "модуль M",
      "процедура p()",
      "  пусть x =",
      "    42",
      "конец",
      "конец",
      "",
    ].join("\n");
    const { ast, errors } = parseProgram(src);
    expect(errors.length).toBe(0);
    const letStmt = (ast as Program).modules[0]?.procedures[0]?.body.find((s: Stmt) => s.kind === "пусть");
    expect(letStmt?.kind).toBe("пусть");
    if (letStmt?.kind !== "пусть") return;
    expect(letStmt.init).toEqual({ kind: "число", value: 42 });
  });

  it("значение вернуть на следующей строке — одна инструкция", () => {
    const src = [
      "модуль M",
      "процедура p()",
      "  вернуть",
      "    0",
      "конец",
      "конец",
      "",
    ].join("\n");
    const { ast, errors } = parseProgram(src);
    expect(errors.length).toBe(0);
    const body = (ast as Program).modules[0]?.procedures[0]?.body ?? [];
    expect(body.length).toBe(1);
    expect(body[0]).toEqual({ kind: "вернуть", value: { kind: "число", value: 0 } });
  });
});

