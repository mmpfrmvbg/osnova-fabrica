#!/usr/bin/env node
/**
 * ГЕЙТ «ТРАССА ДО ПРАВКИ» — запуск из CI.
 *
 * # Почему отдельный запуск, а не только оракул
 *
 * Оракул `traceGate.audit.test.ts` доказывает, что проверка **умеет** краснеть и что шаблон несёт
 * раздел. Настоящий гейт — это тот же код, исполненный **на теле живого PR**: без этого шага
 * правило остаётся оракулом о правиле, а не преградой (случай 8 реестра: сторож без красной
 * стороны).
 *
 * # Откуда берётся тело
 *
 * На событии `pull_request` GitHub кладёт тело в файл события — `GITHUB_EVENT_PATH`. Ни токена, ни
 * сети: тело уже в руках у CI. Флаг `--pr <N>` (или `TRACE_PR`) зовёт `gh pr view` — для локальной
 * проверки перед пушем.
 *
 * # Код возврата
 *
 * | код | что значит |
 * |---|---|
 * | 0 | трасса есть и заполнена; шаблон в порядке |
 * | 1 | нарушение — PR **не принимается** (текст отказа называет случай) |
 * | 2 | тела PR нет и взять неоткуда — это **«не проверено»**, а не «прошло» |
 *
 * Код 2 отличается от 1 намеренно: «не проверено» и «проверено и плохо» — разные состояния, и
 * сливать их в один ненулевой код значило бы снова стереть различие (случай 12).
 */

import { runTraceGate } from './traceGate';

function prNumberFromArgs(argv: readonly string[]): number | null {
  const at = argv.indexOf('--pr');
  const raw = at >= 0 ? argv[at + 1] : process.env.TRACE_PR;
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  const verdict = runTraceGate({ prNumber: prNumberFromArgs(argv) });

  for (const problem of verdict.templateProblems) console.error(`[шаблон] ${problem}`);
  for (const problem of verdict.body.problems) console.error(`[тело PR] ${problem}`);

  const sourceText =
    verdict.body.source === 'event'
      ? 'файл события GitHub'
      : verdict.body.source === 'gh'
        ? 'gh pr view --json body'
        : 'нет';

  if (!verdict.ok) {
    console.error(`\nГЕЙТ ТРАССЫ: тело PR — ${sourceText}; нарушений ${verdict.templateProblems.length + verdict.body.problems.length}.`);
    return 1;
  }

  if (verdict.body.source === 'нет') {
    // Шаблон проверен, а тело — нет. Это не «прошло»: назвать честно.
    console.log(
      'ГЕЙТ ТРАССЫ: шаблон в порядке; ТЕЛА PR НЕТ — проверено «не применимо», а не «пройдено». ' +
        'Для проверки тела: --pr <N> или GITHUB_EVENT_PATH.',
    );
    return 2;
  }

  console.log(`ГЕЙТ ТРАССЫ: трасса есть и заполнена (источник тела — ${sourceText}); нарушений 0.`);
  return 0;
}

if (require.main === module) {
  process.exit(main());
}
