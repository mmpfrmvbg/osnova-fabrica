// ============================================================
// src/agents/OsnovaCodegen.ts — Главный агент кодогенерации
// trustTier: T2
// Input:  OsnovaSpec + FewShot → OsnovaSource (.osnova)
// ВАЖНО: few-shot обязателен — LLM плохо генерирует кириллику без примеров
// ============================================================

import { getLLMProvider } from '../llm/index';
import { resolvePhaseRouting } from '../llm/routing';
import { stripMarkdownFence } from '../llm/stripMarkdownFence';
import type { OsnovaSpec, OsnovaSource } from '../pipeline/types';
import { buildOsnovaPrompt, assertFewShotNotEmpty } from '../pipeline-llm/buildOsnovaPrompt';
import { wrapLlmError } from '../llm/errors';
import { logger } from '../logger';
import { logLlmUsage } from '../lib/usage-logger';
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
    const selected = Array.from(byCategory.values()).slice(0, 4);
    const goldenExamples = selected
      .filter(c => c.source || c.osnova)
      .map(c => `// Пример: ${c.name ?? c.id}\n${c.source ?? c.osnova}`)
      .join('\n\n---\n\n');

    const sumExample = [
      '// Пример: суммаДо — цикл пока без массивов/объектов',
      'процедура суммаДо(н)',
      '  пусть сумма = 0',
      '  пусть к = 1',
      '  пока к <= н',
      '    сумма = сумма + к',
      '    к = к + 1',
      '  конец',
      '  вернуть сумма',
      'конец',
    ].join('\n');

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

// ✓ ПРАВИЛЬНО — объект и доступ к полю:
// пусть задача = { название: "текст", готово: ложь }
// пусть н = задача.название
// задача.готово = истина

// ✓ ПРАВИЛЬНО — система.* вызовы:
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

    const v12Patterns = `
// ═══ НОВОЕ в v1.1/v1.2 — ИСПОЛЬЗУЙ ЭТИ ПАТТЕРНЫ ═══

// ✓ Индексный доступ к массиву (v1.1 sugar):
// пусть первый = числа[0]
// числа[1] = 99
// числа[0] += 5

// ✓ Опциональное тогда:
// если условие тогда
//   ...
// конец

// ✓ Аргументы командной строки:
// процедура главная(аргументы)
//   пусть первый = аргументы[0]
// конец
//
// ✓ Обработка ошибок (v1.2-alpha):
// попробовать
//   пусть д = система.хранилище.прочитать("ключ")
// иначе_попытка е
//   система.лог.вывести(е)
// конец
//
// выбросить "что-то пошло не так"
//
// ✓ для_каждого с индексом (v1.3 stable):
// для_каждого элемент, индекс в массив
//   система.лог.вывести(индекс)
// конец
//
// ✓ Вызов вспомогательной процедуры (v1.4):
// процедура удвоить(х)
//   вернуть х * 2
// конец
// процедура главная()
//   пусть р = удвоить(5)
//   вернуть р
// конец
//
// ✓ Рекурсия допустима:
// процедура факториал(н)
//   если н <= 1
//     вернуть 1
//   конец
//   вернуть н * факториал(н - 1)
// конец
`.trim();

    cachedFewShot = [goldenExamples, sumExample, antiPatterns, v12Patterns]
      .filter(Boolean)
      .join('\n\n---\n\n');
    return cachedFewShot;
  } catch {
    return '// нет примеров';
  }
}

