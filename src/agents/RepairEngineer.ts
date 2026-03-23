// ============================================================
// src/agents/RepairEngineer.ts — Агент ремонта .osnova кода
// trustTier: T2
// Input:  OsnovaSource + BuildReport? + GoldenReport? → OsnovaSource (патч)
// Правило: исправлять только проблемные строки, не переписывать весь файл
// ============================================================

import { getLLMProvider } from '../llm/index';
import type { OsnovaSource, BuildReport, GoldenReport } from '../pipeline/types';
import { BLOCKING_SEMANTIC_KINDS, NON_BLOCKING_SEMANTIC_KINDS } from '../pipeline/semanticKinds';
import { wrapLlmError } from '../llm/errors';
import { logger } from '../logger';
import { buildOsnovaRepairPrompt } from '../pipeline-llm/buildOsnovaPrompt';
import { stripMarkdownFence } from '../llm/stripMarkdownFence';
import { logLlmUsage } from '../lib/usage-logger';

const log = logger('repair-agent');

function collectErrorKinds(buildReport?: BuildReport): string[] | undefined {
  const sem = buildReport?.semanticErrors ?? [];
  if (sem.length === 0) return undefined;
  const allow = [...BLOCKING_SEMANTIC_KINDS, ...NON_BLOCKING_SEMANTIC_KINDS] as readonly string[];
  const kinds: string[] = [];
  const seen = new Set<string>();
  for (const e of sem) {
    if (!allow.includes(e.kind) || seen.has(e.kind)) continue;
    seen.add(e.kind);
    kinds.push(e.kind);
  }
  if (kinds.length === 0) return undefined;
  return kinds;
}

const SYSTEM_PROMPT = `
Ты — RepairEngineer языка ОСНОВА.
═══ ЗАПРЕЩЁННЫЕ КОНСТРУКЦИИ (никогда не генерировать) ═══
✗  имя := значение        →  пусть имя = значение
✗  вернуть(значение)      →  вернуть значение
✗  конец_пока             →  конец
✗  конец_процедуры        →  конец
✗  конец_модуля           →  конец
✗  система.вывести        →  система.лог.вывести
✗  несколько модуль ...   →  один модуль на файл, в начале файла
✗  пусть на уровне модуля →  пусть только внутри процедуры

═══ ОБЯЗАТЕЛЬНАЯ СТРУКТУРА ФАЙЛА ═══
модуль Имя

процедура главная()
  ...
конец

конец

Первая строка — всегда "модуль Имя". Последняя строка — всегда "конец".
Никаких объявлений и пусть вне процедур.

═══ ПРИМЕР ИСПРАВЛЕНИЯ (:= → пусть) ═══
БЫЛО (ошибка):
  сумма := 0
  i := 1
СТАЛО (правильно):
  пусть сумма = 0
  пусть i = 1

═══ ПРИМЕР ИСПРАВЛЕНИЯ (лишний модуль) ═══
БЫЛО (ошибка):
  модуль Хелпер
    процедура помочь() ... конец
  конец
  модуль Главный
    процедура главная() ... конец
  конец
СТАЛО (правильно):
  модуль Главный
  процедура помочь() ... конец
  процедура главная() ... конец
  конец

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

═══ ОШИБКИ АРГУМЕНТОВ И ПЕРЕОПРЕДЕЛЕНИЯ ═══
- syscall_argc: неверное число аргументов syscall → исправить число аргументов согласно system-api
- redeclare_var: переменная уже объявлена → переименовать или убрать дубль пусть

═══ ОШИБКИ ЦИКЛА ═══
- break_outside_loop: прервать использован вне тела цикла → убрать прервать или
  обернуть содержащий код в пока / для_каждого / цикл ... конец
- continue_outside_loop: продолжить использован вне тела цикла → убрать продолжить
  или обернуть содержащий код в пока / для_каждого / цикл ... конец

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
        se => ([...BLOCKING_SEMANTIC_KINDS, ...NON_BLOCKING_SEMANTIC_KINDS] as readonly string[]).includes(se.kind),
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
    const errorKinds = collectErrorKinds(buildReport);
    const userPrompt = buildOsnovaRepairPrompt(source.source, errors, prefix, errorKinds);

    let response;
    const t0 = Date.now();
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

    logLlmUsage({
      timestamp: new Date().toISOString(),
      role: 'RepairEngineer',
      model,
      tokenUsage: {
        prompt:     response.tokensUsed?.prompt     ?? 0,
        completion: response.tokensUsed?.completion ?? 0,
        total:      response.tokensUsed?.total      ?? 0,
      },
      durationMs: Date.now() - t0,
    });

    const fixed = stripMarkdownFence(response.content);

    return {
      filename: source.filename,
      source: fixed,
      tokensUsed: response.tokensUsed?.total,
    };
  }
}
