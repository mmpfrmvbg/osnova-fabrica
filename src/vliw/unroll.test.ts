import { describe, it, expect } from "vitest";
import { compileSource } from "../compiler/compiler";
import type { OsVbcModule } from "../runtime/vm/bytecode";
import { VM } from "../runtime/vm/interpreter";
import { unrollForEach } from "./unroll";
import { runUnrollOracle } from "./oracle";

function compileModule(src: string): OsVbcModule {
  const res = compileSource(src);
  if (!res.module) {
    const errs = [...res.lexerErrors, ...res.parserErrors].map((e) => e.message).join("; ");
    throw new Error(`компиляция не удалась: ${errs}`);
  }
  return res.module;
}

async function runEntry(mod: OsVbcModule): Promise<unknown> {
  return new VM(mod, { maxSteps: 1_000_000 }).runProcedure(0, []);
}

const SUM_SRC = `
модуль Тест
процедура главная()
  пусть сумма = 0
  для_каждого x в [1, 2, 3]
    сумма = сумма + x
  конец
  вернуть сумма
конец
конец
`;

const INDEX_SRC = `
модуль ТестИндекс
процедура главная()
  пусть последний = 0
  для_каждого x, индекс в [10, 20, 30]
    последний = индекс
  конец
  вернуть последний
конец
конец
`;

const ILP_SRC = `
модуль ТестНезавис
процедура главная()
  пусть первый = 0
  пусть второй = 0
  для_каждого x в [1, 2]
    первый = x + 1
    второй = x * 2
  конец
  вернуть первый + второй
конец
конец
`;

const EMPTY_SRC = `
модуль ТестПусто
процедура главная()
  пусть сумма = 0
  для_каждого x в []
    сумма = сумма + x
  конец
  вернуть сумма
конец
конец
`;

describe("vliw.unrollForEach", () => {
  it("разворачивает для_каждого по литералу: сумма = 6, нет управляющего потока", async () => {
    const mod = compileModule(SUM_SRC);
    const { module, tripCount, hasControlFlow } = unrollForEach(mod);

    expect(tripCount).toBe(3);
    expect(hasControlFlow).toBe(false);
    expect(await runEntry(module)).toBe(6);
  });

  it("сохраняет индекс: последний индекс = 2", async () => {
    const mod = compileModule(INDEX_SRC);
    const { module, tripCount, hasControlFlow } = unrollForEach(mod);

    expect(tripCount).toBe(3);
    expect(hasControlFlow).toBe(false);
    expect(await runEntry(module)).toBe(2);
  });

  it("пустой литерал: tripCount 0, сумма = 0", async () => {
    const mod = compileModule(EMPTY_SRC);
    const { module, tripCount } = unrollForEach(mod);

    expect(tripCount).toBe(0);
    expect(await runEntry(module)).toBe(0);
  });

  it("источник — переменная: без tripCount бросает, с tripCount разворачивает", async () => {
    const src = `
модуль ТестПеременная
процедура главная()
  пусть сумма = 0
  пусть числа = [1, 2, 3]
  для_каждого x в числа
    сумма = сумма + x
  конец
  вернуть сумма
конец
конец
`;
    const mod = compileModule(src);
    expect(() => unrollForEach(mod)).toThrow(/tripCount/);

    const { module, tripCount } = unrollForEach(mod, { tripCount: 3 });
    expect(tripCount).toBe(3);
    expect(await runEntry(module)).toBe(6);
  });
});

describe("vliw.runUnrollOracle", () => {
  it("unroll → пакеты → сверка: equal и линейный/пакетный результат = 6", async () => {
    const mod = compileModule(SUM_SRC);
    const report = await runUnrollOracle(mod);

    expect(report.tripCount).toBe(3);
    expect(report.hasControlFlow).toBe(false);
    expect(report.linearResult).toBe(6);
    expect(report.scheduledResult).toBe(6);
    expect(report.equal).toBe(true);
  });

  it("развёрнутый код пакуется в пакеты (packetCount < число инструкций)", async () => {
    const mod = compileModule(ILP_SRC);
    const report = await runUnrollOracle(mod);

    expect(report.equal).toBe(true);
    expect(report.linearResult).toBe(7);
    expect(report.scheduledResult).toBe(7);
    // Планировщик упаковал линейный код: пакетов меньше, чем инструкций после unroll.
    expect(report.packetCount).toBeGreaterThan(0);
    expect(report.packetCount).toBeLessThan(unrollForEach(mod).module.code.length);
    expect(report.avgSlots).toBeGreaterThan(1);
  });
});
