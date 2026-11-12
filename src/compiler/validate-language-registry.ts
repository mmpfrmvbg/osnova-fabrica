/**
 * Валидация: лексер и реестр языка согласованы.
 *
 * Проверяются обе стороны:
 *  1. всё, что реестр помечает как `implemented`, лексер обязан принимать;
 *  2. всё, что лексер принимает, обязано быть в реестре.
 *
 * Сравнение идёт с `ACCEPTED_KEYWORD_LEXEMES` (зарезервированные слова ПЛЮС
 * контекстные закрывающие `конец_*`), а не с `KEYWORDS`: закрывающие слова
 * намеренно не зарезервированы (их вид определяет парсер, БЛОК 1 v2), но реестр
 * обязан их описывать. Подробно — в `./registryAgreement`.
 *
 * Запуск: npm run validate:spec
 */

import { checkRegistryAgreement } from "./registryAgreement";
import { LANGUAGE_REGISTRY } from "./language-registry";
import { ACCEPTED_KEYWORD_LEXEMES } from "./lexer";

const report = checkRegistryAgreement();

if (report.missingInLexer.length > 0) {
  console.error(
    "[osnova-language:validate] Реестр помечает как implemented ключевые слова, которых нет в лексере:",
    report.missingInLexer.join(", "),
  );
  process.exit(1);
}

if (report.missingInRegistry.length > 0) {
  console.error(
    "[osnova-language:validate] В лексере есть ключевые слова, которых нет в реестре языка:",
    report.missingInRegistry.join(", "),
  );
  process.exit(1);
}

console.log(
  `[osnova-language:validate] OK: лексер и реестр языка (v${report.version}) согласованы, принимаемых лексем: ${ACCEPTED_KEYWORD_LEXEMES.length}`,
);

if (report.missingSyscalls.length > 0) {
  console.error(
    "[validate] invokeRegistry содержит syscalls без registry-записи:",
    report.missingSyscalls.join(", "),
  );
  process.exit(1);
}

if (report.argcMismatches.length > 0) {
  for (const mismatch of report.argcMismatches) {
    console.error(`[validate] argc расхождение: ${mismatch}`);
  }
  process.exit(1);
}

console.log(
  `[osnova-language:validate] OK: syscalls согласованы, записей: ${LANGUAGE_REGISTRY.syscalls.length}`,
);
