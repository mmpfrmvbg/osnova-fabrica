/**
 * Unit-тесты codegen: AST → OsVbcModule (без lexer/parser).
 */

import { describe, it, expect } from "vitest";
import { compile, compileProgram } from ".";
import type { Expr, Module, Program, Stmt } from "./ast";

function moduleAst(name: string, procedures: Module["procedures"]): Module {
  return { name, imports: [], typeDeclarations: [], procedures };
}

describe("codegen compile()", () => {
  it("генерирует константу и ret для простого вернуть", () => {
    const m = compile(
      moduleAst("M", [
        {
          name: "main",
          params: [],
          body: [{ kind: "вернуть", value: { kind: "число", value: 42 } }],
        },
      ]),
    );
    expect(m.moduleName).toBe("M");
    expect(m.constants).toContain(42);
    expect(m.procedures).toHaveLength(1);
    expect(m.procedures[0].name).toBe("main");
    expect(m.procedures[0].argc).toBe(0);
    const slice = m.code.slice(m.procedures[0].codeOffset);
    expect(slice.some((i) => i.op === "const")).toBe(true);
    expect(slice[slice.length - 1].op).toBe("ret");
  });

  it("пусть + присвоить: local.get/set", () => {
    const m = compile(
      moduleAst("V", [
        {
          name: "p",
          params: [],
          body: [
            { kind: "пусть", name: "a", init: { kind: "число", value: 1 } },
            {
              kind: "присвоить",
              name: "a",
              value: {
                kind: "бинарное",
                op: "+",
                left: { kind: "переменная", name: "a" },
                right: { kind: "число", value: 2 },
              },
            },
            { kind: "вернуть", value: { kind: "переменная", name: "a" } },
          ],
        },
      ]),
    );
    const slice = m.code.slice(m.procedures[0].codeOffset);
    expect(slice.filter((i) => i.op === "local.set").length).toBeGreaterThanOrEqual(2);
    expect(slice.some((i) => i.op === "add")).toBe(true);
  });

  it("вложенное если: несколько jmp_if_not / jmp", () => {
    const inner: Stmt = {
      kind: "если",
      condition: { kind: "булево", value: false },
      body: [{ kind: "вернуть", value: { kind: "число", value: 1 } }],
      elseBody: [{ kind: "вернуть", value: { kind: "число", value: 2 } }],
    };
    const body: Stmt[] = [
      {
        kind: "если",
        condition: { kind: "булево", value: true },
        body: [inner],
        elseBody: [{ kind: "вернуть", value: { kind: "число", value: 3 } }],
      },
    ];
    const m = compile(moduleAst("N", [{ name: "n", params: [], body }]));
    expect(m.code.filter((i) => i.op === "jmp_if_not").length).toBeGreaterThanOrEqual(2);
    expect(m.code.some((i) => i.op === "jmp")).toBe(true);
  });

  it("массив и поле объекта в выражении", () => {
    const m = compile(
      moduleAst("O", [
        {
          name: "o",
          params: [],
          body: [
            {
              kind: "вернуть",
              value: {
                kind: "поле",
                object: {
                  kind: "объект",
                  entries: [{ key: "k", value: { kind: "число", value: 9 } }],
                },
                field: "k",
              },
            },
          ],
        },
      ]),
    );
    expect(m.code.some((i) => i.op === "obj.new")).toBe(true);
    expect(m.code.some((i) => i.op === "obj.get")).toBe(true);
  });

  it("для_каждого: служебные локалы и цикл", () => {
    const src: Expr = { kind: "массив", elements: [{ kind: "число", value: 1 }] };
    const m = compile(
      moduleAst("F", [
        {
          name: "f",
          params: [],
          body: [
            {
              kind: "для_каждого",
              item: "x",
              variable: "x",
              source: src,
              collection: src,
              body: [{ kind: "выражение", expr: { kind: "переменная", name: "x" } }],
            },
            { kind: "вернуть", value: { kind: "число", value: 0 } },
          ],
        },
      ]),
    );
    expect(m.procedures[0].localsCount).toBeGreaterThan(1);
    expect(m.code.some((i) => i.op === "invoke" && (i as { name?: string }).name === "система.массив.получить")).toBe(
      true,
    );
  });

  it("попробовать / выбросить: try_begin и throw", () => {
    const m = compile(
      moduleAst("T", [
        {
          name: "t",
          params: [],
          body: [
            {
              kind: "попробовать",
              catchVar: "e",
              body: [
                {
                  kind: "выбросить",
                  value: { kind: "строка", value: "x" },
                },
              ],
              catchBody: [{ kind: "вернуть", value: { kind: "переменная", name: "e" } }],
            },
            { kind: "вернуть", value: { kind: "пусто" } },
          ],
        },
      ]),
    );
    expect(m.code.some((i) => i.op === "try_begin")).toBe(true);
    expect(m.code.some((i) => i.op === "throw")).toBe(true);
  });
});

describe("codegen compileProgram()", () => {
  it("возвращает по одному OsVbcModule на модуль программы", () => {
    const program: Program = {
      modules: [
        moduleAst("A", [
          {
            name: "f",
            params: [],
            body: [{ kind: "вернуть", value: { kind: "число", value: 0 } }],
          },
        ]),
        moduleAst("B", [
          {
            name: "g",
            params: [],
            body: [{ kind: "вернуть", value: { kind: "число", value: 1 } }],
          },
        ]),
      ],
    };
    const out = compileProgram(program);
    expect(out).toHaveLength(2);
    expect(out.map((x) => x.moduleName)).toEqual(["A", "B"]);
    expect(out[0].procedures.some((p) => p.name === "A__f")).toBe(true);
    expect(out[1].procedures.some((p) => p.name === "B__g")).toBe(true);
  });
});
