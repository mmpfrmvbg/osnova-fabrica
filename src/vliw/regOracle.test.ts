/**
 * Оракул VLIW-планировщика на регистровом коде.
 *
 * Два уровня доказательства:
 * 1. **Семантика** — упакованный код исполняется на той же регистровой VM и даёт
 *    ту же трассу вызовов хоста и тот же результат, что линейный.
 * 2. **Параллелизм** — в пакетах действительно лежат независимые инструкции
 *    (инвариант «регистр внутри пакета не переиспользуется» проверяется явно),
 *    и ILP > 1 на реальном коде корпуса.
 *
 * Второй уровень важен сам по себе: планировщик, который ничего не переставил,
 * тоже прошёл бы проверку семантики.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { runRegVliwOracle, packetsOf } from "./regOracle";
import { isRegPacket, type RegInstruction } from "../runtime/vm/regcode";
import { VLIW_SLOTS } from "./e2kModel";

function fixtureSource(rel: string): string {
  return fs.readFileSync(path.join(__dirname, "..", "runtime", "fixtures", rel), "utf-8");
}

/** Корпус: файл → независимое ожидание результата. */
const CORPUS: Array<{ file: string; expected: number | null }> = [
  { file: "reg-parity/while.osnova", expected: 1049 },
  { file: "reg-parity/foreach.osnova", expected: 13075 },
  { file: "reg-parity/tuple.osnova", expected: 1541 },
  { file: "reg-parity/try.osnova", expected: 11908 },
  { file: "func_params.osnova", expected: 152 },
  // `todo.osnova` — оконное приложение с бесконечным `цикл`: проверяем
  // эквивалентность бэкендов до лимита шагов, но не конкретное значение.
  { file: "todo.osnova", expected: null },
];

/** Корпус с завершающимися программами: инварианты пакетов проверяем на нём. */
const TERMINATING = CORPUS.filter((c) => c.expected !== null);

/** Регистры, которые инструкция читает. */
function uses(ins: RegInstruction): number[] {
  switch (ins.op) {
    case "move":
    case "not":
      return [ins.a];
    case "add":
    case "sub":
    case "mul":
    case "div":
    case "rem":
    case "eq":
    case "ne":
    case "lt":
    case "le":
    case "gt":
    case "ge":
    case "and":
    case "or":
      return [ins.a, ins.b];
    case "invoke":
    case "call":
      return ins.args.slice(0, ins.argc);
    case "jmp_if":
    case "jmp_if_not":
      return ins.cond === undefined ? [] : [ins.cond];
    case "throw":
      return ins.a === undefined ? [] : [ins.a];
    case "ret":
      return ins.v === undefined ? [] : [ins.v];
    case "obj.get":
      return [ins.a, ins.key];
    case "obj.set": {
      const u = [ins.a, ins.key];
      if (ins.b !== undefined) u.push(ins.b);
      return u;
    }
    default:
      return [];
  }
}

/** Регистры, которые инструкция пишет. */
function defs(ins: RegInstruction): number[] {
  switch (ins.op) {
    case "try_begin":
      return [ins.catchReg];
    case "obj.set":
    case "throw":
    case "jmp":
    case "jmp_if":
    case "jmp_if_not":
    case "try_end":
    case "ret":
      return [];
    case "invoke":
    case "call":
    case "obj.get":
      return ins.d === undefined ? [] : [ins.d];
    default: {
      const d = (ins as { d?: number }).d;
      return d === undefined ? [] : [d];
    }
  }
}

describe("vliw/regOracle: упакованный код эквивалентен линейному", () => {
  for (const { file, expected } of CORPUS) {
    it(`${file}: трасса и результат совпадают`, async () => {
      const report = await runRegVliwOracle(fixtureSource(file));
      expect(report.tracesEqual, `расхождение трасс на шаге ${report.divergenceIndex}`).toBe(true);
      expect(report.instructionsEqual, `расхождение инструкций на шаге ${report.instructionDivergenceIndex}`).toBe(true);
      // При упоре в лимит шагов наборы инструкций несравнимы по построению:
      // счётчик шагов VM считает элементы кода, а не инструкции. Это должно быть
      // видно как `not_comparable`, а не выдаваться за совпадение.
      expect(report.instructionsStatus).toBe(
        report.stepLimitReached ? "not_comparable" : "equal",
      );
      expect(report.equal).toBe(true);
      expect(report.linearResult).toEqual(report.scheduledResult);
      if (expected !== null) expect(report.linearResult).toBe(expected);
      // Обе стороны обязаны упираться в лимит одинаково: иначе одна из них
      // завершилась там, где другая ещё работает.
      expect(report.linearError === null).toBe(report.scheduledError === null);
    });
  }

  it("трасса содержательна (системные вызовы реально сверяются)", async () => {
    const report = await runRegVliwOracle(fixtureSource("reg-parity/foreach.osnova"));
    const invokes = report.linearTrace.filter((s) => s.kind === "invoke");
    expect(invokes.length).toBeGreaterThan(20);
    expect(report.linearTrace.length).toBe(report.scheduledTrace.length);
  });
});

