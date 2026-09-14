/**
 * Надёжность разбора: парсер обязан **завершаться** на любом входе.
 *
 * Причина этих тестов — реальный вечный цикл/OOM: `попробовать` + слово вместо
 * `иначе_попытка` (`поймать` — типичное написание модели) не давал парсеру
 * сдвинуться, и разбор висел бесконечно. Для агентной фабрики это худший класс
 * бага: любая сгенерированная программа с `поймать` вешала процесс.
 */

import { describe, it, expect } from "vitest";
import { tokenize } from "./lexer";
import { parse } from "./parser";
import { compileSource } from "./compiler";

function parseSource(source: string) {
  const { tokens, errors: lexerErrors } = tokenize(source);
  const { ast, errors } = parse(tokens);
  return { ast, errors, lexerErrors, tokens };
}

/** Тест с жёстким лимитом времени: вечный цикл роняет тест, а не весь прогон. */
const ITERM_TIMEOUT_MS = 5000;

describe("parser-robustness: разбор всегда завершается", () => {
  it(
    "попробовать + поймать: завершается ошибкой, а не зацикливанием",
    () => {
      const source = `модуль Т
процедура главная()
  попробовать
    вернуть 1
  поймать e
    вернуть 2
  конец
конец
конец
`;
      const { ast, errors, tokens } = parseSource(source);
      // Завершились. `поймать` — алиас канонического `иначе_попытка`, значит
      // разбор должен пройти вообще без ошибок.
      expect(tokens.length).toBeGreaterThan(0);
      expect(errors).toEqual([]);
      const proc = ast?.modules[0]?.procedures[0];
      expect(proc?.body[0]?.kind).toBe("попробовать");
    },
    ITERM_TIMEOUT_MS,
  );

  it(
    "неизвестное слово вместо иначе_попытка: завершается, даёт ошибку и не теряет конец блока",
    () => {
      const source = `модуль Т
процедура главная()
  попробовать
    вернуть 1
  чепуха e
    вернуть 2
  конец
конец
конец
`;
      const { errors } = parseSource(source);
      expect(errors.length).toBeGreaterThan(0);
    },
    ITERM_TIMEOUT_MS,
  );

  it(
    "незакрытый попробовать в конце файла: завершается",
    () => {
      const source = `модуль Т
процедура главная()
  попробовать
    вернуть 1
`;
      const { errors } = parseSource(source);
      expect(errors.length).toBeGreaterThan(0);
    },
    ITERM_TIMEOUT_MS,
  );

  it(
    "мусор после попробовать без конца: завершается",
    () => {
      const source = `модуль Т
процедура главная()
  попробовать
    ??? ???
`;
      const { errors } = parseSource(source);
      expect(errors.length).toBeGreaterThan(0);
    },
    ITERM_TIMEOUT_MS,
  );

  const garbageInputs: Array<[string, string]> = [
    ["пустой файл", ""],
    ["только мусор", "@#$ %^& ???"],
    ["модуль без имени", "модуль"],
    ["процедура без конца", "модуль Т\nпроцедура главная()\n  вернуть 1"],
    ["вложенные незакрытые если", "модуль Т\nпроцедура главная()\n  если истина\n    если ложь\n"],
    ["незакрытый массив", "модуль Т\nпроцедура главная()\n  вернуть [1, 2"],
    ["незакрытый объект", "модуль Т\nпроцедура главная()\n  вернуть { а: 1"],
    ["обрыв на операторе", "модуль Т\nпроцедура главная()\n  вернуть 1 +"],
    ["для_каждого без конца", "модуль Т\nпроцедура главная()\n  для_каждого x в [1]\n    вернуть x"],
  ];

  for (const [label, source] of garbageInputs) {
    it(
      `не падает и завершается: ${label}`,
      () => {
        const { errors } = parseSource(source);
        expect(Array.isArray(errors)).toBe(true);
      },
      ITERM_TIMEOUT_MS,
    );
  }
});

