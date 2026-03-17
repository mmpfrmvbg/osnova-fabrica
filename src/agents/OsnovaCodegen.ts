// ============================================================
// src/agents/OsnovaCodegen.ts — Главный агент кодогенерации
// trustTier: T2
// Input:  OsnovaSpec + FewShot → OsnovaSource (.osnova)
// ВАЖНО: few-shot обязателен — LLM плохо генерирует кириллику без примеров
// ============================================================

import { getLLMProvider } from '../llm/index';
import type { OsnovaSpec, OsnovaSource } from '../pipeline/types';
import * as fs from 'fs';
import * as path from 'path';

function loadFewShot(): string {
  try {
    const p = path.resolve(__dirname, '../../docs/golden-tests.json');
    const raw = fs.readFileSync(p, 'utf-8');
    const cases = JSON.parse(raw) as Array<{ name: string; source?: string; osnova?: string }>;
    return cases
      .slice(0, 3)
      .filter(c => c.source || c.osnova)
      .map(c => `// Пример: ${c.name}\n${c.source ?? c.osnova}`)
      .join('\n\n---\n\n');
  } catch {
    return '// нет примеров';
  }
}

const SYSTEM_PROMPT = `
Ты — OsnovaCodegen, кодогенератор языка ОСНОВА.
Язык Основа — это кириллический язык программирования.

Правила:
1. Генерируй ТОЛЬКО код на языке Основа — не TypeScript, не Python, не SQL.
2. Используй кириллические ключевые слова: процедура, если, иначе, цикл, для каждого, вернуть.
3. Типы: Целое32, Строка, Логический, Байт, ?Тип, Результат<Т,Е>, Успех(v), Неудача(e).
4. Syscall API: система.хранилище.получить(), система.хранилище.сохранить(),
   система.окно.создать_окно(), система.сеть.запрос().
5. Отступы: 2 пробела.
6. Имена переменных и процедур — на кириллице.
7. Вернуть ТОЛЬКО код, без markdown-блоков, без объяснений.
`.trim();

export class OsnovaCodegenAgent {
  async generate(spec: OsnovaSpec): Promise<OsnovaSource> {
    const provider = getLLMProvider();
    const fewShot = loadFewShot();

    const userPrompt = [
      '// Примеры программ на языке Основа:',
      fewShot,
      '',
      '// Задание:',
      `// Сгенерируй программу на языке Основа по спецификации:`,
      JSON.stringify(spec, null, 2),
    ].join('\n');

    const response = await provider.complete({
      model: process.env.OSNOVA_MODEL ?? 'llama3.2',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      maxTokens: 8000,
      temperature: 0.2,
    });

    const source = response.content
      .replace(/```[a-z]*\n?/g, '')
      .replace(/```/g, '')
      .trim();

    return {
      filename: `${spec.mainModule}.osnova`,
      source,
      tokensUsed: response.tokensUsed?.total,
    };
  }
}
