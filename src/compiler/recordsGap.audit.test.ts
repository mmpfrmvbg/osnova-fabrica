/**
 * СТОРОЖ ДВУХ ДОЛГОВ ЯЗЫКА — случаи 26 и 27 реестра проверяемости (`docs/verification-debt.md`).
 *
 * # Зачем
 *
 * **Случай 26.** Сахар `xs[i]` парсер разворачивает в встроенный вызов `система.массив.получить`
 * (`src/compiler/parser.ts:1652`, `:952`), а тип возврата встроенных вызовов системе типов
 * неизвестен (`inferExprType` знает только свои процедуры). Поэтому опечатка в поле **через
 * индекс** принимается и даёт `null`, тогда как та же опечатка **через переменную** — отказ
 * компиляции.
 *
 * **Случай 27.** Запись в языке есть (парсер, AST, проверки полей, тесты), а в реестре языка её
 * нет: 0 конструкций из 32. Сторож `check:language-schema` этого не видит по построению — он
 * сверяет схему с реестром, то есть список со списком.
 *
 * # Что здесь держится
 *
 * 1. **Числа расхождения закреплены.** Сдвинулись — красное обязано назвать, какую запись реестра
 *    обновить, а не «тест упал».
 * 2. **Различающий опыт.** Одна и та же ошибка подаётся двумя путями: без сахара и с сахаром.
 *    Пока первый отвергается, а второй принимается — это долг, и он назван долгом. Если форма
 *    начнёт отвергаться, тест покраснеет, и случай 26 снимается вместе с ожиданием.
 *
 * # Негативный контроль
 *
 * Детектор «конструкция записи» проверяется на подложенном списке (обязан найти 1 из 1), а
 * различающий опыт — на **корректной** программе (`xs[0].x` компилируется и даёт число): без
 * этого «всё с индексом не проверяется» читалось бы как доказательство, хотя это было бы
 * свойством самого опыта.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { LANGUAGE_REGISTRY } from "./language-registry";
import { compileSource } from "./compiler";
import { OsVbcVM } from "../runtime/vm";

const ROOT = path.resolve(__dirname, "..", "..");
const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), "utf-8");

/** Закреплённые числа случаев 26 и 27 (замер 2026-09-30, `.tmp/osnova-probe-sugar-count.ts`). */
export const GAP_FACTS = {
  /** Конструкций в `ConstructId`. */
  registryConstructs: 32,
  /** Из них описывают запись. */
  registryRecordConstructs: 0,
  /** Конструкций с `astNode.kind === "TypeDeclaration"` — это перечень, не запись. */
  registryTypeDeclarationConstructs: 1,
  /** Конструкций в схеме `docs/osnova/language-schema.json`. */
  schemaConstructs: 33,
  /** Из них с `astNodeType: "TypeDeclaration"`. */
  schemaTypeDeclarationConstructs: 1,
  /** Строк канона, совпадающих с образцом формы записи (`тип Имя {` или `{ поле:`). */
  canonRecordFormLines: 3,
  /** Из них называют именно форму ТИПА записи (`тип Имя {`); третья строка — объектный литерал. */
  canonRecordTypeLines: 2,
  /** Мест в парсере, где сахар порождает вызов массива. */
  parserSugarSites: 5,
  /** Видов выражений в AST и сколько из них разбирает `inferExprType`. */
  astExprKinds: 13,
  inferredExprKinds: 12,
} as const;

/** Минимальная форма конструкций реестра, нужная детектору (типы реестра шире). */
export interface ConstructLike {
  readonly id?: string;
  readonly astNode: { readonly kind: string; readonly fields: readonly { readonly name: string }[] };
}

/**
 * Конструкции, описывающие **запись**: узел `TypeDeclaration` со спецификацией поля `fields`.
 * Перечень (`variant_type`) под это не подпадает — у него поля `name`/`variants`.
 */
export function recordConstructs(constructs: readonly ConstructLike[]): ConstructLike[] {
  return constructs.filter(
    (construct) =>
      construct.astNode.kind === "TypeDeclaration" &&
      construct.astNode.fields.some((field) => field.name === "fields"),
  );
}

/** Все `.osnova` дерева, кроме служебных каталогов (`.tmp` — песочница, не корпус). */
export function osnovaFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".tmp") continue;
      osnovaFiles(path.join(dir, entry.name), out);
    } else if (entry.name.endsWith(".osnova")) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const ПРОБА_ЧЕРЕЗ_ПЕРЕМЕННУЮ = `
модуль ПробаЧерезПеременную

тип Точка = { x: Число, y: Число }

процедура главная()
  пусть т: Точка = { x: 1, y: 2 }
  вернуть т.нетакого_поля
конец

конец
`.trim();

const ПРОБА_ЧЕРЕЗ_ИНДЕКС = `
модуль ПробаЧерезИндекс

тип Точка = { x: Число, y: Число }

процедура главная()
  пусть точки: [Точка] = [{ x: 1, y: 2 }]
  вернуть точки[0].нетакого_поля
конец

конец
`.trim();

const ПРОБА_КОРРЕКТНАЯ = `
модуль ПробаКорректная

тип Точка = { x: Число, y: Число }

процедура главная()
  пусть точки: [Точка] = [{ x: 1, y: 2 }]
  вернуть точки[0].x
конец

конец
`.trim();

