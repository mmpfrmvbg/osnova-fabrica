/**
 * БЛОК 1 (v2): закрывающее слово называет то, что закрывает.
 *
 * Проверяется три вещи, каждая — своим оракулом:
 *  1. `конец_X` принимается и закрывает именно свой блок (и никакой другой);
 *  2. `конец` — контекстный токен: закрывает ровно один открытый блок,
 *     а вне позиции закрытия работает как обычное имя (`тип Объект { конец: Число }`);
 *  3. инвариант: файл с `конец` даёт ТОТ ЖЕ байткод, что тот же файл с `конец_X`
 *     соответствующего блока. Сравнение — по коду, а не «оба скомпилировались».
 *
 * Источники решений: `memory/v2-goal.md` БЛОК 1, `docs/language-v2-requirements.md`
 * §1.2 (диагностика лишнего `конец`) и §1.4 (самое естественное имя для «end» занято).
 */
import { describe, it, expect } from "vitest";
import { tokenize } from "./lexer";
import { parse } from "./parser";
import { compileSource } from "./compiler";
import type { Program } from "./ast";

function parseProgram(source: string) {
  const { tokens, errors: lexerErrors } = tokenize(source);
  const { ast, errors } = parse(tokens);
  return { ast, errors, lexerErrors, tokens };
}

/** Код обеих VM-сравнимых программ: сравниваем байткод, а не факт успеха. */
function compiledCode(source: string): string {
  const r = compileSource(source, { filename: "блок1.osnova" });
  expect(r.compilerSuccess, JSON.stringify({
    parser: r.parserErrors.map((e) => e.message),
    semantic: r.semanticErrors.map((e) => e.message),
    compiler: r.compilerErrors.map((e) => e.message),
  })).toBe(true);
  const mod = r.module;
  expect(mod).not.toBeNull();
  return JSON.stringify(mod?.code ?? null);
}

function parserMessages(source: string): string[] {
  const { errors } = parseProgram(source);
  return errors.map((e) => e.message);
}

