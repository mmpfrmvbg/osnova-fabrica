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
import { compileProgram } from "./codegen";
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
  });
});

describe("Compiler: для_каждого", () => {
  const arrayInvoke = (name: string, args: unknown[]): unknown => {
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
