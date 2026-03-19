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
import { buildOsnovaRepairPrompt } from '../pipeline-llm/buildOsnovaPrompt';
import { stripMarkdownFence } from '../llm/stripMarkdownFence';

const log = logger('repair-agent');

const SYSTEM_PROMPT = `
Ты — RepairEngineer языка ОСНОВА.
Получаешь .osnova код + список конкретных ошибок тулчейна.
Исправляй ТОЛЬКО строки с ошибками — не переписывай всю программу.
Не меняй логику — только синтаксис.
✗ несколько модулей в файле
✓ попробовать / иначе_попытка е / конец — валидно с v1.2
✓ выбросить значение — валидно с v1.2
✗ пусть вне процедуры
✓ многострочные литералы [] и {} — допустимы с v1.1.0
✓ рекурсивные вызовы процедур допустимы — вернуть факториал(н - 1)
✓ вызов вспомогательной процедуры из главная — пусть р = удвоить(5)
✓ ошибки именованных типов (v1.6):
  - "Тип не объявлен: X" → добавить объявление тип X { ... } до процедур
  - "Отсутствует обязательное поле: X" → добавить поле X в литерал объекта
  - "Неизвестное поле: X (тип Y)" → убрать лишнее поле X из литерала

═══ ПЕРВЫЙ ПРОХОД (глобальные замены) ═══
система.число.остаток(x, y) → x % y
arr[индекс] уже поддерживается парсером — не заменяй на система.массив.получить
для_каждого элемент в массив → также допустимо для_каждого элемент, индекс в массив (v1.3)
Верни ТОЛЬКО исправленный .osnova код, без объяснений, без markdown.
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
      for (const e of (buildReport.semanticErrors ?? []).filter(
        se => se.kind === 'unknown_syscall' || se.kind === 'undeclared_var' || se.kind === 'unknown_procedure',
      )) {
        errors.push(`Семантика [${e.kind}]: ${e.message}`);
      }
    }

    if (goldenReport) {
      for (const e of goldenReport.vmErrors)
        errors.push(`VM: ${e.message}`);
      if (goldenReport.outputDiff)
        errors.push(`Расхождение с эталоном:\n${goldenReport.outputDiff}`);
    }

    const prefix = attempt ? `// Попытка #${attempt}: предыдущие попытки не исправили проблему.` : undefined;
    const userPrompt = buildOsnovaRepairPrompt(source.source, errors, prefix);

    let response;
    try {
      log.debug('fix errors', { errors });
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

    const fixed = stripMarkdownFence(response.content);

    return {
      filename: source.filename,
      source: fixed,
      tokensUsed: response.tokensUsed?.total,
    };
  }
}
