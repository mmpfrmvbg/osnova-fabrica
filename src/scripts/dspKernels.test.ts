/**
 * ОРАКУЛ DSP-ЯДЕР: каждая программа на Основе проходит на VM и совпадает с эталоном.
 *
 * ## Что проверяется
 *
 * Пять ядер (`tests/dsp/kernels/*.osnova`) исполняются на **той же регистровой VM**, что
 * и остальной проект, и их результат сверяется с `tests/dsp/reference.json` — артефактом
 * независимой реализации на Python (`tests/dsp/reference.py`).
 *
 * **Почему эталон читается из файла, а не запускается питоном.** В песочнице запуск
 * внешнего процесса с перехватом вывода ненадёжен, а тест, который «иногда не может
 * запуститься», бесполезен. Поэтому эталон зафиксирован артефактом: его создаёт
 * `python tests/dsp/reference.py --write`, а тест сверяет с ним значения. Совпадение
 * подтверждает, что ядро считает задуманное; расхождение — что оно разошлось с
 * определением из документации ядра.
 *
 * ## Что здесь НЕ проверяется
 *
 * Оптимизируемость ядер, такты, плотность упаковки. Это ядра для будущего эмиттера
 * (Фаза 4), а не замер: замеров на железе нет (`docs/hardware-debt.md`).
 */

import * as fs from "fs";
import * as path from "path";
import { describe, it, expect } from "vitest";
import { regModuleOf } from "../vliw/regOracle";
import { RegVM } from "../runtime/vm/reginterpreter";
import { createDefaultInvokeHandler } from "../runtime/vm/interpreter";
import { resolveEntryIndex } from "../oracle/parity";

const ROOT = path.resolve(__dirname, "..", "..");
const KERNELS_DIR = path.join(ROOT, "tests", "dsp", "kernels");
const REFERENCE = path.join(ROOT, "tests", "dsp", "reference.json");

/** Пять ядер и их алгоритмы — по одному на каждый пункт спецификации. */
const KERNELS: Array<{ name: string; algorithm: string }> = [
  { name: "fir", algorithm: "FIR-фильтр" },
  { name: "iir", algorithm: "IIR-фильтр" },
  { name: "fft", algorithm: "БПФ radix-2" },
  { name: "convolution", algorithm: "свёртка" },
  { name: "correlation", algorithm: "корреляция" },
];

interface Reference {
  [algorithm: string]: { checksum: number; output: number[] };
}

function readReference(): Reference {
  if (!fs.existsSync(REFERENCE)) throw new Error("нет tests/dsp/reference.json");
  return JSON.parse(fs.readFileSync(REFERENCE, "utf-8")) as Reference;
}

/** Прогнать ядро на регистровой VM. */
async function runKernel(name: string, maxSteps = 200_000): Promise<unknown> {
  const source = fs.readFileSync(path.join(KERNELS_DIR, `${name}.osnova`), "utf-8");
  const built = regModuleOf(source);
  if (!built) throw new Error(`ядро не компилируется: ${name}`);
  const entry = resolveEntryIndex(built.module.procedures, undefined) ?? 0;
  const host = createDefaultInvokeHandler();
  const vm = new RegVM(built.module, { maxSteps, invoke: (n, a) => host(n, a) });
  return vm.runProcedure(entry, []);
}

describe("DSP-ядра: программы на Основе против независимого эталона", () => {
  it("эталон содержит значения для всех пяти алгоритмов", () => {
    const reference = readReference();
    for (const { name } of KERNELS) {
      expect(reference[name], `в эталоне нет ${name}`).toBeDefined();
      expect(typeof reference[name]!.checksum, `${name}: checksum не число`).toBe("number");
    }
  });

  it("все пять ядер существуют как программы на Основе", () => {
    for (const { name } of KERNELS) {
      expect(fs.existsSync(path.join(KERNELS_DIR, `${name}.osnova`)), `нет ${name}.osnova`).toBe(true);
    }
  });

  for (const { name, algorithm } of KERNELS) {
    it(`${name} (${algorithm}): результат на VM совпадает с эталоном`, async () => {
      const reference = readReference();
      const value = await runKernel(name);
      // Сравнение числовое: в языке `/` вещественное, и целое значение может прийти
      // как 119.0 — это тот же результат.
      expect(Number(value), `VM: ${String(value)}, эталон: ${reference[name]!.checksum}`).toBe(
        reference[name]!.checksum,
      );
    });
  }

  it("ядра детерминированы: два прогона дают одно и то же", async () => {
    for (const { name } of KERNELS) {
      const first = await runKernel(name);
      const second = await runKernel(name);
      expect(Number(second), `${name}: второй прогон отличается`).toBe(Number(first));
    }
  });
});
