import { LANGUAGE_REGISTRY } from '../compiler/language-registry';
import type { KeywordSpec, ConstructSpec } from '../compiler/language-registry';

function buildPromptSections(): {
  keywords: string;
  constructs: string;
  operators: string;
  literals: string;
  stableSyscalls: string;
  forbiddenPatterns: string;
} {
  const keywords = LANGUAGE_REGISTRY.keywords
    .filter((k: KeywordSpec) => k.implemented)
    .map((k: KeywordSpec) => k.lexeme)
    .join(', ');

  const constructs = LANGUAGE_REGISTRY.constructs
    .filter((c: ConstructSpec) => c.implemented)
    .map((c: ConstructSpec) => `- ${c.id}: ${c.syntax}`)
    .join('\n');

  const operators = LANGUAGE_REGISTRY.operators
    .filter((o) => o.implemented)
    .map((o) => `${o.symbol} (${o.kind}, p=${o.precedence}, ${o.associativity})`)
    .join(', ');

  const literals = LANGUAGE_REGISTRY.literals
    .filter((l) => l.implemented)
    .map((l) => `- ${l.kind}: ${l.examples.join(', ')}`)
    .join('\n');

  const stableSyscalls = LANGUAGE_REGISTRY.syscalls
    .filter((s) => s.status === 'stable')
    .map((s) => `${s.name}(${s.argc})`)
    .join('\n');

  const forbiddenPatterns = LANGUAGE_REGISTRY.forbiddenPatterns
    .map((fp) => `✗ ${fp.id}: ${fp.bad}${fp.good ? ` → ${fp.good}` : ''}`)
    .join('\n');

  return {
    keywords,
    constructs,
    operators,
    literals,
    stableSyscalls,
    forbiddenPatterns,
  };
}

export function buildOsnovaPrompt(text: string): string {
  const s = buildPromptSections();
  return [
    '═══ КЛЮЧЕВЫЕ СЛОВА ═══',
    s.keywords,
    '',
    '═══ КОНСТРУКЦИИ ═══',
    s.constructs,
    '',
    '═══ ОПЕРАТОРЫ ═══',
    s.operators,
    '',
    '═══ ТИПЫ ДАННЫХ ═══',
    s.literals,
    '',
    '═══ РАЗРЕШЁННЫЕ СИСТЕМНЫЕ ВЫЗОВЫ ═══',
    s.stableSyscalls,
    '',
    '═══ ЗАПРЕЩЁННЫЕ ПАТТЕРНЫ ═══',
    s.forbiddenPatterns,
    '',
    'Верни ТОЛЬКО код на языке Основа, без пояснений, без markdown-блоков.',
    'Задача:',
    text,
  ].join('\n');
}

/** Промпт для исправления кода по ошибкам компилятора (repair-цикл). */
export function buildOsnovaRepairPrompt(
  currentSource: string,
  errors: string[],
  prefix?: string,
): string {
  const s = buildPromptSections();
  const constructs = LANGUAGE_REGISTRY.constructs
    .filter((c) => c.implemented)
    .map((c) => c.syntax)
    .join('\n');
  const forbidden = LANGUAGE_REGISTRY.forbiddenPatterns
    .map((fp) => `✗ ${fp.description}: ${fp.bad}${fp.good ? ` → ${fp.good}` : ''}`)
    .join('\n');
  const stableSyscalls = LANGUAGE_REGISTRY.syscalls
    .filter((sc) => sc.status === 'stable')
    .map((sc) => sc.name)
    .join(', ');

  const parts = [
    prefix ? prefix + '\n\n' : '',
    'Ты компилятор языка Основа. Код содержит ошибки компиляции. Исправь их.',
    '',
    'ДОПУСТИМЫЕ КОНСТРУКЦИИ:',
    constructs,
    '',
    'ЗАПРЕЩЁННЫЕ ПАТТЕРНЫ:',
    forbidden,
    '',
    'STABLE SYSCALLS:',
    stableSyscalls,
    '',
    'Текущий код:',
    '---',
    currentSource,
    '---',
    '',
    'Ошибки компилятора:',
    errors.length > 0 ? errors.map((e) => `• ${e}`).join('\n') : 'Программа выполнилась, но результат не совпадает с эталоном.',
    '',
    `Реализованные ключевые слова: ${s.keywords}`,
    '',
    'Верни ТОЛЬКО исправленный код на языке Основа, без пояснений, без markdown-блоков.',
  ].filter(Boolean);
  return parts.join('\n');
}
