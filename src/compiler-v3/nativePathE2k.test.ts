/**
 * ПУТЬ v3 ДО ПЛАТФОРМЫ: фронтенд подставляется в общий конвейер, и вся цепочка
 * (semantic → кодоген → regcodegen → носители → понижение e2k → ELF) идёт одной
 * дорогой, без копий.
 *
 * Здесь же — ДВА дефекта общих слоёв, найденные первой реальной программой, с
 * пробами-сторожами: они воспроизводятся и на v2, то есть это не фронтенд.
 */
import { describe, expect, it } from "vitest";
import { parseV3 } from "./index";
import { compileSource, validateNamedTypesAndRewrite } from "../compiler/compiler";
import { compileToReg } from "../compiler/regcodegen";
import { compile } from "../compiler/codegen";
import { createDefaultInvokeHandler, VM } from "../runtime/vm/interpreter";
import { RegVM } from "../runtime/vm/reginterpreter";
import { loweredProgram } from "../e2k/programImage";
import { shimAvailable } from "../scripts/e2kProgramRun";
import { buildElfFromCode, MINIMAL_BASE } from "../e2k/elfMinimal";
import { buildShim, runInQemu } from "../scripts/e2kQemuExec";
import * as fs from "node:fs";
import * as path from "node:path";

const ФАЙЛ = "путь.osnova";

/** Фронтенд v3, подставленный в общий конвейер (см. `CompileOptions.parse`). */
const опцииV3 = (src: string) => {
  const р = parseV3(src, ФАЙЛ);
  return { filename: ФАЙЛ, parse: () => ({ ast: р.program ?? null, errors: р.errors }) };
};

async function значения(src: string): Promise<{ стек: unknown; регистры: unknown }> {
  const р = parseV3(src, ФАЙЛ);
  expect(р.errors, `разбор: ${р.errors.join("; ")}`).toEqual([]);
  const м = р.program!.modules[0]!;
  expect(validateNamedTypesAndRewrite(м)).toEqual([]);
  const sv = new VM(compile(м), { invoke: createDefaultInvokeHandler(), maxSteps: 2_000_000 });
  const стек = await sv.runProcedure(sv.findProcedureIndex("главная"), []);
  const rv = new RegVM(compileToReg(м), { invoke: createDefaultInvokeHandler(), maxSteps: 2_000_000 });
  const регистры = await rv.runProcedure(rv.findProcedureIndex("главная"), []);
  return { стек, регистры };
}

describe("v3 идёт общим конвейером до понижения e2k", () => {
  it("общий конвейер принимает AST фронтенда v3", () => {
    const src = `действие главная()
  пусть числа = [3, 1, 2]
  вернуть числа[0] + длина числа
конец
`;
    const собран = compileSource(src, опцииV3(src));
    expect(собран.parserErrors).toEqual([]);
    expect(собран.semanticErrors).toEqual([]);
    expect(собран.compilerSuccess).toBe(true);
  });

  it("понижение e2k принимает ту же программу и не отказывает", () => {
    const src = `действие главная()
  пусть числа = [3, 1, 2]
  пусть сумма = 0
  для номер от 1 до длина числа
    сумма = сумма + числа[номер - 1]
  конец для
  вернуть сумма
конец
`;
    const образ = loweredProgram(src, опцииV3(src));
    expect(образ.refused, "отказы понижения: " + JSON.stringify(образ.refused.slice(0, 2))).toEqual([]);
    expect(образ.bytes.length).toBeGreaterThan(100);
  });

  it("вызов несёт не больше ДВУХ аргументов — отказ назван исключением", () => {
    // Граница цели: `call` не несёт третий аргумент. Проба держит границу, чтобы
    // она не превратилась в «программа не компилируется» без причины.
    const src = `процедура три(а: Число, б: Число, в: Число) → Число
  вернуть а + б + в
конец
действие главная()
  вернуть три(1, 2, 3)
конец
`;
    expect(() => loweredProgram(src, опцииV3(src))).toThrow(/носитель несёт не больше 2/);
  });
});

