/**
 * Проверка адаптера «модель e2k → номера слотов».
 *
 * Проверяются два свойства, от которых зависит вся упаковка:
 * 1. каналов ровно 24 и номера слотов не пересекаются (иначе две операции в
 *    разных каналах считались бы конфликтом, или наоборот — конфликт не
 *    находился бы);
 * 2. ограничения документа МЦСТ попадают в модель: деление и корень — только
 *    АЛУ5 (стр. 56), запись в память — только АЛУ2 и АЛУ5 (стр. 56), операция
 *    передачи управления — только ЦУ (стр. 57).
 */

import { describe, it, expect } from "vitest";
import { ALL_CHANNELS, E2K_ISSUE_WIDTH } from "./e2kDevices";
import { E2K_SLOT_OF, e2kMachineModel, e2kPossibleSlots } from "./e2kMachineModel";

describe("модель e2k для верификатора пакетов", () => {
  it("номер слота есть у каждого канала, номера не пересекаются", () => {
    expect(E2K_ISSUE_WIDTH).toBe(24);
    const slots = ALL_CHANNELS.map((ch) => E2K_SLOT_OF[ch]);
    expect(slots).toHaveLength(24);
    expect(new Set(slots).size).toBe(24);
    expect(Math.min(...slots)).toBe(0);
    expect(Math.max(...slots)).toBe(23);
  });

  it("модель объявляет 24 слота", () => {
    expect(e2kMachineModel().slots).toBe(24);
  });

  it("деление — только АЛУ5 (стр. 56)", () => {
    expect(e2kPossibleSlots("div")).toEqual([E2K_SLOT_OF.alu5]);
    expect(e2kPossibleSlots("rem")).toEqual([E2K_SLOT_OF.alu5]);
  });

  it("запись в память — только АЛУ2 и АЛУ5 (стр. 56)", () => {
    expect(e2kPossibleSlots("obj.set")).toEqual([E2K_SLOT_OF.alu2, E2K_SLOT_OF.alu5]);
  });

  it("передача управления — только ЦУ (стр. 57)", () => {
    for (const op of ["jmp", "jmp_if", "jmp_if_not", "call", "ret", "throw"]) {
      expect(e2kPossibleSlots(op)).toEqual([E2K_SLOT_OF.ct]);
    }
  });

  it("чтение — без АЛУ1 и АЛУ4 (стр. 56)", () => {
    const slots = e2kPossibleSlots("obj.get");
    expect(slots).not.toContain(E2K_SLOT_OF.alu1);
    expect(slots).not.toContain(E2K_SLOT_OF.alu4);
    expect(slots.length).toBeGreaterThan(0);
  });

  it("арифметика и литералы имеют непустой набор слотов", () => {
    for (const op of ["add", "sub", "mul", "move", "const", "eq", "not", "and", "or"]) {
      expect(e2kPossibleSlots(op).length).toBeGreaterThan(0);
    }
  });
});
