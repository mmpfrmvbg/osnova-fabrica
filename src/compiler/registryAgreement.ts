/**
 * Согласованность реестра языка с лексером и реестром системных вызовов.
 *
 * Логика вынесена из скрипта `validate-language-registry.ts` отдельным модулем:
 * скрипт завершается `process.exit`, а проверку нужно уметь прогнать оракулом —
 * в том числе на подставных данных, чтобы убедиться, что она всё ещё ЛОВИТ
 * расхождения, а не только молчит на текущем состоянии репозитория.
 *
 * # Почему сравниваем с `ACCEPTED_KEYWORD_LEXEMES`, а не с `KEYWORDS`
 *
 * `KEYWORDS` — зарезервированные слова. Контекстные закрывающие (`конец`,
 * `конец_если`, …) в него не входят: их вид определяет парсер (БЛОК 1 v2).
 * Реестр языка при этом обязан описывать их как `implemented` — иначе перестанет
 * описывать синтаксис, который лексер принимает. Проверка «реестр против
 * `KEYWORDS`» требовала бы обратного и краснела на верном коде; полный набор
 * принимаемых лексем — `ACCEPTED_KEYWORD_LEXEMES` из лексера.
 */

import { ACCEPTED_KEYWORD_LEXEMES } from "./lexer";
import { LANGUAGE_REGISTRY } from "./language-registry";
import { INVOKE_ARG_COUNT } from "../runtime/vm/invokeRegistry";

/** Минимум полей реестра, нужный проверке (полный `LanguageRegistry` подходит). */
export interface RegistryAgreementInput {
  readonly version: string;
  readonly keywords: readonly { readonly lexeme: string; readonly implemented: boolean }[];
  readonly syscalls: readonly { readonly name: string; readonly argc: number }[];
}

export interface AgreementReport {
  readonly version: string;
  /** Помечено `implemented`, но лексер такой лексемы не принимает. */
  readonly missingInLexer: readonly string[];
  /** Лексер принимает лексему, которой нет в реестре вообще. */
  readonly missingInRegistry: readonly string[];
  /** Системный вызов есть в реестре вызовов, но не в реестре языка. */
  readonly missingSyscalls: readonly string[];
  /** Арность вызова расходится между двумя реестрами. */
  readonly argcMismatches: readonly string[];
  readonly ok: boolean;
}

export function checkRegistryAgreement(
  input: RegistryAgreementInput = LANGUAGE_REGISTRY,
  lexerLexemes: readonly string[] = ACCEPTED_KEYWORD_LEXEMES,
  invokeArgc: Readonly<Record<string, number>> = INVOKE_ARG_COUNT,
): AgreementReport {
  const accepted = new Set(lexerLexemes);
  const registryAllLexemes = new Set(input.keywords.map((k) => k.lexeme));
  const registryImplemented = new Set(
    input.keywords.filter((k) => k.implemented).map((k) => k.lexeme),
  );

  const missingInLexer = [...registryImplemented].filter((lexeme) => !accepted.has(lexeme)).sort();
  const missingInRegistry = [...accepted].filter((lexeme) => !registryAllLexemes.has(lexeme)).sort();

  const registrySyscallNames = new Set(input.syscalls.map((s) => s.name));
  const missingSyscalls = Object.keys(invokeArgc)
    .filter((name) => !registrySyscallNames.has(name))
    .sort();

  const argcMismatches = input.syscalls
    .filter((spec) => invokeArgc[spec.name] !== undefined && invokeArgc[spec.name] !== spec.argc)
    .map((spec) => `${spec.name}: registry=${spec.argc}, invokeRegistry=${invokeArgc[spec.name]}`)
    .sort();

  const keywordOk = missingInLexer.length === 0 && missingInRegistry.length === 0;
  const syscallOk = missingSyscalls.length === 0 && argcMismatches.length === 0;

  return {
    version: input.version,
    missingInLexer,
    missingInRegistry,
    missingSyscalls,
    argcMismatches,
    ok: keywordOk && syscallOk,
  };
}
