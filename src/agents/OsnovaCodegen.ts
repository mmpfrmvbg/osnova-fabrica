// ============================================================
// src/agents/OsnovaCodegen.ts — Главный агент кодогенерации
// trustTier: T2
// Input:  OsnovaSpec + FewShot → OsnovaSource (.osnova)
// ВАЖНО: few-shot обязателен — LLM плохо генерирует кириллику без примеров
// ============================================================

import { getLLMProvider } from '../llm/index';
import { stripMarkdownFence } from '../llm/stripMarkdownFence';
import type { OsnovaSpec, OsnovaSource } from '../pipeline/types';
import { buildOsnovaPrompt } from '../pipeline-llm/buildOsnovaPrompt';
import { wrapLlmError } from '../llm/errors';
import { logger } from '../logger';
import * as fs from 'fs';
import * as path from 'path';

const log = logger('codegen-agent');

let cachedFewShot: string | null = null;

function loadFewShot(): string {
  if (cachedFewShot) return cachedFewShot;
  try {
    const p = path.resolve(__dirname, '../../docs/golden-tests.json');
    const raw = fs.readFileSync(p, 'utf-8');
    const data = JSON.parse(raw) as { tests?: Array<{ name?: string; id?: string; source?: string; osnova?: string }> };
    const cases = data.tests ?? [];
    // Берём примеры по категориям: один generic, один arrays, один с иначе_если
    const byCategory = new Map<string, (typeof cases)[0]>();
    for (const c of cases) {
      const cat = (c as { category?: string }).category ?? 'generic';
      if (!byCategory.has(cat)) byCategory.set(cat, c);
    }
    const selected = [...byCategory.values()].slice(0, 4);
    const goldenExamples = selected
      .filter(c => c.source || c.osnova)
      .map(c => `// Пример: ${c.name ?? c.id}\n${c.source ?? c.osnova}`)
      .join('\n\n---\n\n');

    const sumExample = [
      '// Пример: суммаДо — цикл пока без массивов/объектов',
      'процедура суммаДо(н)',
      '  пусть сумма = 0',
      '  пусть и = 1',
      '  пока и <= н',
      '    сумма = сумма + и',
      '    и = и + 1',
      '  конец',
      '  вернуть сумма',
      'конец',
    ].join('\n');

    cachedFewShot = [goldenExamples, sumExample].filter(Boolean).join('\n\n---\n\n');

    const antiPatterns = `
// ═══ ЗАПРЕЩЁННЫЕ ПАТТЕРНЫ — НИКОГДА НЕ ДЕЛАЙ ТАК ═══

// ✗ НЕЛЬЗЯ — несколько модулей:
// модуль Хранилище ... конец
// модуль Главный ... конец

// ✓ ПРАВИЛЬНО — один модуль:
// модуль Главный
//   процедура вспомогательная() ... конец
//   процедура главная() ... конец
// конец

// ✗ НЕЛЬЗЯ — объектный литерал:
// пусть задача = { название: "текст", готово: ложь }

// ✓ ПРАВИЛЬНО — отдельные переменные:
// пусть задачаНазвание = "текст"
// пусть задачаГотово = ложь

// ✗ НЕЛЬЗЯ — свойство через точку:
// задача.название
// ключ.начинаетсяС("задача:")
// результат.успех

// ✓ ПРАВИЛЬНО — переменные или параметры процедур:
// система.массив.получить(названия, индекс)

// ✗ НЕЛЬЗЯ — межмодульный вызов:
// Хранилище.сохранить(данные)

// ✓ ПРАВИЛЬНО — прямой вызов процедуры в том же модуле:
// сохранить(данные)

// ✗ НЕЛЬЗЯ — несуществующие API:
// система.окно.вывестиТекст(...)
// система.окно.вывод(...)
// ключ.начинаетсяС(...)
// целое32(x)

// ✓ ПРАВИЛЬНО — только: система.лог.вывести(...)
`.trim();

    cachedFewShot = antiPatterns + '\n\n---\n\n' + cachedFewShot;
    return cachedFewShot;
  } catch {
    return '// нет примеров';
  }
}

