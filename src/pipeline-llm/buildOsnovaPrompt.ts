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
    '═══ ПРИМЕРЫ ПРАВИЛЬНОГО КОДА ═══',
    '// Пример: цикл с счётчиком',
    'модуль t',
    'процедура главная()',
    '  пусть i = 0',
    '  пока i < 5',
    '    i = i + 1',
    '  конец',
    '  вернуть i',
    'конец',
    'конец',
    '',
    '// Пример: работа со строками',
    'модуль t',
    'процедура главная()',
    '  пусть s = система.строка.объединить("итого: ", система.строка.объединить("", 42))',
    '  система.лог.вывести(s)',
    '  вернуть система.строка.длина(s)',
    'конец',
    'конец',
    '',
    '// Пример: массив и для_каждого',
    'модуль t',
    'процедура главная()',
    '  пусть числа = [10, 20, 30]',
    '  пусть сумма = 0',
    '  для_каждого эл в числа',
    '    сумма = сумма + эл',
    '  конец',
    '  вернуть сумма',
    'конец',
    'конец',
    '',
    '// Пример: объект и поля',
    'модуль t',
    'процедура главная()',
    '  пусть запись = { счёт: 0, имя: "игрок" }',
    '  запись.счёт = запись.счёт + 1',
    '  вернуть запись.счёт',
    'конец',
    'конец',
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
    .map((sc) => `${sc.name}(${sc.argc})`)
    .join('\n');

  const parts = [
    prefix ? prefix + '\n\n' : '',
    'Ты компилятор языка Основа. Код содержит ошибки компиляции. Исправь их.',
    '',
    '═══ ПРАВИЛЬНЫЙ ОБРАЗЕЦ ═══',
    '// Всегда: модуль → процедура главная() → конец → конец',
    '// вернуть значение (без скобок)',
    '// конец (не конец_если, не конец_пока)',
    '// пусть x = 1 / x = x + 1 (не x := 1)',
    '',
    'ДОПУСТИМЫЕ КОНСТРУКЦИИ:',
    constructs,
    '',
    'ЗАПРЕЩЁННЫЕ ПАТТЕРНЫ:',
    forbidden,
    '',
    'STABLE SYSCALLS (имя(argc)):',
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
