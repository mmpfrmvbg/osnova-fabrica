/**
 * ОРАКУЛ УПАКОВКИ: тесты пишутся ДО `packetPacker.ts`.
 *
 * ## Что проверяется
 *
 * `packInstructions(module, model)` собирает соседние инструкции в пакеты, НЕ
 * меняя их взаимный порядок. Такой упаковщик обязан соблюдать:
 *
 * 1. все инварианты `verifyPackets` (RAW / WAR / WAW / передача управления /
 *    ширина / совместимость со слотами) — они про **аппаратную** легальность;
 * 2. два инварианта, которые `verifyPackets` проверить не может, потому что в
 *    упакованном модуле `off` — индекс элемента и информация «какая инструкция
 *    была целью» теряется:
 *    - инструкция-цель перехода и первая инструкция процедуры обязаны открывать
 *      пакет (быть в слоте 0);
 *    - передача управления обязана закрывать пакет: слоты после неё в VM не
 *      исполняются (см. `docs/vliw-pack-diagnosis.md`).
 *
 * Эквивалентность в VM следует из конструкции: слоты пакета исполняются
 * последовательно в том же порядке, а единственное отличие пакета от линейного
 * кода — выход из пакета при передаче управления. Поэтому «в порядке + передача
 * управления закрывает пакет» сохраняет поведение, а проверки регистров и
 * слотов оставлены ради того, чтобы код был легален на модели аппарата.
 */

import { describe, it, expect } from "vitest";
import { packInstructions } from "./packetPacker";
import { verifyPackets, type MachineModel } from "./packetVerifier";
import { isRegPacket, type RegCodeElement, type RegInstruction, type RegModule } from "../runtime/vm/regcode";

/** Модель машины для тестов: 4 слота, деление — только слот 0, ветвления — слот 3. */
const MODEL: MachineModel = {
  slots: 4,
  possibleSlots: (op: string) => {
    if (op === "div" || op === "rem") return [0];
    if (op === "jmp" || op === "jmp_if" || op === "jmp_if_not" || op === "ret" || op === "throw") {
      return [3];
    }
    return [0, 1, 2];
  },
};

const K = (d: number, k = 0): RegInstruction => ({ op: "const", d, type: "i32", k }) as RegInstruction;
const ADD = (d: number, a: number, b: number): RegInstruction => ({ op: "add", d, a, b }) as RegInstruction;
const MOVE = (d: number, a: number): RegInstruction => ({ op: "move", d, a }) as RegInstruction;
const RET = (v?: number): RegInstruction =>
  (v === undefined ? { op: "ret" } : { op: "ret", v }) as RegInstruction;
const CALL = (d: number, fi = 0, args: number[] = []): RegInstruction =>
  ({ op: "call", d, fi, args, argc: args.length }) as RegInstruction;
const JMP_IF = (cond: number, off: number): RegInstruction =>
  ({ op: "jmp_if", cond, off }) as RegInstruction;

/** Процедуры для модуля: одна или несколько. */
function procedures(offsets: number[]): RegModule["procedures"] {
  return offsets.map((codeOffset, i) => ({
    name: i === 0 ? "главная" : `п${i}`,
    codeOffset,
    argc: 0,
    vregs: 16,
    localToVreg: {},
  }));
}

/** Линейный модуль из кода и адресов процедур. */
function module(code: RegInstruction[], offsets: number[] = [0]): RegModule {
  return {
    ir: "osnova-reg",
    version: 1,
    moduleName: "тест",
    constants: [1, 2, 3],
    procedures: procedures(offsets),
    code,
  };
}

/** Развернуть элементы в список инструкций (пакет → его слоты). */
function flatten(code: readonly RegCodeElement[]): RegInstruction[] {
  const out: RegInstruction[] = [];
  for (const el of code) {
    if (isRegPacket(el)) out.push(...el.slots);
    else out.push(el as RegInstruction);
  }
  return out;
}

