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
  // ДЕФЕКТ, НЕ ЭТАЛОН. Правильный ответ — 11 (стек и регистры согласны). Модель
  // даёт 15 — тихая ложь на цели: программа «собралась», отказов понижения 0,
  // результат неверный. Воспроизводится и на v2 тем же кодом, значит дефект
  // ОБЩЕГО слоя (понижение/раскладка e2k), а не фронтенда v3.
  //
  // ЛОКАЛИЗОВАНО замером (`.tmp/osnova-spec/константы.ts`): носитель `IR.const`
  // несёт ИНДЕКС ПУЛА (`literalFromIr: 1`, `literalFromPool: true`); пул после
  // эмиссии верный — `[1, 3, 7]`, — а по индексу 0 приходит **0**, а не 1. При
  // `а + б` определение константы устраняется как лишнее (`removedCopies: 1`) и
  // расхождения нет; как только у константы появляется настоящее чтение,
  // появляется и неверное значение. Смотреть `src/e2k/rematerialize.ts` +
  // `src/e2k/regAlloc.ts` (пул, который читает понижение, и пул, на который
  // ссылаются индексы носителей, обязаны быть ОДНИМ массивом).
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

  it.skipIf(!shimAvailable())("модель даёт 15 — ЭТО ДЕФЕКТ, ожидание подлежит замене на 11", () => {
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
    // ВНИМАНИЕ: 15 — ДЕФЕКТ, правильно 11. Менять это число можно ТОЛЬКО вместе с
    // исправлением дефекта, и тогда — на 11.
    expect(
      прогон?.status,
      "модель вернула не 15: либо дефект исправлен (тогда ожидание меняется на 11), либо изменилось что-то ещё",
    ).toBe(15);
  });
});
