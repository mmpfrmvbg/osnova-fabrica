import { LANGUAGE_REGISTRY } from '../compiler/language-registry';
import type { KeywordEntry, ConstructEntry } from '../compiler/language-registry';

export function buildOsnovaPrompt(text: string): string {
  const keywords = LANGUAGE_REGISTRY.keywords
    .filter((k: KeywordEntry) => k.implemented)
    .map((k: KeywordEntry) => k.lexeme)
    .join(', ');
  const constructs = LANGUAGE_REGISTRY.constructs
    .filter((c: ConstructEntry) => c.implemented)
    .map((c: ConstructEntry) => `${c.id}: ${c.syntax}`)
    .join('\n');

  return [
    'Ты компилятор языка Основа. Напиши программу на языке Основа по описанию.',
    'Реализованные ключевые слова:',
    keywords,
    'Реализованные конструкции:',
    constructs,
    'Верни ТОЛЬКО код на языке Основа, без пояснений, без markdown-блоков.',
    'Задача:',
    text,
  ].join('\n');
}

/** Промпт для исправления кода по ошибкам компилятора (repair-цикл). */
export function buildOsnovaRepairPrompt(
  currentSource: string,
  errors: string[],
): string {
  return [
    'Ты компилятор языка Основа. Код содержит ошибки компиляции. Исправь их.',
    '',
    'Текущий код:',
    '---',
    currentSource,
    '---',
    '',
    'Ошибки компилятора:',
    errors.map((e) => `• ${e}`).join('\n'),
    '',
    'Верни ТОЛЬКО исправленный код на языке Основа, без пояснений, без markdown-блоков.',
  ].join('\n');
}