// ---------------------------------------------------------------------------
// ПОЗИТИВНЫЕ: упаковка собирает пакеты
// ---------------------------------------------------------------------------

describe("packInstructions: собирает независимые инструкции в пакет", () => {
  it("1. две независимые инструкции → один пакет, плотность 2.00", () => {
    const r = packInstructions(module([K(1, 0), K(2, 1)]), MODEL);
    expect(verifyPackets(r.module, MODEL)).toEqual({ ok: true });
    expect(r.module.code.length).toBe(1);
    expect(r.stats.elementsBefore).toBe(2);
    expect(r.stats.elementsAfter).toBe(1);
    expect(r.stats.widePackets).toBe(1);
    expect(r.stats.densityBefore).toBeCloseTo(1, 5);
    expect(r.stats.densityAfter).toBeCloseTo(2, 5);
  });

  it("2. порядок инструкций не меняется", () => {
    const code = [K(1, 0), K(2, 1), K(3, 2)];
    const r = packInstructions(module(code), MODEL);
    expect(verifyPackets(r.module, MODEL)).toEqual({ ok: true });
    const ops = flatten(r.module.code).map((i) => i.op);
    expect(ops).toEqual(code.map((i) => i.op));
    for (let i = 0; i < code.length; i++) {
      expect(flatten(r.module.code)[i]).toEqual(code[i]);
    }
  });

  it("3. карта keys: элемент и слот → индекс исходной инструкции", () => {
    const code = [K(1, 0), K(2, 1)];
    const r = packInstructions(module(code), MODEL);
    expect(r.keys).toEqual([[0, 1]]);
    expect(r.positionOf).toEqual([0, 0]);
  });

  it("4. модель с 24 слотами собирает десять независимых инструкций в один пакет", () => {
    const wide: MachineModel = { slots: 24, possibleSlots: () => Array.from({ length: 24 }, (_, i) => i) };
    const code = Array.from({ length: 10 }, (_, i) => K(i + 1, i));
    const r = packInstructions(module(code), wide);
    expect(verifyPackets(r.module, wide)).toEqual({ ok: true });
    expect(r.module.code.length).toBe(1);
    expect(r.stats.densityAfter).toBeCloseTo(10, 5);
  });

  it("5. одиночный слот остаётся обычной инструкцией, а не пакетом", () => {
    const r = packInstructions(module([RET()]), MODEL);
    expect(isRegPacket(r.module.code[0]!)).toBe(false);
    expect(r.stats.widePackets).toBe(0);
    expect(r.stats.densityAfter).toBeCloseTo(1, 5);
  });
});

// ---------------------------------------------------------------------------
// НЕГАТИВНЫЕ: нелегальные комбинации раскладываются по разным пакетам
// ---------------------------------------------------------------------------

