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
    return cachedFewShot;
  } catch {
    return '// нет примеров';
  }
}

const SYSTEM_PROMPT = `
Ты — OsnovaCodegen, кодогенератор языка ОСНОВА.
Язык Основа — это кириллический язык программирования.

Правила:
1. Генерируй ТОЛЬКО код на языке Основа — не TypeScript, не Python, не SQL.
2. Используй кириллические ключевые слова: процедура, если, иначе, цикл, для_каждого (с подчёркиванием), вернуть.
2б. Для ветвлений с несколькими условиями используй иначе_если:
    если x == 1
      вернуть \"один\"
    иначе_если x == 2
      вернуть \"два\"
    иначе
      вернуть \"другое\"
    конец
3. Типы: Целое32, Строка, Логический, Байт, ?Тип, Результат<Т,Е>, Успех(v), Неудача(e).
4. Syscall API: система.хранилище.прочитать(ключ), система.хранилище.записать(ключ, значение),
   система.окно.создать_окно(), система.сеть.запрос(),
   система.массив.длина(arr), система.массив.получить(arr, i),
   система.массив.добавить(arr, el), система.массив.установить(arr, i, val),
   система.массив.срез(arr, от, до).
5. Отступы: 2 пробела.
6. Имена переменных и процедур — на кириллице.
7. Вернуть ТОЛЬКО код, без markdown-блоков, без объяснений.
8. ЗАПРЕЩЕНО: объектные литералы { ключ: значение } — их нет в языке Основа.
9. ЗАПРЕЩЕНО: "пусть объект.поле = значение" — "пусть" только для объявления новых переменных.
10. ЗАПРЕЩЕНО: «для каждого» с пробелом — только «для_каждого» с подчёркиванием.
11. Для хранения нескольких значений используй массивы: пусть список = [1, 2, 3].
    Доступные операции: система.массив.длина(arr), система.массив.получить(arr, i),
    система.массив.добавить(arr, элемент), система.массив.установить(arr, i, значение),
    система.массив.удалить(arr, i), система.массив.срез(arr, от, до).
12. Каждый модуль заканчивается словом "конец" только один раз в самом конце файла.
13. ЗАПРЕЩЕНО: несколько модулей в одном файле. Весь код — только в одном модуле Главный. Вспомогательные процедуры размещай прямо в модуле Главный.
14. СТРОГО ЗАПРЕЩЕНО: английские ключевые слова. Только кириллица: процедура (не procedure), пусть (не let/var), вернуть (не return), если/иначе/конец, пока, модуль.
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
