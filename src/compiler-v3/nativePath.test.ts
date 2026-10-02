/**
 * НАТИВНЫЙ ПУТЬ v3: frontend v3 → AST v2 → (общий проход разрешения) → regcodegen →
 * регистровая VM. Две вещи, которые ревью назвало блокерами:
 *
 *   1. `длина` — один узел, реализацию выбирает СЕМАНТИКА по типу операнда:
 *      `длина "абв"` → `система.строка.длина`, `длина [1,2,3]` → `система.массив.длина`.
 *      Проверяется ЗНАЧЕНИЕМ на обеих VM, а не только видом AST: строковая длина
 *      раньше была недостижима, и AST-проверка этого не ловила.
 *   2. Счётный цикл `для i от a до b` доходит до `regcodegen` без отказа —
 *      он разворачивается во фронтенде в существующие узлы (`пусть` + `пока`).
 */
import { describe, expect, it } from "vitest";
import { validateNamedTypesAndRewrite } from "../compiler/compiler";
import { compile } from "../compiler/codegen";
import { compileToReg } from "../compiler/regcodegen";
import { createDefaultInvokeHandler, VM } from "../runtime/vm/interpreter";
import { RegVM } from "../runtime/vm/reginterpreter";
import { parseV3 } from "./index";
import type { Module } from "../compiler/ast";

const ФАЙЛ = "нативный.osnova";

/** v3-исходник → AST, доведённый до вида, который ждут кодогены. */
function модульV3(источник: string): Module {
  const р = parseV3(источник, ФАЙЛ);
  expect(р.errors, `v3 не разобрал: ${р.errors.join("; ")}`).toEqual([]);
  const м = р.program!.modules[0]!;
  const ошибки = validateNamedTypesAndRewrite(м);
  expect(ошибки, `проход разрешения: ${ошибки.join("; ")}`).toEqual([]);
  return м;
}

/** Стековая VM: эталон поведения (байткод из того же AST). */
async function стековая(м: Module): Promise<unknown> {
  const байткод = compile(м);
  const vm = new VM(байткод, { invoke: createDefaultInvokeHandler(), maxSteps: 200_000 });
  return vm.runProcedure(vm.findProcedureIndex("главная"), []);
}

/** Регистровая VM: нативная цель. */
async function регистровая(м: Module): Promise<unknown> {
  const reg = compileToReg(м);
  const vm = new RegVM(reg, { invoke: createDefaultInvokeHandler(), maxSteps: 200_000 });
  return vm.runProcedure(vm.findProcedureIndex("главная"), []);
}

describe("v3 → нативный путь (regcodegen), без второго рантайма", () => {
  it("`длина` строки и списка: реализацию выбирает семантика по типу", async () => {
    const м = модульV3(`действие главная()
  пусть строка = "абв"
  пусть числа = [1, 2, 3, 4]
  вернуть длина строка * 100 + длина числа
конец
`);
    // 3 * 100 + 4 — на обеих VM одно и то же число.
    expect(await стековая(м)).toBe(304);
    expect(await регистровая(м)).toBe(304);
  });

  it("`длина` по аннотации параметра: Строка против Списка", async () => {
    const м = модульV3(`процедура сколько(с: Строка) → Число
  вернуть длина с
конец
действие главная()
  вернуть сколько("абвгд")
конец
`);
    expect(await стековая(м)).toBe(5);
    expect(await регистровая(м)).toBe(5);
  });

  it("счётный цикл доходит до регистров: сумма 1..10", async () => {
    const м = модульV3(`действие главная()
  пусть сумма = 0
  для номер от 1 до 10
    сумма = сумма + номер
  конец для
  вернуть сумма
конец
`);
    expect(await стековая(м)).toBe(55);
    expect(await регистровая(м)).toBe(55);
  });

  it("счётный цикл с шагом и убыванием", async () => {
    const м = модульV3(`действие главная()
  пусть нечётных = 0
  для номер от 1 до 10 шаг 3
    нечётных = нечётных + 1
  конец для
  пусть обратно = 0
  для номер от 5 до 1 шаг 0 - 1
    обратно = обратно * 10 + номер
  конец для
  вернуть нечётных * 100000 + обратно
конец
`);
    // шагов 1,4,7,10 → 4; обратно = 54321
    expect(await стековая(м)).toBe(4 * 100000 + 54321);
    expect(await регистровая(м)).toBe(4 * 100000 + 54321);
  });

  it("контроль: `длина` разрешена в РАЗНЫЕ вызовы, а не в один", () => {
    const м = модульV3(`действие главная()
  пусть строка = "аб"
  пусть числа = [1, 2, 3]
  вернуть длина строка + длина числа
конец
`);
    const вид = JSON.stringify(м).match(/система\.(строка|массив)\.длина/g) ?? [];
    expect(new Set(вид)).toEqual(new Set(["система.строка.длина", "система.массив.длина"]));
  });
});
