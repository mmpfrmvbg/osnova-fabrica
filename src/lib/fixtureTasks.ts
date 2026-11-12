// ============================================================
// src/lib/fixtureTasks.ts — фильтр фикстур для замеров языка
//
// Зачем: 79,5 % трейсов в runs/traces.jsonl — повторяющиеся тестовые задачи.
// Любой замер качества языка по сырому трейсу измеряет «посчитай сумму от 1
// до 10», а не язык. Пока фильтр не применён, цифры врут в разы.
//
// Устройство — по требованию: СПИСОК известных фикстур это ДАННЫЕ, а не
// эвристика вида «начинается с тест». Эвристика ловит лишнее и пропускает
// нужное; список — точен и правится руками.
//
// Сторож: задача, встретившаяся >= FIXTURE_REPEAT_THRESHOLD раз и отсутствующая
// в списке, объявляется кандидатом и роняет замер. Так новая фикстура не может
// тихо войти в статистику.
//
// Источник чисел: docs/trace-failure-report.md, замер 2026-09-19.
// ============================================================

/** Порог повторяемости: столько и больше вхождений — кандидат в фикстуры. */
export const FIXTURE_REPEAT_THRESHOLD = 50;

export interface FixtureEntry {
  /** Точный текст задачи. Сравнение — по полному совпадению. */
  readonly task: string;
  /** Сколько раз встретилась на момент замера (документация, не проверяется). */
  readonly observedCount: number;
  /** Почему это фикстура. */
  readonly note: string;
}

/**
 * Известные фикстуры. Числа — замер 2026-09-19 по runs/traces.jsonl.
 *
 * Первые четыре пришли из замера; пятая («тест», 111 вхождений) была найдена
 * сторожем: она не попала в исходный список, но превысила порог.
 */
export const KNOWN_FIXTURE_TASKS: readonly FixtureEntry[] = [
  {
    task: 'посчитай сумму от 1 до 10',
    observedCount: 2419,
    note: 'повторяющийся тестовый пример пайплайна',
  },
  { task: 'задача', observedCount: 737, note: 'заглушка вместо задачи' },
  { task: 'тест repair-цикла', observedCount: 216, note: 'тест repair-цикла' },
  { task: '__test__partial__mock__', observedCount: 150, note: 'мок частичного результата' },
  { task: 'тест', observedCount: 111, note: 'заглушка; найдена сторожем по порогу' },
] as const;

const KNOWN = new Set(KNOWN_FIXTURE_TASKS.map((f) => f.task));

/** Фикстура ли задача — по списку, без эвристик. */
export function isFixtureTask(task: string): boolean {
  return KNOWN.has(task);
}

/** Частоты задач по корпусу. */
export function taskCounts(tasks: Iterable<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of tasks) counts.set(t, (counts.get(t) ?? 0) + 1);
  return counts;
}

/**
 * Кандидаты в фикстуры: встретились >= порога раз, но в списке их нет.
 * Пустой массив = список полон.
 */
export function escapedFixtureCandidates(
  counts: ReadonlyMap<string, number>,
): { task: string; count: number }[] {
  const out: { task: string; count: number }[] = [];
  for (const [task, count] of counts) {
    if (count >= FIXTURE_REPEAT_THRESHOLD && !KNOWN.has(task)) out.push({ task, count });
  }
  return out.sort((a, b) => b.count - a.count);
}

/**
 * Сторож замера. Бросает, если появилась новая частая задача: молча она
 * попала бы в «реальные» и раздула статистику языка.
 */
export function assertNoEscapedFixtures(counts: ReadonlyMap<string, number>): void {
  const escaped = escapedFixtureCandidates(counts);
  if (escaped.length > 0) {
    throw new Error(
      'fixtureTasks: частые задачи не объявлены фикстурами — ' +
        'добавь их в KNOWN_FIXTURE_TASKS либо объясни, почему они реальные: ' +
        escaped.map((e) => `${e.count}× «${e.task}»`).join(', '),
    );
  }
}

/** Разделяет записи на фикстуры и реальные задачи. */
export function splitFixtures<T>(
  items: readonly T[],
  taskOf: (item: T) => string,
): { fixtures: T[]; real: T[] } {
  const fixtures: T[] = [];
  const real: T[] = [];
  for (const item of items) (isFixtureTask(taskOf(item)) ? fixtures : real).push(item);
  return { fixtures, real };
}
