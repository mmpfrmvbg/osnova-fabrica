/**
 * БЛОК 2: целочисленное деление (`div`).
 *
 * # Почему оператор НЕ называется `//`
 *
 * `//` в языке — комментарий до конца строки (`src/compiler/lexer.ts`). Поэтому
 * `10 // 3` сегодня **не ошибка**: хвост строки отбрасывается как комментарий, и
 * программа молча считает `10`. Замер по живому журналу `runs/traces.jsonl`
 * (3675 исходников, `.tmp/measure-division-spelling.ts`): `//` после кода — 4
 * случая, и **все четыре — пояснения** («// Проверяем, начинается ли путь с "/"»),
 * ни одного арифметического `//`; слов `div`, `дел`, `цел_деление` — ноль;
 * «обратный слэш как оператор» — 1 ложное срабатывание (это `\t` внутри строки).
 *
 * Решение: `//` остаётся комментарием, оператор называется **`div`** (короткое
 * ASCII-написание, как `for`/`catch`/`end` в реестре алиасов), а русское
 * `цел_деление` принимается алиасом — механизмом `LLM_KEYWORD_ALIASES`, который
 * для того и заведён («почти канонические написания, которые модель пишет»).
 *
 * # Округление: К НУЛЮ (отсечение), а не floor
 *
 * Решено тестом и записано решением:
 *  1. согласуется с `%`: остаток у нас по знаку делимого (как в JS), поэтому
 *     тождество `a div b * b + a rem b == a` выполняется;
 *  2. совпадает с формой e2k `SDIVs` (руководство МЦСТ §10.3.3 — отсечение к
 *     нулю), поэтому понижение в неё не требует менять семантику;
 *  3. floor дал бы в языке **третье** правило округления, которого не требует ни
 *     одна из двух уже имеющихся операций.
 *
 * Отсюда: `-7 div 3 = -2` (не `-3`).
 */
import { describe, it, expect } from "vitest";
import { compileSource, tokenize, VM } from ".";
import { LANGUAGE_REGISTRY, LLM_KEYWORD_ALIASES } from "./language-registry";
import { REFUSALS, loweringOf } from "../e2k/e2kRealRun";
import { CARRIER_OF_OP } from "../e2k/emitterShell";

/** Скомпилировать и исполнить процедуру `р()` из источника. */
async function run(source: string): Promise<unknown> {
  const r = compileSource(source);
  expect(r.lexerErrors, "лексер чист").toEqual([]);
  expect(r.parserErrors, "парсер чист").toEqual([]);
  expect(r.compilerSuccess, "модуль собран").toBe(true);
  const vm = new VM(r.module!);
  return vm.runProcedure(vm.findProcedureIndex("р"), []);
}

const proc = (body: string): string => `модуль т\nпроцедура р()\n${body}\nконец\nконец`;

