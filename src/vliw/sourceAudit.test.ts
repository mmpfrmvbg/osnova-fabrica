/**
 * Аудит источников: каждое число в модели железа обязано иметь источник.
 *
 * ## Зачем
 *
 * Владелец заметил: за сессию трижды находилась выдумка в данных —
 * 1. модель слотов `I0/I1/M/B` с «все операции 1 такт» — имён и утверждения нет
 *    в руководстве;
 * 2. `global.get`/`global.set`/`field.get`/`field.set`/`result.unwrap`/
 *    `result.tag` — опкоды, которых в языке не существует;
 * 3. `ret` не был объявлен эффектом.
 *
 * Общий признак: **данные выглядели как факт, но источника не имели.** Поэтому
 * проверка должна быть не «прочитать и подумать», а исполняемой: каждое число
 * обязано нести метку источника рядом с собой.
 *
 * ## Как проверяется
 *
 * Читается исходный текст `src/vliw/e2kDevices.ts` (не скомпилированный модуль),
 * и для каждого экспортируемого числа/таблицы в 1200 символах перед объявлением
 * ищется одна из меток:
 *
 * - `ИСТОЧНИК:` — с номером страницы руководства (`стр. N`) ИЛИ с явным
 *   указанием, что это наше решение (`наш`, `НАШЕ РЕШЕНИЕ`, `НЕ ДОКУМЕНТ`);
 * - `Стр. N` — короткая форма цитаты.
 *
 * Если метки нет — тест падает и требует её добавить. Так «забыть указать
 * источник» становится невозможно, а «выдумать число» — заметно на ревью.
 *
 * ## Что этот тест НЕ делает
 *
 * Он не проверяет, что источник ПРАВИЛЬНЫЙ — только что он заявлен. Проверка
 * правильности источника — это уже чтение документа человеком. Тест закрывает
 * ровно ту дыру, из-за которой выдумка попадала в код незамеченной.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const E2K_DEVICES = path.join(__dirname, "e2kDevices.ts");

/** Объявления, которые обязаны нести источник: числа и таблицы модели. */
const REQUIRES_SOURCE: readonly string[] = [
  "CHANNELS",
  "ALL_CHANNELS",
  "E2K_ISSUE_WIDTH",
  "ALU_CLUSTER",
  "UNITS",
  "LATENCY",
  "DOMAIN_PENALTY",
  "REGISTER_FILE",
  "PREDICATE_FILE",
];

const SOURCE_MARKERS = ["источник:", "стр."];

describe("аудит источников: числа модели несут источник", () => {
  const text = fs.readFileSync(E2K_DEVICES, "utf-8");

  it("файл модели читается и содержит ожидаемые объявления", () => {
    expect(text.length).toBeGreaterThan(1000);
    for (const name of REQUIRES_SOURCE) {
      expect(text, `нет объявления ${name}`).toContain(`export const ${name}`);
    }
  });

  for (const name of REQUIRES_SOURCE) {
    it(`«${name}»: рядом указан источник`, () => {
      const at = text.indexOf(`export const ${name}`);
      expect(at, `не найдено объявление ${name}`).toBeGreaterThan(-1);
      const window = text.slice(Math.max(0, at - 1200), at);
      const lower = window.toLowerCase();
      const hasMarker = SOURCE_MARKERS.some((m) => lower.includes(m));
      expect(
        hasMarker,
        `У «${name}» нет пометки источника в комментарии выше. Каждое число модели ` +
          `обязано нести ИСТОЧНИК: либо «стр. N» (руководство МЦСТ), либо явное ` +
          `«НАШЕ РЕШЕНИЕ, НЕ ДОКУМЕНТ». Без этого выдумку невозможно отличить от факта.`,
      ).toBe(true);
    });
  }
});

/**
 * Убирает комментарии из исходника, оставляя код.
 *
 * Нужно потому, что сами предупреждения про выдуманные опкоды живут в
 * комментариях (`«здесь когда-то были `global.get`/`field.get` — их нет в языке»`),
 * и без очистки поиск ловил бы собственные пояснения вместо кода.
 */
function stripComments(src: string): string {
  // Блочные комментарии — до строчных, чтобы не порвать границы.
  let out = src.replace(/\/\*[\s\S]*?\*\//g, " ");
  // Строчные комментарии.
  out = out.replace(/\/\/[^\n]*/g, " ");
  return out;
}

describe("аудит источников: выдуманные опкоды не вернулись", () => {
  /**
   * Опкоды, которых в языке НЕТ. Они уже однажды жили в модели слотов и в
   * `dependencyGraph.ts` и создавали видимость поддержки глобальных переменных и
   * Result-типов. Проверяем, что они не вернулись нигде в `src/vliw/`.
   */
  const PHANTOM = [
    "global.get",
    "global.set",
    "field.get",
    "field.set",
    "result.unwrap",
    "result.tag",
  ];

  it("в src/vliw нет ветвей на несуществующие опкоды (в коде, не в комментариях)", () => {
    const dir = path.join(__dirname);
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

    const offenders: string[] = [];
    for (const f of files) {
      const code = stripComments(fs.readFileSync(path.join(dir, f), "utf-8"));
      for (const op of PHANTOM) {
        // Опкод как СТРОКОВЫЙ ЛИТЕРАЛ в коде.
        const re = new RegExp(`["'\`]${op.replace(".", "\\.")}["'\`]`);
        if (re.test(code)) {
          offenders.push(`${f}: ${op}`);
        }
      }
    }
    expect(
      offenders,
      `Найдены несуществующие опкоды в коде: ${offenders.join(", ")}. ` +
        `Канонический список — ALL_OPS в src/runtime/vm/bytecode.ts.`,
    ).toEqual([]);
  });

  it("комментарии про эти опкоды сохранены — они объясняют, что их нельзя возвращать", () => {
    // Если бы эти комментарии исчезли, следующий автор снова добавил бы ветки
    // «на всякий случай», как это уже было. Проверяем оба места, где они жили:
    // зависимость по стеку и модель слотов.
    const dep = fs.readFileSync(path.join(__dirname, "dependencyGraph.ts"), "utf-8");
    expect(dep).toContain("global.get");
    expect(dep).toContain("result.tag");
    const model = fs.readFileSync(path.join(__dirname, "e2kModel.ts"), "utf-8");
    expect(model).toContain("global.get");
    expect(model).toContain("field.get");
  });
});
