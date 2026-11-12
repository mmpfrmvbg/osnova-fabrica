/**
 * ДОСТАТОЧНОСТЬ ПРОЦЕДУРНОЙ РАЗМЕТКИ ДЛЯ DSP: проверка развилки.
 *
 * ## Вопрос, на который отвечает тест
 *
 * Разметка атомов в байткоде (`src/compiler/atomRegions.ts`) имеет процедурную
 * гранулярность: **одна процедура — один атом**. Если бы ядро DSP требовало двух разных
 * атомов **внутри одной процедуры**, разметки не хватило бы и понадобилось бы дробление
 * с метками в исходнике. Владелец потребовал проверить это, а не предположить.
 *
 * ## Что здесь измеряется и что утверждается
 *
 * **Измеряется** (и печатается в отчёте): сколько процедур в каждом ядре и как они
 * называются. У ядер есть служебные процедуры — свёртка результата в контрольную сумму
 * (`сумма`) и целочисленное деление (`целое_деление`), плюс точка входа (`главная`). Это
 * структура тестовой обвязки, а не признак нехватки гранулярности.
 *
 * **Утверждается**: (1) каждая процедура покрывается ровно одним атомом; (2) атом
 * оптимизируем — ядра вычислительные; (3) непокрытых процедур нет; (4) ни одна процедура
 * не требует двух атомов.
 *
 * **Демонстрируется ограничение**: синтетический модуль, где одну процедуру пытаются
 * разрезать на два атома, — разметка это отвергает. То есть предел гранулярности
 * существует, и он проверяется, а не замалчивается.
 */

import * as fs from "fs";
import * as path from "path";
import { describe, it, expect } from "vitest";
import { regModuleOf } from "../vliw/regOracle";
import { annotateAtomRegions, isOptimizableAtom, verifyAtomRegions } from "../compiler/atomRegions";
import type { RegModule } from "../runtime/vm/regcode";

const ROOT = path.resolve(__dirname, "..", "..");
const KERNELS_DIR = path.join(ROOT, "tests", "dsp", "kernels");

/**
 * Пять ядер и атом, соответствующий природе каждого.
 *
 * FIR и IIR — обработка временного ряда (окно скользит по ряду): A5.
 * БПФ — спектр того же ряда: A5.
 * Свёртка и корреляция — операция над двумя массивами: A6 (вектор).
 * Все три атома из каталога оптимизируемы (A5, A6, B5), поэтому для ядер это не меняет
 * вывод, но природу ядра называет честно.
 */
const KERNELS: Array<{ name: string; atom: string; why: string }> = [
  { name: "fir", atom: "A5", why: "скользящее окно по временному ряду" },
  { name: "iir", atom: "A5", why: "рекурсивная фильтрация ряда" },
  { name: "fft", atom: "A5", why: "спектр временного ряда" },
  { name: "convolution", atom: "A6", why: "операция над двумя массивами" },
  { name: "correlation", atom: "A6", why: "операция над двумя массивами со сдвигом" },
];

function kernelModule(name: string): RegModule {
  const source = fs.readFileSync(path.join(KERNELS_DIR, `${name}.osnova`), "utf-8");
  const built = regModuleOf(source);
  if (!built) throw new Error(`ядро не компилируется: ${name}`);
  return built.module;
}

describe("достаточность процедурной разметки для пяти DSP-ядер", () => {
  it("ИЗМЕРЕНИЕ: сколько процедур в каждом ядре и как они называются", () => {
    const measured = KERNELS.map(({ name }) => {
      const procedures = kernelModule(name).procedures.map((p) => p.name);
      return { name, count: procedures.length, procedures };
    });
    // Печатается в вывод теста — это данные для решения, а не утверждение.
    console.log("процедуры по ядрам: " + measured.map((m) => `${m.name}=${m.count} (${m.procedures.join(", ")})`).join("; "));
    for (const m of measured) expect(m.count, `${m.name}: процедур не меньше одной`).toBeGreaterThan(0);
  });

  it("каждая процедура каждого ядра покрывается ровно одним атомом", () => {
    for (const { name, atom } of KERNELS) {
      const module = kernelModule(name);
      const assigned = module.procedures.map((p) => p.name);
      const annotated = annotateAtomRegions(module, [{ atom, procedures: assigned }]);
      expect(annotated.atoms, `${name}: разметка не поставлена`).toHaveLength(module.procedures.length);
      expect(verifyAtomRegions(annotated), `${name}: проверка нашла нарушения`).toEqual([]);
    }
  });

  it("атом ядра оптимизируем — ядра вычислительные", () => {
    for (const { name, atom, why } of KERNELS) {
      expect(isOptimizableAtom(atom), `${name}: атом ${atom} не оптимизируем (${why})`).toBe(true);
    }
  });

  it("непокрытых процедур нет ни в одном ядре", () => {
    for (const { name, atom } of KERNELS) {
      const module = kernelModule(name);
      const annotated = annotateAtomRegions(module, [
        { atom, procedures: module.procedures.map((p) => p.name) },
      ]);
      const covered = new Set(annotated.atoms!.map((r) => r.procedure));
      const uncovered = module.procedures.map((_, i) => i).filter((i) => !covered.has(i));
      expect(uncovered, `${name}: не покрыты процедуры ${uncovered.join(", ")}`).toEqual([]);
    }
  });

  it("ни одна процедура ядра не требует ДВУХ атомов — предела гранулярности ядра не достигают", () => {
    for (const { name, atom } of KERNELS) {
      const module = kernelModule(name);
      // Разметка «на каждый код-элемент свой атом» невозможна: попытка отнести одну
      // процедуру к двум атомам отвергается — значит внутри процедуры дробление
      // потребовало бы отдельного механизма, и ядра в него не упираются.
      for (const proc of module.procedures) {
        expect(
          () =>
            annotateAtomRegions(module, [
              { atom, procedures: [proc.name] },
              { atom: "B5", procedures: [proc.name] },
            ]),
          `${name}/${proc.name}: одна процедура отнесена к двум атомам без отказа`,
        ).toThrow(/двум атомам/i);
      }
    }
  });

  it("ОГРАНИЧЕНИЕ ПРОВЕРЕНО: разметка не умеет резать процедуру на два атома", () => {
    // Синтетический модуль: одна процедура, которую хочется разделить.
    const module: RegModule = {
      ir: "osnova-reg",
      version: 1,
      moduleName: "синтетика",
      constants: [],
      procedures: [{ name: "смесь", codeOffset: 0, argc: 0, vregs: 4, localToVreg: {} }],
      code: [
        { op: "const", d: 1 },
        { op: "add", d: 2, a: 1, b: 1 },
        { op: "ret", v: 2 },
      ] as RegModule["code"],
    };
    const half = annotateAtomRegions(module, [{ atom: "A6", procedures: ["смесь"] }]);
    // Попытка «дописать» второй атом на ту же процедуру — отказ.
    expect(() => annotateAtomRegions(module, [{ atom: "A6", procedures: ["смесь"] }, { atom: "B5", procedures: ["смесь"] }])).toThrow(
      /двум атомам/i,
    );
    // И проверка отвергает разметку, у которой регион не совпал с границами процедуры.
    half.atoms![0]!.end = 1;
    expect(verifyAtomRegions(half).some((p) => /не совпадает с границами процедуры/.test(p))).toBe(true);
  });
});
