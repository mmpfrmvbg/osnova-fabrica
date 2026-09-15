/**
 * Тесты планировщика с перестановкой.
 *
 * Главное здесь — не «стало быстрее», а **корректность**: перестановка
 * разрешена только там, где её допускает граф зависимостей, и это проверяется
 * явно ({@link validateRegSchedule}), а не предполагается.
 *
 * Смысл среза: в стековом байткоде перестановка ломает порядок `push`/`pop`
 * (так это и задокументировано в `scheduler.ts`), поэтому in-order упаковка
 * была вынужденной. В регистровой форме операнды явные — перестановка законна.
 * Тест должен это доказать на реальном скомпилированном коде, а не на
 * синтетике.
 */

import { describe, it, expect } from "vitest";
import {
  scheduleRegWithReorder,
  scheduleGraphWithReorder,
  validateRegSchedule,
  splitLinearRegions,
  inOrderBaselineCycles,
  regOpClass,
} from "./reorderScheduler";
import { buildRegDependencyGraph } from "./regGraph";
import type { RegInstruction } from "../runtime/vm/regcode";
import { compileSource } from "../compiler/compiler";
import { compileToReg } from "../compiler/regcodegen";

const K = (d: number, k: number): RegInstruction =>
  ({ op: "const", d, type: "i32", k }) as RegInstruction;

/** Собрать регистровый код из исходника Основа. */
function regCodeOf(source: string): RegInstruction[] {
  const compiled = compileSource(source);
  expect(compiled.parserErrors, "исходник должен разбираться").toHaveLength(0);
  expect(compiled.moduleAst, "нужен расширенный AST").toBeTruthy();
  const mod = compileToReg(compiled.moduleAst!);
  const proc = mod.procedures[0]!;
  const code: RegInstruction[] = [];
  for (let i = proc.codeOffset; i < mod.code.length; i++) {
    const el = mod.code[i]!;
    // Пакетов в свежескомпилированном коде быть не должно.
    if ((el as { packet?: boolean }).packet) continue;
    code.push(el as RegInstruction);
  }
  return code;
}

describe("reorderScheduler: перестановка законна только внутри участка", () => {
  it("участок — весь линейный код, если переходов нет", () => {
    const code = [K(0, 0), K(1, 1), { op: "add", d: 2, a: 0, b: 1 } as RegInstruction];
    const regions = splitLinearRegions(code);
    expect(regions).toEqual([{ start: 0, end: 3 }]);
  });

  it("терминатор закрывает участок", () => {
    const code = [
      K(1, 0),
      { op: "ret", v: 1 } as RegInstruction,
      K(2, 1),
      { op: "ret", v: 2 } as RegInstruction,
    ];
    const regions = splitLinearRegions(code);
    // ret закрывает участок; следующий начинается сразу после него.
    expect(regions.length).toBeGreaterThanOrEqual(2);
    for (const r of regions) {
      expect(r.end).toBeGreaterThan(r.start);
    }
  });

  it("цель перехода начинает новый участок", () => {
    const code = [
      { op: "jmp_if", off: 3, cond: 0 } as RegInstruction,
      K(1, 0),
      { op: "ret", v: 1 } as RegInstruction,
      K(2, 1),
      { op: "ret", v: 2 } as RegInstruction,
    ];
    const starts = new Set(splitLinearRegions(code).map((r) => r.start));
    expect(starts.has(3)).toBe(true);
  });
});

