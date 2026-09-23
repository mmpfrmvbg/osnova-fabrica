import { describe, it, expect } from "vitest";
import { compileSource } from ".";
import { tokenize } from "./lexer";
import { VM } from "../runtime/vm/interpreter";
import { LANGUAGE_REGISTRY } from "./language-registry";

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

  it("иначе с вложенным если не съедает конец модуля", async () => {
    const src = wrap(`  если ложь
    вернуть 0
  иначе
    если истина
      вернуть 2
    конец
  конец
  вернуть 1`);
    expect(await run(src)).toBe(2);
  });

  it("процедура без вернуть: вызов как инструкция не роняет стек", async () => {
    const src = `
модуль т
процедура рисуй()
  пусть x = 1
конец
процедура главная()
  рисуй()
  рисуй()
  вернуть 4
конец
конец`.trim();
    expect(await run(src)).toBe(4);
  });

  it("вызов процедуры как инструкция не оставляет мусор на стеке", async () => {
    const src = `
модуль т
процедура побочный()
  вернуть 0
конец
процедура главная()
  побочный()
  побочный()
  пусть o = { a: 7 }
  вернуть o.a
конец
конец`.trim();
    expect(await run(src)).toBe(7);
  });

  it("вызов syscall как инструкция не оставляет мусор на стеке", async () => {
    const src = `
модуль т
процедура главная()
  пусть a = [1, 2]
  система.массив.длина(a)
  система.массив.добавить(a, 3)
  пусть o = { x: 8 }
  вернуть o.x
конец
конец`.trim();
    expect(await run(src)).toBe(8);
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

describe("LLM ergonomics: `=` вместо `==` в позиции условия (пункт 1.1 требований)", () => {
  // 52 случая в трейсах: модель тянет `=` из Pascal/SQL. Принимаем `=` как `==`
  // ТОЛЬКО в позиции условия (после `если`, `иначе_если`, `пока`), чтобы
  // присваивание и литералы объектов не изменились.
  it("если x = 5 читается как x == 5", async () => {
    const src = wrap("  пусть x = 5\n  если x = 5\n    вернуть 1\n  конец\n  вернуть 0");
    expect(await run(src)).toBe(1);
  });

  it("ложное условие с = не срабатывает (это сравнение, а не присваивание)", async () => {
    const src = wrap("  пусть x = 5\n  если x = 6\n    вернуть 1\n  конец\n  вернуть 0");
    expect(await run(src)).toBe(0);
  });

  it("пока x = 5 читается как x == 5", async () => {
    const src = wrap("  пусть x = 5\n  пока x = 5\n    прервать\n  конец\n  вернуть 1");
    expect(await run(src)).toBe(1);
  });

  it("иначе_если x = 2 читается как x == 2", async () => {
    const src = wrap(`  пусть x = 2
  если x == 1
    вернуть 1
  иначе_если x = 2
    вернуть 2
  конец
  вернуть 0`);
    expect(await run(src)).toBe(2);
  });

  it("два = в одном условии через и", async () => {
    const src = wrap("  пусть x = 5\n  пусть y = 6\n  если x = 5 и y = 6\n    вернуть 1\n  конец\n  вернуть 0");
    expect(await run(src)).toBe(1);
  });

  it("= в аргументе вызова ВНУТРИ условия читается как ==", async () => {
    // Решение зафиксировано тестом: режим условия действует на всё поддерево
    // условия, включая вложенные вызовы. `=` внутри выражения сегодня и так
    // невалиден, поэтому приём только превращает отказ в сравнение.
    const src = `
модуль т
процедура проверь(б)
  если б
    вернуть 1
  конец
  вернуть 0
конец
процедура главная()
  пусть x = 5
  если проверь(x = 5)
    вернуть 1
  конец
  вернуть 0
конец
конец`.trim();
    expect(await run(src)).toBe(1);
  });

  it("граница: = в аргументе вызова ВНЕ условия — по-прежнему ошибка", () => {
    // Вне условия `=` остаётся оператором инструкции, а не выражения.
    const cr = compileSource(wrap("  пусть x = 5\n  система.лог.вывести(x = 5)\n  вернуть 0"));
    expect(cr.compilerSuccess).toBe(false);
    expect(cr.parserErrors.length).toBeGreaterThan(0);
  });

  it("присваивание и литерал объекта не сломаны", async () => {
    expect(await run(wrap("  пусть x = 5\n  x = 7\n  вернуть x"))).toBe(7);
    expect(await run(wrap("  пусть o = { x: 5 }\n  вернуть o.x"))).toBe(5);
  });
});

describe("LLM ergonomics: `:=` как алиас `=` (пункт 1.3 требований)", () => {
  // 20 случаев в трейсах: модель тянет `:=` из Паскаля. Двоеточие в языке есть
  // только в аннотации типа и в литералах объектов, где за ним идёт имя типа, а
  // не `=`, поэтому разбор однозначен.
  it("пусть x := 5 работает как пусть x = 5", async () => {
    expect(await run(wrap("  пусть x := 5\n  вернуть x"))).toBe(5);
  });

  it("присваивание x := 7 работает", async () => {
    expect(await run(wrap("  пусть x = 5\n  x := 7\n  вернуть x"))).toBe(7);
  });

  it("в условии := идёт тем же путём, что = (читается как ==)", async () => {
    expect(await run(wrap("  пусть x = 5\n  если x := 5\n    вернуть 1\n  конец\n  вернуть 0"))).toBe(1);
  });

  it("контроль: аннотация типа пусть x: Число = 5 не сломана", async () => {
    const src = "модуль т\nпроцедура главная()\n  пусть x: Число = 5\n  вернуть x\nконец\nконец";
    expect(await run(src)).toBe(5);
  });

  it("контроль: литерал объекта { x: 5 } не сломан", async () => {
    expect(await run(wrap("  пусть o = { x: 5 }\n  вернуть o.x"))).toBe(5);
  });
});

describe("LLM ergonomics: `поймать` — канон, `иначе_попытка` — алиас", () => {
  const tryCatch = (catchWord: string): string => `модуль т
процедура главная()
  попробовать
    выбросить "ошибка"
  ${catchWord} е
    вернуть 1
  конец
  вернуть 0
конец
конец`;

  it("канон поймать перехватывает выброшенное", async () => {
    expect(await run(tryCatch("поймать"))).toBe(1);
  });

  it("алиас иначе_попытка работает так же", async () => {
    expect(await run(tryCatch("иначе_попытка"))).toBe(1);
  });

  it("оба написания дают один вид токена — канонический `поймать`", () => {
    const kindsOf = (word: string): string[] =>
      tokenize(word).tokens.filter((t) => t.kind !== "конец_файла").map((t) => t.kind);
    expect(kindsOf("поймать")).toEqual(["поймать"]);
    expect(kindsOf("иначе_попытка"), "старое написание — алиас к тому же виду").toEqual(["поймать"]);
  });

  it("канон зафиксирован реестром: поймать implemented, иначе_попытка — алиас", () => {
    const canon = LANGUAGE_REGISTRY.keywords.find((k) => k.lexeme === "поймать");
    const alias = LANGUAGE_REGISTRY.keywords.find((k) => k.lexeme === "иначе_попытка");
    expect(canon?.implemented, "поймать — канон (implemented)").toBe(true);
    expect(alias?.implemented, "иначе_попытка — алиас, не канон").toBe(false);
  });

  it("английский catch — тот же вид токена", () => {
    const kinds = tokenize("catch е").tokens.filter((t) => t.kind !== "конец_файла").map((t) => t.kind);
    expect(kinds).toEqual(["поймать"]);
  });
});