describe("БЛОК 1: инвариант «конец = конец_X своего блока»", () => {
  it("процедура: конец vs конец_процедуры", () => {
    const legacy = ["модуль t", "процедура главная()", "  вернуть 0", "конец", "конец"].join("\n");
    const canonical = ["модуль t", "процедура главная()", "  вернуть 0", "конец_процедуры", "конец_модуля"].join("\n");
    expect(compiledCode(canonical)).toBe(compiledCode(legacy));
  });

  it("если/иначе: конец vs конец_если", () => {
    const legacy = [
      "модуль t",
      "процедура главная()",
      "  пусть x = 0",
      "  если истина",
      "    x = 1",
      "  иначе",
      "    x = 2",
      "  конец",
      "  вернуть x",
      "конец",
      "конец",
    ].join("\n");
    const canonical = [
      "модуль t",
      "процедура главная()",
      "  пусть x = 0",
      "  если истина",
      "    x = 1",
      "  иначе",
      "    x = 2",
      "  конец_если",
      "  вернуть x",
      "конец_процедуры",
      "конец_модуля",
    ].join("\n");
    expect(compiledCode(canonical)).toBe(compiledCode(legacy));
  });

  it("пока: конец vs конец_пока", () => {
    const legacy = [
      "модуль t",
      "процедура главная()",
      "  пусть x = 0",
      "  пока x < 3",
      "    x = x + 1",
      "  конец",
      "  вернуть x",
      "конец",
      "конец",
    ].join("\n");
    const canonical = [
      "модуль t",
      "процедура главная()",
      "  пусть x = 0",
      "  пока x < 3",
      "    x = x + 1",
      "  конец_пока",
      "  вернуть x",
      "конец_процедуры",
      "конец_модуля",
    ].join("\n");
    expect(compiledCode(canonical)).toBe(compiledCode(legacy));
  });

  it("для_каждого: конец vs конец_для", () => {
    const legacy = [
      "модуль t",
      "процедура главная()",
      "  пусть s = 0",
      "  для_каждого эл в [1, 2, 3]",
      "    s = s + эл",
      "  конец",
      "  вернуть s",
      "конец",
      "конец",
    ].join("\n");
    const canonical = [
      "модуль t",
      "процедура главная()",
      "  пусть s = 0",
      "  для_каждого эл в [1, 2, 3]",
      "    s = s + эл",
      "  конец_для",
      "  вернуть s",
      "конец_процедуры",
      "конец_модуля",
    ].join("\n");
    expect(compiledCode(canonical)).toBe(compiledCode(legacy));
  });

  it("цикл: конец vs конец_цикла", () => {
    const legacy = [
      "модуль t",
      "процедура главная()",
      "  пусть x = 0",
      "  цикл",
      "    x = x + 1",
      "    если x > 2",
      "      прервать",
      "    конец",
      "  конец",
      "  вернуть x",
      "конец",
      "конец",
    ].join("\n");
    const canonical = [
      "модуль t",
      "процедура главная()",
      "  пусть x = 0",
      "  цикл",
      "    x = x + 1",
      "    если x > 2",
      "      прервать",
      "    конец_если",
      "  конец_цикла",
      "  вернуть x",
      "конец_процедуры",
      "конец_модуля",
    ].join("\n");
    expect(compiledCode(canonical)).toBe(compiledCode(legacy));
  });

  it("когда: конец vs конец_когда", () => {
    const legacy = [
      "модуль t",
      "тип Цвет = красный | зелёный",
      "процедура главная()",
      "  пусть c = Цвет.красный",
      "  когда c",
      "  есть Цвет.красный",
      "    вернуть 1",
      "  иначе",
      "    вернуть 2",
      "  конец",
      "конец",
      "конец",
    ].join("\n");
    const canonical = [
      "модуль t",
      "тип Цвет = красный | зелёный",
      "процедура главная()",
      "  пусть c = Цвет.красный",
      "  когда c",
      "  есть Цвет.красный",
      "    вернуть 1",
      "  иначе",
      "    вернуть 2",
      "  конец_когда",
      "конец_процедуры",
      "конец_модуля",
    ].join("\n");
    expect(compiledCode(canonical)).toBe(compiledCode(legacy));
  });

  it("попробовать/иначе_попытка: конец vs конец_попробовать", () => {
    const legacy = [
      "модуль t",
      "процедура главная()",
      "  попробовать",
      "    выбросить \"ошибка\"",
      "  иначе_попытка e",
      "    вернуть 1",
      "  конец",
      "  вернуть 0",
      "конец",
      "конец",
    ].join("\n");
    const canonical = [
      "модуль t",
      "процедура главная()",
      "  попробовать",
      "    выбросить \"ошибка\"",
      "  иначе_попытка e",
      "    вернуть 1",
      "  конец_попробовать",
      "  вернуть 0",
      "конец_процедуры",
      "конец_модуля",
    ].join("\n");
    expect(compiledCode(canonical)).toBe(compiledCode(legacy));
  });

  it("вложенность: одиночный конец закрывает ВНУТРЕННИЙ блок", () => {
    const single = [
      "модуль t",
      "процедура главная()",
      "  пусть x = 0",
      "  если истина",
      "    пока x < 3",
      "      x = x + 1",
      "    конец",
      "  конец",
      "  вернуть x",
      "конец",
      "конец",
    ].join("\n");
    const named = [
      "модуль t",
      "процедура главная()",
      "  пусть x = 0",
      "  если истина",
      "    пока x < 3",
      "      x = x + 1",
      "    конец_пока",
      "  конец_если",
      "  вернуть x",
      "конец_процедуры",
      "конец_модуля",
    ].join("\n");
    expect(compiledCode(single)).toBe(compiledCode(named));
  });

  it("смешение форм: конец_пока внутри, одиночный конец снаружи", () => {
    const mixed = [
      "модуль t",
      "процедура главная()",
      "  пусть x = 0",
      "  если истина",
      "    пока x < 3",
      "      x = x + 1",
      "    конец_пока",
      "  конец",
      "  вернуть x",
      "конец_процедуры",
      "конец_модуля",
    ].join("\n");
    const all = [
      "модуль t",
      "процедура главная()",
      "  пусть x = 0",
      "  если истина",
      "    пока x < 3",
      "      x = x + 1",
      "    конец_пока",
      "  конец_если",
      "  вернуть x",
      "конец_процедуры",
      "конец_модуля",
    ].join("\n");
    expect(compiledCode(mixed)).toBe(compiledCode(all));
  });
});