describe("дефекты ОБЩИХ слоёв, найденные первой реальной программой", () => {
  it("`продолжить` внутри перебора — прежде ЛОЖНЫЙ отказ regcodegen (исправлено)", async () => {
    // Холостой замер тела `для_каждого` идёт ДО пролога цикла, поэтому цель
    // `продолжить` в замере не заведена. Прежде это давало отказ на ВЕРНОЙ
    // программе — и не только в v3: та же v2-программа отвергалась (замерено).
    const { стек, регистры } = await значения(`процедура место(веса: Список Число, искал: Число) → Число
  пусть мест = 1
  для каждого другой, номер в веса
    если номер == искал
      продолжить
    конец если
    если другой < веса[искал]
      мест = мест + 1
    конец если
  конец для
  вернуть мест
конец
действие главная()
  вернуть место([4, 1, 3, 2], 0)
конец
`);
    // Значение здесь не важно — важно, что обе VM СОГЛАСНЫ и разбор прошёл:
    // прежде regcodegen отказывал на верной программе.
    expect(стек).toBe(регистры);
  });

  it("индекс перебора `для эл, и в …` — прежде семантика его не знала (исправлено)", () => {
    // Форма есть и в реестре (`for_each_indexed`), и в AST (`index`), но в области
    // видимости индекс не заводился: программа, которая им ПОЛЬЗУЕТСЯ, получала
    // ложное «используется без объявления через пусть». Замерено и на v2.
    const src = `процедура главная()
  для эл, инд в [10, 20, 30]
    система.лог.вывести(инд)
  конец
  вернуть 0
конец_процедуры
`;
    const собран = compileSource(src, { filename: "инд.osnova" });
    expect(собран.parserErrors).toEqual([]);
    expect(собран.semanticErrors, "индекс перебора обязан быть объявленным").toEqual([]);
  });
});

describe("РАСХОЖДЕНИЕ МОДЕЛИ: выражение из трёх слагаемых с литералом в середине", () => {
  // ИСПРАВЛЕНО 2026-10-02. Прежде модель давала здесь 15, и это была ТИХАЯ ЛОЖЬ: программа
  // «собиралась», отказов понижения 0, результат чужой. Настоящая причина — НЕ пул констант
  // (прежняя редакция этого комментария указывала на него, и это опровергнуто замером: пул
  // эмиттера и пул понижения совпадают поэлементно, `movts` несёт верный литерал) и НЕ WAR на
  // регистре (пара WAR убрана переименованием — ответ остался 15).
  //
  // Причина — ГРАНИЦА ОКНА: `call wbs = 4` сдвигает окно вызываемой на 8 регистров, поэтому
  // `%b[n]` вызываемой — это `%b[n + 8]` вызывающего. Раскладка выдавала вызываемой `%b[0..9]`,
  // и её `%b[2..7]` оказывались `%b[10..15]` вызывающего — рантаймом массивов. Выход программы
  // считает `код = значение + %b[12]` (`src/e2k/printCall.ts#exitCarrierInstructions`), а `%b[4]`
  // вызываемой — это ровно `%b[12]` вызывающего: в этой программе туда попадало `а + 1` = **4**,
  // отсюда ровно `11 + 4 = 15`. Замер различителем `.tmp/osnova-reread-which.ts` (одна и та же
  // арифметика, разные временные регистры вызываемой): `%b[2..4]` → 15, `%b[4..8]` → 14,
  // `%b[8..12]` → 11, `%b[12..15]` → 11 — разница В ТОЧНОСТИ равна засорённому `%b[4]`.
  //
  // Правка: бюджет регистров вызываемой — `CALLEE_REGISTERS` (`src/e2k/twoPassLayout.ts`), её
  // собственная половина кадра. Разбор — `docs/hardware-debt.md` §3.96.
  const ИСХОДНИК = `процедура сумма(а: Число, б: Число) → Число
  вернуть а + 1 + б
конец
действие главная()
  вернуть сумма(3, 7)
конец
`;

  it("эталон: стек и регистры дают 11 — ЭТО ПРАВИЛЬНЫЙ ОТВЕТ", async () => {
    const { стек, регистры } = await значения(ИСХОДНИК);
    expect(стек).toBe(11);
    expect(регистры).toBe(11);
  });

  it.skipIf(!shimAvailable())("модель даёт 11 — совпадает с эталоном (дефект закрыт)", () => {
    const образ = loweredProgram(ИСХОДНИК, опцииV3(ИСХОДНИК));
    expect(образ.refused).toEqual([]);
    const elf = buildElfFromCode(
      образ.bytes,
      MINIMAL_BASE,
      { writable: true, extraMemory: образ.arena.extraMemory },
    ).bytes;
    const файл = path.join(process.cwd(), ".tmp", "расхождение-литерал.elf");
    fs.writeFileSync(файл, elf);
    buildShim();
    const прогон = runInQemu(файл, { shim: true, timeoutMs: 30_000 });
    // 11 — эталон языка (стек и регистры выше). Число вернулось к эталону правкой бюджета
    // регистров вызываемой; негативный контроль — откат этой правки красит ровно эту проверку
    // (запись негативного контроля в `src/scripts/e2kLayoutNegativeControl.ts`).
    expect(
      прогон?.status,
      "модель разошлась с эталоном: раскладка снова отдала вызываемой регистры вызывающего",
    ).toBe(11);
  });
});
