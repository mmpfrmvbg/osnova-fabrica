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
import { OSNOVA_FORBIDDEN_RULES } from './osnova-constraints';
import { buildOsnovaRepairPrompt } from '../pipeline-llm/buildOsnovaPrompt';
import { stripMarkdownFence } from '../llm/stripMarkdownFence';

const log = logger('repair-agent');

const SYSTEM_PROMPT = `
Ты — RepairEngineer языка ОСНОВА.
Получаешь .osnova код + список конкретных ошибок тулчейна.

═══ СИНТАКСИС ОСНОВА — ОБЯЗАТЕЛЬНО СОБЛЮДАТЬ ═══

модуль ИмяМодуля
процедура имя(параметр1, параметр2)
  пусть переменная = значение
  переменная = новоеЗначение
  если условие
    ...
  иначе_если условие
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
конец

═══ АБСОЛЮТНЫЕ ЗАПРЕТЫ ═══
✗ Зарезервированные слова как имена параметров/переменных — ЗАПРЕЩЕНО:
  НЕЛЬЗЯ: процедура сумма(начало, конец), пусть конец = 10
  ПРАВИЛЬНО: процедура сумма(старт, предел), пусть предел = 10
  Запрещены: конец, начало, если, иначе, пока, вернуть, пусть, модуль, процедура, истина, ложь, пусто, для_каждого, цикл, в
✗ вернуть(x)        → вернуть x
✗ конец_пока        → конец
✗ конец_процедуры   → конец
✗ конец_модуля      → конец
✗ конец_если        → конец
✗ система.вывести   → система.лог.вывести
✗ массив[i]         → система.массив.получить(массив, i)
✗ и/или/не как имена переменных
✗ тогда после условия
✗ := вместо =
✗ несколько модулей в файле
✗ пусть вне процедуры
✗ многострочные литералы [] и {}

═══ ПРАВИЛА РЕМОНТА ═══

═══ ПЕРВЫЙ ПРОХОД — до любых других исправлений ═══
Перед исправлением других ошибок — найти и заменить ВСЕ вхождения:
  конец_если     → конец
  конец_пока     → конец
  конец_процедуры → конец
  конец_модуля   → конец
  вернуть(...)   → вернуть ...
  система.вывести → система.лог.вывести
  система.число.остаток(x, y) → x % y
  параметр с именем конец → переименовать в предел
  параметр с именем начало → переименовать в старт

Это глобальная замена по всему файлу, не только в строках с ошибками.

1. Исправляй ТОЛЬКО строки с ошибками — не переписывай всю программу.
2. Не меняй логику — только синтаксис.
3. Ошибки лексера: неверный символ → исправь токен.
4. Ошибки парсера: неверная структура → исправь по синтаксису выше.
5. Ошибки VM: неизвестный invoke → замени на разрешённый система.* вызов.
6. Верни ТОЛЬКО исправленный .osnova код, без объяснений, без markdown.

Запрещённые конструкции:
${OSNOVA_FORBIDDEN_RULES}
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