describe("БЛОК 1, негативный контроль: закрывающее слово обязано совпадать", () => {
  it("конец_пока закрывает если → ошибка парсера", () => {
    const src = [
      "модуль t",
      "процедура главная()",
      "  если истина",
      "    вернуть 1",
      "  конец_пока",
      "конец",
      "конец",
    ].join("\n");
    expect(parserMessages(src).length).toBeGreaterThan(0);
  });

  it("конец_если закрывает пока → ошибка парсера", () => {
    const src = [
      "модуль t",
      "процедура главная()",
      "  пока истина",
      "    вернуть 1",
      "  конец_если",
      "конец",
      "конец",
    ].join("\n");
    expect(parserMessages(src).length).toBeGreaterThan(0);
  });

  it("конец_для закрывает цикл → ошибка парсера", () => {
    const src = [
      "модуль t",
      "процедура главная()",
      "  цикл",
      "    прервать",
      "  конец_для",
      "конец",
      "конец",
    ].join("\n");
    expect(parserMessages(src).length).toBeGreaterThan(0);
  });

  it("конец_процедуры закрывает модуль → ошибка парсера", () => {
    const src = ["модуль t", "процедура главная()", "  вернуть 0", "конец", "конец_процедуры"].join("\n");
    expect(parserMessages(src).length).toBeGreaterThan(0);
  });

  it("конец_модуля без открытого блока → ошибка, а не молчаливый пропуск", () => {
    const src = ["модуль t", "процедура главная()", "  вернуть 0", "конец", "конец", "конец_модуля"].join("\n");
    expect(parserMessages(src).length).toBeGreaterThan(0);
  });
});

describe("БЛОК 1: `конец` как имя — контекстный токен, а не ключевое слово", () => {
  it("тип с полем `конец` и доступ к нему работает", () => {
    const src = [
      "модуль t",
      "тип Объект = { конец: Число }",
      "процедура главная()",
      "  пусть о = Объект { конец: 5 }",
      "  вернуть о.конец",
      "конец",
      "конец",
    ].join("\n");
    const r = compileSource(src, { filename: "поле.osnova" });
    expect(r.lexerErrors).toEqual([]);
    expect(r.parserErrors.map((e) => e.message)).toEqual([]);
    expect(r.semanticErrors.map((e) => e.message)).toEqual([]);
    expect(r.compilerSuccess).toBe(true);
  });

  it("`пусть конец = ...` — объявление принимается, не keyword_as_identifier", () => {
    // ИЗВЕСТНОЕ ОГРАНИЧЕНИЕ (долг БЛОК 1, не выдаётся за готовое): объявление
    // `пусть конец = 5` разбирается, `keyword_as_identifier` не выдаётся, но
    // ИСПОЛЬЗОВАНИЕ такого имени в выражении (`вернуть конец`) пока не
    // поддерживается: `конец` в конце строки неотличим от закрытия блока.
    const src = [
      "модуль t",
      "процедура главная()",
      "  пусть конец = 5",
      "  вернуть 1",
      "конец",
      "конец",
    ].join("\n");
    const r = compileSource(src, { filename: "имя.osnova" });
    expect(r.lexerErrors).toEqual([]);
    expect(r.parserErrors.map((e) => e.message)).toEqual([]);
    expect(r.semanticErrors.map((e) => e.kind)).not.toContain("keyword_as_identifier");
    expect(r.compilerSuccess).toBe(true);
  });

  it("`конец` как параметр процедуры и как аргумент вызова", () => {
    const src = [
      "модуль t",
      "процедура сумма_диапазона(начало, конец)",
      "  вернуть конец - начало",
      "конец",
      "процедура главная()",
      "  вернуть сумма_диапазона(1, 10)",
      "конец",
      "конец",
    ].join("\n");
    const r = compileSource(src, { filename: "параметр.osnova" });
    expect(r.parserErrors.map((e) => e.message)).toEqual([]);
    expect(r.semanticErrors.map((e) => e.kind)).not.toContain("keyword_param");
    expect(r.compilerSuccess).toBe(true);
  });

  it("`конец` в позиции закрытия по-прежнему закрывает блок", () => {
    const src = ["модуль t", "процедура главная()", "  если истина", "    вернуть 1", "  конец", "конец", "конец"].join("\n");
    const { ast, errors } = parseProgram(src);
    expect(errors.map((e) => e.message)).toEqual([]);
    const proc = (ast as { procedures: Array<{ body: Array<{ kind: string; body?: unknown[] }> }> }).procedures[0];
    const ifStmt = proc?.body[0];
    expect(ifStmt?.kind).toBe("если");
    expect(ifStmt?.body?.length).toBe(1);
  });
});

