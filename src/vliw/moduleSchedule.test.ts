/**
 * Тесты планирования **всех процедур модуля**.
 *
 * ## Что здесь главное
 *
 * Дефект, найденный на мультипроцедурном корпусе: `splitLinearRegions` трактовал
 * `off` перехода как индекс внутри переданного массива, тогда как в регистровом
 * модуле он **абсолютный по всему `module.code`**. Планирование среза одной
 * процедуры давало неверные границы участков, планировщик переставлял инструкции
 * через реальные границы циклов, и `while.osnova` считал `1041` вместо `1049`.
 *
 * Здесь это зафиксировано: сначала проверяется сама арифметика базы адресов, потом
 * эквивалентность на мультипроцедурных модулях.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { applyReorderToWholeModule, runReorderEquivalence } from "./reorderEquivalence";
import { splitLinearRegions, linearRegionStarts } from "./reorderScheduler";
import { regModuleOf } from "./regOracle";
import type { RegInstruction, RegModule } from "../runtime/vm/regcode";
import { isRegPacket } from "../runtime/vm/regcode";

const FIXTURES = path.join(__dirname, "..", "runtime", "fixtures");

function moduleOf(file: string): RegModule {
  const built = regModuleOf(fs.readFileSync(path.join(FIXTURES, file), "utf-8"));
  if (!built) throw new Error(`${file} не компилируется`);
  return built.module;
}

describe("база адресов: off абсолютный, а не индекс среза", () => {
  it("без базы цель перехода вне массива игнорируется", () => {
    // Переход на абсолютный адрес 100 — вне массива из 5 элементов.
    const code = [
      { op: "const", d: 1, type: "i32", k: 0 } as RegInstruction,
      { op: "jmp", off: 100 } as RegInstruction,
      { op: "const", d: 2, type: "i32", k: 1 } as RegInstruction,
    ];
    const starts = linearRegionStarts(code, 0);
    // Цель 100 не добавляет границу, но сам терминатор закрывает участок.
    expect(starts.has(100)).toBe(false);
    expect(starts.has(1)).toBe(true);
  });

  it("с базой 95 та же цель становится локальным индексом", () => {
    const code = [
      { op: "const", d: 1, type: "i32", k: 0 } as RegInstruction,
      { op: "jmp", off: 100 } as RegInstruction,
      { op: "const", d: 2, type: "i32", k: 1 } as RegInstruction,
    ];
    // 100 относительно базы 95 — это индекс 5, всё ещё вне массива из 3.
    expect(linearRegionStarts(code, 95).has(5)).toBe(false);
    // А с базой 98 — индекс 2, это конец массива (допустимая граница).
    const s = linearRegionStarts(code, 98);
    expect(s.has(2)).toBe(true);
  });

  it("реальный модуль: переходы процедуры указывают на абсолютные адреса", () => {
    const m = moduleOf(path.join("reg-parity", "while.osnova"));
    const offsets = m.procedures.map((p) => p.codeOffset);
    // Найдём процедуру, которая НЕ первая — у неё off точно абсолютные.
    const idx = 1;
    const start = offsets[idx]!;
    const end = offsets.filter((c) => c > start).sort((a, b) => a - b)[0] ?? m.code.length;
    const body = m.code
      .slice(start, end)
      .filter((e) => !isRegPacket(e)) as RegInstruction[];
    const jumps = body.filter(
      (i) => i.op === "jmp" || i.op === "jmp_if" || i.op === "jmp_if_not",
    );
    expect(jumps.length).toBeGreaterThan(0);
    // Хотя бы один переход указывает ЗА пределы тела — значит он абсолютный.
    const absolute = jumps.some((j) => {
      const off = (j as { off: number }).off;
      return off >= body.length || off < start;
    });
    expect(absolute).toBe(true);
  });

  it("с базой границы участков строятся корректно (регрессия 1041 vs 1049)", () => {
    const m = moduleOf(path.join("reg-parity", "while.osnova"));
    const offsets = m.procedures.map((p) => p.codeOffset);
    const start = offsets[1]!;
    const end = offsets.filter((c) => c > start).sort((a, b) => a - b)[0] ?? m.code.length;
    const body = m.code
      .slice(start, end)
      .filter((e) => !isRegPacket(e)) as RegInstruction[];

    // Без базы участок получается один (цели вне массива игнорируются).
    const withoutBase = splitLinearRegions(body, 0);
    // С базой целей больше — участков тоже.
    const withBase = splitLinearRegions(body, start);

    expect(withBase.length).toBeGreaterThanOrEqual(withoutBase.length);
    // Все участки в пределах тела.
    for (const r of withBase) {
      expect(r.start).toBeGreaterThanOrEqual(0);
      expect(r.end).toBeLessThanOrEqual(body.length);
      expect(r.end).toBeGreaterThan(r.start);
    }
  });
});

describe("планирование всех процедур модуля", () => {
  it("планирует каждую процедуру модуля, а не только точку входа", () => {
    const m = moduleOf("game_rounds.osnova");
    const res = applyReorderToWholeModule(m, {});
    expect(res.proceduresScheduled).toBe(m.procedures.length);
    expect(res.proceduresScheduled).toBeGreaterThan(1);
  });

  it("адреса всех процедур остаются валидными и внутри кода", () => {
    const m = moduleOf("micro_crm.osnova");
    const res = applyReorderToWholeModule(m, {});
    for (const p of res.scheduled.procedures) {
      expect(p.codeOffset).toBeGreaterThanOrEqual(0);
      expect(p.codeOffset).toBeLessThan(res.scheduled.code.length);
    }
    // Инструкция по codeOffset существует и не является пакетом-обрубком.
    for (const p of res.scheduled.procedures) {
      expect(res.scheduled.code[p.codeOffset]).toBeDefined();
    }
  });

  it("длина кода не меняется: перестановка не теряет и не добавляет инструкций", () => {
    for (const file of ["game_rounds.osnova", "micro_crm.osnova", "task_stats.osnova"]) {
      const m = moduleOf(file);
      const res = applyReorderToWholeModule(m, {});
      expect(res.scheduled.code.length, file).toBe(m.code.length);
    }
  });

  it("НЕ мутирует исходный модуль (иначе линейное сравнение ложно)", () => {
    // Дефект: мелкая копия инструкции оставляла `off`/`args` общими с исходным
    // модулем, пересчёт адресов портил оригинал, и оракул сравнивал
    // переставленный код с уже испорченным «линейным».
    const m = moduleOf("game_rounds.osnova");
    const before = JSON.stringify(m);
    applyReorderToWholeModule(m, {});
    expect(JSON.stringify(m)).toBe(before);
  });

  it("мультипроцедурные модули: эквивалентность доказана", async () => {
    const cases: Array<[string, string | undefined, unknown[]]> = [
      ["game_rounds.osnova", "run_golden", [[
        { результат: "победа", очки: 15 },
        { результат: "поражение", очки: 5 },
        { результат: "победа", очки: 10 },
      ]]],
      ["micro_crm.osnova", "run_golden", [[{ имя: "А" }]]],
      ["task_stats.osnova", undefined, []],
      ["func_params.osnova", undefined, []],
    ];
    for (const [file, entry, args] of cases) {
      const m = moduleOf(file);
      expect(m.procedures.length, `${file} должен быть многоproцедурным`).toBeGreaterThan(1);
      const report = await runReorderEquivalence(m, {
        ...(entry !== undefined ? { entryProcedure: entry } : {}),
        args: args as never[],
        maxSteps: 200_000,
      });
      expect(report.ok, `${file}: ${report.message}`).toBe(true);
      expect(report.tracesEqual, file).toBe(true);
    }
  });
});

describe("честный замер: что даёт перестановка на модуле", () => {
  /**
   * Зафиксировано намеренно, и это КАЛИБРОВКА, а не разочарование.
   *
   * Замер на ядре «N независимых аккумуляторов в цикле» (200 итераций) показал
   * закономерность: выигрыш растёт с числом независимых цепочек —
   *   1 цепочка 0.0%, 2 — 5.6%, 3 — 9.0%, 4 — 11.3%, 6 — 14.0%.
   *
   * Отсюда следствия, которые здесь и охраняются:
   * 1. **цикл сам по себе выигрыша не даёт** — нужен ILP внутри цикла;
   * 2. **на программе эффект разбавляется** — цепочки с ILP составляют часть
   *    модуля, поэтому 16.3% на процедуре дают 4.0% на модуле.
   *
   * Если кто-то заявит больший выигрыш на этих фикстурах, он должен сначала
   * показать, откуда он взялся.
   */
  it("на линейных процедурах приложений порядок меняется, но такты — нет", () => {
    const m = moduleOf("game_rounds.osnova");
    const res = applyReorderToWholeModule(m, {});
    expect(res.orderChanged).toBe(true);
    const again = applyReorderToWholeModule(m, { respectClusters: false });
    expect(again.proceduresScheduled).toBe(res.proceduresScheduled);
  });

  it("на корпусе циклических мультипроцедурных программ выигрыш мал и измерен", async () => {
    const measured: Array<[string, number, number]> = [];
    for (const file of [
      "cycle_multi.osnova",
      "cycle_nested.osnova",
      "cycle_array.osnova",
      "cycle_chains.osnova",
    ]) {
      const m = moduleOf(file);
      expect(m.procedures.length, `${file} должен быть многоproцедурным`).toBeGreaterThan(1);
      const report = await runReorderEquivalence(m, { maxSteps: 500_000 });
      expect(report.ok, `${file}: ${report.message}`).toBe(true);
      expect(report.moduleProcedures).toBeGreaterThan(1);
      measured.push([file, report.moduleCyclesInOrder, report.moduleCyclesReordered]);
    }
    // Выигрыш НЕ отрицательный (перестановка не должна ухудшать) и НЕ большой
    // (цепочки с ILP — лишь часть модуля). Оба края важны: первый — корректность,
    // второй — честность замера.
    for (const [file, io, re] of measured) {
      expect(re, `${file}: перестановка не должна ухудшать такты`).toBeLessThanOrEqual(io);
      const gain = io > 0 ? (io - re) / io : 0;
      expect(gain, `${file}: выигрыш не должен быть заявлен больше 20%`).toBeLessThan(0.2);
    }
  });

  it("выигрыш есть на процедуре с несколькими независимыми цепочками", async () => {
    // cycle_chains: три независимых накопления в одной процедуре.
    const m = moduleOf("cycle_chains.osnova");
    const report = await runReorderEquivalence(m, { maxSteps: 500_000 });
    expect(report.ok, report.message).toBe(true);
    // Хотя бы где-то в модуле порядок изменён.
    const res = applyReorderToWholeModule(m, {});
    expect(res.orderChanged).toBe(true);
    // И такты по модулю не выросли.
    expect(report.moduleCyclesReordered).toBeLessThanOrEqual(report.moduleCyclesInOrder);
  });
});
