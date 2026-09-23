/**
 * Синонимы системных вызовов: замер по реальным следам, а не по догадке.
 *
 * Источник данных — `runs/traces.jsonl`: 3607 записей с исходником. Перекомпиляция
 * даёт список имён, которых в языке нет (`unknown_syscall`). После уже принятых
 * четырёх синонимов осталось **25 различимых имён**; три из них — `система.результат.*`,
 * они отложены до БЛОКА 3 (тип `Результат`).
 *
 * Из оставшихся 22 каноническая цель **доказана** для 14: цель есть в реестре
 * системных вызовов И арность канона совпадает с арностью реального вызова в следе.
 * Остальные 8 цели не имеют (см. `docs/language-v2.md` §9 и реестр долга): часть
 * требует не переименования, а преобразования аргументов, часть — конструкции,
 * которой в языке нет (динамический вызов, проверка доступности сети).
 *
 * Смысл оракула — инвариант: **синоним даёт тот же байткод, что канон**. Это
 * сильнее «компилируется без ошибок»: имя действительно сведено к канону, а не
 * просто принято.
 */
import { describe, it, expect } from "vitest";
import { compileSource } from "../compiler/compiler";
import { LANGUAGE_REGISTRY } from "../compiler/language-registry";
import { SYSCALL_ALIASES } from "./vm/invokeRegistry";

/** Пары из замера: синоним → канон и арность реального вызова в следе. */
const PAIRS: Array<[string, string, number]> = [
  ["система.вывести", "система.лог.вывести", 1],
  ["система.вывод.текст", "система.лог.вывести", 1],
  ["система.окно.вывестиТекст", "система.лог.вывести", 1],
  ["система.окно.отобразить", "система.окно.показать", 1],
  ["система.окно.создать", "система.окно.создать_окно", 3],
  ["система.окно.ввод", "система.ввод.текст", 1],
  ["система.сеть.отправить", "система.сеть.пост", 2],
  ["система.строка.из", "система.строка.из_числа", 1],
  ["система.строка.изЧисла", "система.строка.из_числа", 1],
  ["система.хранилище.загрузить", "система.хранилище.прочитать", 1],
  ["система.хранилище.получить_элемент", "система.массив.получить", 2],
  ["система.хранилище.удалить_элемент", "система.массив.удалить", 2],
  ["система.хранилище.добавить", "система.массив.добавить", 2],
  ["система.число.остаток", "система.математика.остаток", 2],
];

function wrap(body: string): string {
  return `модуль т\nпроцедура главная()\n${body}\nконец\nконец`;
}

function bytecodeOf(src: string): string {
  const cr = compileSource(src, { filename: "синоним.osnova" });
  expect(
    cr.compilerSuccess,
    cr.parserErrors.map((e) => e.message).join("; ") + " " + cr.semanticErrors.map((e) => e.message).join("; "),
  ).toBe(true);
  return JSON.stringify(cr.module?.code ?? null);
}

describe("синонимы системных вызовов: синоним даёт тот же байткод, что канон", () => {
  for (const [alias, canon, argc] of PAIRS) {
    it(`${alias} → ${canon}`, () => {
      const args = Array.from({ length: argc }, (_, i) => String(i + 1)).join(", ");
      const aliasSrc = wrap(`  ${alias}(${args})\n  вернуть 1`);
      const canonSrc = wrap(`  ${canon}(${args})\n  вернуть 1`);
      expect(bytecodeOf(aliasSrc), alias).toBe(bytecodeOf(canonSrc));
    });
  }
});

describe("синонимы системных вызовов: инварианты реестра", () => {
  it("каждая цель синонима существует как канонический вызов", () => {
    const canonNames = new Set(LANGUAGE_REGISTRY.syscalls.map((s) => s.name));
    for (const [alias, canon] of Object.entries(SYSCALL_ALIASES)) {
      expect(canonNames.has(canon), `${alias} → ${canon}: цели нет в реестре`).toBe(true);
    }
  });

  it("в реестре синонимов нет ни одной записи result.* (отложены до БЛОК 3)", () => {
    for (const alias of Object.keys(SYSCALL_ALIASES)) {
      expect(alias.startsWith("система.результат."), alias + " должен ждать БЛОК 3").toBe(false);
    }
  });

  it("синоним не подменяет каноническое имя самого себя", () => {
    const canonNames = new Set(LANGUAGE_REGISTRY.syscalls.map((s) => s.name));
    for (const alias of Object.keys(SYSCALL_ALIASES)) {
      expect(canonNames.has(alias), alias + " — это канон, его нельзя объявлять синонимом").toBe(false);
    }
  });

  it("все пары замера действительно есть в реестре синонимов", () => {
    for (const [alias, canon] of PAIRS) {
      expect(SYSCALL_ALIASES[alias], alias + " отсутствует в SYSCALL_ALIASES").toBe(canon);
    }
  });
});
