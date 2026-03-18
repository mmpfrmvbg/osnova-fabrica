/**
 * Smoke-тест компилятора: todo.osnova компилируется без ошибок.
 * Запуск: npx vitest run
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { compileSource } from "./compiler";
import { tokenize } from "./lexer";
import { parse } from "./parser";
import { VM, InterpreterError } from "../runtime/vm/interpreter";
import type { OsVbcModule } from "../runtime/vm/bytecode";

const FIXTURES_DIR = join(__dirname, "..", "runtime", "fixtures");

describe("Compiler smoke: todo.osnova", () => {
  it("компилирует без ошибок и содержит процедуры запуск, handle_event, handle_add", () => {
    const source = readFileSync(join(FIXTURES_DIR, "todo.osnova"), "utf-8");
    const result = compileSource(source);

    expect(result.lexerErrors.length).toBe(0);
    expect(result.parserErrors.length).toBe(0);
    expect(result.module).toBeTruthy();

    const names = result.module!.procedures.map((p) => p.name);
    expect(names).toContain("запуск");
    expect(names).toContain("handle_event");
    expect(names).toContain("handle_add");
  });
});

describe("Compiler: иначе (if/else)", () => {
  it("если истина ... иначе ... конец: then-branch, VM returns 1", async () => {
    const source = `
модуль t
процедура main()
  пусть x = 0
  если истина
    x = 1
  иначе
    x = 2
  конец
  вернуть x
конец`.trim();
    const result = compileSource(source);
    expect(result.lexerErrors.length).toBe(0);
    expect(result.parserErrors.length).toBe(0);
    expect(result.module).toBeTruthy();
    const vm = new VM(result.module!, { maxSteps: 1000 });
    expect(await vm.runProcedure(0, [])).toBe(1);
  });

  it("если ложь ... иначе ... конец: else-branch, VM returns 2", async () => {
    const source = `
модуль t
процедура main()
  пусть x = 0
  если ложь
    x = 1
  иначе
    x = 2
  конец
  вернуть x
конец`.trim();
    const result = compileSource(source);
    expect(result.module).toBeTruthy();
    const vm = new VM(result.module!, { maxSteps: 1000 });
    expect(await vm.runProcedure(0, [])).toBe(2);
  });

  it("иначе_если генерирует корректный байткод", async () => {
    const source = `
модуль t
процедура main()
  пусть x = 0
  если x == 1
    x = 1
  иначе_если x == 2
    x = 2
  иначе_если x == 3
    x = 3
  иначе
    x = 4
  конец
  вернуть x
конец`.trim();
    const result = compileSource(source);
    expect(result.lexerErrors.length).toBe(0);
    expect(result.parserErrors.length).toBe(0);
    expect(result.module).toBeTruthy();
    const vm = new VM(result.module!, { maxSteps: 1000 });
    expect(await vm.runProcedure(0, [])).toBe(4);
    // x==1 → ветка 1
    const src1 = source.replace("пусть x = 0", "пусть x = 1");
    expect(await new VM(compileSource(src1).module!, { maxSteps: 1000 }).runProcedure(0, [])).toBe(1);
    // x==2 → ветка 2
    const src2 = source.replace("пусть x = 0", "пусть x = 2");
    expect(await new VM(compileSource(src2).module!, { maxSteps: 1000 }).runProcedure(0, [])).toBe(2);
    // x==3 → ветка 3
    const src3 = source.replace("пусть x = 0", "пусть x = 3");
    expect(await new VM(compileSource(src3).module!, { maxSteps: 1000 }).runProcedure(0, [])).toBe(3);
  });

  it("если без иначе: VM returns 1", async () => {
    const source = `
модуль t
процедура main()
  пусть x = 0
  если истина
    x = 1
  конец
  вернуть x
конец`.trim();
    const result = compileSource(source);
    expect(result.module).toBeTruthy();
    const vm = new VM(result.module!, { maxSteps: 1000 });
    expect(await vm.runProcedure(0, [])).toBe(1);
  });
});

describe("Compiler: массивы (array literals)", () => {
  const arrayInvoke = (name: string, args: unknown[]): unknown => {
    if (name === "система.массив.создать") return [];
    if (name === "система.массив.добавить") {
      const arr = args[0] as unknown[];
      if (Array.isArray(arr)) arr.push(args[1]);
      return null;
    }
    if (name === "система.массив.установить") {
      const arr = args[0] as unknown[];
      const idx = Number(args[1]) | 0;
      if (Array.isArray(arr) && idx >= 0 && idx < arr.length) arr[idx] = args[2];
      return null;
    }
    if (name === "система.массив.удалить") {
      const arr = args[0] as unknown[];
      const idx = Number(args[1]) | 0;
      if (Array.isArray(arr) && idx >= 0 && idx < arr.length) arr.splice(idx, 1);
      return null;
    }
    if (name === "система.массив.срез") {
      const arr = args[0];
      const from = Number(args[1]) | 0;
      const to = Number(args[2]) | 0;
      return Array.isArray(arr) ? arr.slice(from, to) : [];
    }
    if (name === "система.массив.длина") return (args[0] != null ? (args[0] as unknown[]) : []).length;
    if (name === "система.массив.получить") return (args[0] as unknown[])[args[1] as number];
    return null;
  };

  it("пустой массив []: вернуть длина → 0", async () => {
    const source = `
модуль t
процедура main()
  пусть arr = []
  вернуть система.массив.длина(arr)
конец`.trim();
    const result = compileSource(source);
    expect(result.lexerErrors.length).toBe(0);
    expect(result.parserErrors.length).toBe(0);
    expect(result.module).toBeTruthy();
    const vm = new VM(result.module!, { invoke: arrayInvoke, maxSteps: 1000 });
    expect(await vm.runProcedure(0, [])).toBe(0);
  });

  it("массив [1, 2, 3]: вернуть длина → 3", async () => {
    const source = `
модуль t
процедура main()
  пусть arr = [1, 2, 3]
  вернуть система.массив.длина(arr)
конец`.trim();
    const result = compileSource(source);
    expect(result.module).toBeTruthy();
    const vm = new VM(result.module!, { invoke: arrayInvoke, maxSteps: 1000 });
    expect(await vm.runProcedure(0, [])).toBe(3);
  });

  it("массив [10, 20, 30]: получить(1) → 20", async () => {
    const source = `
модуль t
процедура main()
  пусть arr = [10, 20, 30]
  вернуть система.массив.получить(arr, 1)
конец`.trim();
    const result = compileSource(source);
    expect(result.module).toBeTruthy();
    const vm = new VM(result.module!, { invoke: arrayInvoke, maxSteps: 1000 });
    expect(await vm.runProcedure(0, [])).toBe(20);
  });

  it("для_каждого x в [1, 2, 3]: sum → 6", async () => {
    const source = `
модуль t
процедура main()
  пусть arr = [1, 2, 3]
  пусть sum = 0
  для_каждого x в arr
    sum = sum + x
  конец
  вернуть sum
конец`.trim();
    const result = compileSource(source);
    expect(result.module).toBeTruthy();
    const vm = new VM(result.module!, { invoke: arrayInvoke, maxSteps: 1000 });
    expect(await vm.runProcedure(0, [])).toBe(6);
  });

  it("система.массив.добавить: [1, 2] + 3 → длина 3", async () => {
    const source = `
модуль t
процедура main()
  пусть arr = [1, 2]
  система.массив.добавить(arr, 3)
  вернуть система.массив.длина(arr)
конец`.trim();
    const result = compileSource(source);
    expect(result.module).toBeTruthy();
    const vm = new VM(result.module!, { invoke: arrayInvoke, maxSteps: 1000 });
    expect(await vm.runProcedure(0, [])).toBe(3);
  });
});

describe("Compiler: для_каждого", () => {
  const arrayInvoke = (name: string, args: unknown[]): number | null => {
    if (name === "система.массив.длина") return (args[0] != null ? (args[0] as unknown[]) : []).length;
    if (name === "система.массив.получить") return (args[0] as unknown[])[args[1] as number] as number;
    return null;
  };

  it("для_каждого x в arr: sum elements, VM returns 60", async () => {
    const source = `
модуль t
процедура main(arr)
  пусть sum = 0
  для_каждого x в arr
    sum = sum + x
  конец
  вернуть sum
конец`.trim();
    const result = compileSource(source);
    expect(result.lexerErrors.length).toBe(0);
    expect(result.parserErrors.length).toBe(0);
    expect(result.module).toBeTruthy();
    const vm = new VM(result.module!, { invoke: arrayInvoke, maxSteps: 10000 });
    expect(await vm.runProcedure(0, [[10, 20, 30]])).toBe(60);
  });

  it("для_каждого по пустому массиву: return 0", async () => {
    const source = `
модуль t
процедура main(arr)
  пусть sum = 0
  для_каждого x в arr
    sum = sum + 1
  конец
  вернуть sum
конец`.trim();
    const result = compileSource(source);
    expect(result.module).toBeTruthy();
    const vm = new VM(result.module!, { invoke: arrayInvoke, maxSteps: 1000 });
    expect(await vm.runProcedure(0, [[]])).toBe(0);
  });

  it("вложенные для_каждого не затирают __for_arr", async () => {
    const source = `
модуль t
процедура main(arr)
  пусть sum = 0
  для_каждого a в arr
    для_каждого b в a
      sum = sum + 1
    конец
  конец
  вернуть sum
конец`.trim();
    const result = compileSource(source);
    expect(result.compilerSuccess).toBe(true);
    expect(result.module).toBeTruthy();
    const vm = new VM(result.module!, { invoke: arrayInvoke, maxSteps: 10000 });
    // [[1], [2, 3]] → inner loops: 1 + 2 = 3
    expect(await vm.runProcedure(0, [[[1], [2, 3]]])).toBe(3);
  });
});

describe("Compiler: short-circuit и/или", () => {
  it("и при falsy left возвращает false и не вычисляет right", async () => {
    const source = `модуль t
процедура main()
  пусть x = 0 и 1
  если x
    вернуть 0
  иначе
    вернуть 1
  конец
конец`;
    const result = compileSource(source);
    expect(result.compilerSuccess).toBe(true);
    expect(result.module).toBeTruthy();
    const vm = new VM(result.module!, { maxSteps: 100 });
    // x должен быть false (short-circuit: 0 falsy → skip right, emit const.false)
    const r = await vm.runProcedure(0, []);
    expect(r).toBe(1);
  });

  it("или при truthy left возвращает true и не вычисляет right", async () => {
    const source = `модуль t
процедура main()
  пусть x = 1 или 0
  если x
    вернуть 1
  иначе
    вернуть 0
  конец
конец`;
    const result = compileSource(source);
    expect(result.compilerSuccess).toBe(true);
    expect(result.module).toBeTruthy();
    const vm = new VM(result.module!, { maxSteps: 100 });
    const r = await vm.runProcedure(0, []);
    expect(r).toBe(1);
  });
});

describe("Compiler: и / или / не", () => {
  it("не ложь → истина, return 1", async () => {
    const source = `модуль t
процедура main()
  если не ложь
    вернуть 1
  иначе
    вернуть 0
  конец
конец`;
    const result = compileSource(source);
    expect(result.module).toBeTruthy();
    const vm = new VM(result.module!, { maxSteps: 100 });
    expect(await vm.runProcedure(0, [])).toBe(1);
  });

  it("истина и истина → 1, истина и ложь → 0", async () => {
    const t = `модуль t
процедура main()
  если истина и истина
    вернуть 1
  иначе
    вернуть 0
  конец
конец`;
    const f = `модуль t
процедура main()
  если истина и ложь
    вернуть 1
  иначе
    вернуть 0
  конец
конец`;
    const rT = compileSource(t);
    const rF = compileSource(f);
    expect(await new VM(rT.module!, { maxSteps: 100 }).runProcedure(0, [])).toBe(1);
    expect(await new VM(rF.module!, { maxSteps: 100 }).runProcedure(0, [])).toBe(0);
  });

  it("ложь или истина → 1", async () => {
    const source = `модуль t
процедура main()
  если ложь или истина
    вернуть 1
  иначе
    вернуть 0
  конец
конец`;
    const result = compileSource(source);
    expect(await new VM(result.module!, { maxSteps: 100 }).runProcedure(0, [])).toBe(1);
  });

  it("не (истина и ложь) → 1", async () => {
    const source = `модуль t
процедура main()
  если не (истина и ложь)
    вернуть 1
  иначе
    вернуть 0
  конец
конец`;
    const result = compileSource(source);
    expect(await new VM(result.module!, { maxSteps: 100 }).runProcedure(0, [])).toBe(1);
  });
});

describe("Compiler negative: errors reported", () => {
  it("модуль without identifier → parserErrors", () => {
    const result = compileSource("модуль \n");
    expect(result.parserErrors.length).toBeGreaterThan(0);
    expect(result.module).toBeFalsy();
  });

  it("пусть = 42 → parse error + recovery, AST produced", () => {
    const source = "модуль t\nпроцедура main()\n  пусть = 42\nконец\n";
    const { tokens } = tokenize(source);
    const { ast, errors } = parse(tokens);
    expect(errors.length).toBeGreaterThan(0);
    expect(ast).toBeTruthy();
    expect(ast!.procedures.length).toBe(1);
    expect(ast!.procedures[0].body.length).toBe(0);
  });

  it("процедура 123() → parse error + recovery, second procedure in AST", () => {
    const source = "модуль t\nпроцедура 123()\nконец\nпроцедура ok()\n  вернуть\nконец\n";
    const { tokens } = tokenize(source);
    const { ast, errors } = parse(tokens);
    expect(errors.length).toBeGreaterThan(0);
    expect(ast!.procedures.length).toBe(1);
    expect(ast!.procedures[0].name).toBe("ok");
  });

  it("пусть y = x (x не объявлен) → compilerErrors (семантанализ в batch-5)", () => {
    const result = compileSource("модуль t\nпроцедура main()\n  пусть y = x\nконец\n");
    expect(result.compilerSuccess).toBe(false);
    const hasError = result.parserErrors.length > 0 || result.compilerErrors.length > 0;
    expect(hasError).toBe(true);
    expect(result.module).toBeFalsy();
  });

  it("вызов несуществующей процедуры → compilerErrors (семантанализ в batch-5)", () => {
    const result = compileSource("модуль t\nпроцедура main()\n  foo()\nконец\n");
    expect(result.compilerSuccess).toBe(false);
    const hasError = result.parserErrors.length > 0 || result.compilerErrors.length > 0;
    expect(hasError).toBe(true);
    expect(result.module).toBeFalsy();
  });

  it("присвоить без пусть даёт compilerError", () => {
    const result = compileSource("модуль t\nпроцедура main()\n  x = 1\n  вернуть x\nконец\n");
    expect(result.compilerSuccess).toBe(false);
    expect(result.compilerErrors.some((e) => /не объявлена через пусть|Переменная.*не объявлена/.test(e.message))).toBe(true);
  });
});

describe("VM: invoke unknown", () => {
  it("вызов неизвестного invoke бросает InterpreterError", async () => {
    const module: OsVbcModule = {
      version: 1,
      moduleName: "test",
      constants: [],
      procedures: [{ name: "main", codeOffset: 0, argc: 0, localsCount: 0 }],
      code: [{ op: "invoke", name: "система.неизвестный.вызов" }],
    };
    const vm = new VM(module, { maxSteps: 100 });
    await expect(vm.runProcedure(0, [])).rejects.toThrow(InterpreterError);
    await expect(vm.runProcedure(0, [])).rejects.toThrow(/Unknown invoke/);
  });
});
