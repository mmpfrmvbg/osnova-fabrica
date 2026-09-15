/**
 * СКВОЗНОЙ ПРОГОН: пять DSP-ядер через эмиттер на оболочке.
 *
 * Маршрут: исходник на Основе → `RegModule` → разметка атомов → **эмиттер** → байты →
 * **декодер** → `RegModule` → регистровая VM → сверка с `tests/dsp/reference.json`
 * (независимая реализация на Python).
 *
 * # Что это доказывает
 *
 * Что конвейер **сохраняет семантику**: значения после круга «эмиттер → байты → декодер»
 * совпадают с эталоном. Оракул не зависит от кодировки: он сравнивает числа, а не байты,
 * поэтому переживёт замену оболочки на реальную кодировку.
 *
 * # Чего это не доказывает
 *
 * Что код корректен для e2k: оболочка — не e2k, носители IR — наши имена. Что семантика e2k
 * совпадает с семантикой регистровой VM: это только симулятор или железо, которых нет.
 * И что модель задержек верна: она этим конвейером не используется вовсе.
 */

import * as fs from "fs";
import * as path from "path";
import { describe, it, expect } from "vitest";
import { getEncoder } from "./backend";
import { emitShell } from "./emitterShell";
import { decodeShellImage, runShellImage } from "./emitterRoundtrip";
import { sameRegInstruction } from "./emitterOracle";
import { annotateAtomRegions, verifyAtomRegions } from "../compiler/atomRegions";
import { regModuleOf } from "../vliw/regOracle";
import { RegVM } from "../runtime/vm/reginterpreter";
import { createDefaultInvokeHandler } from "../runtime/vm/interpreter";
import { resolveEntryIndex } from "../oracle/parity";
import type { RegModule } from "../runtime/vm/regcode";

const ROOT = path.resolve(__dirname, "..", "..");
const KERNELS_DIR = path.join(ROOT, "tests", "dsp", "kernels");
const REFERENCE = path.join(ROOT, "tests", "dsp", "reference.json");

const encoder = getEncoder("internal-shell");

/** Пять ядер и атом, соответствующий природе каждого (`src/scripts/dspBoundarySufficiency.test.ts`). */
const KERNELS: Array<{ name: string; atom: string; algorithm: string }> = [
  { name: "fir", atom: "A5", algorithm: "FIR-фильтр" },
  { name: "iir", atom: "A5", algorithm: "IIR-фильтр" },
  { name: "fft", atom: "A5", algorithm: "БПФ radix-2" },
  { name: "convolution", atom: "A6", algorithm: "свёртка" },
  { name: "correlation", atom: "A6", algorithm: "корреляция" },
];

function readReference(): Record<string, { checksum: number }> {
  return JSON.parse(fs.readFileSync(REFERENCE, "utf-8")) as Record<string, { checksum: number }>;
}

/** Собрать ядро и проставить разметку атомов. */
function annotatedKernel(name: string, atom: string): RegModule {
  const source = fs.readFileSync(path.join(KERNELS_DIR, `${name}.osnova`), "utf-8");
  const built = regModuleOf(source);
  if (!built) throw new Error(`ядро не компилируется: ${name}`);
  const annotated = annotateAtomRegions(built.module, [
    { atom, procedures: built.module.procedures.map((p) => p.name) },
  ]);
  const problems = verifyAtomRegions(annotated);
  if (problems.length > 0) throw new Error(`${name}: разметка не прошла проверку: ${problems.join("; ")}`);
  return annotated;
}

/** Прогнать модуль напрямую на регистровой VM (без эмиттера) — для сравнения. */
async function runDirect(module: RegModule): Promise<unknown> {
  const entry = resolveEntryIndex(module.procedures, undefined) ?? 0;
  const host = createDefaultInvokeHandler();
  const vm = new RegVM(module, { maxSteps: 200_000, invoke: (n, a) => host(n, a) });
  return vm.runProcedure(entry, []);
}