describe("parser-robustness: поймать — алиас иначе_попытка", () => {
  it("лексер выдаёт токен иначе_попытка на слово поймать", () => {
    const { tokens } = tokenize("попробовать\n  вернуть 1\nпоймать e\n  вернуть 2\nконец");
    expect(tokens.map((t) => t.kind)).toContain("иначе_попытка");
    expect(tokens.some((t) => t.kind === "идентификатор" && t.lexeme === "поймать")).toBe(false);
  });

  it("английский catch — тот же алиас", () => {
    const { tokens } = tokenize("try\n  вернуть 1\ncatch e\n  вернуть 2\nend");
    expect(tokens.map((t) => t.kind)).toContain("иначе_попытка");
  });

  it("программа с поймать компилируется и перехватывает выброшенное", async () => {
    const source = `модуль Т
процедура главная()
  попробовать
    выбросить "бум"
  поймать ошибка
    вернуть 7
  конец
  вернуть 0
конец
конец
`;
    const result = compileSource(source);
    expect(result.lexerErrors).toEqual([]);
    expect(result.parserErrors).toEqual([]);
    expect(result.module).not.toBeNull();

    const { VM } = await import("../runtime/vm/interpreter");
    const vm = new VM(result.module!, { maxSteps: 1000 });
    const value = await vm.runProcedure(0, []);
    expect(value).toBe(7);
  });
});

describe("parser-robustness: тип-запись со знаком равенства", () => {
  it("тип Имя = { … } разбирается как запись", () => {
    const source = `модуль Т
тип Точка = { х: Число, у: Число }

процедура главная()
  вернуть 1
конец
конец
`;
    const { ast, errors } = parseSource(source);
    expect(errors).toEqual([]);
    expect(ast?.modules[0]?.typeDeclarations).toEqual([
      {
        kind: "TypeDeclaration",
        name: "Точка",
        fields: [
          { name: "х", type: { name: "Число", nullable: false } },
          { name: "у", type: { name: "Число", nullable: false } },
        ],
      },
    ]);
  });

  it("тип Имя { … } (канон без равенства) продолжает работать", () => {
    const source = `модуль Т
тип Точка { х: Число, у: Число }

процедура главная()
  вернуть 1
конец
конец
`;
    const { ast, errors } = parseSource(source);
    expect(errors).toEqual([]);
    expect(ast?.modules[0]?.typeDeclarations[0]?.fields).toHaveLength(2);
  });

  it("тип Имя = а | б (перечень с равенством) не сломан", () => {
    const source = `модуль Т
тип Масть = пики | черви

процедура главная()
  вернуть 1
конец
конец
`;
    const { ast, errors } = parseSource(source);
    expect(errors).toEqual([]);
    expect(ast?.modules[0]?.typeDeclarations[0]?.variants).toEqual(["пики", "черви"]);
  });

  it("тип Имя = {} — пустая запись допустима", () => {
    const source = `модуль Т
тип Пусто = {}

процедура главная()
  вернуть 1
конец
конец
`;
    const { ast, errors } = parseSource(source);
    expect(errors).toEqual([]);
    expect(ast?.modules[0]?.typeDeclarations[0]?.fields).toEqual([]);
  });

  it("тип без имени — понятная ошибка", () => {
    const { errors } = parseSource("модуль Т\nтип = { а: Число }\n");
    expect(errors.some((e) => e.message.includes("имя типа"))).toBe(true);
  });

  it("запись со знаком равенства работает целиком: литерал объекта с типом", async () => {
    const source = `модуль Т
тип Точка = { х: Число, у: Число }

процедура главная()
  пусть p = Точка { х: 3, у: 4 }
  вернуть p.х * 10 + p.у
конец
конец
`;
    const result = compileSource(source);
    expect(result.compilerErrors).toEqual([]);
    expect(result.module).not.toBeNull();

    const { VM } = await import("../runtime/vm/interpreter");
    const vm = new VM(result.module!, { maxSteps: 1000 });
    expect(await vm.runProcedure(0, [])).toBe(34);
  });
});
