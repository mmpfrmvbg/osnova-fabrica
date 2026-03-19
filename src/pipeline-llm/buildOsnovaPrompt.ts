import { LANGUAGE_REGISTRY, LANGUAGE_VERSION } from '../compiler/language-registry';
import type { KeywordSpec, ConstructSpec } from '../compiler/language-registry';

function buildPromptSections(): {
  keywords: string;
  constructs: string;
  constructExamples: string;
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

  const constructExamples = LANGUAGE_REGISTRY.constructs
    .filter((c: ConstructSpec) => c.implemented && c.example)
    .map((c: ConstructSpec) => `// ${c.syntax}\n${c.example!}`)
    .join('\n\n');

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
    .map((fp) => {
      const lines = [`✗ ${fp.description}`];
      lines.push(`  НЕЛЬЗЯ: ${fp.bad}`);
      if (fp.good) lines.push(`  ПРАВИЛЬНО: ${fp.good}`);
      return lines.join('\n');
    })
    .join('\n\n');

  return {
    keywords,
    constructs,
    constructExamples,
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
    '## Модули (v1.5)',
    '',
    'Импорт (только в начале файла, до процедур):',
    'использовать модуль Утилиты из "утилиты.osnova"',
    '',
    'Экспорт процедуры:',
    'процедура экспорт сложить(а, б)',
    '  вернуть а + б',
    'конец',
    '',
    'Вызов импортированной процедуры:',
    'пусть результат = Утилиты.сложить(2, 3)',
    '',
    'ЗАПРЕЩЕНО:',
    '- вызывать Утилиты.внутренняя() если она не помечена экспорт',
    '- писать использовать после объявления процедур',
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
    '═══ КОНСТРУКЦИИ С ПРИМЕРАМИ (из реестра) ═══',
    s.constructExamples,
    '',
    `═══ ПРИМЕРЫ ПРАВИЛЬНОГО КОДА (${LANGUAGE_VERSION}) ═══`,
    '',
    '// Пример: цикл с счётчиком',
    'модуль т',
    'процедура главная()',
    '  пусть i = 0',
    '  пока i < 5',
    '    i = i + 1',
    '  конец',
    '  вернуть i',
    'конец',
    'конец',
    '',
    '// Пример: массив — индексный доступ (v1.1 sugar)',
    'модуль т',
    'процедура главная()',
    '  пусть числа = [10, 20, 30]',
    '  пусть первый = числа[0]',
    '  числа[1] = 99',
    '  вернуть первый',
    'конец',
    'конец',
    '',
    '// Пример: если с тогда (тогда опционально, v1.1)',
    'модуль т',
    'процедура главная()',
    '  пусть х = 5',
    '  если х > 0 тогда',
    '    вернуть истина',
    '  иначе',
    '    вернуть ложь',
    '  конец',
    'конец',
    'конец',
    '',
    '// Пример: для_каждого — простой перебор (v1.0, stable в v1.3)',
    'модуль т',
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
    '// Пример: для_каждого с индексом (v1.3 indexed form)',
    'модуль т',
    'процедура главная()',
    '  пусть числа = [10, 20, 30]',
    '  для_каждого эл, и в числа',
    '    система.лог.вывести(и)',
    '  конец',
    '  вернуть 0',
    'конец',
    'конец',
    '',
    '// Пример: объект и поля',
    'модуль т',
    'процедура главная()',
    '  пусть запись = { счёт: 0, имя: "игрок" }',
    '  запись.счёт = запись.счёт + 1',
    '  вернуть запись.счёт',
    'конец',
    'конец',
    '',
    '// Пример: главная с аргументами (v1.1)',
    'модуль т',
    'процедура главная(аргументы)',
    '  пусть первый = аргументы[0]',
    '  система.лог.вывести(первый)',
    '  вернуть 0',
    'конец',
    'конец',
    '',
    '// Пример: обработка ошибок попробовать/иначе_попытка (v1.2-alpha)',
    'модуль т',
    'процедура главная()',
    '  попробовать',
    '    пусть д = система.хранилище.прочитать("ключ")',
    '    вернуть д',
    '  иначе_попытка е',
    '    система.лог.вывести(е)',
    '    вернуть пусто',
    '  конец',
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
    .map((fp) => {
      const lines = [`✗ ${fp.description}`];
      lines.push(`  НЕЛЬЗЯ: ${fp.bad}`);
      if (fp.good) lines.push(`  ПРАВИЛЬНО: ${fp.good}`);
      return lines.join('\n');
    })
    .join('\n\n');
  const stableSyscalls = LANGUAGE_REGISTRY.syscalls
    .filter((sc) => sc.status === 'stable')
    .map((sc) => `${sc.name}(${sc.argc})`)
    .join('\n');

  const errorTips: string[] = [];
  if (errors.some((e) => e.includes('Модуль не найден'))) {
    errorTips.push('Если ошибка содержит "Модуль не найден": проверь путь в `использовать ... из \"путь\"` — файл должен существовать.');
  }
  if (errors.some((e) => e.includes('Процедура не экспортирована'))) {
    errorTips.push('Если ошибка содержит "Процедура не экспортирована": добавь `экспорт` перед процедурой в импортируемом модуле.');
  }

  const parts = [
    prefix ? prefix + '\n\n' : '',
    'Ты компилятор языка Основа. Код содержит ошибки компиляции. Исправь их.',
    '',
    '═══ ПРАВИЛЬНЫЙ ОБРАЗЕЦ ═══',
    '// Всегда: модуль → процедура главная() → конец → конец',
    '// вернуть значение (без скобок)',
    '// конец (не конец_если, не конец_пока)',
    '// arr[i] читается как числа[0], arr[i] = val пишет в массив',
    '// [] и {} многострочные литералы допустимы с v1.1',
    '// multiline: пусть числа = [',
    '//   10,',
    '//   20',
    '// ]  — валидно',
    '// главная() или главная(аргументы) — оба варианта допустимы',
    '// попробовать / иначе_попытка е / конец — перехват ошибок (v1.2)',
    '// выбросить "сообщение" — бросить ошибку',
    '// выбросить принимает только объявленную переменную или строковый литерал',
    '// выбросить "текст ошибки"  ИЛИ  выбросить переменнаяВScope',
    '// НЕЛЬЗЯ: выбросить необъявленнаяПеременная',
    '// для_каждого эл в массив / для_каждого эл, и в массив — оба варианта',
    '// пусть р = удвоить(5) — вызов процедуры, рекурсия поддерживается (v1.4)',
    '// выбросить внутри если внутри попробовать — допустимо (v1.2)',
    '// попробовать / если х > 0 / выбросить "ошибка" / конец / иначе_попытка е / конец',
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
    ...(errorTips.length > 0 ? ['Подсказки по ошибкам:', ...errorTips, ''] : []),
    `Реализованные ключевые слова: ${s.keywords}`,
    '',
    'Верни ТОЛЬКО исправленный код на языке Основа, без пояснений, без markdown-блоков.',
  ].filter(Boolean);
  return parts.join('\n');
}