describe("БЛОК 2: `div` — целочисленное деление", () => {
  it("10 div 3 = 3, а обычное деление осталось вещественным: 10 / 3 = 3.333…", async () => {
    expect(await run(proc("  вернуть 10 div 3"))).toBe(3);
    const real = await run(proc("  вернуть 10 / 3"));
    expect(typeof real).toBe("number");
    expect(real as number).toBeCloseTo(10 / 3, 12);
  });

  it("округление К НУЛЮ: -7 div 3 = -2 (не floor -3)", async () => {
    expect(await run(proc("  вернуть 0 - 7 div 3"))).toBe(-2);
    expect(await run(proc("  вернуть (0 - 7) div 3"))).toBe(-2);
    expect(await run(proc("  вернуть 7 div (0 - 3)"))).toBe(-2);
    // floor дал бы -3 и -3 — решение записано здесь, а не в комментарии
    expect(await run(proc("  вернуть (0 - 7) div 3"))).not.toBe(-3);
  });

  it("согласовано с `%`: a div b * b + a rem b == a", async () => {
    for (const [a, b] of [
      [10, 3],
      [-7, 3],
      [7, -3],
      [-8, 2],
    ] as const) {
      const got = await run(
        proc(`  вернуть (${a} div ${b}) * ${b} + (${a} % ${b})`),
      );
      expect(got, `${a} div ${b} с остатком`).toBe(a);
    }
  });

  it("работает в выражении, в присваивании и в условии", async () => {
    // приоритет как у `*` и `/`: 2 + 10 div 3 = 5
    expect(await run(proc("  вернуть 2 + 10 div 3"))).toBe(5);
    // левоассоциативность: 20 div 3 div 2 = (20 div 3) div 2 = 6 div 2 = 3
    expect(await run(proc("  вернуть 20 div 3 div 2"))).toBe(3);
    // присваивание
    expect(await run(proc("  пусть н = 100 div 7\n  вернуть н"))).toBe(14);
    // условие
    expect(await run(proc("  если 7 div 2 == 3\n    вернуть 1\n  конец\n  вернуть 0"))).toBe(1);
  });

  it("деление на ноль — ошибка, а не 0 и не NaN", async () => {
    await expect(run(proc("  вернуть 10 div 0"))).rejects.toThrow(/div/i);
  });

  it("лексер: `div` — свой вид токена, а `цел_деление` — алиас к нему", () => {
    const canonical = tokenize("div\n");
    expect(canonical.errors).toEqual([]);
    expect(canonical.tokens[0]?.kind).toBe("div");
    const alias = tokenize("цел_деление\n");
    expect(alias.errors).toEqual([]);
    expect(alias.tokens[0]?.kind, "русское написание ведёт к тому же виду").toBe("div");
    expect(LLM_KEYWORD_ALIASES["цел_деление"]).toBe("div");
    expect(
      LANGUAGE_REGISTRY.keywords.some((k) => k.lexeme === "div" && k.implemented),
      "канон описан в реестре языка",
    ).toBe(true);
  });

  it("НЕГАТИВНЫЙ КОНТРОЛЬ: `//` — комментарий, и оператором деления не стал", () => {
    // `10 // 3` лексер по-прежнему считает комментарием: токенов-чисел ровно один,
    // и `div` в них нет. Это и есть причина, по которой оператор назван иначе.
    const { tokens, errors } = tokenize("10 // 3\n");
    expect(errors).toEqual([]);
    expect(tokens.filter((t) => t.kind === "число")).toHaveLength(1);
    expect(tokens.some((t) => t.kind === "div")).toBe(false);
    // И поведение то же: программа возвращает 10, а не 3 — молча, без ошибки.
    return run(proc("  вернуть 10 // 3")).then((value) => {
      expect(value, "хвост съеден комментарием — отсюда запрет на `//`").toBe(10);
    });
  });

  it("НЕГАТИВНЫЙ КОНТРОЛЬ: `div` не тронул `/` и `%`", async () => {
    expect(await run(proc("  вернуть 7 % 3"))).toBe(1);
    expect(await run(proc("  вернуть (0 - 7) % 3"))).toBe(-1);
    expect(await run(proc("  вернуть 9 / 3"))).toBe(3);
    expect(await run(proc("  вернуть 7 / 2"))).toBeCloseTo(3.5, 12);
  });
});

describe("БЛОК 2: понижение `div` в e2k — форма `SDIVs`", () => {
  it("носитель `IR.idiv` понижается в `sdivs` и НЕ числится отказом", () => {
    const rule = loweringOf("IR.idiv");
    expect(rule, "правило понижения есть").toBeDefined();
    expect(rule!.mnemonic).toBe("sdivs");
    expect(rule!.slots).toEqual(["src1", "src2", "dst"]);
    expect(REFUSALS["IR.idiv"], "IR.idiv не отказ").toBeUndefined();
    // `IR.div` остаётся отказом: он ВЕЩЕСТВЕННЫЙ — форма ему по-прежнему не пара.
    expect(REFUSALS["IR.div"]).toBeDefined();
  });

  it("байткод-операция `idiv` ведёт к носителю `IR.idiv`", () => {
    expect(CARRIER_OF_OP["idiv"]).toBe("IR.idiv");
  });
});