describe("packInstructions: нелегальные пары разводятся по пакетам", () => {
  it("1. RAW внутри пакета запрещён: потребитель и потребитель в разных элементах", () => {
    // const пишет r1, add читает r1 — в одном пакете значение ещё не видно.
    const r = packInstructions(module([K(1, 0), ADD(5, 1, 2)]), MODEL);
    expect(verifyPackets(r.module, MODEL)).toEqual({ ok: true });
    expect(r.module.code.length).toBe(2);
    expect(r.stats.densityAfter).toBeCloseTo(1, 5);
    expect(r.stats.newPacketReasons.conflict).toBe(1);
  });

  it("2. WAW внутри пакета запрещён: две записи в один регистр", () => {
    const r = packInstructions(module([K(7, 0), K(7, 1)]), MODEL);
    expect(verifyPackets(r.module, MODEL)).toEqual({ ok: true });
    expect(r.module.code.length).toBe(2);
  });

  it("3. WAR внутри пакета запрещён: запись затирает прочитанный регистр", () => {
    const r = packInstructions(module([ADD(5, 9, 2), K(9, 0)]), MODEL);
    expect(verifyPackets(r.module, MODEL)).toEqual({ ok: true });
    expect(r.module.code.length).toBe(2);
  });

  it("4. несовместимость со слотами: четыре деления не помещаются в модель", () => {
    const DIV = (d: number, a: number, b: number): RegInstruction => ({ op: "div", d, a, b }) as RegInstruction;
    const code = [DIV(1, 10, 11), DIV(2, 12, 13), DIV(3, 14, 15), DIV(4, 16, 17)];
    const r = packInstructions(module(code), MODEL);
    expect(verifyPackets(r.module, MODEL)).toEqual({ ok: true });
    // В модели деление допустимо только в слоте 0, поэтому в один пакет влезает
    // не больше одного деления.
    expect(r.module.code.length).toBe(4);
    expect(r.stats.widePackets).toBe(0);
  });

  it("5. модель с одним слотом: каждый элемент — одна инструкция", () => {
    const one: MachineModel = { slots: 1, possibleSlots: () => [0] };
    const r = packInstructions(module([K(1, 0), K(2, 1), K(3, 2)]), one);
    expect(verifyPackets(r.module, one)).toEqual({ ok: true });
    expect(r.module.code.length).toBe(3);
    expect(r.stats.densityAfter).toBeCloseTo(1, 5);
  });

  it("6. пакет не шире машины", () => {
    const three: MachineModel = { slots: 3, possibleSlots: () => [0, 1, 2] };
    const code = Array.from({ length: 6 }, (_, i) => K(i + 1, i));
    const r = packInstructions(module(code), three);
    expect(verifyPackets(r.module, three)).toEqual({ ok: true });
    for (const el of r.module.code) {
      if (isRegPacket(el)) expect(el.slots.length).toBeLessThanOrEqual(3);
    }
    expect(r.stats.densityAfter).toBeCloseTo(3, 5);
  });
});

// ---------------------------------------------------------------------------
// ПЕРЕДАЧА УПРАВЛЕНИЯ: регрессия на измеренный дефект
// ---------------------------------------------------------------------------