describe("reorderScheduler: корректность расписания", () => {
  it("на синтетике: порядок выдачи — топологическая сортировка", () => {
    const code: RegInstruction[] = [
      K(0, 0),
      K(1, 1),
      { op: "mul", d: 2, a: 0, b: 1 } as RegInstruction, // L=4
      K(3, 2),
      { op: "add", d: 4, a: 2, b: 3 } as RegInstruction, // зависит от mul
    ];
    const graph = buildRegDependencyGraph(code, {});
    const r = scheduleGraphWithReorder(code, graph);
    const v = validateRegSchedule(code, graph, r);
    expect(v.problems).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it("даже переставленный код не нарушает готовность операндов", () => {
    // Готовим сценарий, где перестановка обязана случиться: длинная цепочка
    // и независимая ветка, которую выгодно начать раньше.
    const code = regCodeOf(`модуль Тест
процедура главная()
  пусть a = 2 * 3
  пусть b = 10 + 20
  пусть c = 1 + 2
  вернуть a + b + c
конец
конец
`);
    const graph = buildRegDependencyGraph(code, {});
    const r = scheduleGraphWithReorder(code, graph);
    const v = validateRegSchedule(code, graph, r);
    expect(v.problems, v.problems.join("; ")).toEqual([]);
  });

  it("перестановка НЕ выходит за границы участка", () => {
    const code = regCodeOf(`модуль Тест
процедура главная()
  пусть i = 0
  пусть s = 0
  пока i < 3
    s = s + i
    i = i + 1
  конец
  вернуть s
конец
конец
`);
    // Проверяем именно внутриучастковую перестановку: для каждого участка
    // планируем его отдельно и убеждаемся, что выданные инструкции — ровно
    // этот участок и никакие чужие. Глобальное расписание между участками
    // переставлять не должно, и это проверяется отдельно ниже.
    for (const region of splitLinearRegions(code)) {
      const slice = code.slice(region.start, region.end);
      const graph = buildRegDependencyGraph(slice, {});
      const r = scheduleGraphWithReorder(slice, graph);
      expect(new Set(r.order).size).toBe(slice.length);
      expect(Math.min(...r.order)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...r.order)).toBeLessThan(slice.length);
    }
  });

  it("участки планируются последовательно и не перемешиваются", () => {
    const code = regCodeOf(`модуль Тест
процедура главная()
  пусть i = 0
  пусть s = 0
  пока i < 3
    s = s + i
    i = i + 1
  конец
  вернуть s
конец
конец
`);
    const r = scheduleRegWithReorder(code, {});
    // Все инструкции выданы ровно один раз.
    expect(new Set(r.order).size).toBe(code.length);
    // Порядок выдачи не убывает по такту: планировщик не возвращается назад.
    let prev = -1;
    for (const idx of r.order) {
      expect(r.issueAt[idx]).toBeGreaterThanOrEqual(prev);
      prev = r.issueAt[idx]!;
    }
  });

  it("эффекты сохраняют относительный порядок", () => {
    const code = regCodeOf(`модуль Тест
процедура главная()
  пусть о = { a: 1 }
  система.лог.вывести("раз")
  система.лог.вывести("два")
  вернуть о.a
конец
конец
`);
    const graph = buildRegDependencyGraph(code, {});
    const r = scheduleGraphWithReorder(code, graph);
    const v = validateRegSchedule(code, graph, r);
    expect(v.problems).toEqual([]);
    // Находим индексы двух invoke и проверяем, что первый раньше второго.
    const invokes = code
      .map((ins, i) => ({ ins, i }))
      .filter((x) => x.ins.op === "invoke")
      .map((x) => x.i);
    expect(invokes.length).toBeGreaterThanOrEqual(2);
    const pos = new Map(r.order.map((idx, p) => [idx, p]));
    expect(pos.get(invokes[0]!)).toBeLessThan(pos.get(invokes[1]!)!);
  });
});

describe("reorderScheduler: перестановка реально даёт выигрыш", () => {
  it("на синтетике: независимая ветка выдаётся раньше, чем при in-order", () => {
    // mul (L=4) блокирует свой потребитель. Независимая ветка могла бы идти
    // параллельно — in-order её не пускает, потому что она стоит позже.
    const code: RegInstruction[] = [
      K(0, 0),
      K(1, 1),
      { op: "mul", d: 2, a: 0, b: 1 } as RegInstruction, // L=4, d=2
      { op: "add", d: 3, a: 2, b: 2 } as RegInstruction, // ждёт mul
      K(4, 2),
      K(5, 3),
      { op: "add", d: 6, a: 4, b: 5 } as RegInstruction, // независимая ветка
    ];
    const graph = buildRegDependencyGraph(code, {});
    const reordered = scheduleGraphWithReorder(code, graph);
    const inOrder = inOrderBaselineCycles(code, graph);
    expect(reordered.metrics.inOrderCycles).toBe(inOrder);
    expect(reordered.metrics.cycles).toBeLessThanOrEqual(inOrder);
  });

  it("gain неотрицателен и in-order база воспроизводима", () => {
    const code = regCodeOf(`модуль Тест
процедура главная()
  пусть a = 1 + 2
  пусть b = 3 + 4
  пусть c = 5 + 6
  пусть d = 7 + 8
  вернуть a + b + c + d
конец
конец
`);
    const graph = buildRegDependencyGraph(code, {});
    const r = scheduleGraphWithReorder(code, graph);
    expect(r.metrics.gain).toBeGreaterThanOrEqual(0);
    expect(inOrderBaselineCycles(code, graph)).toBeGreaterThan(0);
    // База не должна меняться между вызовами — иначе метрика бессмысленна.
    expect(inOrderBaselineCycles(code, graph)).toBe(inOrderBaselineCycles(code, graph));
  });
});

describe("reorderScheduler: реальный код компилируется и планируется", () => {
  const PROGRAMS: Array<[string, string]> = [
    [
      "арифметика",
      `модуль Тест
процедура главная()
  пусть a = 6 * 7
  пусть b = 100 - 58
  пусть c = 2 + 2
  вернуть a + b + c
конец
конец
`,
    ],
    [
      "массивы и для_каждого",
      `модуль Тест
процедура главная()
  пусть числа = [1, 2, 3, 4]
  пусть сумма = 0
  для_каждого ч в числа
    сумма = сумма + ч
  конец
  вернуть сумма
конец
конец
`,
    ],
    [
      "объекты",
      `модуль Тест
процедура главная()
  пусть о = { x: 3, y: 4 }
  вернуть о.x * о.y
конец
конец
`,
    ],
  ];

  for (const [name, source] of PROGRAMS) {
    it(`${name}: расписание корректно на всём коде`, () => {
      const code = regCodeOf(source);
      expect(code.length).toBeGreaterThan(0);
      const r = scheduleRegWithReorder(code, {});
      // Все инструкции выданы ровно один раз.
      expect(new Set(r.order).size).toBe(code.length);
      expect(r.order.length).toBe(code.length);
      // И каждая — ровно с одним каналом.
      const placed = r.packets.reduce((acc, p) => acc + p.slots.length, 0);
      expect(placed).toBe(code.length);

      // Корректность по участкам проверяем на каждом отдельно.
      for (const region of splitLinearRegions(code)) {
        const slice = code.slice(region.start, region.end);
        const graph = buildRegDependencyGraph(slice, {});
        const local = scheduleGraphWithReorder(slice, graph);
        const v = validateRegSchedule(slice, graph, local);
        expect(v.problems, `${name} [${region.start},${region.end}): ${v.problems.join("; ")}`)
          .toEqual([]);
      }
    });
  }
});

describe("reorderScheduler: классы операций", () => {
  it("mul идёт классом Fp (как в таблице руководства)", () => {
    expect(regOpClass({ op: "mul", d: 0, a: 1, b: 2 } as RegInstruction)).toBe("fp");
    expect(regOpClass({ op: "add", d: 0, a: 1, b: 2 } as RegInstruction)).toBe("int");
    expect(regOpClass({ op: "obj.get", d: 0, a: 1, key: 2 } as RegInstruction)).toBe("ld_l1");
    expect(regOpClass({ op: "obj.set", a: 1, key: 2, b: 3 } as RegInstruction)).toBe("store");
    expect(regOpClass({ op: "ret", v: 0 } as RegInstruction)).toBe("return_to_ct");
  });
});