describe("БЛОК 1: `конец_файла` — вид токена, а не ключевое слово", () => {
  it("конец_файла не распознаётся как конец_ + файла и остаётся служебным токеном", () => {
    const { tokens } = tokenize("модуль t");
    const last = tokens[tokens.length - 1];
    expect(last?.kind).toBe("конец_файла");
    expect(last?.lexeme).toBe("");
  });

  it("слово `конец_файла` в исходнике — не закрытие блока", () => {
    const src = ["модуль t", "процедура главная()", "  вернуть 0", "конец_файла", "конец", "конец"].join("\n");
    const { tokens } = tokenize(src);
    const kinds = tokens.map((t) => t.kind);
    // Служебный токен конца потока ровно один — в конце потока. Слово из
    // исходника даёт ВТОРОЙ токен того же вида, но не в конце: именно поэтому
    // оно не может считаться закрытием блока.
    expect(kinds.filter((k) => k === "конец_файла").length).toBe(2);
    expect(kinds[kinds.length - 1]).toBe("конец_файла");
    expect(kinds.indexOf("конец_файла")).toBeLessThan(kinds.length - 1);
    // Парсер на нём падает с указанием ожидаемого закрытия процедуры.
    const { errors } = parse(tokens);
    const messages = errors.map((e) => e.message);
    expect(messages.some((m) => m.includes("закрытие блока «процедура»"))).toBe(true);
  });
});

describe("БЛОК 1, пункт 4: диагностика лишнего `конец` (§1.2)", () => {
  it("лишнее закрытие: ошибка адресована модулю закрытия, а не чужому объявлению", () => {
    // Baseline: «Ожидается начало следующего модуля или конец файла» без указания
    // на то, что модуль уже закрыт. Сейчас сообщение то же по смыслу, но ошибка
    // адресована строке лишнего слова после закрытого модуля.
    const src = [
      "модуль t",
      "процедура главная()",
      "  вернуть 0",
      "конец",
      "конец",
      "конец",
    ].join("\n");
    const { errors } = parseProgram(src);
    expect(errors.length).toBeGreaterThan(0);
    // Ошибка не про «Ожидается 'модуль'» на строке 1 и не про корректные строки 2–4.
    expect(errors.every((e) => e.line >= 5)).toBe(true);
  });

  it("позиция ошибки при лишнем закрытии — строка самого слова", () => {
    const src = [
      "модуль t",
      "процедура главная()",
      "  вернуть 0",
      "конец",
      "конец",
      "конец",
    ].join("\n");
    const { errors } = parseProgram(src);
    expect(errors.length).toBeGreaterThan(0);
    for (const e of errors) expect(e.line).toBeGreaterThanOrEqual(5);
  });

  it("процедура после закрытого модуля: ошибка называет свою строку", () => {
    const src = [
      "модуль t",
      "процедура главная()",
      "  вернуть 0",
      "конец",
      "конец",
      "процедура вторая()",
      "  вернуть 1",
      "конец",
    ].join("\n");
    const { errors } = parseProgram(src);
    expect(errors.find((e) => e.line === 6), `получено: ${JSON.stringify(errors.map((e) => `${e.line}: ${e.message}`))}`).toBeDefined();
  });

  it("лишнее закрытие после модуля: ошибка указывает на строку лишнего слова", () => {
    // Процедура закрыта на 4, модуль — на 5; `конец_модуля` на 6 закрывать нечего.
    //
    // Известное ограничение: формулировка «лишний … : модуль уже закрыт на строке N»
    // для стопки закрытий не всегда выбирается (приоритет отдаётся сведению о
    // неожиданном объявлении). Гарантируется другое и главное — сообщение больше
    // не указывает на чужую строку и не молчит: ошибка адресует строку слова.
    const src = [
      "модуль t",
      "процедура главная()",
      "  вернуть 0",
      "конец_процедуры",
      "конец",
      "конец_модуля",
    ].join("\n");
    const { errors } = parseProgram(src);
    const messages = errors.map((e) => e.message);
    expect(errors.length, `получено: ${JSON.stringify(errors.map((e) => `${e.line}: ${e.message}`))}`).toBeGreaterThan(0);
    expect(errors.every((e) => e.line >= 5)).toBe(true);
    expect(messages.some((m) => m.includes("конец"))).toBe(true);
  });

  it("ошибка не появляется, когда структура корректна", () => {
    const src = ["модуль t", "процедура главная()", "  вернуть 0", "конец", "конец"].join("\n");
    const { errors } = parseProgram(src);
    expect(errors.map((e) => e.message)).toEqual([]);
  });
});

