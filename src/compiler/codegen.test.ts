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

  it("граничные литералы: 0, отрицательное целое, f64, пустая строка в constants", () => {
    const m = compile(
      moduleAst("L", [
        {
          name: "z",
          params: [],
          body: [{ kind: "вернуть", value: { kind: "число", value: 0 } }],
        },
        {
          name: "neg",
          params: [],
          body: [{ kind: "вернуть", value: { kind: "число", value: -1 } }],
        },
        {
          name: "flt",
          params: [],
          body: [{ kind: "вернуть", value: { kind: "число", value: 0.25 } }],
        },
        {
          name: "es",
          params: [],
          body: [{ kind: "вернуть", value: { kind: "строка", value: "" } }],
        },
      ]),
    );
    expect(m.constants).toEqual(expect.arrayContaining([0, -1, 0.25, ""]));
    expect(m.code.some((i) => i.op === "const" && (i as { type?: string }).type === "f64")).toBe(true);
  });

  it("бинарные *, %, == в одном выражении", () => {
    const m = compile(
      moduleAst("Bin", [
        {
          name: "p",
          params: [],
          body: [
            {
              kind: "вернуть",
              value: {
                kind: "бинарное",
                op: "==",
                left: {
                  kind: "бинарное",
                  op: "*",
                  left: { kind: "число", value: 2 },
                  right: { kind: "число", value: 3 },
                },
                right: {
                  kind: "бинарное",
                  op: "%",
                  left: { kind: "число", value: 10 },
                  right: { kind: "число", value: 4 },
                },
              },
            },
          ],
        },
      ]),
    );
    expect(m.code.some((i) => i.op === "mul")).toBe(true);
    expect(m.code.some((i) => i.op === "rem")).toBe(true);
    expect(m.code.some((i) => i.op === "eq")).toBe(true);
  });

  it("бинарное и: jmp_if_not и jmp (короткое замыкание)", () => {
    const m = compile(
      moduleAst("And", [
        {
          name: "p",
          params: [],
          body: [
            {
              kind: "вернуть",
              value: {
                kind: "бинарное",
                op: "и",
                left: { kind: "булево", value: false },
                right: { kind: "булево", value: true },
              },
            },
          ],
        },
      ]),
    );
    const slice = m.code.slice(m.procedures[0].codeOffset);
    expect(slice.filter((i) => i.op === "jmp_if_not").length).toBeGreaterThanOrEqual(1);
    expect(slice.some((i) => i.op === "jmp")).toBe(true);
  });

  it("короткие процедуры: call, argc параметра и вспомогательная процедура", () => {
    const m = compile(
      moduleAst("Call", [
        {
          name: "twice",
          params: ["x"],
          body: [
            {
              kind: "вернуть",
              value: {
                kind: "бинарное",
                op: "+",
                left: { kind: "переменная", name: "x" },
                right: { kind: "переменная", name: "x" },
              },
            },
          ],
        },
        {
          name: "main",
          params: [],
          body: [
            {
              kind: "вернуть",
              value: { kind: "вызов", name: "twice", args: [{ kind: "число", value: 7 }] },
            },
          ],
        },
      ]),
    );
    const twice = m.procedures.find((p) => p.name === "twice");
    const main = m.procedures.find((p) => p.name === "main");
    expect(twice?.argc).toBe(1);
    expect(main?.argc).toBe(0);
    const mainSlice = m.code.slice(main!.codeOffset);
    expect(mainSlice.some((i) => i.op === "call" && (i as { fi?: number }).fi === 0)).toBe(true);
  });

  it("цепочка вызовов: аргументы слева направо — const, call(inner), call(outer), ret", () => {
    const m = compile(
      moduleAst("Chain", [
        {
          name: "inner",
          params: ["x"],
          body: [{ kind: "вернуть", value: { kind: "переменная", name: "x" } }],
        },
        {
          name: "outer",
          params: ["y"],
          body: [
            {
              kind: "вернуть",
              value: {
                kind: "бинарное",
                op: "+",
                left: { kind: "переменная", name: "y" },
                right: { kind: "число", value: 1 },
              },
            },
          ],
        },
        {
          name: "main",
          params: [],
          body: [
            {
              kind: "вернуть",
              value: {
                kind: "вызов",
                name: "outer",
                args: [
                  {
                    kind: "вызов",
                    name: "inner",
                    args: [{ kind: "число", value: 3 }],
                  },
                ],
              },
            },
          ],
        },
      ]),
    );
    const main = m.procedures.find((p) => p.name === "main")!;
    const slice = m.code.slice(main.codeOffset);
    expect(slice.length).toBeGreaterThanOrEqual(4);
    expect(slice[0].op).toBe("const");
    expect(slice[1].op).toBe("call");
    expect((slice[1] as { fi?: number }).fi).toBe(0);
    expect(slice[2].op).toBe("call");
    expect((slice[2] as { fi?: number }).fi).toBe(1);
    expect(slice[3].op).toBe("ret");
  });

  it("простое если с иначе: const.true, jmp_if_not, then, jmp, else; фиксированная длина префикса", () => {
    const body: Stmt[] = [
      {
        kind: "если",
        condition: { kind: "булево", value: true },
        body: [{ kind: "вернуть", value: { kind: "число", value: 10 } }],
        elseBody: [{ kind: "вернуть", value: { kind: "число", value: 20 } }],
      },
    ];
    const m = compile(moduleAst("Br", [{ name: "b", params: [], body }]));
    const slice = m.code.slice(m.procedures[0].codeOffset);
    const head = slice.slice(0, 7).map((i) => i.op);
    expect(head).toEqual([
      "const.true",
      "jmp_if_not",
      "const",
      "ret",
      "jmp",
      "const",
      "ret",
    ]);
    expect(slice.length).toBe(8);
    expect(slice[7].op).toBe("ret");
  });

  it("иначе_если: цепочка jmp_if_not и финальный jmp к концу", () => {
    const body: Stmt[] = [
      {
        kind: "если",
        condition: { kind: "булево", value: false },
        body: [{ kind: "вернуть", value: { kind: "число", value: 1 } }],
        elseIfClauses: [
          {
            condition: { kind: "булево", value: true },
            body: [{ kind: "вернуть", value: { kind: "число", value: 2 } }],
          },
        ],
        elseBody: [{ kind: "вернуть", value: { kind: "число", value: 3 } }],
      },
    ];
    const m = compile(moduleAst("Elif", [{ name: "e", params: [], body }]));
    const slice = m.code.slice(m.procedures[0].codeOffset);
    expect(slice.filter((i) => i.op === "jmp_if_not").length).toBeGreaterThanOrEqual(2);
    expect(slice.filter((i) => i.op === "jmp").length).toBeGreaterThanOrEqual(2);
  });

  it("унарное не: eq со стеком false", () => {
    const m = compile(
      moduleAst("Not", [
        {
          name: "n",
          params: [],
          body: [
            {
              kind: "вернуть",
              value: {
                kind: "унарное",
                op: "не",
                arg: { kind: "булево", value: true },
              },
            },
          ],
        },
      ]),
    );
    const slice = m.code.slice(m.procedures[0].codeOffset);
    expect(slice.some((i) => i.op === "eq")).toBe(true);
  });

  it("бинарное или: jmp_if и короткое замыкание", () => {
    const m = compile(
      moduleAst("Or", [
        {
          name: "p",
          params: [],
          body: [
            {
              kind: "вернуть",
              value: {
                kind: "бинарное",
                op: "или",
                left: { kind: "булево", value: true },
                right: { kind: "булево", value: false },
              },
            },
          ],
        },
      ]),
    );
    const slice = m.code.slice(m.procedures[0].codeOffset);
    expect(slice.some((i) => i.op === "jmp_if")).toBe(true);
    expect(slice.some((i) => i.op === "jmp")).toBe(true);
  });

  it("поле_присвоить: obj.set в потоке инструкций", () => {
    const m = compile(
      moduleAst("Set", [
        {
          name: "s",
          params: [],
          body: [
            { kind: "пусть", name: "o", init: { kind: "объект", entries: [] } },
            {
              kind: "поле_присвоить",
              object: { kind: "переменная", name: "o" },
              field: "x",
              value: { kind: "число", value: 5 },
            },
            { kind: "вернуть", value: { kind: "переменная", name: "o" } },
          ],
        },
      ]),
    );
    expect(m.code.filter((i) => i.op === "obj.set").length).toBeGreaterThanOrEqual(1);
  });

  it("пока: прервать и продолжить — jmp с заплатками", () => {
    const m = compile(
      moduleAst("Brk", [
        {
          name: "w",
          params: [],
          body: [
            {
              kind: "пока",
              condition: { kind: "булево", value: true },
              body: [
                { kind: "прервать" },
                { kind: "вернуть", value: { kind: "число", value: 99 } },
              ],
            },
            { kind: "вернуть", value: { kind: "число", value: 0 } },
          ],
        },
      ]),
    );
    const slice = m.code.slice(m.procedures[0].codeOffset);
    expect(slice.filter((i) => i.op === "jmp").length).toBeGreaterThanOrEqual(2);
    const cont = compile(
      moduleAst("Cont", [
        {
          name: "c",
          params: [],
          body: [
            {
              kind: "пока",
              condition: { kind: "булево", value: true },
              body: [
                { kind: "продолжить" },
                { kind: "вернуть", value: { kind: "число", value: 1 } },
              ],
            },
            { kind: "вернуть", value: { kind: "число", value: 0 } },
          ],
        },
      ]),
    );
    expect(cont.code.slice(cont.procedures[0].codeOffset).some((i) => i.op === "jmp")).toBe(true);
  });

  it("цикл: безусловный jmp с абсолютным off к началу тела (назад по PC)", () => {
    const m = compile(
      moduleAst("Loop", [
        {
          name: "l",
          params: [],
          body: [
            {
              kind: "цикл",
              body: [{ kind: "прервать" }],
            },
            { kind: "вернуть", value: { kind: "число", value: 0 } },
          ],
        },
      ]),
    );
    const procOffset = m.procedures[0].codeOffset;
    const slice = m.code.slice(procOffset);
    let hasBackwardJmp = false;
    slice.forEach((ins, relIdx) => {
      if (ins.op !== "jmp") return;
      const absPc = procOffset + relIdx;
      const target = (ins as { off: number }).off;
      if (target < absPc) hasBackwardJmp = true;
    });
    expect(hasBackwardJmp).toBe(true);
  });

  it("для_каждого с индексом: local.set для item и index", () => {
    const src: Expr = { kind: "массив", elements: [{ kind: "число", value: 7 }] };
    const m = compile(
      moduleAst("Idx", [
        {
          name: "f",
          params: [],
          body: [
            {
              kind: "для_каждого",
              item: "v",
              index: "i",
              variable: "v",
              source: src,
              collection: src,
              body: [{ kind: "выражение", expr: { kind: "переменная", name: "i" } }],
            },
            { kind: "вернуть", value: { kind: "число", value: 0 } },
          ],
        },
      ]),
    );
    expect(m.procedures[0].localsCount).toBeGreaterThanOrEqual(4);
    const slice = m.code.slice(m.procedures[0].codeOffset);
    expect(slice.filter((i) => i.op === "local.set").length).toBeGreaterThanOrEqual(3);
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