describe("packInstructions: передача управления закрывает пакет", () => {
  it("1. после `call` в том же пакете нет слотов", () => {
    // ИЗМЕРЕННЫЙ ДЕФЕКТ: упаковка по `issueAt` положила `move` после `call`.
    // VM покидает пакет на `call`, и `move` не исполнился: `while.osnova` дала
    // 49 вместо 1049, шагов 249 → 248, потеряна ровно одна инструкция.
    const code = [K(4, 1), CALL(3, 0, [4]), MOVE(6, 0), K(1, 0), RET()];
    const r = packInstructions(module(code), MODEL);
    expect(verifyPackets(r.module, MODEL)).toEqual({ ok: true });
    for (const el of r.module.code) {
      if (!isRegPacket(el)) continue;
      el.slots.forEach((slot, i) => {
        const ins = slot as RegInstruction;
        if (ins.op === "call" || ins.op === "ret" || ins.op === "throw") {
          expect(i).toBe(el.slots.length - 1);
        }
      });
    }
  });

  it("2. `move` после `call` лежит в следующем элементе и исполняется", () => {
    const code = [K(4, 1), CALL(3, 0, [4]), MOVE(6, 0)];
    const r = packInstructions(module(code), MODEL);
    const flat = flatten(r.module.code);
    expect(flat.map((i) => i.op)).toEqual(["const", "call", "move"]);
    // `call` — последний слот своего элемента, `move` — первый слот следующего.
    const callAt = flat.indexOf(flat.find((i) => i.op === "call")!);
    expect(callAt).toBe(1);
    expect(r.positionOf[2]).toBeGreaterThan(r.positionOf[1]!);
  });

  it("3. ветвление последнее в своём пакете", () => {
    const code = [K(1, 0), JMP_IF(1, 3), K(2, 1), K(3, 2)];
    const r = packInstructions(module(code), MODEL);
    expect(verifyPackets(r.module, MODEL)).toEqual({ ok: true });
    for (const el of r.module.code) {
      if (!isRegPacket(el)) continue;
      el.slots.forEach((slot, i) => {
        if ((slot as RegInstruction).op === "jmp_if") expect(i).toBe(el.slots.length - 1);
      });
    }
  });

  it("4. цель перехода открывает пакет (слот 0)", () => {
    // jmp_if ведёт на индекс 3; инструкции 1 и 2 перед целью не должны оказаться
    // в одном пакете с целью, иначе VM, войдя в пакет, исполнит их лишний раз.
    const code = [JMP_IF(1, 3), K(2, 1), K(3, 2), K(4, 3), RET()];
    const r = packInstructions(module(code), MODEL);
    expect(verifyPackets(r.module, MODEL)).toEqual({ ok: true });
    const jmp = flatten(r.module.code).find((i) => i.op === "jmp_if")!;
    const element = jmp.off!;
    expect(r.keys[element]![0]).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// АДРЕСА И НЕИЗМЕННОСТЬ ИСХОДА
// ---------------------------------------------------------------------------

describe("packInstructions: адреса и исходный модуль", () => {
  it("1. `off` пересчитан на индекс элемента", () => {
    // Код: 0:const 1:const 2:jmp 3:const 4:ret
    // Упаковка: [const,const] — элемент 0; jmp — элемент 1; const — элемент 2; ret — 3
    const code = [K(1, 0), K(2, 1), { op: "jmp", off: 3 } as RegInstruction, K(3, 2), RET()];
    const r = packInstructions(module(code), MODEL);
    const jmp = flatten(r.module.code).find((i) => i.op === "jmp")!;
    expect(jmp.off).toBe(r.positionOf[3]);
  });

  it("2. `codeOffset` процедур пересчитан", () => {
    // Первая процедура: K(1);RET() → 1 элемент. Вторая начинается с индекса 2.
    const code = [K(1, 0), RET(), K(2, 1), RET()];
    const r = packInstructions(module(code, [0, 2]), MODEL);
    expect(r.module.procedures[0]!.codeOffset).toBe(0);
    expect(r.module.procedures[1]!.codeOffset).toBe(r.positionOf[2]);
  });

  it("3. начало второй процедуры открывает пакет", () => {
    const code = [K(1, 0), K(2, 1), K(3, 2), K(4, 3)];
    const r = packInstructions(module(code, [0, 2]), MODEL);
    expect(verifyPackets(r.module, MODEL)).toEqual({ ok: true });
    // Индексы 0..1 — первая процедура (пакет), 2..3 — вторая: цель не может
    // лежать внутри пакета первой.
    expect(r.positionOf[2]).toBeGreaterThan(r.positionOf[0]!);
    expect(r.keys[r.positionOf[2]!]![0]).toBe(2);
  });

  it("4. исходный модуль не меняется", () => {
    const code = [K(1, 0), K(2, 1), { op: "jmp", off: 3 } as RegInstruction, K(3, 2), RET()];
    const m = module(code, [0]);
    const before = JSON.parse(JSON.stringify(m));
    packInstructions(m, MODEL);
    expect(JSON.parse(JSON.stringify(m))).toEqual(before);
  });

  it("5. все адреса пересчитаны, список непересчитанных пуст", () => {
    const code = [K(1, 0), K(2, 1), { op: "jmp", off: 3 } as RegInstruction, K(3, 2), RET()];
    const r = packInstructions(module(code), MODEL);
    expect(r.unmappedAddresses).toEqual([]);
  });

  it("6. плотность упаковки считается как инструкций на элемент", () => {
    const code = Array.from({ length: 6 }, (_, i) => K(i + 1, i));
    const two: MachineModel = { slots: 2, possibleSlots: () => [0, 1] };
    const r = packInstructions(module(code), two);
    expect(r.stats.instructions).toBe(6);
    expect(r.stats.elementsAfter).toBe(3);
    expect(r.stats.densityAfter).toBeCloseTo(2, 5);
    expect(r.stats.packedInstructions).toBe(6);
  });
});
