/**
 * ОРАКУЛ РЕШЕНИЯ О СЛИЯНИИ: `prMerge.decide` различает «зелено» и «не знаю».
 *
 * # Что здесь доказывается
 *
 * Владелец проекта не читает ни диффов, ни логов CI, поэтому единственная защита от
 * «влили красное» — этот оракул. Он проверяет обе стороны каждой границы:
 *
 * | граница | сливается | НЕ сливается / ждёт |
 * |---|---|---|
 * | проверки | все `COMPLETED`, ни одной красной | пусто → ждём; идёт → ждём; красная → не сливаем и называем имя |
 * | автор | владелец, dependabot | чужой → решает человек |
 * | черновик | готовый PR | `isDraft` → не сливаем |
 * | ветка | `main` | другая цель → не сливаем |
 * | конфликт | `MERGEABLE` | `CONFLICTING`/`DIRTY` → не сливаем |
 *
 * Отдельно проверено, что `SKIPPED` (метрики, выключенные на PR) — **не** красная
 * проверка: иначе ни один PR не слился бы никогда.
 */

import { describe, expect, it } from 'vitest';
import {
  authorAllowed,
  checkState,
  decide,
  formatLine,
  mergeCommand,
  parseArgs,
  summarize,
  type OpenPr,
  type RawCheck,
} from './prMerge';

/** PR владельца, все проверки зелёные. */
function ownerPr(overrides: Partial<OpenPr> = {}): OpenPr {
  return {
    number: 115,
    title: 'B2b: пусть, присваивание, выражения',
    isDraft: false,
    baseRefName: 'main',
    headRefName: 'feat/b2b',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    author: { login: 'mmpfrmvbg', is_bot: false },
    statusCheckRollup: [
      { name: 'типы + линт + тесты + шлюзы', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'QEMU + AST (METRICS)', status: 'COMPLETED', conclusion: 'SKIPPED' },
    ],
    ...overrides,
  };
}

function checks(...items: RawCheck[]): RawCheck[] {
  return items;
}

describe('decide: слияние разрешено только по зелёному списку проверок', () => {
  it('владелец, все проверки COMPLETED и зелёные → сливать', () => {
    expect(decide(ownerPr())).toEqual({ action: 'merge', reason: 'все проверки зелёные' });
  });

  it('СИГНАЛ «CLEAN» НЕ ДОСТАТОЧЕН: пустой список проверок → ждать', () => {
    const decision = decide(ownerPr({ statusCheckRollup: [] }));
    expect(decision.action).toBe('wait');
    expect(decision.reason).toContain('не запускались');
  });

  it('проверки ещё идут → ждать и назвать, сколько из скольких', () => {
    const decision = decide(
      ownerPr({
        statusCheckRollup: checks(
          { name: 'tests', status: 'COMPLETED', conclusion: 'SUCCESS' },
          { name: 'qemu', status: 'IN_PROGRESS', conclusion: null },
        ),
      }),
    );
    expect(decision.action).toBe('wait');
    expect(decision.reason).toBe('проверки идут: 1 из 2');
  });

  it('красная проверка → не сливать и назвать её ИМЯ, а не «есть красные»', () => {
    const decision = decide(
      ownerPr({
        statusCheckRollup: checks(
          { name: 'типы + линт + тесты + шлюзы', status: 'COMPLETED', conclusion: 'SUCCESS' },
          { name: 'Golden Gate', status: 'COMPLETED', conclusion: 'FAILURE' },
        ),
      }),
    );
    expect(decision.action).toBe('skip');
    expect(decision.reason).toBe('красные проверки: Golden Gate');
  });

  it('SKIPPED не красная: иначе не слился бы ни один PR (метрики на PR выключены)', () => {
    expect(
      decide(
        ownerPr({
          statusCheckRollup: checks({
            name: 'METRICS',
            status: 'COMPLETED',
            conclusion: 'SKIPPED',
          }),
        }),
      ).action,
    ).toBe('merge');
  });

  it('PR-бот dependabot сливается, чужой PR — нет', () => {
    expect(decide(ownerPr({ author: { login: 'app/dependabot', is_bot: true } })).action).toBe(
      'merge',
    );
    expect(decide(ownerPr({ author: { login: 'random-contributor', is_bot: false } })).action).toBe(
      'skip',
    );
    expect(authorAllowed(ownerPr({ author: { login: 'random-contributor' } }))).toBe(false);
  });

  it('черновик, чужая цель, конфликт и блокировка — не сливаются', () => {
    expect(decide(ownerPr({ isDraft: true })).action).toBe('skip');
    expect(decide(ownerPr({ baseRefName: 'release' })).reason).toContain('release');
    expect(decide(ownerPr({ mergeable: 'CONFLICTING' })).reason).toContain('перебазировать');
    expect(decide(ownerPr({ mergeStateStatus: 'DIRTY' })).action).toBe('skip');
    expect(decide(ownerPr({ mergeStateStatus: 'BLOCKED' })).action).toBe('skip');
  });

  it('GitHub ещё не решил (UNKNOWN) → ждать, а не сливать наугад', () => {
    expect(decide(ownerPr({ mergeable: 'UNKNOWN' })).action).toBe('wait');
    expect(decide(ownerPr({ mergeStateStatus: 'UNKNOWN' })).action).toBe('wait');
  });

  it('старый вид проверки (StatusContext: state) читается, а не висит «идёт» вечно', () => {
    expect(checkState({ context: 'old-ci', state: 'PENDING' })).toEqual({
      name: 'old-ci',
      done: false,
      red: false,
    });
    expect(checkState({ context: 'old-ci', state: 'FAILURE' }).red).toBe(true);
    expect(
      decide(ownerPr({ statusCheckRollup: checks({ context: 'old-ci', state: 'SUCCESS' }) }))
        .action,
    ).toBe('merge');
  });
});

describe('summarize: числа отчёта', () => {
  it('считает по действиям', () => {
    expect(
      summarize([
        { action: 'merge', reason: '' },
        { action: 'wait', reason: '' },
        { action: 'skip', reason: '' },
        { action: 'merge', reason: '' },
      ]),
    ).toEqual({ merge: 2, wait: 1, skip: 1 });
  });
});

describe('аргументы и отчёт', () => {
  it('по умолчанию сухой прогон: без --apply main не меняется', () => {
    expect(parseArgs([])).toEqual({ apply: false, only: null });
    expect(parseArgs(['--apply'])).toEqual({ apply: true, only: null });
    expect(parseArgs(['--only', '115', '--apply'])).toEqual({ apply: true, only: 115 });
    expect(() => parseArgs(['--only'])).toThrow(/номер PR/);
    expect(() => parseArgs(['--only', 'abc'])).toThrow(/номер PR/);
  });

  it('команда слияния — merge-коммит, как в истории репозитория', () => {
    expect(mergeCommand(115)).toEqual(['pr', 'merge', '115', '--merge']);
  });

  it('строка отчёта называет номер, действие и причину', () => {
    const pr = ownerPr();
    const line = formatLine(pr, decide(pr));
    expect(line).toContain('#115');
    expect(line).toContain('можно слить');
    expect(line).toContain('все проверки зелёные');
  });
});
