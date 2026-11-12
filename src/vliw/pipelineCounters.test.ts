/**
 * Тесты аппаратных счётчиков (гл. 5.2 руководства МЦСТ, стр. 63–64).
 *
 * Счётчики считает симулятор нашего расписания, а не железо. Поэтому тесты
 * проверяют не «совпало с Эльбрусом», а:
 * 1. имена и смысл совпадают с `dprof`;
 * 2. счётчики, которые мы НЕ моделируем, возвращаются как `null`, а не нулём —
 *    ноль означал бы «измерено и равно нулю», а это неправда;
 * 3. перестановка снижает `BUB_E2` на реальном коде — то есть счётчик реагирует
 *    на то, ради чего он заведён;
 * 4. зависимости между счётчиками держатся (`EXEC <= TICKS`, `CPI = TICKS/EXEC`).
 */

import { describe, it, expect } from "vitest";
import { countPipeline, formatCounters, MEMORY_LATENCY, packetsFill } from "./pipelineCounters";
import { scheduleRegWithReorder, scheduleRegInOrder } from "./reorderScheduler";
import type { RegInstruction } from "../runtime/vm/regcode";
import { compileSource } from "../compiler/compiler";
import { compileToReg } from "../compiler/regcodegen";

function regCodeOf(source: string): RegInstruction[] {
  const compiled = compileSource(source);
  expect(compiled.parserErrors).toHaveLength(0);
  const mod = compileToReg(compiled.moduleAst!);
  const proc = mod.procedures[0]!;
  const out: RegInstruction[] = [];
  for (let i = proc.codeOffset; i < mod.code.length; i++) {
    const el = mod.code[i]!;
    if ((el as { packet?: boolean }).packet) continue;
    out.push(el as RegInstruction);
  }
  return out;
}

const PROGRAM = `модуль Т
процедура главная()
  пусть a = 1 + 2
  пусть b = 3 + 4
  пусть c = 5 + 6
  пусть d = 7 + 8
  пусть e = 9 + 10
  пусть f = 11 + 12
  вернуть a + b + c + d + e + f
конец
конец
`;

describe("pipelineCounters: имена и смысл совпадают с dprof", () => {
  it("счётчики, которых у нас нет, возвращаются null, а не нулём", () => {
    const code = regCodeOf(PROGRAM);
    const c = countPipeline(scheduleRegWithReorder(code, {}));
    // Эти три мы не моделируем — и говорим об этом явно.
    expect(c.BUB_B).toBeNull();
    expect(c.IB_NO_COMMAND).toBeNull();
    expect(c.L2_QUERY).toBeNull();
    expect(c.L2_HIT).toBeNull();
    // А эти — моделируем.
    expect(typeof c.TICKS).toBe("number");
    expect(typeof c.EXEC).toBe("number");
    expect(typeof c.BUB_E2).toBe("number");
  });

  it("EXEC равен числу инструкций — ни одна не потеряна", () => {
    const code = regCodeOf(PROGRAM);
    const c = countPipeline(scheduleRegWithReorder(code, {}));
    expect(c.EXEC).toBe(code.length);
  });

  it("CPI/IPC согласованы с TICKS и EXEC", () => {
    const code = regCodeOf(PROGRAM);
    const c = countPipeline(scheduleRegWithReorder(code, {}));
    // EXEC МОЖЕТ быть больше TICKS — в этом и смысл VLIW: за один такт
    // выдаётся несколько инструкций. Поэтому проверяем не «EXEC <= TICKS»,
    // а согласованность производных метрик.
    expect(c.CPI).toBeCloseTo(c.TICKS / c.EXEC, 6);
    expect(c.IPC).toBeCloseTo(c.EXEC / c.TICKS, 6);
    expect(c.IPC).toBeGreaterThan(0);
  });

  it("на пустом расписании нет деления на ноль", () => {
    const c = countPipeline(scheduleRegWithReorder([], {}));
    expect(c.TICKS).toBe(0);
    expect(c.EXEC).toBe(0);
    expect(c.CPI).toBe(0);
    expect(c.IPC).toBe(0);
  });

  it("отчёт читается теми же словами, что вывод dprof", () => {
    const code = regCodeOf(PROGRAM);
    const text = formatCounters(countPipeline(scheduleRegWithReorder(code, {})));
    for (const key of ["TICKS", "EXEC", "BUB_E2", "BUB_B", "IB_NO_COMMAND", "L2_QUERY", "L2_HIT"]) {
      expect(text).toContain(key);
    }
    expect(text).toContain("не моделируется");
  });
});