async function valueOf(source: string): Promise<string> {
  const compiled = compileSource(source);
  if (compiled.module === null) return `ОТКАЗ: ${compiled.compilerErrors.map((e) => e.message).join("; ")}`;
  const vm = new OsVbcVM(compiled.module, { maxSteps: 5000 });
  return `значение ${String(await vm.execute())}`;
}

describe("долги языка: сахар теряет тип (26) и реестр уже компилятора (27)", () => {
  it("случай 27: конструкций записи в реестре 0, форма названа в каноне", () => {
    const registryText = read("src/compiler/language-registry.ts");
    expect(LANGUAGE_REGISTRY.constructs.length, "конструкций в реестре").toBe(
      GAP_FACTS.registryConstructs,
    );
    const records = recordConstructs(LANGUAGE_REGISTRY.constructs);
    expect(
      records.length,
      "в реестре появилась конструкция записи — обновите случай 27 (docs/verification-debt.md) и это число",
    ).toBe(GAP_FACTS.registryRecordConstructs);
    expect(
      LANGUAGE_REGISTRY.constructs.filter((c) => c.astNode.kind === "TypeDeclaration").length,
      "конструкций с узлом TypeDeclaration (перечень)",
    ).toBe(GAP_FACTS.registryTypeDeclarationConstructs);
    expect(registryText, "текст реестра не описывает форму записи").not.toMatch(/\{\s*поле:/);
    expect(
      LANGUAGE_REGISTRY.keywords.some((k) => k.lexeme === "тип"),
      "ключевое слово «тип» в реестре обязано быть — иначе пропадёт и слово",
    ).toBe(true);

    const schema = JSON.parse(read("docs/osnova/language-schema.json")) as {
      constructions: Array<{ astNodeType?: string }>;
    };
    expect(schema.constructions.length, "конструкций в схеме").toBe(GAP_FACTS.schemaConstructs);
    expect(
      schema.constructions.filter((c) => c.astNodeType === "TypeDeclaration").length,
      "в схеме описана только форма перечня",
    ).toBe(GAP_FACTS.schemaTypeDeclarationConstructs);

    const canonLines = read("docs/language-v2.md").split(/\r?\n/);
    const byPattern = canonLines.filter((line) => /тип Имя\s*\{|\{\s*поле:/.test(line));
    expect(byPattern.length, "строк канона с образцом формы записи").toBe(
      GAP_FACTS.canonRecordFormLines,
    );
    // Различение обязательно: образец `{ поле:` ловит и объектный литерал (`:257`), а форма
    // ТИПА — это строки с `тип Имя {`. Поэтому числа два, и оба закреплены.
    expect(
      byPattern.filter((line) => /тип Имя\s*\{/.test(line)).length,
      "строк канона, называющих именно ТИП записи",
    ).toBe(GAP_FACTS.canonRecordTypeLines);

    // Контроль детектора: на подложенном списке он обязан находить запись, иначе «0» ничего не значит.
    const planted: ConstructLike[] = [
      { id: "variant_type", astNode: { kind: "TypeDeclaration", fields: [{ name: "variants" }] } },
      { id: "record_type", astNode: { kind: "TypeDeclaration", fields: [{ name: "fields" }] } },
    ];
    expect(recordConstructs(planted).length, "детектор записи слеп").toBe(1);
  });

  it("случай 26: опечатка через переменную отвергается, через индекс принимается и даёт null", async () => {
    const черезПеременную = compileSource(ПРОБА_ЧЕРЕЗ_ПЕРЕМЕННУЮ);
    expect(
      черезПеременную.compilerSuccess,
      "проверка полей обязана отвергать опечатку через переменную — иначе это не различающий опыт",
    ).toBe(false);
    expect(
      черезПеременную.compilerErrors.map((e) => e.message).join(" | "),
      "отказ обязан называть поле и тип",
    ).toMatch(/Неизвестное поле: нетакого_поля \(тип Точка\)/);

    // ДОЛГ: тот же дефект через сахар `xs[i]` не отвергается. Покраснеет — значит закрыт:
    // снимите случай 26 из docs/verification-debt.md вместе с этим ожиданием.
    const черезИндекс = compileSource(ПРОБА_ЧЕРЕЗ_ИНДЕКС);
    expect(
      черезИндекс.compilerSuccess,
      "СЛУЧАЙ 26 ЗАКРЫТ? Опечатка через индекс начала отвергаться — обновите запись случая 26",
    ).toBe(true);
    expect(await valueOf(ПРОБА_ЧЕРЕЗ_ИНДЕКС), "принятая опечатка даёт не отказ, а null").toBe(
      "значение null",
    );

    // Контроль опыта: корректное поле через индекс обязано компилироваться и считаться.
    expect(await valueOf(ПРОБА_КОРРЕКТНАЯ), "корректная форма через индекс").toBe("значение 1");
  });

  it("корпус не пользуется записями: 0 программ .osnova с объявлением типа", () => {
    const files = osnovaFiles(ROOT);
    expect(files.length, "программ .osnova в дереве (без .tmp)").toBeGreaterThan(50);
    const withType = files.filter((file) => /^\s*тип\s+\S/m.test(fs.readFileSync(file, "utf-8")));
    expect(
      withType.map((file) => path.relative(ROOT, file)),
      "в корпусе появилась программа с объявлением типа — обновите случай 27 и это ожидание",
    ).toEqual([]);
  });
});
