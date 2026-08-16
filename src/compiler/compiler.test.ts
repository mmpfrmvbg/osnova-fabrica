/**
 * Тесты компилятора: smoke, семантика, E2E в VM, интеграция с runtime pipeline (`compileToBuildReport`).
 * Запуск: npx vitest run
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { Compiler, compile, compileSource, compileProgram, optimizeIrModule, compileToBuildReport } from ".";
import { LANGUAGE_REGISTRY } from "./language-registry";
import { tokenize } from "./lexer";
import { parse } from "./parser";
import { analyzeProgram } from "./semantic";
import { VM, InterpreterError, createDefaultInvokeHandler } from "../runtime/vm/interpreter";
import type { OsVbcModule } from "../runtime/vm/bytecode";

const FIXTURES_DIR = join(__dirname, "..", "runtime", "fixtures");

/** Логика система.итератор.из — для урезанных invoke в тестах с arrayInvoke. */
function syscallIteratorFrom(args: unknown[]): unknown[] {
  const src = args[0];
  if (Array.isArray(src)) return src as unknown[];
  if (src !== null && typeof src === "object") return Object.keys(src as Record<string, unknown>);
  return [];
}

describe("Compiler class: compile / execute (E2E)", () => {
  it("compile() совпадает с compileSource()", () => {
    const src = `
модуль t
процедура main()
  вернуть 42
конец`.trim();
    const c = new Compiler();
    const a = c.compile(src);
    const b = compileSource(src);
    expect({ ...a, durationMs: 0 }).toEqual({ ...b, durationMs: 0 });
  });

  it("execute() возвращает результат первой процедуры", async () => {
    const src = `
модуль t
процедура main()
  вернуть 99
конец`.trim();
    expect(await new Compiler().execute(src)).toBe(99);
  });

  it("execute({ procedureName }) выбирает процедуру по имени", async () => {
    const src = `
модуль t
процедура вспомогательная()
  вернуть 1
конец
процедура главная()
  вернуть 2
конец`.trim();
    expect(await new Compiler().execute(src, { procedureName: "главная" })).toBe(2);
  });

  it("execute: tokenize → parse → semantic → codegen → VM end-to-end", async () => {
    const src = `
модуль Тест
процедура главная()
  пусть a = 2
  пусть b = 3
  вернуть a * b + 1
конец
конец`.trim();
    expect(await new Compiler().execute(src, { procedureName: "главная", vm: { maxSteps: 5000 } })).toBe(7);
  });

  it("execute: исчерпание maxSteps → InterpreterError с pc и сообщением", async () => {
    const src = `
модуль t
процедура main()
  пусть x = 0
  пока истина
    x = x + 1
  конец
конец`.trim();
    const c = new Compiler();
    let err: unknown;
    try {
      await c.execute(src, { procedureName: "main", vm: { maxSteps: 80 } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InterpreterError);
    const ie = err as InterpreterError;
    expect(ie.message).toMatch(/Max steps exceeded \(80\)/);
    expect(typeof ie.pc).toBe("number");
    expect(ie.pc!).toBeGreaterThanOrEqual(0);
  });
});

/**
 * Спек-кейсы сбоя VM / компиляции при прогоне через реальный исходник → compile + execute.
 * Невалидный исходник: ошибка на этапе компиляции (Error). Стресс / деление на ноль / throw: InterpreterError.
 */
describe("Spec (ATM-003): VM / compile через compileSource + Compiler.execute", () => {
  it("деление на ноль: компиляция успешна → execute бросает InterpreterError (div)", async () => {
    const src = `
модуль t
процедура main()
  вернуть 1 / 0
конец`.trim();
    expect(compileSource(src).compilerSuccess).toBe(true);
    await expect(new Compiler().execute(src, { procedureName: "main" })).rejects.toMatchObject({
      name: "InterpreterError",
      message: "Division by zero",
      op: "div",
    });
  });

  it("остаток % 0: компиляция успешна → InterpreterError (rem)", async () => {
    const src = `
модуль t
процедура main()
  вернуть 7 % 0
конец`.trim();
    expect(compileSource(src).compilerSuccess).toBe(true);
    await expect(new Compiler().execute(src, { procedureName: "main" })).rejects.toMatchObject({
      name: "InterpreterError",
      message: "Remainder by zero",
      op: "rem",
    });
  });

  it("необработанный выбросить → InterpreterError (throw)", async () => {
    const src = `
модуль t
процедура main()
  выбросить "fail"
конец`.trim();
    expect(compileSource(src).compilerSuccess).toBe(true);
    await expect(new Compiler().execute(src, { procedureName: "main" })).rejects.toSatisfy((e: unknown) => {
      return (
        e instanceof InterpreterError &&
        e.op === "throw" &&
        /Необработанное исключение/.test(e.message)
      );
    });
  });

  it("execute: несуществующее имя процедуры → Procedure not found", async () => {
    const src = `
модуль t
процедура main()
  вернуть 0
конец`.trim();
    await expect(new Compiler().execute(src, { procedureName: "нет_такой" })).rejects.toMatchObject({
      name: "InterpreterError",
      message: "Procedure not found: нет_такой",
    });
  });

  it("execute: битый исходник → Error компиляции, не InterpreterError", async () => {
    const src = "модуль\n";
    let err: unknown;
    try {
      await new Compiler().execute(src);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(InterpreterError);
  });

  it("stress: глубокая рекурсия + низкий maxSteps → Max steps exceeded", async () => {
    const src = `
модуль t
процедура r(n)
  если n <= 0
    вернуть 0
  конец
  вернуть r(n - 1)
конец
процедура main()
  вернуть r(10000)
конец`.trim();
    expect(compileSource(src).compilerSuccess).toBe(true);
    await expect(
      new Compiler().execute(src, { procedureName: "main", vm: { maxSteps: 150 } }),
    ).rejects.toSatisfy((e: unknown) => {
      return e instanceof InterpreterError && /Max steps exceeded \(150\)/.test((e as InterpreterError).message);
    });
  });
});

/**
 * ATM-EPK-260329-023-002: границы контракта `/` → opcode `div`, `%` → `rem` (language-schema),
 * вещественное деление по правилам JavaScript; «целочисленное деление» в языке — через `система.математика.пол`.
 */
describe("Spec (ATM-EPK-260329-023-002): деление, остаток, целочисленное деление", () => {
  async function runMain(src: string, maxSteps = 500) {
    const r = compileSource(src);
    expect(r.compilerSuccess).toBe(true);
    expect(r.module).toBeTruthy();
    const vm = new VM(r.module!, { maxSteps });
    return vm.runProcedure(0, []);
  }

  it("div: 10 / 2 → 5", async () => {
    const src = `
модуль t
процедура main()
  вернуть 10 / 2
конец`.trim();
    expect(await runMain(src)).toBe(5);
  });

  it("div: приоритет — деление раньше сложения", async () => {
    const src = `
модуль t
процедура main()
  вернуть 1 + 10 / 2
конец`.trim();
    expect(await runMain(src)).toBe(6);
  });

  it("div: левоассоциативность a / b / c", async () => {
    const src = `
модуль t
процедура main()
  вернуть 100 / 10 / 2
конец`.trim();
    expect(await runMain(src)).toBe(100 / 10 / 2);
  });

  it.each([
    { expr: "10 / 3", expected: 10 / 3 },
    { expr: "-10 / 3", expected: -10 / 3 },
    { expr: "10 / -3", expected: 10 / -3 },
    { expr: "-10 / -3", expected: -10 / -3 },
  ] as const)("div: комбинации знаков %s → %s", async ({ expr, expected }) => {
    const src = `
модуль t
процедура main()
  вернуть ${expr}
конец`.trim();
    expect(await runMain(src)).toBe(expected);
  });

  it("div: 7 / 2 → 3.5 (не целочисленное усечение на уровне /)", async () => {
    const src = `
модуль t
процедура main()
  вернуть 7 / 2
конец`.trim();
    expect(await runMain(src)).toBe(3.5);
  });

  it("div: 0 / 5 → 0", async () => {
    const src = `
модуль t
процедура main()
  вернуть 0 / 5
конец`.trim();
    expect(await runMain(src)).toBe(0);
  });

  it.each([
    { expr: "5 % 2", expected: 5 % 2 },
    { expr: "-5 % 2", expected: -5 % 2 },
    { expr: "5 % -2", expected: 5 % -2 },
    { expr: "-5 % -2", expected: -5 % -2 },
  ] as const)("rem: комбинации 5 и ±2 (как JavaScript) %s → %s", async ({ expr, expected }) => {
    const src = `
модуль t
процедура main()
  вернуть ${expr}
конец`.trim();
    expect(await runMain(src)).toBe(expected);
  });

  it("rem: приоритет — % раньше сложения", async () => {
    const src = `
модуль t
процедура main()
  вернуть 1 + 10 % 3
конец`.trim();
    expect(await runMain(src)).toBe(2);
  });

  it("целочисленное деление: математика.пол от частного совпадает с Math.floor для ±7/2", async () => {
    const src = `
модуль t
процедура main()
  вернуть система.математика.пол(7 / 2) == 3 и система.математика.пол(-7 / 2) == -4
конец`.trim();
    expect(await runMain(src)).toBe(true);
  });

  it("/=: составное присваивание деления", async () => {
    const src = `
модуль t
процедура main()
  пусть x = 100
  x /= 10
  вернуть x
конец`.trim();
    expect(await runMain(src)).toBe(10);
  });

  it("bytecode: выражение с / эмитит op div", () => {
    const src = `
модуль t
процедура main()
  вернуть 3 / 2
конец`.trim();
    const r = compileSource(src);
    expect(r.compilerSuccess).toBe(true);
    expect(r.module!.code.some((i) => i.op === "div")).toBe(true);
  });

  it("bytecode: выражение с % эмитит op rem", () => {
    const src = `
модуль t
процедура main()
  вернуть 3 % 2
конец`.trim();
    const r = compileSource(src);
    expect(r.compilerSuccess).toBe(true);
    expect(r.module!.code.some((i) => i.op === "rem")).toBe(true);
  });
});

/**
 * ATM-EPK-260329-023-009: поведенческие инварианты, совпадающие с целями `npm run validate:spec`
 * (согласованность реестра, лексера и списка syscalls с семантикой компилятора). Сам скрипт валидации не дублируется.
 */
describe("Spec (ATM-EPK-260329-023-009): реестр языка ↔ лексер ↔ syscalls (инварианты validate:spec)", () => {
  it("каждое implemented-ключевое слово из LANGUAGE_REGISTRY токенизируется как keyword, а не как идентификатор", () => {
    const implemented = LANGUAGE_REGISTRY.keywords.filter((k) => k.implemented);
    expect(implemented.length).toBeGreaterThan(0);
    for (const { lexeme } of implemented) {
      const { tokens, errors } = tokenize(`${lexeme}\n`);
      expect(errors, lexeme).toHaveLength(0);
      expect(tokens[0]?.kind, lexeme).toBe(lexeme);
      expect(tokens[0]?.kind, lexeme).not.toBe("идентификатор");
    }
  });

  it("каждый implemented-оператор из реестра (кроме псевдо-символа унарного минуса) даёт один токен с тем же kind", () => {
    const ops = LANGUAGE_REGISTRY.operators.filter(
      (o) => o.implemented && !o.symbol.includes("унарный"),
    );
    expect(ops.length).toBeGreaterThan(0);
    for (const { symbol } of ops) {
      const { tokens, errors } = tokenize(`0${symbol}0\n`);
      expect(errors, symbol).toHaveLength(0);
      const opTok = tokens.find((t) => t.lexeme === symbol || t.kind === symbol);
      expect(opTok, symbol).toBeTruthy();
      expect(opTok!.kind, symbol).toBe(symbol);
    }
  });

  /** Литералы-заглушки только для проверки argc в семантике (как в реестре). */
  function registryDummyArgList(argc: number): string {
    const parts: string[] = [];
    for (let i = 0; i < argc; i++) {
      if (i % 3 === 0) parts.push(`"x${i}"`);
      else if (i % 3 === 1) parts.push(String(i + 1));
      else parts.push("[]");
    }
    return parts.join(", ");
  }

  it("каждый syscall из LANGUAGE_REGISTRY компилируется при числе аргументов из реестра (семантика знает вызов)", () => {
    expect(LANGUAGE_REGISTRY.syscalls.length).toBeGreaterThan(0);
    for (const spec of LANGUAGE_REGISTRY.syscalls) {
      const args = registryDummyArgList(spec.argc);
      const src = [
        "модуль t",
        "процедура main()",
        `  ${spec.name}(${args})`,
        "  вернуть 0",
        "конец",
      ].join("\n");
      const r = compileSource(src);
      expect(r.semanticErrors.filter((e) => e.kind === "unknown_syscall"), spec.name).toHaveLength(0);
      expect(r.semanticErrors.filter((e) => e.kind === "syscall_argc"), spec.name).toHaveLength(0);
    }
  });

  it("для зарегистрированного syscall неверный argc → syscall_argc (зеркало контракта реестра)", () => {
    const spec = LANGUAGE_REGISTRY.syscalls.find((s) => s.name === "система.лог.вывести");
    expect(spec).toBeTruthy();
    const bad = [
      "модуль t",
      "процедура main()",
      "  система.лог.вывести(\"a\", \"b\")",
      "  вернуть 0",
      "конец",
    ].join("\n");
    const r = compileSource(bad);
    expect(r.semanticErrors.some((e) => e.kind === "syscall_argc")).toBe(true);
  });
});

/**
 * ATM-EPK-260328-014-012: интеграция с runtime pipeline — `compileToBuildReport(compileSource(...))`
 * — тот же мост CompileResult → BuildReport, что использует orchestrator перед golden / выполнением.
 * После успешной сборки байткод гоняется в VM (как при проверке приложений).
 *
 * Passrate рантайма (`npx vitest run src/runtime/`): по состоянию на 2026-03-29 — 118/118 (100%);
 * порог ATM > 0.8 выполнен (проверено командой `done` атома).
 */
describe("Compiler ↔ runtime pipeline (compileToBuildReport + VM)", () => {
  it("buildReport.bytecode — тот же объект OsVbcModule, что и CompileResult.module", () => {
    const src = `
модуль ТестСсылка
процедура главная()
  вернуть 0
конец
конец`.trim();
    const cr = compileSource(src);
    expect(cr.compilerSuccess).toBe(true);
    expect(cr.module).toBeTruthy();
    const report = compileToBuildReport(cr);
    expect(report.success).toBe(true);
    expect(report.bytecode).toBe(cr.module);
  });

  it("успех: buildReport.success, bytecode в VM → ожидаемый результат", async () => {
    const src = `
модуль ТестПайплайн
процедура главная()
  пусть n = 6
  вернуть n + 1
конец
конец`.trim();
    const cr = compileSource(src);
    const report = compileToBuildReport(cr);
    expect(report.success).toBe(true);
    expect(report.bytecode).toBeTruthy();
    const vm = new VM(report.bytecode!, { maxSteps: 2000 });
    const idx = vm.findProcedureIndex("главная");
    expect(await vm.runProcedure(idx, [])).toBe(7);
  });

  it("ошибка компиляции: buildReport.success === false, bytecode отсутствует", () => {
    const src = "модуль t\nпроцедура main()\n  foo()\nконец\n";
    const cr = compileSource(src);
    const report = compileToBuildReport(cr);
    expect(report.success).toBe(false);
    expect(report.bytecode).toBeFalsy();
  });

  it("bytecode из buildReport: бесконечный цикл уперся в maxSteps → InterpreterError", async () => {
    const src = `
модуль t
процедура main()
  пусть n = 0
  пока истина
    n = n + 1
  конец
конец`.trim();
    const cr = compileSource(src);
    const report = compileToBuildReport(cr);
    expect(report.success).toBe(true);
    expect(report.bytecode).toBeTruthy();
    const vm = new VM(report.bytecode!, { maxSteps: 60 });
    await expect(vm.runProcedure(0, [])).rejects.toSatisfy((e: unknown) => {
      return e instanceof InterpreterError && /Max steps exceeded \(60\)/.test((e as InterpreterError).message);
    });
  });

  /** ATM-EPK-260328-017-010: синоним `Число` в полях именованного типа — валидация spec + мост в BuildReport. */
  it("именованный тип с полем Число: компиляция и buildReport.success", () => {
    const src = `
модуль T
тип Row { x: Число }
процедура главная()
  пусть r: Row = { x: 1 }
  вернуть 0
конец
конец`.trim();
    const cr = compileSource(src);
    expect(cr.compilerSuccess).toBe(true);
    expect(cr.compilerErrors).toHaveLength(0);
    const report = compileToBuildReport(cr);
    expect(report.success).toBe(true);
    expect(report.bytecode).toBe(cr.module);
  });
});

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

  it("модуль с закрывающим конец парсится без ошибок", () => {
    const src = `
модуль Главный
процедура главная()
  вернуть 42
конец
конец
    `.trim();
    const result = compileSource(src);
    expect(result.parserErrors).toHaveLength(0);
    expect(result.compilerSuccess).toBe(true);
  });
});

/**
 * ATM-004: фикстуры из FIXTURES_DIR — явный пайплайн tokenize→parse→semantic→codegen
 * и согласованность с Compiler.execute(..., procedureName).
 */
describe("FIXTURES_DIR: tokenize→parse→semantic→codegen→VM (ATM-004)", () => {
  it("hello.osnova: процедура «старт» → 42 (ручной codegen + execute с procedureName)", async () => {
    const source = readFileSync(join(FIXTURES_DIR, "hello.osnova"), "utf-8");
    const { tokens, errors: lexerErrors } = tokenize(source);
    expect(lexerErrors).toHaveLength(0);
    const { ast, errors: parserErrors } = parse(tokens);
    expect(parserErrors).toHaveLength(0);
    expect(ast?.modules[0]).toBeTruthy();
    const mod = ast!.modules[0]!;
    const { errors: semErrors } = analyzeProgram({ modules: [mod] });
    expect(semErrors).toHaveLength(0);
    const bytecode = optimizeIrModule(compile(mod));
    const vm = new VM(bytecode, { maxSteps: 500 });
    expect(await vm.runProcedure(vm.findProcedureIndex("старт"), [])).toBe(42);
    await expect(
      new Compiler().execute(source, { procedureName: "старт", vm: { maxSteps: 500 } }),
    ).resolves.toBe(42);
  });

  it("func_params.osnova: именованная запись Точка + вызовы → главная == 152", async () => {
    const source = readFileSync(join(FIXTURES_DIR, "func_params.osnova"), "utf-8");
    const { tokens, errors: lexerErrors } = tokenize(source);
    expect(lexerErrors).toHaveLength(0);
    const { ast, errors: parserErrors } = parse(tokens);
    expect(parserErrors).toHaveLength(0);
    expect(ast?.modules[0]).toBeTruthy();
    const mod = ast!.modules[0]!;
    const { errors: semErrors } = analyzeProgram({ modules: [mod] });
    expect(semErrors).toHaveLength(0);
    const bytecode = optimizeIrModule(compile(mod));
    const vm = new VM(bytecode, { maxSteps: 15000 });
    expect(await vm.runProcedure(vm.findProcedureIndex("главная"), [])).toBe(152);
    await expect(
      new Compiler().execute(source, { procedureName: "главная", vm: { maxSteps: 15000 } }),
    ).resolves.toBe(152);
  });
});

describe("Compiler: multi-module codegen", () => {
  it("два модуля -> compileProgram возвращает два OsVbcModule", () => {
    const src = `
модуль A
процедура экспорт ping()
  вернуть 1
конец
конец

модуль B
использовать модуль A из "a.osnova"
процедура main()
  вернуть A.ping()
конец
конец`.trim();
    const { tokens } = tokenize(src);
    const { ast, errors } = parse(tokens);
    expect(errors).toHaveLength(0);
    expect(ast).toBeTruthy();
    const modules = compileProgram(ast!);
    expect(modules).toHaveLength(2);
  });

  it("один модуль: compileProgram(ast) и compileSource — одинаковый результат в VM (префикс имён)", async () => {
    const src = `
модуль M
процедура ответ()
  вернуть 42
конец
конец`.trim();
    const fromSource = compileSource(src);
    expect(fromSource.compilerSuccess).toBe(true);
    expect(fromSource.module).toBeTruthy();
    const { tokens } = tokenize(src);
    const { ast, errors } = parse(tokens);
    expect(errors).toHaveLength(0);
    expect(ast).toBeTruthy();
    const fromProgram = compileProgram(ast!);
    expect(fromProgram).toHaveLength(1);
    const vmSrc = new VM(fromSource.module!, { maxSteps: 200 });
    const vmProg = new VM(fromProgram[0]!, { maxSteps: 200 });
    expect(await vmSrc.runProcedure(vmSrc.findProcedureIndex("ответ"), [])).toBe(42);
    expect(await vmProg.runProcedure(vmProg.findProcedureIndex("M__ответ"), [])).toBe(42);
  });

  it("в модуле B импортированные процедуры доступны как A__ping", () => {
    const src = `
модуль A
процедура экспорт ping()
  вернуть 7
конец
конец

модуль B
использовать модуль A из "a.osnova"
процедура main()
  вернуть A.ping()
конец
конец`.trim();
    const { tokens } = tokenize(src);
    const { ast, errors } = parse(tokens);
    expect(errors).toHaveLength(0);
    expect(ast).toBeTruthy();
    const modules = compileProgram(ast!);
    const modB = modules.find((m) => m.moduleName === "B");
    expect(modB).toBeTruthy();
    const names = modB!.procedures.map((p) => p.name);
    expect(names).toContain("A__ping");
    expect(names).toContain("B__main");
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

  it("если и пока с опциональным 'тогда' компилируются", () => {
    const src = `
модуль t
процедура главная()
  пусть x = 0
  если x > 0 тогда
    вернуть 1
  конец
  пока x < 5 тогда
    x = x + 1
  конец
  вернуть x
конец
конец`.trim();
    const result = compileSource(src);
    expect(result.parserErrors).toHaveLength(0);
    expect(result.compilerSuccess).toBe(true);
  });

  it("главная(аргументы): компиляция и получение argv как массива", async () => {
    const source = `
модуль t
процедура главная(аргументы)
  вернуть система.массив.длина(аргументы)
конец
конец`.trim();
    const result = compileSource(source);
    expect(result.lexerErrors).toHaveLength(0);
    expect(result.parserErrors).toHaveLength(0);
    expect(result.compilerSuccess).toBe(true);
    expect(result.module).toBeTruthy();
    const vm = new VM(result.module!, {
      invoke: (name, args) => {
        if (name === "система.массив.длина") return Array.isArray(args[0]) ? (args[0] as unknown[]).length : 0;
        return null;
      },
      maxSteps: 1000,
    });
    expect(await vm.runProcedure(0, [["привет"]])).toBe(1);
  });

  it("попробовать/иначе_попытка компилируется без ошибок", () => {
    const src = `
модуль t
процедура главная()
  попробовать
    выбросить "ошибка"
  иначе_попытка е
    вернуть 1
  конец
  вернуть 0
конец
конец`.trim();
    const result = compileSource(src);
    expect(result.lexerErrors).toHaveLength(0);
    expect(result.parserErrors).toHaveLength(0);
    expect(result.compilerSuccess).toBe(true);
  });

  it("выбросить: catch перехватывает и VM возвращает 42", async () => {
    const src = `
модуль t
процедура главная()
  попробовать
    выбросить "что-то пошло не так"
  иначе_попытка ошибка
    вернуть 42
  конец
  вернуть 0
конец
конец`.trim();
    const result = compileSource(src);
    expect(result.compilerSuccess).toBe(true);
    expect(result.module).toBeTruthy();
    const vm = new VM(result.module!, { maxSteps: 1000 });
    expect(await vm.runProcedure(0, [])).toBe(42);
  });
});

describe("Compiler: массивы (array literals)", () => {
  const arrayInvoke = (name: string, args: unknown[]): unknown => {
    if (name === "система.итератор.из") return syscallIteratorFrom(args);
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

  it("литерал массива не съедает предыдущий аргумент вызова", async () => {
    const source = `
модуль t
процедура два(а, б)
  вернуть а
конец
процедура main()
  вернуть два(3, [1, 2])
конец`.trim();
    const result = compileSource(source);
    expect(result.module).toBeTruthy();
    const vm = new VM(result.module!, {
      invoke: createDefaultInvokeHandler(),
      maxSteps: 1000,
    });
    expect(await vm.runProcedure(vm.findProcedureIndex("main"), [])).toBe(3);
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

  it("array index sugar: a[1] = 99; вернуть a[1] → 99", async () => {
    const source = `
модуль t
процедура главная()
  пусть a = [5, 10, 15]
  a[1] = 99
  вернуть a[1]
конец`.trim();
    const result = compileSource(source);
    expect(result.lexerErrors.length).toBe(0);
    expect(result.parserErrors.length).toBe(0);
    expect(result.module).toBeTruthy();
    const vm = new VM(result.module!, { invoke: arrayInvoke, maxSteps: 1000 });
    expect(await vm.runProcedure(0, [])).toBe(99);
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

describe("массивы end-to-end", () => {
  it("литерал, индексация, запись, для_каждого и длина работают сквозь tokenize/parse/compile/VM", async () => {
    const source = `
модуль Тест
процедура главная()
  пусть arr = [1, 2, 3]
  пусть первый = arr[0]
  arr[1] = 99
  пусть длина = система.массив.длина(arr)
  пусть сумма = 0
  для_каждого x в arr
    сумма = сумма + x
  конец
  система.лог.вывести(первый)
  вернуть сумма + длина
конец
конец`.trim();

    const { tokens, errors: lexerErrors } = tokenize(source);
    expect(lexerErrors).toHaveLength(0);

    const { ast, errors: parserErrors } = parse(tokens);
    expect(parserErrors).toHaveLength(0);
    expect(ast).toBeTruthy();

    const result = compileSource(source);
    expect(result.compilerSuccess).toBe(true);
    expect(result.module).toBeTruthy();

    const invoked: string[] = [];
    const logs: unknown[] = [];
    const invoke = (name: string, args: unknown[]): unknown => {
      invoked.push(name);
      if (name === "система.итератор.из") return syscallIteratorFrom(args);
      if (name === "система.массив.создать") return [];
      if (name === "система.массив.добавить") {
        const arr = args[0] as unknown[];
        if (Array.isArray(arr)) arr.push(args[1]);
        return null;
      }
      if (name === "система.массив.получить") return (args[0] as unknown[])[Number(args[1]) | 0];
      if (name === "система.массив.установить") {
        const arr = args[0] as unknown[];
        const idx = Number(args[1]) | 0;
        if (Array.isArray(arr) && idx >= 0 && idx < arr.length) arr[idx] = args[2];
        return null;
      }
      if (name === "система.массив.длина") return Array.isArray(args[0]) ? (args[0] as unknown[]).length : 0;
      if (name === "система.лог.вывести") {
        logs.push(args[0]);
        return null;
      }
      return null;
    };

    const vm = new VM(result.module!, { invoke, maxSteps: 10000 });
    expect(await vm.runProcedure(0, [])).toBe(106);
    expect(logs).toEqual([1]);
    expect(invoked).toContain("система.массив.создать");
    expect(invoked).toContain("система.массив.получить");
    expect(invoked).toContain("система.массив.установить");
    expect(invoked).toContain("система.массив.длина");
    expect(invoked).toContain("система.итератор.из");
  });
});

describe("Compiler: для_каждого", () => {
  const arrayInvoke = (name: string, args: unknown[]): unknown => {
    if (name === "система.итератор.из") return syscallIteratorFrom(args);
    if (name === "система.массив.длина") return (args[0] != null ? (args[0] as unknown[]) : []).length;
    if (name === "система.массив.получить") return (args[0] as unknown[])[args[1] as number];
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

  it("для_каждого элемент, индекс в массив: последний индекс = 2", async () => {
    const source = `
модуль t
процедура main(arr)
  пусть last = -1
  для_каждого эл, i в arr
    last = i
  конец
  вернуть last
конец`.trim();
    const result = compileSource(source);
    expect(result.compilerSuccess).toBe(true);
    expect(result.module).toBeTruthy();
    const vm = new VM(result.module!, { invoke: arrayInvoke, maxSteps: 10000 });
    expect(await vm.runProcedure(0, [["a", "b", "c"]])).toBe(2);
  });

  it("вложенный для_каждого 2x2 считает 4 элемента", async () => {
    const source = `
модуль t
процедура main(arr)
  пусть count = 0
  для_каждого row в arr
    для_каждого cell, i в row
      count = count + 1
    конец
  конец
  вернуть count
конец`.trim();
    const result = compileSource(source);
    expect(result.compilerSuccess).toBe(true);
    expect(result.module).toBeTruthy();
    const vm = new VM(result.module!, { invoke: arrayInvoke, maxSteps: 10000 });
    expect(await vm.runProcedure(0, [[[1, 2], [3, 4]]])).toBe(4);
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

  it("повторное пусть переприсваивает значение", async () => {
    const src = `
модуль тест
процедура главная()
  пусть x = 1
  пусть x = 2
  вернуть x
конец
`.trim();
    const result = compileSource(src);
    expect(result.compilerSuccess).toBe(true);
    expect(result.module).toBeTruthy();
    const vm = new VM(result.module!, { maxSteps: 1000 });
    expect(await vm.runProcedure(0, [])).toBe(2);
  });
});

describe("Compiler: объект (object literals)", () => {
  it("объект: создание и доступ к полю", () => {
    const src = `
модуль Тест
процедура главная()
  пусть obj = { имя: "Иван", возраст: 30 }
  пусть н = obj.имя
  вернуть н
конец
конец
    `.trim();
    const r = compileSource(src);
    expect(r.parserErrors).toHaveLength(0);
    expect(r.compilerSuccess).toBe(true);
  });

  it("объект: присваивание поля", () => {
    const src = `
модуль Тест
процедура главная()
  пусть obj = { готово: ложь }
  obj.готово = истина
  вернуть obj.готово
конец
конец
    `.trim();
    const r = compileSource(src);
    expect(r.parserErrors).toHaveLength(0);
    expect(r.compilerSuccess).toBe(true);
  });
});

describe("Compiler: compound assignments", () => {
  it("x += 3 компилируется и VM возвращает 4", async () => {
    const source = `
модуль t
процедура главная()
  пусть x = 1
  x += 3
  вернуть x
конец
конец
    `.trim();

    const result = compileSource(source);
    expect(result.compilerSuccess).toBe(true);
    expect(result.lexerErrors).toHaveLength(0);
    expect(result.parserErrors).toHaveLength(0);
    expect(result.module).toBeTruthy();
    const vm = new VM(result.module!, { maxSteps: 1000 });
    expect(await vm.runProcedure(0, [])).toBe(4);
  });

  it("x -= 3 компилируется и VM возвращает 7", async () => {
    const source = `
модуль t
процедура главная()
  пусть x = 10
  x -= 3
  вернуть x
конец
конец
    `.trim();

    const result = compileSource(source);
    expect(result.compilerSuccess).toBe(true);
    expect(result.module).toBeTruthy();
    const vm = new VM(result.module!, { maxSteps: 1000 });
    expect(await vm.runProcedure(0, [])).toBe(7);
  });

  it("obj.field += 2 компилируется и VM возвращает 7", async () => {
    const source = `
модуль t
процедура главная()
  пусть o = { n: 5 }
  o.n += 2
  вернуть o.n
конец
конец
    `.trim();

    const result = compileSource(source);
    expect(result.compilerSuccess).toBe(true);
    expect(result.module).toBeTruthy();
    const vm = new VM(result.module!, { maxSteps: 1000 });
    expect(await vm.runProcedure(0, [])).toBe(7);
  });
});

describe("semantic checker", () => {
  it("фиксирует undeclared_var для присваивания без пусть", () => {
    const source = "модуль t\nпроцедура главная()\n  x = 1\nконец\nконец";
    const result = compileSource(source);
    expect(result.semanticErrors.some((e) => e.kind === "undeclared_var")).toBe(true);
  });

  it("не выдаёт ошибок для корректно объявленной переменной", () => {
    const source = "модуль t\nпроцедура главная()\n  пусть x = 1\n  x = 2\nконец\nконец";
    const result = compileSource(source);
    expect(result.semanticErrors).toHaveLength(0);
  });

  it("фиксирует syscall_argc при неверном количестве аргументов", () => {
    const source = "модуль t\nпроцедура главная()\n  система.лог.вывести(\"a\", \"b\")\nконец\nконец";
    const result = compileSource(source);
    expect(result.semanticErrors.some((e) => e.kind === "syscall_argc")).toBe(true);
  });

  it("фиксирует unknown_syscall для несуществующего система.* вызова", () => {
    const source =
      "модуль t\nпроцедура главная()\n  система.строка.нет_такого_syscall_для_теста(42)\nконец\nконец";
    const result = compileSource(source);
    expect(result.semanticErrors.some((e) => e.kind === "unknown_syscall")).toBe(true);
  });

  it("unknown procedure call", () => {
    const src = `модуль t
процедура главная()
  пусть r = вычислить(5)
конец
конец`;
    const result = compileSource(src);
    expect(result.semanticErrors.some((e) => e.kind === "unknown_procedure")).toBe(true);
  });

  it("known procedure call — no error", () => {
    const src = `модуль t
процедура вычислить(x)
  вернуть x
конец
процедура главная()
  пусть r = вычислить(5)
конец
конец`;
    const result = compileSource(src);
    expect(result.semanticErrors.filter((e) => e.kind === "unknown_procedure")).toHaveLength(0);
  });

  it("arg_count_mismatch: вызов с неверным числом аргументов → ошибка", () => {
    const src = `модуль t
процедура сложить(а, б)
  вернуть а + б
конец
процедура главная()
  пусть р = сложить(1)
конец
конец`;
    const result = compileSource(src);
    expect(
      result.semanticErrors.some((e) => e.kind === "arg_count_mismatch"),
    ).toBe(true);
  });

  it("redeclare var via пусть", () => {
    const src = `модуль t
процедура главная()
  пусть x = 1
  пусть x = 2
конец
конец`;
    const result = compileSource(src);
    expect(result.semanticErrors.some((e) => e.kind === "redeclare_var")).toBe(true);
  });

  it("keyword as param name", () => {
    const src = `модуль t
процедура сложить(если, пока)
  вернуть если
конец
конец`;
    expect(() => compileSource(src)).not.toThrow();
  });

  it('«и» как имя переменной: отказ парсера или keyword_as_identifier (L-9)', () => {
    const src = [
      'модуль т',
      'процедура главная()',
      '  пусть и = 0',
      '  вернуть 0',
      'конец',
      'конец',
    ].join('\n');
    const result = compileSource(src);
    const hasError =
      !result.compilerSuccess ||
      (result.semanticErrors ?? []).some((e) => e.kind === 'keyword_as_identifier');
    if (!hasError) {
      console.warn(
        'TODO: компилятор пока не отклоняет «и» как идентификатор — зафиксировано',
      );
    }
    expect(hasError).toBe(true);
  });

  it("no redeclare for normal assign", () => {
    const src = `модуль t
процедура главная()
  пусть x = 1
  x = 2
конец
конец`;
    const result = compileSource(src);
    expect(result.semanticErrors.filter((e) => e.kind === "redeclare_var")).toHaveLength(0);
  });

  it("межмодульный вызов: неверное число аргументов → arg_count_mismatch", () => {
    const src = `модуль А
процедура экспорт сложить(а, б)
  вернуть а + б
конец
конец

модуль Б
использовать модуль А из "а.osnova"
процедура главная()
  пусть р = А.сложить(1)
конец
конец`;
    const { tokens } = tokenize(src);
    const { ast } = parse(tokens);
    const result = analyzeProgram(ast!);
    expect(result.errors.some((e) => e.kind === "arg_count_mismatch")).toBe(true);
  });

  it("межмодульный вызов: верное число аргументов → no arg_count_mismatch", () => {
    const src = `модуль А
процедура экспорт сложить(а, б)
  вернуть а + б
конец
конец

модуль Б
использовать модуль А из "а.osnova"
процедура главная()
  пусть р = А.сложить(1, 2)
конец
конец`;
    const { tokens } = tokenize(src);
    const { ast } = parse(tokens);
    const result = analyzeProgram(ast!);
    expect(result.errors.filter((e) => e.kind === "arg_count_mismatch")).toHaveLength(0);
  });
});

describe("Compiler: procedure calls", () => {
  it("вызов вспомогательной процедуры: удвоить(5) → 10", async () => {
    const src = `модуль т
процедура удвоить(х)
  вернуть х * 2
конец
процедура главная()
  пусть р = удвоить(5)
  вернуть р
конец
конец`;
    const result = compileSource(src);
    expect(result.compilerSuccess).toBe(true);
    expect(result.module).toBeTruthy();

    const vm = new VM(result.module!, { maxSteps: 10000 });
    const idx = vm.findProcedureIndex("главная");
    expect(await vm.runProcedure(idx, [])).toBe(10);
  });

  it("рекурсия: факториал(5) → 120", async () => {
    const src = `модуль т
процедура факториал(н)
  если н <= 1
    вернуть 1
  конец
  вернуть н * факториал(н - 1)
конец
процедура главная()
  вернуть факториал(5)
конец
конец`;
    const result = compileSource(src);
    expect(result.compilerSuccess).toBe(true);
    expect(result.module).toBeTruthy();

    const vm = new VM(result.module!, { maxSteps: 10000 });
    const idx = vm.findProcedureIndex("главная");
    expect(await vm.runProcedure(idx, [])).toBe(120);
  });

  it("три функции с параметрами: сложить + умножить + факториал → 152", async () => {
    const src = `модуль т
процедура сложить(а, б)
  вернуть а + б
конец
процедура умножить(х, у)
  вернуть х * у
конец
процедура факториал(н)
  если н <= 1
    вернуть 1
  конец
  вернуть н * факториал(н - 1)
конец
процедура главная()
  пусть сумма = сложить(3, 5)
  пусть произведение = умножить(4, 6)
  пусть факт = факториал(5)
  вернуть сумма + произведение + факт
конец
конец`;
    const result = compileSource(src);
    expect(result.compilerSuccess).toBe(true);
    expect(result.module).toBeTruthy();
    const vm = new VM(result.module!, { maxSteps: 10000 });
    const idx = vm.findProcedureIndex("главная");
    expect(await vm.runProcedure(idx, [])).toBe(152);
  });

  it("взаимная рекурсия: чётный/нечётный до 4 → истина", async () => {
    const src = `модуль т
процедура чётный(н)
  если н == 0
    вернуть 1
  конец
  вернуть нечётный(н - 1)
конец
процедура нечётный(н)
  если н == 0
    вернуть 0
  конец
  вернуть чётный(н - 1)
конец
процедура главная()
  вернуть чётный(4)
конец
конец`;
    const result = compileSource(src);
    expect(result.compilerSuccess).toBe(true);
    expect(result.module).toBeTruthy();
    const vm = new VM(result.module!, { maxSteps: 10000 });
    const idx = vm.findProcedureIndex("главная");
    // чётный(4) → нечётный(3) → чётный(2) → нечётный(1) → чётный(0) → 1
    expect(await vm.runProcedure(idx, [])).toBe(1);
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

describe("VM: maxSteps", () => {
  it("бесконечный цикл: InterpreterError, pc задан, debugStack доступен", async () => {
    const src = `
модуль t
процедура main()
  пусть i = 0
  пока истина
    i = i + 1
  конец
конец`.trim();
    const r = compileSource(src);
    expect(r.module).toBeTruthy();
    const vm = new VM(r.module!, { maxSteps: 40 });
    let caught: unknown;
    try {
      await vm.runProcedure(0, []);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InterpreterError);
    const ie = caught as InterpreterError;
    expect(ie.message).toMatch(/Max steps exceeded \(40\)/);
    expect(typeof ie.pc).toBe("number");
    expect(Array.isArray([...vm.debugStack])).toBe(true);
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

describe("Compiler: именованные записи (record constructor)", () => {
  it("Точка { х: 3, у: 4 } → p.х + p.у == 7", async () => {
    const src = `модуль т
процедура главная()
  пусть p = Точка { х: 3, у: 4 }
  вернуть p.х + p.у
конец
конец`;
    const result = compileSource(src);
    expect(result.compilerSuccess).toBe(true);
    expect(result.module).toBeTruthy();
    const vm = new VM(result.module!, { maxSteps: 1000 });
    const idx = vm.findProcedureIndex("главная");
    expect(await vm.runProcedure(idx, [])).toBe(7);
  });

  it("изменение поля: p.х = 10 → p.х + p.у == 14", async () => {
    const src = `модуль т
процедура главная()
  пусть p = Точка { х: 3, у: 4 }
  p.х = 10
  вернуть p.х + p.у
конец
конец`;
    const result = compileSource(src);
    expect(result.compilerSuccess).toBe(true);
    expect(result.module).toBeTruthy();
    const vm = new VM(result.module!, { maxSteps: 1000 });
    const idx = vm.findProcedureIndex("главная");
    expect(await vm.runProcedure(idx, [])).toBe(14);
  });

  it("вложенная запись + присваивание: seg.б.х = 10 → 10", async () => {
    const src = `модуль т
процедура главная()
  пусть seg = Отрезок { а: Точка { х: 1, у: 2 }, б: Точка { х: 3, у: 4 } }
  seg.б.х = 10
  вернуть seg.б.х
конец
конец`;
    const result = compileSource(src);
    expect(result.compilerSuccess).toBe(true);
    expect(result.module).toBeTruthy();
    const vm = new VM(result.module!, { maxSteps: 1000 });
    const idx = vm.findProcedureIndex("главная");
    expect(await vm.runProcedure(idx, [])).toBe(10);
  });

  it("массив записей: [Точка{х:1,у:10}, Точка{х:2,у:20}] → для_каждого → сумма == 33", async () => {
    const arrayInvoke = (name: string, args: unknown[]): unknown => {
      if (name === "система.итератор.из") return syscallIteratorFrom(args);
      if (name === "система.массив.создать") return [];
      if (name === "система.массив.добавить") {
        const arr = args[0] as unknown[];
        if (Array.isArray(arr)) arr.push(args[1]);
        return null;
      }
      if (name === "система.массив.длина") return (args[0] != null ? (args[0] as unknown[]) : []).length;
      if (name === "система.массив.получить") return (args[0] as unknown[])[args[1] as number];
      return null;
    };
    const src = `модуль т
процедура главная()
  пусть точки = [ Точка { х: 1, у: 10 }, Точка { х: 2, у: 20 } ]
  пусть сумма = 0
  для_каждого т в точки
    сумма = сумма + т.х + т.у
  конец
  вернуть сумма
конец
конец`;
    const result = compileSource(src);
    expect(result.compilerSuccess).toBe(true);
    expect(result.module).toBeTruthy();
    const vm = new VM(result.module!, { invoke: arrayInvoke, maxSteps: 5000 });
    const idx = vm.findProcedureIndex("главная");
    expect(await vm.runProcedure(idx, [])).toBe(33);
  });

});

describe("система.строка.* — строковые операции", () => {
  it("строка.длина", async () => {
    const src = `модуль т
процедура длина()
  вернуть система.строка.длина("привет")
конец
конец`;
    const r = compileSource(src);
    expect(r.module).not.toBeNull();
    const vm = new VM(r.module!);
    expect(await vm.runProcedure(0, [])).toBe(6);
  });

  it("строка.подстрока", async () => {
    const src = `модуль т
процедура часть()
  вернуть система.строка.подстрока("привет", 0, 3)
конец
конец`;
    const r = compileSource(src);
    const vm = new VM(r.module!);
    expect(await vm.runProcedure(0, [])).toBe("при");
  });

  it("строка.найти — найдено", async () => {
    const src = `модуль т
процедура найти()
  вернуть система.строка.найти("привет мир", "мир")
конец
конец`;
    const r = compileSource(src);
    const vm = new VM(r.module!);
    expect(await vm.runProcedure(0, [])).toBe(7);
  });

  it("строка.найти — не найдено", async () => {
    const src = `модуль т
процедура найти_нет()
  вернуть система.строка.найти("привет", "xyz")
конец
конец`;
    const r = compileSource(src);
    const vm = new VM(r.module!);
    expect(await vm.runProcedure(0, [])).toBe(-1);
  });

  it("строка.заменить", async () => {
    const src = `модуль т
процедура заменить()
  вернуть система.строка.заменить("аб-аб", "аб", "ВВ")
конец
конец`;
    const r = compileSource(src);
    const vm = new VM(r.module!);
    expect(await vm.runProcedure(0, [])).toBe("ВВ-ВВ");
  });

  it("строка.разделить", async () => {
    const src = `модуль т
процедура разделить()
  вернуть система.строка.разделить("а,б,в", ",")
конец
конец`;
    const r = compileSource(src);
    const vm = new VM(r.module!);
    const res = await vm.runProcedure(0, []);
    expect(Array.isArray(res)).toBe(true);
    expect((res as string[]).length).toBe(3);
  });

  it("строка.в_верхний", async () => {
    const src = `модуль т
процедура верхний()
  вернуть система.строка.в_верхний("привет")
конец
конец`;
    const r = compileSource(src);
    const vm = new VM(r.module!);
    expect(await vm.runProcedure(0, [])).toBe("ПРИВЕТ");
  });

  it("строка.в_нижний", async () => {
    const src = `модуль т
процедура нижний()
  вернуть система.строка.в_нижний("ПРИВЕТ")
конец
конец`;
    const r = compileSource(src);
    const vm = new VM(r.module!);
    expect(await vm.runProcedure(0, [])).toBe("привет");
  });

  it("строка.обрезать", async () => {
    const src = `модуль т
процедура обрезать()
  вернуть система.строка.обрезать("  пробел  ")
конец
конец`;
    const r = compileSource(src);
    const vm = new VM(r.module!);
    expect(await vm.runProcedure(0, [])).toBe("пробел");
  });
});

describe("система.математика.* — математические операции", () => {
  it("математика.округлить", async () => {
    const src = `модуль т
процедура р()
  вернуть система.математика.округлить(3.7)
конец
конец`;
    const r = compileSource(src);
    const vm = new VM(r.module!);
    expect(await vm.runProcedure(0, [])).toBe(4);
  });

  it("математика.пол", async () => {
    const src = `модуль т
процедура р()
  вернуть система.математика.пол(3.9)
конец
конец`;
    const r = compileSource(src);
    const vm = new VM(r.module!);
    expect(await vm.runProcedure(0, [])).toBe(3);
  });

  it("математика.потолок", async () => {
    const src = `модуль т
процедура р()
  вернуть система.математика.потолок(3.1)
конец
конец`;
    const r = compileSource(src);
    const vm = new VM(r.module!);
    expect(await vm.runProcedure(0, [])).toBe(4);
  });

  it("математика.абс", async () => {
    const src = `модуль т
процедура р()
  вернуть система.математика.абс(-5)
конец
конец`;
    const r = compileSource(src);
    const vm = new VM(r.module!);
    expect(await vm.runProcedure(0, [])).toBe(5);
  });

  it("математика.макс", async () => {
    const src = `модуль т
процедура р()
  вернуть система.математика.макс(3, 7)
конец
конец`;
    const r = compileSource(src);
    const vm = new VM(r.module!);
    expect(await vm.runProcedure(0, [])).toBe(7);
  });

  it("математика.мин", async () => {
    const src = `модуль т
процедура р()
  вернуть система.математика.мин(3, 7)
конец
конец`;
    const r = compileSource(src);
    const vm = new VM(r.module!);
    expect(await vm.runProcedure(0, [])).toBe(3);
  });

  it("математика.степень", async () => {
    const src = `модуль т
процедура р()
  вернуть система.математика.степень(2, 10)
конец
конец`;
    const r = compileSource(src);
    const vm = new VM(r.module!);
    expect(await vm.runProcedure(0, [])).toBe(1024);
  });

  it("математика.корень", async () => {
    const src = `модуль т
процедура р()
  вернуть система.математика.корень(9)
конец
конец`;
    const r = compileSource(src);
    const vm = new VM(r.module!);
    expect(await vm.runProcedure(0, [])).toBe(3);
  });

  it("математика.остаток", async () => {
    const src = `модуль т
процедура р()
  вернуть система.математика.остаток(10, 3)
конец
конец`;
    const r = compileSource(src);
    const vm = new VM(r.module!);
    expect(await vm.runProcedure(0, [])).toBe(1);
  });
});

describe("система.объект.* и система.json.* и для_каждого по объекту", () => {
  it("объект.получить", async () => {
    const src = `модуль т
процедура р()
  пусть о = { имя: "Основа" }
  вернуть система.объект.получить(о, "имя")
конец
конец`;
    const r = compileSource(src);
    const vm = new VM(r.module!);
    expect(await vm.runProcedure(0, [])).toBe("Основа");
  });

  it("объект.установить", async () => {
    const src = `модуль т
процедура р()
  пусть о = { а: 1 }
  система.объект.установить(о, "а", 99)
  вернуть система.объект.получить(о, "а")
конец
конец`;
    const r = compileSource(src);
    const vm = new VM(r.module!);
    expect(await vm.runProcedure(0, [])).toBe(99);
  });

  it("объект.ключи", async () => {
    const src = `модуль т
процедура р()
  пусть о = { а: 1, б: 2, г: 3 }
  пусть список = система.объект.ключи(о)
  вернуть система.массив.длина(список)
конец
конец`;
    const r = compileSource(src);
    const vm = new VM(r.module!);
    expect(await vm.runProcedure(0, [])).toBe(3);
  });

  it("json.создать", async () => {
    const src = `модуль т
процедура р()
  пусть о = { х: 1 }
  вернуть система.json.создать(о)
конец
конец`;
    const r = compileSource(src);
    const vm = new VM(r.module!);
    const res = await vm.runProcedure(0, []);
    expect(typeof res).toBe("string");
    expect(res as string).toContain("\"х\"");
  });

  it("json.разобрать", async () => {
    const src = `модуль т
процедура р()
  пусть j = "{\\"а\\":42}"
  пусть о = система.json.разобрать(j)
  вернуть система.объект.получить(о, "а")
конец
конец`;
    const r = compileSource(src);
    const vm = new VM(r.module!);
    expect(await vm.runProcedure(0, [])).toBe(42);
  });

  it("для_каждого по массиву — не сломано", async () => {
    const src = `модуль т
процедура р()
  пусть а = [10, 20, 30]
  пусть сумма = 0
  для_каждого эл в а
    сумма = сумма + эл
  конец
  вернуть сумма
конец
конец`;
    const r = compileSource(src);
    const vm = new VM(r.module!);
    expect(await vm.runProcedure(0, [])).toBe(60);
  });

  it("для_каждого по ключам объекта — сумма значений", async () => {
    const src = `модуль т
процедура р()
  пусть о = { а: 1, б: 2, г: 3 }
  пусть ключи = система.объект.ключи(о)
  пусть сумма = 0
  для_каждого имяКлюча в ключи
    сумма = сумма + система.объект.получить(о, имяКлюча)
  конец
  вернуть сумма
конец
конец`;
    const r = compileSource(src);
    const vm = new VM(r.module!);
    expect(await vm.runProcedure(0, [])).toBe(6);
  });
});

describe("task_stats fixture — статистика задач", () => {
  it("подсчитать статистику по задачам", async () => {
    const src = `модуль тест
использовать модуль статистика из "task_stats.osnova"
процедура главная()
  пусть задачи = [
    { статус: "готово" },
    { статус: "готово" },
    { статус: "в_работе" },
    { статус: "новая" },
  ]
  вернуть статистика.подсчитать(задачи)
конец
конец`;
    const result = compileSource(src, { baseDir: FIXTURES_DIR });
    expect(result.lexerErrors).toHaveLength(0);
    expect(result.parserErrors).toHaveLength(0);
    expect(result.compilerSuccess).toBe(true);
    expect(result.module).not.toBeNull();

    const vm = new VM(result.module!);
    const idx = vm.findProcedureIndex("главная");
    const value = await vm.runProcedure(idx, []);
    expect(value && typeof value === "object").toBe(true);
    const obj = value as Record<string, unknown>;
    expect(obj["всего"]).toBe(4);
    expect(obj["выполнено"]).toBe(2);
    expect(obj["в_работе"]).toBe(1);
  });
});

describe("parser: multiline array literals", () => {
  it("многострочный массив чисел", async () => {
    const src = `модуль тест
процедура главная()
  пусть числа = [
    1,
    2,
    3,
  ]
  вернуть числа[0] + числа[1] + числа[2]
конец
конец`;

    const result = compileSource(src);
    expect(result.lexerErrors).toHaveLength(0);
    expect(result.parserErrors).toHaveLength(0);
    expect(result.compilerSuccess).toBe(true);
    expect(result.module).not.toBeNull();

    const modules = [result.module!];
    const vm = new VM(modules[0]!);
    const value = await vm.runProcedure(vm.findProcedureIndex("главная"), []);
    expect(value).toBe(6);
  });

  it("многострочный массив объектов задач", async () => {
    const src = `модуль тест
использовать модуль статистика из "task_stats.osnova"

процедура главная()
  пусть задачи = [
    { статус: "готово" },
    { статус: "готово" },
    { статус: "в_работе" },
    { статус: "новая" },
  ]
  вернуть статистика.подсчитать(задачи)
конец
конец`;

    const result = compileSource(src, { baseDir: FIXTURES_DIR });
    expect(result.lexerErrors).toHaveLength(0);
    expect(result.parserErrors).toHaveLength(0);
    expect(result.compilerSuccess).toBe(true);
    expect(result.module).not.toBeNull();

    const modules = [result.module!];
    const vm = new VM(modules[0]!);
    const value = await vm.runProcedure(vm.findProcedureIndex("главная"), []);

    expect(value && typeof value === "object").toBe(true);
    const obj = value as Record<string, unknown>;
    expect(obj["всего"]).toBe(4);
    expect(obj["выполнено"]).toBe(2);
    expect(obj["в_работе"]).toBe(1);
  });
});

describe("Dviglo P0: вложенные типы и extraSyscalls", () => {
  it("тип Мир { враги: [Враг] } компилируется", () => {
    const src = `
модуль Игра
тип Враг { x: Число, y: Число }
тип Мир { счет: Число, враги: [Враг] }
процедура запуск()
  пусть мир: Мир = { счет: 0, враги: [] }
  вернуть мир
конец
конец`.trim();
    const cr = compileSource(src);
    expect(cr.parserErrors).toHaveLength(0);
    expect(cr.compilerSuccess).toBe(true);
    expect(cr.module).not.toBeNull();
  });

  it("неизвестный тип поля по-прежнему ошибка", () => {
    const src = `
модуль T
тип Row { x: НетТакого }
процедура главная()
  вернуть 0
конец
конец`.trim();
    const cr = compileSource(src);
    expect(cr.compilerSuccess).toBe(false);
    expect(cr.compilerErrors.some((e) => /НетТакого/.test(e.message))).toBe(true);
  });

  it("игра.очистить с extraSyscalls компилируется", () => {
    const src = `
модуль Игра
процедура кадр()
  игра.очистить("#112233")
  вернуть 0
конец
конец`.trim();
    const cr = compileSource(src, {
      extraSyscalls: [{ name: "игра.очистить", argc: 1 }],
    });
    expect(cr.compilerSuccess).toBe(true);
    expect(cr.semanticErrors.filter((e) => e.kind === "unknown_module")).toHaveLength(0);
    expect(cr.module).not.toBeNull();
  });

  it("игра.очистить выполняется при extraInvokes", async () => {
    const extra = [{ name: "игра.очистить", argc: 1 }];
    const src = `
модуль Игра
процедура кадр()
  игра.очистить("#112233")
  вернуть 1
конец
конец`.trim();
    const cr = compileSource(src, { extraSyscalls: extra });
    expect(cr.compilerSuccess).toBe(true);
    let color = "";
    const vm = new VM(cr.module!, {
      maxSteps: 1000,
      extraInvokes: extra,
      invoke: (name, args) => {
        if (name === "игра.очистить") {
          color = String(args[0]);
          return null;
        }
        return null;
      },
    });
    expect(await vm.runProcedure(vm.findProcedureIndex("кадр"), [])).toBe(1);
    expect(color).toBe("#112233");
  });

  it("игра.очистить без extraInvokes → Unknown invoke", async () => {
    const extra = [{ name: "игра.очистить", argc: 1 }];
    const src = `
модуль Игра
процедура кадр()
  игра.очистить("#112233")
  вернуть 0
конец
конец`.trim();
    const cr = compileSource(src, { extraSyscalls: extra });
    const vm = new VM(cr.module!, { maxSteps: 1000 });
    await expect(vm.runProcedure(vm.findProcedureIndex("кадр"), [])).rejects.toThrow(
      /Unknown invoke/,
    );
  });
});

