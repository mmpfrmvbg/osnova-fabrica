// ============================================================
// src/lib/fixtureTasks.test.ts
//
// Оракул фильтра фикстур. Негативные контроли обязательны: фильтр, который
// «ловит всё», обнулил бы статистику, а фильтр, который пропускает частую
// задачу, раздувает её.
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  FIXTURE_REPEAT_THRESHOLD,
  KNOWN_FIXTURE_TASKS,
  assertNoEscapedFixtures,
  escapedFixtureCandidates,
  isFixtureTask,
  splitFixtures,
  taskCounts,
} from './fixtureTasks';

describe('isFixtureTask: список, а не эвристика', () => {
  it('каждая объявленная фикстура распознаётся', () => {
    for (const f of KNOWN_FIXTURE_TASKS) {
      expect(isFixtureTask(f.task), f.task).toBe(true);
    }
  });

  it('«тест» (111 прогонов) распознаётся — регрессия регулярки с \\b и кириллицей', () => {
    expect(isFixtureTask('тест')).toBe(true);
  });

  it('редкая осмысленная задача фикстурой не считается', () => {
    expect(isFixtureTask('сделай TODO-лист')).toBe(false);
    expect(isFixtureTask('найди наибольший общий делитель чисел 48 и 18')).toBe(false);
  });

  it('задача, ПОХОЖАЯ на тестовую, но не объявленная — не фикстура (нет эвристики)', () => {
    expect(isFixtureTask('тестирование нового модуля')).toBe(false);
    expect(isFixtureTask('тест G1 pipeline')).toBe(false);
  });
});

describe('escapedFixtureCandidates и сторож', () => {
  it('частая необъявленная задача становится кандидатом', () => {
    const counts = taskCounts([...Array(60).fill('новая частая задача')]);
    expect(escapedFixtureCandidates(counts)).toEqual([
      { task: 'новая частая задача', count: 60 },
    ]);
    expect(() => assertNoEscapedFixtures(counts)).toThrow(/новая частая задача/);
  });

  it('объявленные фикстуры кандидатами не становятся', () => {
    const counts = taskCounts(
      KNOWN_FIXTURE_TASKS.flatMap((f) => Array<string>(FIXTURE_REPEAT_THRESHOLD).fill(f.task)),
    );
    expect(escapedFixtureCandidates(counts)).toEqual([]);
    expect(() => assertNoEscapedFixtures(counts)).not.toThrow();
  });

  it('порог строгий: 49 вхождений — ещё не кандидат, 50 — уже', () => {
    expect(escapedFixtureCandidates(taskCounts(Array(49).fill('x')))).toEqual([]);
    expect(escapedFixtureCandidates(taskCounts(Array(50).fill('x')))).toEqual([{ task: 'x', count: 50 }]);
  });

  it('реальные задачи любой редкости сторож не трогает', () => {
    const counts = taskCounts(['a', 'b', 'b', 'c', 'c', 'c']);
    expect(escapedFixtureCandidates(counts)).toEqual([]);
  });
});

describe('splitFixtures', () => {
  it('разделяет записи по списку фикстур', () => {
    const items = [
      { task: 'тест' },
      { task: 'сделай TODO-лист' },
      { task: 'посчитай сумму от 1 до 10' },
      { task: 'найди НОД' },
    ];
    const { fixtures, real } = splitFixtures(items, (i) => i.task);
    expect(fixtures.map((f) => f.task)).toEqual(['тест', 'посчитай сумму от 1 до 10']);
    expect(real.map((f) => f.task)).toEqual(['сделай TODO-лист', 'найди НОД']);
  });

  it('пустой вход даёт пустые части', () => {
    expect(splitFixtures([], () => 'x')).toEqual({ fixtures: [], real: [] });
  });
});
