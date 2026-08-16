import { describe, it, expect } from "vitest";
import { compileSource } from ".";
import { tokenize } from "./lexer";
import { VM } from "../runtime/vm/interpreter";

function wrap(body: string): string {
  return `модуль т\nпроцедура главная()\n${body}\nконец\nконец`;
}

async function run(src: string): Promise<unknown> {
  const cr = compileSource(src);
  expect(cr.parserErrors, cr.parserErrors.map((e) => e.message).join("; ")).toEqual([]);
  expect(cr.compilerSuccess).toBe(true);
  expect(cr.module).not.toBeNull();
  const vm = new VM(cr.module!, { maxSteps: 5000 });
  return vm.runProcedure(vm.findProcedureIndex("главная"), []);
}

describe("LLM ergonomics: нейросеть пишет Основу без ловушек", () => {
  it("многострочный объект и поле-ключевое слово конец", async () => {
    const src = `
модуль т
тип Мир { счет: Число, конец: Логический }
процедура главная()
  пусть мир: Мир = {
    счет: 1,
    конец: ложь
  }
  вернуть мир.счет
конец
конец`.trim();
    expect(await run(src)).toBe(1);
  });

  it("цепочечное сравнение a < x < b", async () => {
    const src = wrap("  пусть x = 2\n  если 1 < x < 3\n    вернуть 1\n  конец\n  вернуть 0");
    expect(await run(src)).toBe(1);
  });

  it("строка + число склеивается", async () => {
    const src = wrap('  вернуть "счет " + 7');
    expect(await run(src)).toBe("счет 7");
  });

  it("вернуть(x) со скобками", async () => {
    const src = wrap("  вернуть(41 + 1)");
    expect(await run(src)).toBe(42);
  });

  it("let / if / true / && / /* */", async () => {
    const src = `
module t
function главная()
  /* блок */
  let x = 1
  if x == 1 && true
    return 9
  end
  return 0
end
end`.trim();
    expect(await run(src)).toBe(9);
  });

  it("иначе если через пробел", async () => {
    const src = wrap(`  пусть x = 2
  если x == 1
    вернуть 1
  иначе если x == 2
    вернуть 2
  иначе
    вернуть 3
  конец`);
    expect(await run(src)).toBe(2);
  });

  it("=== и !== как == и !=", async () => {
    const src = wrap("  если 1 === 1 && 2 !== 3\n    вернуть 1\n  конец\n  вернуть 0");
    expect(await run(src)).toBe(1);
  });

  it("блок-комментарий выкидывается", () => {
    const { errors, tokens } = tokenize("модуль т /* hi */ процедура главная()\n  вернуть 1\nконец\nконец");
    expect(errors).toEqual([]);
    expect(tokens.some((t) => t.kind === "процедура")).toBe(true);
  });

  it("else if на английском", async () => {
    const src = `
module t
function главная()
  let x = 2
  if x == 1
    return 1
  else if x == 2
    return 2
  else
    return 3
  end
end
end`.trim();
    expect(await run(src)).toBe(2);
  });
});
