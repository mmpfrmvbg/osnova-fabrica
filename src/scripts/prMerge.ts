#!/usr/bin/env node
/**
 * СЛИЯНИЕ PR БЕЗ ВЛАДЕЛЬЦА: владелец проекта — не программист (AGENTS.md, раздел
 * «Владелец — НЕ программист: issue, PR и слияния ведёт агент»).
 *
 * Инструмент отвечает на один вопрос: **«какие открытые pull request уже безопасно
 * влить в `main`, а какие нет и почему»** — и по `--apply` вливает. Решение принимает
 * он, а не владелец: смотреть диффы и логи CI владельцу нечем.
 *
 * # Почему решение НЕ по `mergeStateStatus: CLEAN`
 *
 * Защита ветки `main` в GitHub-репозитории не включена (проверено 2026-11-12:
 * `gh api repos/…/branches/main/protection` → 404). Без защиты GitHub выставляет
 * `CLEAN` и пока проверки ещё идут, поэтому слияние «по CLEAN» влило бы PR с красными
 * тестами — то есть молча внесло бы в `main` дефект, который проверки как раз и ловят.
 * Единственный источник решения — **список проверок** (`statusCheckRollup`):
 *
 * | состояние списка | что это значит | действие |
 * |---|---|---|
 * | пуст | проверки ещё не запускались — «не знаю», а не «хорошо» | ждать |
 * | есть `status != COMPLETED` | проверки идут | ждать |
 * | есть `FAILURE`/`TIMED_OUT`/… | проверки красные | не сливать, назвать имена |
 * | все `COMPLETED`, ни одной красной | можно | слить |
 *
 * # Что НИКОГДА не сливается
 *
 * - черновик (`isDraft`) — он ещё не объявлен готовым;
 * - ветка не в `main`;
 * - автор не владелец и не dependabot: чужой PR — это решение человека, а не агента;
 * - конфликт с `main` (`CONFLICTING`/`DIRTY`) — сперва перебазировать;
 * - заблокирован правилами (`BLOCKED`).
 *
 * # Запуск
 *
 * ```powershell
 * npm run pr:merge                      # сухой прогон: показать и объяснить
 * npm run pr:merge -- --apply           # слить всё зелёное и безопасное
 * npm run pr:merge -- --only 115 --apply
 * ```
 *
 * Сухой прогон — по умолчанию НАМЕРЕННО: инструмент, который без флага меняет `main`,
 * однажды сработает не в тот момент и не в том дереве.
 */

import { execFileSync } from 'node:child_process';

/** Логин владельца: его PR можно вливать без вопросов. */
export const OWNER_LOGIN = 'mmpfrmvbg';

/** Логины, которыми GitHub подписывает обновления зависимостей. */
const BOT_LOGINS: readonly string[] = ['app/dependabot', 'dependabot[bot]', 'dependabot'];

/** Заключения проверок, при которых PR сливать нельзя (всё остальное — не красное). */
const RED_CONCLUSIONS: readonly string[] = [
  'FAILURE',
  'TIMED_OUT',
  'CANCELLED',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
  'STALE',
  'ERROR',
];

/** Проверка в том виде, в каком её отдаёт `gh pr list --json statusCheckRollup`. */
export interface RawCheck {
  readonly __typename?: string | null;
  readonly name?: string | null;
  readonly status?: string | null;
  readonly conclusion?: string | null;
  readonly context?: string | null;
  readonly state?: string | null;
}

/** Открытый PR в том виде, в каком его отдаёт `gh pr list --json …`. */
export interface OpenPr {
  readonly number: number;
  readonly title: string;
  readonly isDraft: boolean;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly mergeable: string;
  readonly mergeStateStatus: string;
  readonly author?: { readonly login?: string | null; readonly is_bot?: boolean | null } | null;
  readonly statusCheckRollup?: readonly RawCheck[] | null;
}

/** Что делать с PR. */
export type Action = 'merge' | 'wait' | 'skip';

/** Решение по одному PR: действие и его причина обычными словами. */
export interface Decision {
  readonly action: Action;
  readonly reason: string;
}

/** Нормализованное состояние одной проверки. */
export interface CheckState {
  readonly name: string;
  readonly done: boolean;
  readonly red: boolean;
}

/**
 * Приводит проверку к «закончилась / ещё идёт / красная».
 *
 * В `statusCheckRollup` лежат ДВА вида записей: `CheckRun` (`status` + `conclusion`)
 * и старый `StatusContext` (`state`). Считать только первый значило бы объявить
 * старый вид «ещё идущим» навсегда — то есть вечно ждать.
 */
export function checkState(check: RawCheck): CheckState {
  const name = check.name ?? check.context ?? 'проверка без имени';
  if (typeof check.status === 'string' && check.status.length > 0) {
    return {
      name,
      done: check.status === 'COMPLETED',
      red: RED_CONCLUSIONS.includes((check.conclusion ?? '').toUpperCase()),
    };
  }
  const state = (check.state ?? '').toUpperCase();
  return {
    name,
    done: state !== 'PENDING' && state !== 'EXPECTED' && state.length > 0,
    red: state === 'FAILURE' || state === 'ERROR',
  };
}

/** Автор, чьи PR агент вправе вливать сам: владелец и бот зависимостей. */
export function authorAllowed(pr: OpenPr): boolean {
  const login = pr.author?.login ?? '';
  return login === OWNER_LOGIN || BOT_LOGINS.includes(login) || login.startsWith('dependabot');
}