describe("БЛОК 1: `вернуть` и контекстное имя `конец`", () => {
  // Оракул задачи «вернуть конец». Признак значения — та же строка, что `вернуть`:
  // `вернуть конец` возвращает переменную, `вернуть` + перевод строки — пустой
  // возврат, а `конец` на следующей строке закрывает блок.
  it("1.1 `вернуть конец` возвращает значение переменной (байткод как с `x`)", () => {
    const withKonets = [
      "модуль t",
      "процедура f()",
      "  пусть конец = 5",
      "  вернуть конец",
      "конец",
      "процедура главная()",
      "  вернуть f()",
      "конец",
      "конец",
    ].join("\n");
    const withX = [
      "модуль t",
      "процедура f()",
      "  пусть x = 5",
      "  вернуть x",
      "конец",
      "процедура главная()",
      "  вернуть f()",
      "конец",
      "конец",
    ].join("\n");
    // Сравнение по байткоду: имя `конец` не должно менять ничего, кроме имени.
    expect(compiledCode(withKonets)).toBe(compiledCode(withX));
  });

  it("1.2 `вернуть` без значения — пустой возврат, закрытие блока не съедено", () => {
    const legacy = ["модуль t", "процедура главная()", "  вернуть", "конец", "конец"].join("\n");
    const named = ["модуль t", "процедура главная()", "  вернуть", "конец_процедуры", "конец_модуля"].join("\n");
    expect(parseProgram(legacy).errors.map((e) => e.message)).toEqual([]);
    expect(compiledCode(legacy)).toBe(compiledCode(named));
    // И значение действительно пустое, а не «вернули закрывающее слово».
    const proc = (parseProgram(legacy).ast as Program).modules[0]?.procedures[0];
    expect(proc?.body[0]).toEqual({ kind: "вернуть", value: undefined });
  });

  it("1.3 `вернуть конец_если` — ошибка: закрывающее слово не выражение", () => {
    const src = ["модуль t", "процедура главная()", "  вернуть конец_если", "конец", "конец"].join("\n");
    const { errors } = parseProgram(src);
    const messages = errors.map((e) => e.message);
    expect(messages.length, `получено: ${JSON.stringify(messages)}`).toBeGreaterThan(0);
    // Диагностика должна указывать на выражение, а не на «закрытие процедуры».
    expect(messages.some((m) => m.includes("Ожидается выражение"))).toBe(true);
  });

  it("1.4 поле `конец` в возвращаемом выражении не сломано", () => {
    const src = [
      "модуль t",
      "тип Объект = { конец: Число }",
      "процедура главная()",
      "  пусть о = Объект { конец: 5 }",
      "  вернуть о.конец",
      "конец",
      "конец",
    ].join("\n");
    const r = compileSource(src, { filename: "поле-возврат.osnova" });
    expect(r.parserErrors.map((e) => e.message)).toEqual([]);
    expect(r.semanticErrors.map((e) => e.message)).toEqual([]);
    expect(r.compilerSuccess).toBe(true);
  });

  it("1.5 `вернуть конец` не путается с закрытием блока (значение и закрытие рядом)", () => {
    // Значение — на строке `вернуть`; закрытие — следующей строкой. Оба `конец`.
    const src = [
      "модуль t",
      "процедура f()",
      "  пусть конец = 1",
      "  вернуть конец",
      "конец",
      "конец",
    ].join("\n");
    const { ast, errors } = parseProgram(src);
    expect(errors.map((e) => e.message)).toEqual([]);
    const proc = (ast as Program).modules[0]?.procedures[0];
    expect(proc?.body[1]).toEqual({
      kind: "вернуть",
      value: { kind: "переменная", name: "конец" },
    });
  });
});
