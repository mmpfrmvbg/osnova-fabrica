/**
 * Smoke-тест компилятора: todo.osnova компилируется без ошибок и содержит ожидаемые процедуры.
 * Запуск: npx tsx --test src/tools/osnova-compiler/compiler.test.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compileSource } from "./compiler";
import { tokenize } from "./lexer";
import { parse } from "./parser";
import { VM } from "../osnova-runtime/vm/interpreter";

const FIXTURES_DIR = join(__dirname, "..", "osnova-runtime", "fixtures");

describe("Compiler smoke: todo.osnova", () => {
  it("compiles without lex/parse errors and has procedures запуск, handle_event, handle_add", () => {
    const source = readFileSync(join(FIXTURES_DIR, "todo.osnova"), "utf-8");
    const result = compileSource(source);

    assert.strictEqual(result.lexErrors.length, 0, "no lex errors");
    assert.strictEqual(result.parseErrors.length, 0, "no parse errors");
    assert.ok(result.module, "module produced");

    const names = result.module!.procedures.map((p) => p.name);
    assert.ok(names.includes("запуск"), "procedure запуск");
    assert.ok(names.includes("handle_event"), "procedure handle_event");
    assert.ok(names.includes("handle_add"), "procedure handle_add");
  });
});

describe("Compiler: иначе (if/else)", () => {
  it("если истина ... иначе ... конец: then-branch runs, VM returns 1", async () => {
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
конец
`;
    const result = compileSource(source.trim());
    assert.strictEqual(result.lexErrors.length, 0, "no lex errors");
    assert.strictEqual(result.parseErrors.length, 0, "no parse errors");
    assert.ok(result.module, "module produced");
    const vm = new VM(result.module!, { maxSteps: 1000 });
    const value = await vm.runProcedure(0, []);
    assert.strictEqual(value, 1, "then-branch: x=1");
  });

  it("если ложь ... иначе ... конец: else-branch runs, VM returns 2", async () => {
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
конец
`;
    const result = compileSource(source.trim());
    assert.ok(result.module, "module produced");
    const vm = new VM(result.module!, { maxSteps: 1000 });
    const value = await vm.runProcedure(0, []);
    assert.strictEqual(value, 2, "else-branch: x=2");
  });

  it("если без иначе: backward compatible, VM returns 1", async () => {
    const source = `
модуль t
процедура main()
  пусть x = 0
  если истина
    x = 1
  конец
  вернуть x
конец
`;
    const result = compileSource(source.trim());
    assert.ok(result.module, "module produced");
    const vm = new VM(result.module!, { maxSteps: 1000 });
    const value = await vm.runProcedure(0, []);
    assert.strictEqual(value, 1, "if without else: x=1");
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
конец
`;
    const result = compileSource(source.trim());
    assert.strictEqual(result.lexErrors.length, 0, "no lex errors");
    assert.strictEqual(result.parseErrors.length, 0, "no parse errors");
    assert.ok(result.module, "module produced");
    const vm = new VM(result.module!, { invoke: arrayInvoke, maxSteps: 10000 });
    const value = await vm.runProcedure(0, [[10, 20, 30]]);
    assert.strictEqual(value, 60, "sum 10+20+30=60");
  });

  it("для_каждого по пустому массиву: body not run, return 0", async () => {
    const source = `
модуль t
процедура main(arr)
  пусть sum = 0
  для_каждого x в arr
    sum = sum + 1
  конец
  вернуть sum
конец
`;
    const result = compileSource(source.trim());
    assert.ok(result.module, "module produced");
    const vm = new VM(result.module!, { invoke: arrayInvoke, maxSteps: 1000 });
    const value = await vm.runProcedure(0, [[]]);
    assert.strictEqual(value, 0, "empty array: sum stays 0");
  });
});

describe("Compiler: и / или / не (short-circuit)", () => {
  it("не ложь → истина, не истина → ложь", async () => {
    const source = `
модуль t
процедура main()
  если не ложь
    вернуть 1
  иначе
    вернуть 0
  конец
конец
`;
    const result = compileSource(source.trim());
    assert.ok(result.module, "module");
    const vm = new VM(result.module!, { maxSteps: 100 });
    const value = await vm.runProcedure(0, []);
    assert.strictEqual(value, 1, "не ложь = истина → then-branch");
  });

  it("истина и истина → 1, истина и ложь → 0", async () => {
    const t = `
модуль t
процедура main()
  если истина и истина
    вернуть 1
  иначе
    вернуть 0
  конец
конец
`;
    const f = `
модуль t
процедура main()
  если истина и ложь
    вернуть 1
  иначе
    вернуть 0
  конец
конец
`;
    const rT = compileSource(t.trim());
    const rF = compileSource(f.trim());
    assert.ok(rT.module && rF.module);
    const vm = new VM(rT.module!, { maxSteps: 100 });
    assert.strictEqual(await vm.runProcedure(0, []), 1, "истина и истина");
    const vm2 = new VM(rF.module!, { maxSteps: 100 });
    assert.strictEqual(await vm2.runProcedure(0, []), 0, "истина и ложь");
  });

  it("ложь или истина → 1, ложь или ложь → 0", async () => {
    const source = `
модуль t
процедура main()
  если ложь или истина
    вернуть 1
  иначе
    вернуть 0
  конец
конец
`;
    const result = compileSource(source.trim());
    assert.ok(result.module);
    const vm = new VM(result.module!, { maxSteps: 100 });
    assert.strictEqual(await vm.runProcedure(0, []), 1, "ложь или истина = истина");
  });

  it("не (истина и ложь) → истина, return 1", async () => {
    const source = `
модуль t
процедура main()
  если не (истина и ложь)
    вернуть 1
  иначе
    вернуть 0
  конец
конец
`;
    const result = compileSource(source.trim());
    assert.ok(result.module);
    const vm = new VM(result.module!, { maxSteps: 100 });
    assert.strictEqual(await vm.runProcedure(0, []), 1);
  });
});

describe("Compiler negative: errors reported", () => {
  it("invalid syntax (модуль without identifier) → parseErrors.length > 0", () => {
    const source = "модуль \n";
    const result = compileSource(source);
    assert.ok(result.parseErrors.length > 0, "parse errors expected");
    assert.ok(!result.module, "no module on parse error");
  });

  it("invalid syntax (пусть = 42) → parse error + recovery (sync to newline), AST still produced", () => {
    const source = "модуль t\nпроцедура main()\n  пусть = 42\nконец\n";
    const { tokens } = tokenize(source);
    const { ast, errors } = parse(tokens);
    assert.ok(errors.length > 0, "parse error expected after 'пусть'");
    assert.ok(ast, "recovery: parser produced AST despite error");
    assert.strictEqual(ast!.procedures.length, 1, "one procedure");
    assert.strictEqual(ast!.procedures[0].body.length, 0, "bad stmt skipped via sync, body empty");
  });

  it("broken procedure signature → parse error + recovery (sync to next процедура), second procedure in AST", () => {
    const source = "модуль t\nпроцедура 123()\nконец\nпроцедура ok()\n  вернуть\nконец\n";
    const { tokens } = tokenize(source);
    const { ast, errors } = parse(tokens);
    assert.ok(errors.length > 0, "parse error expected (procedure name must be identifier)");
    assert.ok(ast, "recovery: module still produced");
    assert.strictEqual(ast!.procedures.length, 1, "broken procedure skipped via syncToTopLevel, only ok() parsed");
    assert.strictEqual(ast!.procedures[0].name, "ok", "second procedure present");
  });

  it("unknown variable in expression (пусть y = x without пусть x) → compile error in parseErrors", () => {
    const source = "модуль t\nпроцедура main()\n  пусть y = x\nконец\n";
    const result = compileSource(source);
    assert.ok(result.parseErrors.length > 0, "codegen throws → reported as parseErrors");
    assert.ok(!result.module, "no module");
  });

  it("call to non-existent procedure → compile error in parseErrors", () => {
    const source = "модуль t\nпроцедура main()\n  foo()\nконец\n";
    const result = compileSource(source);
    assert.ok(result.parseErrors.length > 0, "unknown procedure → reported");
    assert.ok(!result.module, "no module");
  });
});