/**
 * Решение по одному PR. Чистая функция: ни сети, ни git — поэтому её поведение
 * проверяется оракулом без живого GitHub.
 */
export function decide(pr: OpenPr): Decision {
  if (pr.isDraft) {
    return { action: 'skip', reason: 'черновик: ещё не объявлен готовым' };
  }
  if (pr.baseRefName !== 'main') {
    return { action: 'skip', reason: `цель «${pr.baseRefName}», а не main` };
  }
  if (!authorAllowed(pr)) {
    return {
      action: 'skip',
      reason: `автор «${pr.author?.login ?? '?'}» — не владелец и не бот зависимостей: решает человек`,
    };
  }
  if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY') {
    return { action: 'skip', reason: 'конфликт с main: сначала перебазировать' };
  }
  if (pr.mergeStateStatus === 'BLOCKED') {
    return { action: 'skip', reason: 'слияние заблокировано правилами ветки' };
  }

  const states = (pr.statusCheckRollup ?? []).map(checkState);
  if (states.length === 0) {
    return { action: 'wait', reason: 'проверки ещё не запускались' };
  }
  const running = states.filter((s) => !s.done);
  if (running.length > 0) {
    return { action: 'wait', reason: `проверки идут: ${running.length} из ${states.length}` };
  }
  const red = states.filter((s) => s.red);
  if (red.length > 0) {
    return { action: 'skip', reason: `красные проверки: ${red.map((s) => s.name).join(', ')}` };
  }
  if (pr.mergeable === 'UNKNOWN' || pr.mergeStateStatus === 'UNKNOWN') {
    return { action: 'wait', reason: 'GitHub ещё считает, можно ли слить' };
  }
  if (pr.mergeable !== 'MERGEABLE') {
    return { action: 'wait', reason: `GitHub не подтверждает слияние (${pr.mergeable})` };
  }
  return { action: 'merge', reason: 'все проверки зелёные' };
}

/** Итог по всем PR — числами, чтобы отчёт был проверяемым. */
export interface Summary {
  readonly merge: number;
  readonly wait: number;
  readonly skip: number;
}

export function summarize(decisions: readonly Decision[]): Summary {
  return {
    merge: decisions.filter((d) => d.action === 'merge').length,
    wait: decisions.filter((d) => d.action === 'wait').length,
    skip: decisions.filter((d) => d.action === 'skip').length,
  };
}

/** Строка отчёта по одному PR: обычными словами, для владельца. */
export function formatLine(pr: OpenPr, decision: Decision): string {
  const title = pr.title.length > 60 ? `${pr.title.slice(0, 57)}…` : pr.title;
  const what =
    decision.action === 'merge'
      ? 'можно слить'
      : decision.action === 'wait'
        ? 'ждём'
        : 'не сливаем';
  return `[PR] #${pr.number} «${title}» — ${what}: ${decision.reason}`;
}

/** Вызов `gh` с JSON-ответом. */
export function ghJson(args: readonly string[]): unknown {
  const out = execFileSync('gh', [...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out) as unknown;
}

/** Команда слияния: merge-коммит, как в истории репозитория; ветку удаляет настройка repo. */
export function mergeCommand(number: number): readonly string[] {
  return ['pr', 'merge', String(number), '--merge'];
}

/** Разбор аргументов командной строки. */
export interface CliOptions {
  readonly apply: boolean;
  readonly only: number | null;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const onlyIndex = argv.indexOf('--only');
  let only: number | null = null;
  if (onlyIndex >= 0) {
    const raw = argv[onlyIndex + 1];
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`--only требует номер PR, получено «${raw ?? ''}»`);
    }
    only = parsed;
  }
  return { apply: argv.includes('--apply'), only };
}

/** Точка входа CLI. Возвращает код возврата процесса. */
export function main(argv: readonly string[]): number {
  const options = parseArgs(argv);
  const prs = ghJson([
    'pr',
    'list',
    '--state',
    'open',
    '--limit',
    '100',
    '--json',
    'number,title,isDraft,baseRefName,headRefName,mergeable,mergeStateStatus,author,statusCheckRollup',
  ]) as OpenPr[];

  const selected = options.only === null ? prs : prs.filter((pr) => pr.number === options.only);
  if (options.only !== null && selected.length === 0) {
    console.error(`[PR] #${options.only} не найден среди открытых`);
    return 1;
  }

  const decisions = selected.map((pr) => ({ pr, decision: decide(pr) }));
  for (const { pr, decision } of decisions) {
    console.log(formatLine(pr, decision));
  }

  const summary = summarize(decisions.map((d) => d.decision));
  console.log(
    `\nИтог: можно слить ${summary.merge}, ждём ${summary.wait}, не сливаем ${summary.skip}.`,
  );

  if (!options.apply) {
    console.log('Сухой прогон: чтобы слить, добавьте --apply.');
    return 0;
  }

  let failed = 0;
  for (const { pr, decision } of decisions) {
    if (decision.action !== 'merge') continue;
    try {
      execFileSync('gh', [...mergeCommand(pr.number)], { encoding: 'utf8', stdio: 'inherit' });
      console.log(`[PR] #${pr.number} слит в main.`);
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[PR] #${pr.number} слить не удалось: ${message}`);
    }
  }
  return failed === 0 ? 0 : 1;
}

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(`[PR] ошибка: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
