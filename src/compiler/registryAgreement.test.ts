/**
 * Оракул проверки согласованности реестра языка с лексером.
 *
 * Повод: `npm run validate:spec` был **красным** на этой ветке. Причина — не
 * данные, а посылка проверки: она сравнивала `implemented`-слова реестра с
 * `KEYWORDS`, а `конец` и `конец_*` намеренно НЕ зарезервированы после БЛОК 1 v2
 * (`fee960a`): их вид определяет парсер, лексер лишь принимает лексемы
 * (`BLOCK_CLOSING_LEXEMES`). Проверка требовала от лексера зарезервировать
 * контекстные слова и краснела на верном коде.
 *
 * Тесты держат обе стороны: (1) на текущих данных расхождений нет; (2) проверка
 * по-прежнему ЛОВИТ расхождения — на подставных данных, а не «молчит всегда».
 */
import { describe, it, expect } from "vitest";
import { checkRegistryAgreement } from "./registryAgreement";
import { ACCEPTED_KEYWORD_LEXEMES, BLOCK_CLOSING_LEXEMES, KEYWORDS } from "./lexer";
import { LANGUAGE_REGISTRY } from "./language-registry";
import { INVOKE_ARG_COUNT } from "../runtime/vm/invokeRegistry";

const synthetic = (lexemes: string[]) => ({
  version: "тест",
  keywords: lexemes.map((lexeme) => ({ lexeme, implemented: true })),
  syscalls: [] as { name: string; argc: number }[],
});

describe("согласованность реестра и лексера", () => {
  it("на текущем репозитории расхождений нет", () => {
    const report = checkRegistryAgreement();
    expect(report.missingInLexer).toEqual([]);
    expect(report.missingInRegistry).toEqual([]);
    expect(report.missingSyscalls).toEqual([]);
    expect(report.argcMismatches).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("контекстные закрывающие слова лексер принимает, хотя они не зарезервированы", () => {
    // Это и была причина красноты: `конец_*` есть в реестре как implemented, но
    // в KEYWORDS их нет намеренно.
    for (const lexeme of BLOCK_CLOSING_LEXEMES) {
      expect(ACCEPTED_KEYWORD_LEXEMES, `${lexeme} принимается лексером`).toContain(lexeme);
      expect(
        Object.keys(KEYWORDS),
        `${lexeme} не зарезервировано — вид определяет парсер`,
      ).not.toContain(lexeme);
    }
  });

  it("ЛОВИТ: implemented-слово реестра, которого лексер не принимает", () => {
    const report = checkRegistryAgreement(
      synthetic(["модуль", "выдуманное_слово"]),
      ["модуль"],
    );
    expect(report.missingInLexer).toEqual(["выдуманное_слово"]);
    expect(report.ok).toBe(false);
  });

  it("ЛОВИТ: лексема лексера, которой нет в реестре", () => {
    const report = checkRegistryAgreement(synthetic(["модуль"]), ["модуль", "лишнее_слово"]);
    expect(report.missingInRegistry).toEqual(["лишнее_слово"]);
    expect(report.ok).toBe(false);
  });

  it("ЛОВИТ: syscall без записи в реестре языка", () => {
    const report = checkRegistryAgreement(synthetic(["модуль"]), ["модуль"], {
      "система.выдумка.вызов": 1,
    });
    expect(report.missingSyscalls).toEqual(["система.выдумка.вызов"]);
    expect(report.ok).toBe(false);
  });

  it("ЛОВИТ: расхождение арности syscall", () => {
    const input = {
      version: "тест",
      keywords: [{ lexeme: "модуль", implemented: true }],
      syscalls: [{ name: "система.лог.вывести", argc: 2 }],
    };
    const report = checkRegistryAgreement(input, ["модуль"], { "система.лог.вывести": 1 });
    expect(report.argcMismatches).toEqual(["система.лог.вывести: registry=2, invokeRegistry=1"]);
    expect(report.ok).toBe(false);
  });

  it("арность из реестра вызовов совпадает с реестром языка для всех общих имён", () => {
    const mismatched = LANGUAGE_REGISTRY.syscalls
      .filter((s) => INVOKE_ARG_COUNT[s.name] !== undefined && INVOKE_ARG_COUNT[s.name] !== s.argc)
      .map((s) => s.name);
    expect(mismatched).toEqual([]);
  });
});