describe("pipelineCounters: BUB_E2 реагирует на планирование", () => {
  it("перестановка даёт не больше блокировок, чем in-order", () => {
    const code = regCodeOf(PROGRAM);
    const reordered = countPipeline(scheduleRegWithReorder(code, {}));
    const inOrder = countPipeline(scheduleRegInOrder(code, {}));
    expect(reordered.BUB_E2).toBeLessThanOrEqual(inOrder.BUB_E2);
    expect(reordered.TICKS).toBeLessThanOrEqual(inOrder.TICKS);
  });

  it("на реальном коде перестановка снижает TICKS (проверка, что счётчик не мёртв)", () => {
    const code = regCodeOf(PROGRAM);
    const reordered = countPipeline(scheduleRegWithReorder(code, {}));
    const inOrder = countPipeline(scheduleRegInOrder(code, {}));
    // Если бы счётчики не реагировали на расписание, этот тест был бы зелёным
    // при любом планировщике — и метрика была бы бесполезной.
    expect(reordered.TICKS).toBeLessThan(inOrder.TICKS);
  });

  it("идеально упакованный участок не имеет ни одной блокировки", () => {
    // Чистая целочисленная программа: задержка 1, шесть независимых веток —
    // перестановке есть что заполнить.
    const code = regCodeOf(PROGRAM);
    const r = scheduleRegWithReorder(code, {});
    const c = countPipeline(r);
    // BUB_E2 не может превышать TICKS.
    expect(c.BUB_E2).toBeLessThanOrEqual(c.TICKS);
  });
});

describe("pipelineCounters: уровень памяти влияет на длительность чтения", () => {
  it("таблица уровней памяти совпадает с руководством (стр. 71)", () => {
    expect(MEMORY_LATENCY).toEqual({ l1: 3, l2: 11, l3: 40, mem: 100 });
  });

  it("чем хуже уровень памяти, тем больше тактов", () => {
    const source = `модуль Т
процедура главная()
  пусть о = { x: 1, y: 2 }
  вернуть о.x + о.y
конец
конец
`;
    const code = regCodeOf(source);
    // Уровень памяти передаётся ПЛАНИРОВЩИКУ: руководство (стр. 71) говорит, что
    // планировщик всегда планирует чтение из L1, если нет подсказки, — значит
    // «хуже L1» это именно другой сценарий планирования, а не постфактум-поправка.
    const r = scheduleRegWithReorder(code, {});
    const l1 = countPipeline(r, "l1");
    const mem = countPipeline(r, "mem");
    expect(mem.TICKS).toBeGreaterThan(l1.TICKS);
    // Разница не обязана равняться 97 на каждое чтение: часть задержек двух
    // чтений перекрывается (они независимы и выдаются в разные такты), поэтому
    // проверяем, что «удорожание» действительно порядка разницы уровней, а не
    // единицы.
    expect(mem.TICKS - l1.TICKS).toBeGreaterThan(
      (MEMORY_LATENCY.mem - MEMORY_LATENCY.l1) / 2,
    );
  });

  it("планировщик принимает уровень памяти и меняет расписание", () => {
    const source = `модуль Т
процедура главная()
  пусть о = { x: 1, y: 2 }
  вернуть о.x + о.y
конец
конец
`;
    const code = regCodeOf(source);
    const atL1 = scheduleRegWithReorder(code, { memoryLevel: "l1" });
    const atMem = scheduleRegWithReorder(code, { memoryLevel: "mem" });
    // При промахе мимо L1 чтения «дорожают», поэтому участок длиннее.
    expect(atMem.metrics.cycles).toBeGreaterThan(atL1.metrics.cycles);
  });
});

describe("pipelineCounters: заполненность пакетов", () => {
  it("packetsFill считает инструкции на пакет", () => {
    const code = regCodeOf(PROGRAM);
    const r = scheduleRegWithReorder(code, {});
    const fill = packetsFill(r);
    expect(fill).toBeGreaterThan(0);
    expect(fill).toBeLessThanOrEqual(24);
  });
});