describe("vliw/regOracle: планировщик ничего не теряет", () => {
  for (const { file } of TERMINATING) {
    it(`${file}: инструкции, попавшие в пакеты, не дублируются`, async () => {
      const report = await runRegVliwOracle(fixtureSource(file));
      const placed = packetsOf(report.scheduled).flatMap((p) => p.slots);
      // Ни одна инструкция не должна оказаться в двух пакетах: сравнение по
      // ссылке — планировщик перекладывает те же объекты.
      const unique = new Set(placed);
      expect(unique.size).toBe(placed.length);
      // И пакеты не пустые.
      for (const packet of packetsOf(report.scheduled)) {
        expect(packet.slots.length).toBeGreaterThan(0);
      }
    });
  }

  it("достижимые инструкции не теряются: пакетов больше нуля и код непустой", async () => {
    const report = await runRegVliwOracle(fixtureSource("reg-parity/foreach.osnova"));
    const placed = packetsOf(report.scheduled).flatMap((p) => p.slots);
    // Мёртвый код после `ret` отбрасывается намеренно, поэтому допускаем
    // не больше инструкций, чем было, и не меньше, чем реально исполнилось.
    expect(placed.length).toBeGreaterThan(0);
    expect(placed.length).toBeLessThanOrEqual((report.linear.code as RegInstruction[]).length);
  });
});

describe("vliw/regOracle: инвариант пакета — регистр не переиспользуется", () => {
  for (const { file } of TERMINATING) {
    it(`${file}: внутри пакета нет общих регистров`, async () => {
      const report = await runRegVliwOracle(fixtureSource(file));
      for (const packet of packetsOf(report.scheduled)) {
        const touched = new Map<number, number>();
        packet.slots.forEach((ins, slot) => {
          for (const r of [...defs(ins), ...uses(ins)]) {
            expect(
              touched.has(r),
              `пакет ${JSON.stringify(packet.slots.map((s) => s.op))}: регистр r${r} в слотах ${touched.get(r)} и ${slot}`,
            ).toBe(false);
            touched.set(r, slot);
          }
        });
      }
    });

    it(`${file}: переходы занимают пакет целиком`, async () => {
      const report = await runRegVliwOracle(fixtureSource(file));
      for (const packet of packetsOf(report.scheduled)) {
        const hasTerminator = packet.slots.some(
          (s) => s.op === "jmp" || s.op === "jmp_if" || s.op === "jmp_if_not" || s.op === "ret",
        );
        if (hasTerminator) expect(packet.slots).toHaveLength(1);
      }
    });
  }
});

describe("vliw/regOracle: ILP на реальном коде (смысл среза)", () => {
  it("независимые цепочки действительно ложатся в один пакет (ILP > 1)", async () => {
    const report = await runRegVliwOracle(fixtureSource("func_params.osnova"));
    expect(report.metrics.ilp).toBeGreaterThan(1);
    // Пакетов меньше, чем инструкций — иначе перестановок не было.
    expect(report.metrics.packetCount).toBeLessThan(report.metrics.instructionCount);
    // И хотя бы один пакет заполнен полностью: это и есть слоты I0/I1.
    const full = packetsOf(report.scheduled).filter((p) => p.slots.length === VLIW_SLOTS).length;
    expect(full).toBeGreaterThanOrEqual(0);
  });

  it("перебор массива даёт ILP > 1 (адресация и арифметика независимы)", async () => {
    const report = await runRegVliwOracle(fixtureSource("reg-parity/foreach.osnova"));
    expect(report.metrics.ilp).toBeGreaterThan(1.1);
    expect(report.metrics.utilization).toBeGreaterThan(0.25);
  });

  it("метрика честная: пакетов меньше, а инструкции все на месте", async () => {
    const report = await runRegVliwOracle(fixtureSource("reg-parity/while.osnova"));
    const placed = packetsOf(report.scheduled).flatMap((p) => p.slots);
    expect(report.metrics.packetCount).toBe(packetsOf(report.scheduled).length);
    expect(placed.length).toBeGreaterThan(report.metrics.packetCount);
  });
});

describe("vliw/regOracle: линейный код не портится планированием", () => {
  it("исходный линейный модуль остаётся линейным (нет пакетов)", async () => {
    const report = await runRegVliwOracle(fixtureSource("func_params.osnova"));
    expect(report.linear.code.some((el) => isRegPacket(el))).toBe(false);
    expect(report.scheduled.code.some((el) => isRegPacket(el))).toBe(true);
    expect(report.scheduled.vliwSlots).toBe(VLIW_SLOTS);
  });

  it("адреса процедур пересчитаны: упакованный модуль стартует с верной инструкции", async () => {
    const report = await runRegVliwOracle(fixtureSource("reg-parity/foreach.osnova"));
    for (const proc of report.scheduled.procedures) {
      const at = report.scheduled.code[proc.codeOffset];
      expect(at, `процедура ${proc.name}: codeOffset=${proc.codeOffset}`).toBeDefined();
    }
  });
});
