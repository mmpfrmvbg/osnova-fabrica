/**
 * ОРАКУЛ ЭМИТТЕРА: проверки написаны ДО реализации.
 *
 * Этот файл — контрольная работа эмиттера на оболочке: покрытие карты размещения (1.1),
 * round-trip через кодировку (1.2), инъективность (1.3), чувствительность к подмене бита (1.4)
 * и границы атомов (1.5). Он написан раньше `src/e2k/emitterShell.ts`: до реализации все
 * проверки падают, потому что эмиттер отказывает (`EmitterRefusalError`).
 *
 * **Оракул проверяется на декоративность**: отдельный тест подменяет карту размещения, байты и
 * список инструкций и требует, чтобы проверки это заметили. Оракул, который всегда зелёный,
 * не проверяет ничего.
 */

import { describe, it, expect } from "vitest";
import { auditEncoder, getEncoder, type AsmInstruction } from "./backend";
import { OPCODES } from "./encoding";
import {
  IR_CARRIER_PREFIX,
  SHELL_IMAGE_FORMAT,
  checkEmitResult,
  type ShellEmitResult,
  type ShellImage,
} from "./emitterOracle";
import { emitShell } from "./emitterShell";
import type { RegModule } from "../runtime/vm/regcode";

const encoder = getEncoder("internal-shell");

/** Синтетический линейный модуль: две процедуры, покрытые одним атомом каждая. */
function syntheticModule(): RegModule {
  return {
    ir: "osnova-reg",
    version: 1,
    moduleName: "синтетика-оболочка",
    constants: [7, 3],
    procedures: [
      { name: "вычислить", codeOffset: 0, argc: 1, vregs: 8, localToVreg: {}, returnsValue: true },
      { name: "главная", codeOffset: 11, argc: 0, vregs: 4, localToVreg: {}, returnsValue: true },
    ],
    code: [
      { op: "const", d: 1, type: "i32", k: 0 },
      { op: "move", d: 2, a: 1 },
      { op: "add", d: 3, a: 2, b: 1 },
      { op: "mul", d: 4, a: 3, b: 2 },
      { op: "sub", d: 5, a: 4, b: 3 },
      { op: "lt", d: 6, a: 5, b: 4 },
      { op: "jmp_if_not", off: 9, cond: 6 },
      { op: "invoke", d: 7, name: "система.массив.длина", args: [5], argc: 1 },
      { op: "jmp", off: 10 },
      { op: "move", d: 7, a: 5 },
      { op: "ret", v: 7 },
      { op: "const", d: 0, type: "i32", k: 1 },
      { op: "call", d: 1, fi: 0, args: [0], argc: 1 },
      { op: "ret", v: 1 },
    ] as RegModule["code"],
    atoms: [
      { atom: "A5", optimizable: true, procedure: 0, start: 0, end: 11 },
      { atom: "A5", optimizable: true, procedure: 1, start: 11, end: 14 },
    ],
  };
}

function emit(): { module: RegModule; result: ShellEmitResult } {
  const module = syntheticModule();
  return { module, result: emitShell(module, encoder) };
}

/** Тот же результат, но с подменённым артефактом — для проверки самого оракула. */
function withImage(result: ShellEmitResult, patch: Partial<ShellImage>): ShellEmitResult {
  return { ...result, image: { ...result.image, ...patch } };
}

