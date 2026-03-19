/**
 * Валидация: лексер использует только ключевые слова, помеченные в реестре языка как implemented,
 * и в реестре нет лишних реализованных ключевых слов по сравнению с лексером.
 * Запуск: npx tsx src/tools/osnova-compiler/validate-language-registry.ts
 */
import { KEYWORDS } from "./lexer";
import {
  LANGUAGE_REGISTRY,
  getImplementedKeywords,
} from "./language-registry";
import { INVOKE_ARG_COUNT } from "../runtime/vm/invokeRegistry";

const lexerLexemes = new Set(Object.keys(KEYWORDS));
const implemented = getImplementedKeywords(LANGUAGE_REGISTRY);
const registryImplementedLexemes = new Set(implemented.map((k) => k.lexeme));
const registryAllLexemes = new Set(LANGUAGE_REGISTRY.keywords.map((k) => k.lexeme));

const missingInLexer: string[] = [];
for (const lexeme of registryImplementedLexemes) {
  if (!lexerLexemes.has(lexeme)) {
    missingInLexer.push(lexeme);
  }
}

const missingInRegistry: string[] = [];
for (const lexeme of lexerLexemes) {
  if (!registryAllLexemes.has(lexeme)) {
    missingInRegistry.push(lexeme);
  }
}

if (missingInLexer.length > 0) {
  console.error(
    "[osnova-language:validate] Реестр помечает как implemented ключевые слова, которых нет в лексере:",
    missingInLexer.join(", ")
  );
  process.exit(1);
}

if (missingInRegistry.length > 0) {
  console.error(
    "[osnova-language:validate] В лексере есть ключевые слова, которых нет в реестре языка:",
    missingInRegistry.join(", ")
  );
  process.exit(1);
}

console.log(
  `[osnova-language:validate] OK: лексер и реестр языка (v${LANGUAGE_REGISTRY.version}) согласованы, ключевых слов: ${lexerLexemes.size}`
);

const registrySyscallNames = new Set(LANGUAGE_REGISTRY.syscalls.map((s) => s.name));
const missingSyscalls = Object.keys(INVOKE_ARG_COUNT).filter(
  (name) => !registrySyscallNames.has(name),
);

if (missingSyscalls.length > 0) {
  console.error(
    "[validate] invokeRegistry содержит syscalls без registry-записи:",
    missingSyscalls.join(", "),
  );
  process.exit(1);
}

for (const spec of LANGUAGE_REGISTRY.syscalls) {
  const declared = INVOKE_ARG_COUNT[spec.name];
  if (declared !== undefined && declared !== spec.argc) {
    console.error(
      `[validate] argc расхождение: ${spec.name} — registry=${spec.argc}, invokeRegistry=${declared}`,
    );
    process.exit(1);
  }
}

console.log(
  `[osnova-language:validate] OK: syscalls согласованы, записей: ${LANGUAGE_REGISTRY.syscalls.length}`,
);
