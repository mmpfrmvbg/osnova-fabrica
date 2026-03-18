import { LANGUAGE_REGISTRY } from '../compiler/language-registry';
import type { KeywordSpec, ConstructSpec } from '../compiler/language-registry';

export function buildOsnovaPrompt(text: string): string {
  const keywords = LANGUAGE_REGISTRY.keywords
    .filter((k: KeywordSpec) => k.implemented)
    .map((k: KeywordSpec) => k.lexeme)
    .join(', ');
  const constructs = LANGUAGE_REGISTRY.constructs
    .filter((c: ConstructSpec) => c.implemented)
    .map((c: ConstructSpec) => `${c.id}: ${c.syntax}`)
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
  prefix?: string,
): string {
  const parts = [
    prefix ? prefix + '\n\n' : '',
    'Ты компилятор языка Основа. Код содержит ошибки компиляции. Исправь их.',
    '',
    'Текущий код:',
    '---',
    currentSource,
    '---',
    '',
    'Ошибки компилятора:',
    errors.length > 0 ? errors.map((e) => `• ${e}`).join('\n') : 'Программа выполнилась, но результат не совпадает с эталоном.',
    '',
    'Верни ТОЛЬКО исправленный код на языке Основа, без пояснений, без markdown-блоков.',
  ].filter(Boolean);
  return parts.join('\n');
}
