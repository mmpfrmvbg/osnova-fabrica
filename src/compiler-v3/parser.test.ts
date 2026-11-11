/**
 * D51 A1/A1.5 — дешугаринг `поднять` и названный отказ `защита`.
 *
 * Здесь проверяется именно ГРАНИЦА ФРОНТЕНДА, а не поведение спеки: `parseV3`
 * (v3 → AST v2). Спека (`src/spec/specification.test.ts`) исполняет свой
 * интерпретатор и этот путь не покрывает — поэтому до A1 у `поднять`/`защита`
 * в v3 не было ни одного сторожа (аудит D51).
 *
 * N = 4: каждый тест краснеет при откате A1/A1.5, ни один не «зелёный всегда».
 */
import { describe, expect, it } from "vitest";
import type { Procedure } from "../compiler/ast";
import { validateNamedTypesAndRewrite } from "../compiler/compiler";
import { compile } from "../compiler/codegen";
import { compileToReg } from "../compiler/regcodegen";
import { createDefaultInvokeHandler, VM } from "../runtime/vm/interpreter";
import { RegVM } from "../runtime/vm/reginterpreter";
import { parseV3 } from "./index";

const ФАЙЛ = "д51-парсер.osnova";

/** Процедура по имени: тесты читают её тело, а не весь `Program`. */
function процедура(источник: string, имя: string): Procedure {
  const р = parseV3(источник, ФАЙЛ);
  expect(р.errors, `v3 не разобрал: ${р.errors.join("; ")}`).toEqual([]);
  const п = р.program!.modules[0]!.procedures.find((x) => x.name === имя);
  expect(п, `нет процедуры «${имя}»`).toBeDefined();
  return п!;
}

const ПОДНЯТЬ_В_РЕЗУЛЬТАТЕ = `процедура получить(ч: Число) -> Результат<Число, Строка>
  если ч == 0
    поднять "беда"
  конец если
  вернуть Успех(ч * 2)
конец получить
`;

describe("D51 A1: поднять → вернуть Неудача", () => {
  it("в Результат-процедуре даёт вернуть + неудача, не выбросить", () => {
    const п = процедура(ПОДНЯТЬ_В_РЕЗУЛЬТАТЕ, "получить");
    const ветка = п.body[0];
    expect(ветка.kind).toBe("если");
    if (ветка.kind !== "если") throw new Error("ожидалось «если»");
    // Вложенный блок наследует returnType: это и проверяет стек сохранения.
    expect(ветка.body).toEqual([
      { kind: "вернуть", value: { kind: "неудача", значение: { kind: "строка", value: "беда" } } },
    ]);
    expect(JSON.stringify(п.body)).not.toContain('"выбросить"');
  });

  it("вне Результат-процедуры — OSN-PAR-020, а не throw", () => {
    const р = parseV3(
      `процедура главная() -> Число
  поднять "беда"
  вернуть 0
конец главная
`,
      ФАЙЛ,
    );
    expect(р.program).toBeUndefined();
    expect(р.errors).toHaveLength(1);
    expect(р.errors[0]).toContain("OSN-PAR-020");
  });
});

describe("D51 A1.5: защита — названный отказ", () => {
  it("блочная защита даёт OSN-PAR-021 и не строит попробовать", () => {
    const р = parseV3(
      `процедура главная() -> Число
  защита
    вернуть 1
  при ошибке как причина
    вернуть 2
  конец защита
  вернуть 0
конец главная
`,
      ФАЙЛ,
    );
    expect(р.program).toBeUndefined();
    expect(р.errors).toHaveLength(1);
    expect(р.errors[0]).toContain("OSN-PAR-021");
  });
});

describe("D51 A1: поведение Результата на обеих VM", () => {
  it("поднять без защита доносит Неудачу: главная возвращает -1", async () => {
    const р = parseV3(
      `процедура получить(ч: Число) -> Результат<Число, Строка>
  если ч == 0
    поднять "беда"
  конец если
  вернуть Успех(ч * 2)
конец получить

процедура главная() -> Число
  пусть тег, нагрузка = получить(0)
  если тег != 0
    вернуть -1
  конец если
  вернуть нагрузка
конец главная
`,
      ФАЙЛ,
    );
    expect(р.errors, `v3 не разобрал: ${р.errors.join("; ")}`).toEqual([]);
    const м = р.program!.modules[0]!;
    const ошибки = validateNamedTypesAndRewrite(м);
    expect(ошибки, `проход разрешения: ${ошибки.join("; ")}`).toEqual([]);

    const байткод = compile(м);
    const стек = new VM(байткод, { invoke: createDefaultInvokeHandler(), maxSteps: 200_000 });
    expect(await стек.runProcedure(стек.findProcedureIndex("главная"), [])).toBe(-1);

    const reg = compileToReg(м);
    const регистры = new RegVM(reg, { invoke: createDefaultInvokeHandler(), maxSteps: 200_000 });
    expect(await регистры.runProcedure(регистры.findProcedureIndex("главная"), [])).toBe(-1);
  });
});
