// ============================================================
// src/agents/RepairEngineer.ts — Агент ремонта .osnova кода
// trustTier: T2
// Input:  OsnovaSource + BuildReport? + GoldenReport? → OsnovaSource (патч)
// Правило: исправлять только проблемные строки, не переписывать весь файл
// ============================================================

import { getLLMProvider } from '../llm/index';
import type { OsnovaSource, BuildReport, GoldenReport } from '../pipeline/types';
import { wrapLlmError } from '../llm/errors';
import { logger } from '../logger';

const log = logger('repair-agent');

const SYSTEM_PROMPT = `
Ты — RepairEngineer языка ОСНОВА.
Получаешь .osnova код + список конкретных ошибок тулчейна.

Правила:
1. Исправь ТОЛЬКО строки с ошибками — не переписывай всю программу.
2. Не меняй логику — только синтаксис/типы.
3. Ошибки лексера: неверный символ, незакрытая строка → исправь токен.
4. Ошибки парсера: неверная структура → добавь/убери ключевое слово.
5. Ошибки VM: stack underflow, неизвестный invoke → исправь вызов система.*.
6. Верни ТОЛЬКО исправленный .osnova код, без объяснений, без markdown.
`.trim();

export class RepairEngineerAgent {
  async fix(
    source: OsnovaSource,
    buildReport?: BuildReport,
    goldenReport?: GoldenReport,
    attempt?: number,
  ): Promise<OsnovaSource> {
    const provider = getLLMProvider();
    const model = process.env.OSNOVA_MODEL ?? 'qwen-coder-plus';
    log.debug('fix', { model, attempt, filename: source.filename });

    const errors: string[] = [];

    if (buildReport) {
      for (const e of buildReport.lexerErrors)
        errors.push(`Лексер [${e.line}:${e.column}]: ${e.message}`);
      for (const e of buildReport.parserErrors)
        errors.push(`Парсер [${e.line}:${e.column}]: ${e.message}`);
      for (const e of buildReport.compilerErrors)
        errors.push(`Компилятор: ${e.message}`);
    }

    if (goldenReport) {
      for (const e of goldenReport.vmErrors)
        errors.push(`VM: ${e.message}`);
      if (goldenReport.outputDiff)
        errors.push(`Расхождение с эталоном:\n${goldenReport.outputDiff}`);
    }

    const userPrompt = [
      '// Текущий .osnova код:',
      source.source,
      '',
      '// Ошибки:',
      errors.length > 0 ? errors.join('\n') : 'Программа выполнилась, но результат не совпадает с эталоном.',
    ].join('\n');

    let response;
    try {
      response = await provider.complete({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        maxTokens: 8000,
        temperature: 0.1,
      });
    } catch (err) {
      throw wrapLlmError(err, 'RepairEngineer.fix', { model, attempt });
    }

    const fixed = response.content
      .replace(/```[a-z]*\n?/g, '')
      .replace(/```/g, '')
      .trim();

    return {
      filename: source.filename,
      source: fixed,
      tokensUsed: response.tokensUsed?.total,
    };
  }
}