const SYSTEM_PROMPT = `
Ты — OsnovaCodegen. Генерируй ТОЛЬКО код на языке Основа.
Ядро синтаксиса, операторы, литералы, системные вызовы и запрещённые паттерны
приходят в user prompt из language-registry. Следуй им строго.

═══ ПРАВИЛА СТРУКТУРЫ ═══
- процедура главная() — ВСЕГДА без параметров, создаёт данные внутри себя
- вспомогательные процедуры могут принимать параметры
- Рекурсия компилируется, но может падать в VM — предпочитай итерацию через пока.
- Для факториала, Фибоначчи и подобных задач — всегда используй цикл пока, не рекурсию.
- Один модуль на файл
- Имена переменных и процедур — кириллица
- Отступы — 2 пробела
- Последнее слово файла — "конец" (закрывает модуль)
- Вспомогательные процедуры — внутри того же модуля

## Именованные типы (v1.6.0)

Правила:
- nullable-поле: ?Тип — может быть пусто, при отсутствии в литерале = пусто
- обязательные поля (без ?) — ДОЛЖНЫ присутствовать в литерале
- вложенные типы в полях НЕ поддерживаются (только Целое32, Строка, Логический + nullable)
- тип Имя { } — запрещено генерировать внутри процедуры

---
❌ ЗАПРЕЩЕНО в полях типа:
- другой именованный тип как поле: тип Заказ { клиент: Клиент } — НЕЛЬЗЯ
- массив как поле: позиции: массив — НЕЛЬЗЯ
- объект как поле: адрес: { город: Строка } — НЕЛЬЗЯ
- допустимы ТОЛЬКО: Целое32, Строка, Логический, ?Целое32, ?Строка, ?Логический

❌ ЗАПРЕЩЕНО использовать система.* которых нет в разделе "РАЗРЕШЁННЫЕ СИСТЕМНЫЕ ВЫЗОВЫ"
из user prompt (подставляется из language-registry):
- разрешены только система.*(argc), перечисленные в user prompt.
Любой другой система.* вызов — ОШИБКА компиляции.
---

Объявление типа (только на уровне модуля, до процедур):
тип Заказ {
  стол: Целое32
  гость: Строка
  оплачен: Логический
  комментарий: ?Строка
}

Аннотация переменной (опциональная):
пусть заказ: Заказ = { стол: 3, гость: "Иван", оплачен: ложь }
`.trim();

function loadAbPromptOverride(): string | null {
  const promptFile = process.env.OSNOVA_AB_PROMPT_FILE;
  if (!promptFile) return null;
  try {
    return fs.readFileSync(promptFile, 'utf-8').trim();
  } catch {
    process.stderr.write(
      `[ab-prompt] не удалось прочитать ${promptFile} — используется встроенный промпт\n`,
    );
    return null;
  }
}

export class OsnovaCodegenAgent {
  constructor(private registryContext: string = '') {}

  async generate(spec: OsnovaSpec): Promise<OsnovaSource> {
    const provider = getLLMProvider();
    const routing = resolvePhaseRouting('codegen');
    const model = routing.model;
    const fewShot = loadFewShot();
    log.debug('generate', {
      model,
      tier: routing.tier,
      level: routing.level,
      mainModule: spec.mainModule,
    });

    assertFewShotNotEmpty(fewShot, 'OsnovaCodegen.generate');
    const specPrompt = buildOsnovaPrompt(JSON.stringify(spec, null, 2));

    const systemPrompt = loadAbPromptOverride() ?? SYSTEM_PROMPT;

    let response;
    const t0 = Date.now();
    try {
      response = await provider.complete({
        model,
        messages: [
          {
            role: 'system',
            content: systemPrompt + (this.registryContext ? '\n\n' + this.registryContext : ''),
          },
          {
            role: 'user',
            content: specPrompt + '\n\n// Few-shot примеры программ на языке Основа:\n' + fewShot,
          },
        ],
        maxTokens: routing.maxTokens,
        temperature: routing.temperature,
        thinking: routing.thinking,
        reasoningEffort: routing.reasoningEffort,
      });
    } catch (err) {
      throw wrapLlmError(err, 'OsnovaCodegen.generate', { model });
    }

    logLlmUsage({
      timestamp: new Date().toISOString(),
      role: 'OsnovaCodegen',
      model,
      tokenUsage: {
        prompt:     response.tokensUsed?.prompt     ?? 0,
        completion: response.tokensUsed?.completion ?? 0,
        total:      response.tokensUsed?.total      ?? 0,
      },
      durationMs: Date.now() - t0,
    });

    const source = stripMarkdownFence(response.content);

    return {
      filename: `${spec.mainModule}.osnova`,
      source,
      tokensUsed: response.tokensUsed?.total,
    };
  }
}
