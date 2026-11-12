/**
 * Аудит источников: каждое число модели обязано иметь источник.
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
 *
 * ## Расширение на VM (`src/runtime/vm/`)
 *
 * Второй блок проверяет слой виртуальной машины. Там выдумку искать нужно иначе:
 * у VM числа — это в основном **константы поведения** (лимит шагов, версии
 * формата), а не физические величины из документа. Для них требование иное:
 * константа обязана быть либо объяснена рядом, либо помечена как НАШЕ РЕШЕНИЕ.
 *
 * Отдельно проверяется то, где выдумка была бы настоящим дефектом, а не
 * неточностью комментария: **согласованность реестра арностей системных вызовов
 * с фактическим поведением VM** (`INVOKE_ARG_COUNT`). Ошибка в этой таблице не
 * даёт ошибки компиляции: стек «уезжает» на один элемент, и ошибка проявляется
 * далеко от места. Проверка механическая — все 78 syscalls прогоняются.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { INVOKE_ARG_COUNT } from "../runtime/vm/invokeRegistry";
import { VM } from "../runtime/vm/interpreter";
import type { OsVbcModule } from "../runtime/vm/bytecode";

const E2K_DEVICES = path.join(__dirname, "e2kDevices.ts");
const VM_DIR = path.join(__dirname, "..", "runtime", "vm");

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

// ---------------------------------------------------------------------------
// Слой виртуальной машины
// ---------------------------------------------------------------------------

describe("аудит источников: константы VM объяснены или помечены", () => {
  /**
   * Константы, которые задают наблюдаемое поведение VM. Для каждой требуется
   * объяснение рядом: откуда число. Это не «выдумка или нет» (проверить
   * «правильность» лимита шагов нечем), а требование **явности**: читатель
   * должен видеть, что число выбрано нами, а не взято из стандарта.
   */
  const VM_CONSTANTS: Array<{ file: string; marker: string; what: string }> = [
    { file: "interpreter.ts", marker: "1_000_000", what: "лимит шагов стековой VM" },
    { file: "reginterpreter.ts", marker: "1_000_000", what: "лимит шагов регистровой VM" },
    { file: "bytecode.ts", marker: "BYTECODE_VERSION", what: "версия формата" },
    { file: "regcode.ts", marker: "REGCODE_VERSION", what: "версия формата" },
    { file: "regcode.ts", marker: "REGCODE_IR", what: "имя IR" },
  ];

  for (const { file, marker, what } of VM_CONSTANTS) {
    it(`${file}: «${marker}» (${what}) объяснён рядом`, () => {
      const src = fs.readFileSync(path.join(VM_DIR, file), "utf-8");
      const at = src.indexOf(marker);
      expect(at, `не найдено «${marker}» в ${file}`).toBeGreaterThan(-1);
      // Берём окно вверх и вниз: объяснение может стоять до или после.
      const window = src.slice(Math.max(0, at - 1500), at + 500).toLowerCase();
      const explained = [
        "источник:",
        "наше решение",
        "наш ",
        "политика",
        "лимит",
        "защита от",
        "версия формата",
        "решение проекта",
      ].some((m) => window.includes(m));
      expect(
        explained,
        `У «${marker}» в ${file} нет объяснения рядом. Константа поведения обязана ` +
          `нести пометку: откуда она (стандарт, документ) или что это НАШЕ РЕШЕНИЕ ` +
          `(политика, защита от зацикливания). Иначе её нельзя отличить от выдумки.`,
      ).toBe(true);
    });
  }
});

describe("аудит источников: реестр арностей согласован с VM", () => {
  /**
   * `INVOKE_ARG_COUNT` — таблица «имя syscall → сколько аргументов снять со
   * стека». Ошибка здесь НЕ даёт ошибки компиляции и не всегда видна в тестах:
   * стек уезжает на один элемент, и ошибка проявляется далеко от места.
   *
   * Проверка механическая: для каждого syscall генерируется программа, которая
   * кладёт ровно объявленное число аргументов и вызывает его. Если объявление
   * расходится с реализацией, прогон падает на underflow стека.
   */
  it("все арности — целые неотрицательные числа", () => {
    const bad: string[] = [];
    for (const [name, argc] of Object.entries(INVOKE_ARG_COUNT)) {
      if (!Number.isInteger(argc) || argc < 0) bad.push(`${name}=${argc}`);
    }
    expect(bad, `некорректные арности: ${bad.join(", ")}`).toEqual([]);
  });

  it("реестр не пуст и содержит ожидаемые имена", () => {
    const names = Object.keys(INVOKE_ARG_COUNT);
    expect(names.length).toBeGreaterThan(50);
    expect(names).toContain("система.лог.вывести");
    expect(names).toContain("система.массив.создать");
    expect(names).toContain("система.массив.получить");
  });

  it("каждый syscall исполняется с объявленным числом аргументов", async () => {
    const failures: string[] = [];
    for (const [name, argc] of Object.entries(INVOKE_ARG_COUNT)) {
      const proc = { name: "тест", codeOffset: 0, argc: 0, localsCount: argc + 2 };
      const code: Array<Record<string, unknown>> = [];
      for (let i = 0; i < argc; i++) code.push({ op: "const.null" });
      code.push({ op: "invoke", name });
      code.push({ op: "local.set", i: argc });
      code.push({ op: "ret" });
      const module: OsVbcModule = {
        version: 1,
        moduleName: "тест",
        constants: [],
        procedures: [proc],
        code: code as never,
      };
      try {
        const vm = new VM(module, { invoke: () => null, maxSteps: 1000 });
        await vm.runProcedure(0, []);
      } catch (e) {
        failures.push(`${name} (argc=${argc}): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    expect(failures, `syscalls с расхождением арности: ${failures.join("; ")}`).toEqual([]);
  });
});