describe("эмиттер на оболочке: оракул (написан до реализации)", () => {
  it("эмиттер вызывается на модуле с разметкой и отдаёт артефакт", () => {
    const { module, result } = emit();
    expect(result.image.bytes.length).toBe(module.code.length * 10);
    expect(result.instructions).toHaveLength(module.code.length);
    expect(result.report.instructions).toBe(module.code.length);
  });

  it("1.1 карта размещения покрывает все инструкции без пропусков и пересечений", () => {
    const { module, result } = emit();
    expect(checkEmitResult(result, module, encoder)).toEqual([]);
    const positions = result.image.placement.map((entry) => entry.position).sort((a, b) => a - b);
    expect(positions).toEqual(module.code.map((_, i) => i));
    const indexes = result.image.placement.map((entry) => entry.codeIndex).sort((a, b) => a - b);
    expect(indexes).toEqual(module.code.map((_, i) => i));
    for (const entry of result.image.placement) {
      expect(entry.end - entry.start, `инструкция ${entry.codeIndex}`).toBe(10);
    }
  });

  it("1.2 round-trip через кодировку: поля сохраняются", () => {
    const { result } = emit();
    for (const entry of result.image.placement) {
      const bytes = result.image.bytes.slice(entry.start, entry.end);
      const asm = result.instructions[entry.position]!;
      // Байты потока — ровно то, что даёт кодирование этой инструкции.
      expect(Array.from(encoder.encode(asm)), `позиция ${entry.position}`).toEqual(Array.from(bytes));
      // И обратное декодирование возвращает ту же инструкцию.
      const back = encoder.decode(bytes);
      expect(back.mnemonic).toBe(asm.mnemonic);
      expect(back.channel).toBe(asm.channel);
      expect(back.operands).toEqual(asm.operands);
    }
  });

  it("1.3 и 1.4 шлюз кодировки: инъективность и чувствительность к подмене бита", () => {
    const { result } = emit();
    const audit = auditEncoder(encoder, result.instructions);
    expect(audit.notes, audit.notes.join("; ")).toEqual([]);
    expect(audit.outcome).toBe("готов");
    const byName = new Map(audit.checks.map((check) => [check.name, check]));
    expect(byName.get("инъективность")?.ok).toBe(true);
    expect(byName.get("чувствительность к подмене бита")?.ok).toBe(true);
    expect(byName.get("round-trip")?.ok).toBe(true);
  });

  it("1.5 перестановка не выходит за границу атома", () => {
    const { module, result } = emit();
    expect(result.report.regions).toHaveLength(module.atoms!.length);
    for (const region of module.atoms!) {
      const inside = result.image.placement
        .filter((entry) => entry.codeIndex >= region.start && entry.codeIndex < region.end)
        .map((entry) => entry.codeIndex)
        .sort((a, b) => a - b);
      const expected = Array.from({ length: region.end - region.start }, (_, i) => region.start + i);
      expect(inside, `атом ${region.atom}`).toEqual(expected);
      for (const entry of result.image.placement) {
        if (entry.codeIndex >= region.start && entry.codeIndex < region.end) {
          expect(entry.atom).toBe(region.atom);
          expect(entry.optimizable).toBe(region.optimizable);
        }
      }
    }
    // Отчёт обязан назвать каждый участок и его флаг.
    const atoms = result.report.regions.map((region) => `${region.atom}:${String(region.optimizable)}`);
    expect(atoms).toEqual(module.atoms!.map((r) => `${r.atom}:${String(r.optimizable)}`));
  });

  it("1.5 без разметки или с испорченной разметкой эмиттер отказывает", () => {
    const noAtoms = syntheticModule();
    delete noAtoms.atoms;
    expect(() => emitShell(noAtoms, encoder)).toThrow(/разметк/i);

    const broken = syntheticModule();
    broken.atoms![0]!.end = broken.atoms![0]!.end - 1;
    expect(() => emitShell(broken, encoder)).toThrow(/разметк|не совпадает/i);

    const twoAtomsInOneProcedure = syntheticModule();
    twoAtomsInOneProcedure.atoms = [
      { atom: "A5", optimizable: true, procedure: 0, start: 0, end: 11 },
      { atom: "A1", optimizable: false, procedure: 0, start: 0, end: 11 },
    ];
    expect(() => emitShell(twoAtomsInOneProcedure, encoder)).toThrow(/разметк|дважды/i);
  });

  it("носители помечены как наши: префикс IR., и ни один не является мнемоникой e2k", () => {
    const { result } = emit();
    expect(result.report.carriers.length).toBeGreaterThan(5);
    const documented = new Set(OPCODES.map((entry) => entry.mnemonic));
    for (const carrier of result.report.carriers) {
      expect(carrier.startsWith(IR_CARRIER_PREFIX), `носитель «${carrier}»`).toBe(true);
      expect(documented.has(carrier), `носитель «${carrier}» совпал с e2k-мнемоникой`).toBe(false);
    }
    // Набор носителей обязан покрывать операции синтетического модуля.
    const measured = new Set(result.report.carriers);
    for (const expected of ["IR.const", "IR.move", "IR.add", "IR.mul", "IR.sub", "IR.lt", "IR.jmp", "IR.jmp_if_not", "IR.invoke", "IR.call", "IR.ret"]) {
      expect(measured.has(expected), `нет носителя ${expected}`).toBe(true);
    }
  });

  it("артефакт не несёт код IR: круг «байты → IR» не должен быть подстановкой", () => {
    const { result } = emit();
    expect(Object.keys(result.image).sort()).toEqual([
      "bytes",
      "format",
      "frontMatter",
      "instructionSize",
      "invokeNames",
      "passport",
      "placement",
      "version",
    ]);
    expect(result.image.format).toBe(SHELL_IMAGE_FORMAT);
    expect((result.image as unknown as { code?: unknown }).code).toBeUndefined();
    expect(result.image.passport.backendId).toBe("internal-shell");
    expect(result.image.passport.backendStatus).toBe("ДОПУЩЕНИЕ");
    expect(result.image.passport.note).toMatch(/оболочк/i);
  });

  it("таблица имён вызовов попадает в артефакт: имя хост-вызова байтами не выражается", () => {
    const { result } = emit();
    expect(result.image.invokeNames).toContain("система.массив.длина");
  });

  it("2.1 optimizable берётся из module.atoms, а не из разметки вызывающего", () => {
    const module = syntheticModule();
    // Вызывающий подаёт разметку с ПЕРЕВЁРНУТЫМИ флагами: эмиттер обязан её игнорировать.
    const flipped = module.atoms!.map((region) => ({ ...region, optimizable: !region.optimizable }));
    const result = emitShell(module, encoder, { callerAtoms: flipped });
    expect(result.report.regions.map((region) => region.optimizable)).toEqual(
      module.atoms!.map((region) => region.optimizable),
    );
    for (const entry of result.image.placement) {
      const region = module.atoms!.find(
        (item) => entry.codeIndex >= item.start && entry.codeIndex < item.end,
      )!;
      expect(entry.optimizable, `инструкция ${entry.codeIndex}`).toBe(region.optimizable);
    }
    // Дефект 4.2: с включённым доверием к вызывающему флаги берутся у него — и проверка
    // (самопроверка эмиттера) обязана это заметить.
    expect(() => emitShell(module, encoder, { callerAtoms: flipped, defects: { trustCallerFlags: true } })).toThrow(
      /optimizable|разметк/i,
    );
  });

  it("ОРАКУЛ НЕ ДЕКОРАТИВЕН: подмена карты, байтов и списка инструкций ловится", () => {
    const { module, result } = emit();

    const badPlacement = withImage(result, {
      placement: result.image.placement.map((entry, index) =>
        index === 1 ? { ...entry, start: entry.start + 3, end: entry.end + 3 } : entry,
      ),
    });
    expect(checkEmitResult(badPlacement, module, encoder).length).toBeGreaterThan(0);

    const shortPlacement = withImage(result, { placement: result.image.placement.slice(0, -1) });
    expect(checkEmitResult(shortPlacement, module, encoder).length).toBeGreaterThan(0);

    const brokenBytes = Uint8Array.from(result.image.bytes);
    brokenBytes[0] = brokenBytes[0]! ^ 0xff;
    expect(checkEmitResult(withImage(result, { bytes: brokenBytes }), module, encoder).length).toBeGreaterThan(0);

    const swapped: AsmInstruction[] = [...result.instructions];
    swapped[0] = swapped[1]!;
    swapped[1] = result.instructions[0]!;
    const badInstructions: ShellEmitResult = { ...result, instructions: swapped };
    expect(checkEmitResult(badInstructions, module, encoder).length).toBeGreaterThan(0);

    const noNote = withImage(result, {
      passport: { ...result.image.passport, note: "  " },
    });
    expect(checkEmitResult(noNote, module, encoder).length).toBeGreaterThan(0);
  });
});