describe("сквозной прогон: RegModule → эмиттер на оболочке → байты → декодер → VM", () => {
  it("эталон содержит значения всех пяти алгоритмов", () => {
    const reference = readReference();
    for (const { name } of KERNELS) {
      expect(reference[name], `в эталоне нет ${name}`).toBeDefined();
      expect(typeof reference[name]!.checksum, `${name}: checksum не число`).toBe("number");
    }
  });

  for (const { name, atom, algorithm } of KERNELS) {
    it(`${name} (${algorithm}, атом ${atom}): круг сохраняет семантику и совпадает с эталоном`, async () => {
      const reference = readReference();
      const module = annotatedKernel(name, atom);

      const emitted = emitShell(module, encoder);
      const decoded = decodeShellImage(emitted.image, encoder);

      // Код восстановлен побайтово из байтов: сравниваем с эталоном раскладки эмиттера
      // по инструкциям, а не по объектам.
      expect(decoded.code.length, `${name}: инструкций после круга`).toBe(emitted.scheduled.code.length);
      for (let i = 0; i < decoded.code.length; i++) {
        expect(
          sameRegInstruction(decoded.code[i]!, emitted.scheduled.code[i]!),
          `${name}: инструкция ${i} после круга отличается`,
        ).toBe(true);
      }

      // Метаданные модуля сохранены.
      expect(decoded.moduleName).toBe(module.moduleName);
      expect(decoded.constants).toEqual(module.constants);
      expect(decoded.procedures.map((p) => `${p.name}@${p.codeOffset}`)).toEqual(
        module.procedures.map((p) => `${p.name}@${p.codeOffset}`),
      );

      const value = await runShellImage(emitted.image, encoder);
      const direct = await runDirect(module);
      expect(Number(value), `${name}: круг ${String(value)}, напрямую ${String(direct)}`).toBe(Number(direct));
      expect(Number(value), `${name}: VM ${String(value)}, эталон ${reference[name]!.checksum}`).toBe(
        reference[name]!.checksum,
      );
    });
  }

  it("байты несут ровно столько слов, сколько инструкций, и карта совпадает с потоком", () => {
    for (const { name, atom } of KERNELS) {
      const module = annotatedKernel(name, atom);
      const emitted = emitShell(module, encoder);
      expect(emitted.image.bytes.length, `${name}: байт`).toBe(module.code.length * 10);
      expect(emitted.image.placement.length, `${name}: записей карты`).toBe(module.code.length);
      const decoded = decodeShellImage(emitted.image, encoder);
      expect(decoded.code.length, `${name}: слов после декодирования`).toBe(module.code.length);
    }
  });

  it("все пять ядер детерминированы: два круга дают одно и то же", async () => {
    for (const { name, atom } of KERNELS) {
      const module = annotatedKernel(name, atom);
      const first = emitShell(module, encoder);
      const second = emitShell(module, encoder);
      expect(Array.from(second.image.bytes), `${name}: байты второго прогона`).toEqual(
        Array.from(first.image.bytes),
      );
      const value = await runShellImage(first.image, encoder);
      const again = await runShellImage(second.image, encoder);
      expect(Number(again), `${name}: второй круг`).toBe(Number(value));
    }
  });

  it("перестановка внутри участков изменила порядок хотя бы у одного ядра", () => {
    // Иначе проверка границ атомов была бы пустой: нечего ограничивать.
    const changed = KERNELS.filter(({ name, atom }) => {
      const module = annotatedKernel(name, atom);
      return emitShell(module, encoder).report.regions.some((region) => region.reordered);
    });
    expect(changed.length, "ни одно ядро не переставлено — проверка границ пуста").toBeGreaterThan(0);
  });

  it("НАЙДЕНО: перестановка сохраняет семантику ядер (иначе круг расходится с эталоном)", async () => {
    // Если планировщик сломает семантику на этих ядрах, тест выше упадёт по несовпадению
    // с эталоном; здесь утверждается, что перестановка действительно применялась.
    const module = annotatedKernel("fir", "A5");
    const emitted = emitShell(module, encoder);
    expect(emitted.report.regions.every((region) => region.optimizable)).toBe(true);
    expect(emitted.report.limitations.join(" ")).toMatch(/упаковки нет/);
  });

  it("4.3 инструкция без носителя: без дефекта отказ, с дефектом потерю ловит круг", () => {
    // `obj.new` — операция рантайма: в документированном подмножестве её нет.
    const module: RegModule = {
      ir: "osnova-reg",
      version: 1,
      moduleName: "с-неподдержанной-операцией",
      constants: [],
      procedures: [{ name: "главная", codeOffset: 0, argc: 0, vregs: 4, localToVreg: {} }],
      code: [
        { op: "obj.new", d: 1 },
        { op: "ret", v: 1 },
      ] as RegModule["code"],
      atoms: [{ atom: "A5", optimizable: true, procedure: 0, start: 0, end: 2 }],
    };
    expect(() => emitShell(module, encoder), "без дефекта обязан быть отказ").toThrow(/не выражается/);

    const emitted = emitShell(module, encoder, { defects: { allowUnsupported: true } });
    const decoded = decodeShellImage(emitted.image, encoder);
    // Потеря видна ТОЛЬКО на уровне IR: шлюз кодировки её не видит (байты согласованы).
    expect(
      sameRegInstruction(decoded.code[0]!, emitted.scheduled.code[0]!),
      "подстановка носителя вместо отказа не замечена",
    ).toBe(false);
    expect(emitted.scheduled.code[0]!.op).toBe("obj.new");
    expect(decoded.code[0]!.op).toBe("move");
  });

  it("4.4 подстановка вместо разбора ломает круг", () => {
    const module = annotatedKernel("fir", "A5");
    const emitted = emitShell(module, encoder);
    const decoded = decodeShellImage(emitted.image, encoder, { defects: { identityDecode: true } });
    const same =
      decoded.code.length === emitted.scheduled.code.length &&
      decoded.code.every((instruction, index) =>
        sameRegInstruction(instruction, emitted.scheduled.code[index]!),
      );
    expect(same, "подстановка вместо разбора не замечена").toBe(false);
    // И нормальный разбор круг не ломает.
    const honest = decodeShellImage(emitted.image, encoder);
    expect(
      honest.code.every((instruction, index) =>
        sameRegInstruction(instruction, emitted.scheduled.code[index]!),
      ),
    ).toBe(true);
  });
});