const SYSTEM_PROMPT = `
Ты — OsnovaCodegen. Генерируй ТОЛЬКО код на языке Основа.

═══ СИНТАКСИС ═══
// ВАЖНО: пусть работает ТОЛЬКО внутри процедуры
// На уровне модуля — только объявления процедур

модуль ИмяМодуля
процедура имя(параметр1, параметр2)
  пусть переменная = значение
  переменная = новоеЗначение

  // Для накопления строки — используй присвоение, не пусть:
  пусть сообщение = "Начало: "
  сообщение = система.строка.объединить(сообщение, переменная1)
  сообщение = система.строка.объединить(сообщение, " и ")
  сообщение = система.строка.объединить(сообщение, переменная2)
  система.лог.вывести(сообщение)

  если условие
    ...
  иначе_если условие2
    ...
  иначе
    ...
  конец
  пока условие
    ...
  конец
  для_каждого элемент в массив
    ...
  конец
  вернуть значение
конец

═══ ТИПЫ ДАННЫХ ═══
Числа: 42, 3.14
Строки: "текст"
Логические: истина, ложь
Пусто: пусто
Массивы: [1, 2, 3] или [] (пустой)

═══ РАЗРЕШЁННЫЕ ОПЕРАЦИИ С МАССИВАМИ ═══
пусть arr = [1, 2, 3]
система.массив.длина(arr)            → число
система.массив.получить(arr, i)      → элемент по индексу
система.массив.добавить(arr, el)     → добавить в конец
система.массив.установить(arr, i, v) → заменить элемент
система.массив.удалить(arr, i)       → удалить по индексу
система.массив.срез(arr, от, до)     → подмассив

═══ РАЗРЕШЁННЫЕ СИСТЕМНЫЕ ВЫЗОВЫ ═══
система.лог.вывести(строка)
система.хранилище.записать(ключ, значение)
система.хранилище.прочитать(ключ)
система.хранилище.ключи()
система.хранилище.удалить(ключ)
система.строка.объединить(а, б)
система.время.сейчас()
система.файлы.прочитать_все(путь)
система.файлы.записать_все(путь, данные)

═══ АБСОЛЮТНЫЕ ЗАПРЕТЫ ═══
✗ пусть вне процедуры: объявление переменной на уровне модуля — невозможно
  Всё объявляется только внутри процедур.
✗ Функции конвертации: целое32(x), строка(x), число(x) — не существуют
  Числа и строки используются как есть, конвертация недоступна.
✗ система.окружение.* — не существует, нет ввода от пользователя в v0.1
  Для тестирования используй константы прямо в коде: пусть число = 42
✗ Объектные литералы: { ключ: значение } — НЕТ В ЯЗЫКЕ
✗ Свойства через точку: массив.длина, объект.поле — НЕТ В ЯЗЫКЕ
✗ Несуществующие API: система.окно.вывод, система.окно.ввод — НЕТ В ЯЗЫКЕ
✗ Английские слова: let, return, if, function, procedure — НЕТ В ЯЗЫКЕ
✗ Повторное объявление: пусть x = 1 ... пусть x = 2 — используй x = 2 без пусть
✗ Markdown-блоки, комментарии на английском, объяснения

═══ ПРАВИЛА СТРУКТУРЫ ═══
- Один модуль на файл
- Имена переменных и процедур — кириллица
- Отступы — 2 пробела
- Последнее слово файла — "конец" (закрывает модуль)
- Вспомогательные процедуры — внутри того же модуля
`.trim();

export class OsnovaCodegenAgent {
  async generate(spec: OsnovaSpec): Promise<OsnovaSource> {
    const provider = getLLMProvider();
    const model = process.env.OSNOVA_MODEL ?? 'qwen-coder-plus';
    const fewShot = loadFewShot();
    log.debug('generate', { model, mainModule: spec.mainModule });

    const specPrompt = buildOsnovaPrompt(JSON.stringify(spec, null, 2));

    let response;
    try {
      response = await provider.complete({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: specPrompt + '\n\n// Few-shot примеры программ на языке Основа:\n' + fewShot,
          },
        ],
        maxTokens: 8000,
        temperature: 0.2,
      });
    } catch (err) {
      throw wrapLlmError(err, 'OsnovaCodegen.generate', { model });
    }

    const source = stripMarkdownFence(response.content);

    return {
      filename: `${spec.mainModule}.osnova`,
      source,
      tokensUsed: response.tokensUsed?.total,
    };
  }
}
