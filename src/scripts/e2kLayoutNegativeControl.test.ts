/**
 * ОРАКУЛ САМОГО ПРОТОКОЛА НЕГАТИВНОГО КОНТРОЛЯ.
 *
 * # Зачем это отдельный оракул
 *
 * `src/scripts/e2kLayoutNegativeControl.ts` решает, **годен ли** негативный контроль: покраснел
 * ли оракул, восстановлен ли файл побайтово, состоялся ли прогон. Пока у этого решения нет
 * своего негативного контроля, оно — украшение, а не проверка (правило из случая 8 реестра
 * `docs/verification-debt.md`).
 *
 * # Что важно различить
 *
 * Ноль **собранных** проверок и ноль **покрасневших** — разные выводы: первое значит «мутация
 * сломала файл, контроль недействителен», второе — «оракул слеп». Слить их в один — значит
 * выдать поломку обвязки за находку (случай 10 того же реестра).
 *
 * # Чего оракул не делает
 *
 * Не запускает vitest: проверяется **решение** по отчёту, а не исполнение. Исполнение проверено
 * прогоном протокола (`npx tsx src/scripts/e2kLayoutNegativeControl.ts`) и подложенной мутацией
 * с незакрытой скобкой.
 */

import { describe, it, expect } from 'vitest';
import { DEFECTS, verdictOf, type DefectReport } from './e2kLayoutNegativeControl';

/** Годный отчёт: дефект пойман, файл восстановлен, прогон состоялся. */
function good(overrides: Partial<DefectReport> = {}): DefectReport {
  return {
    id: 'T',
    title: 'образец',
    file: 'src/e2k/twoPassLayout.ts',
    shaBefore: 'AA',
    shaAfter: 'AA',
    shaMatch: true,
    mutatedChanged: true,
    caughtBy: ['проверка 1.3'],
    caught: 1,
    mutatedCollected: 15,
    restoredCollected: 15,
    restoredFailed: 0,
    restoredPassed: 15,
    ...overrides,
  };
}

describe('протокол негативного контроля: годен ли контроль', () => {
  it('годный отчёт не даёт замечаний', () => {
    expect(verdictOf(good())).toEqual([]);
  });

  it('таблица дефектов описывает четыре случая с названными оракулами', () => {
    expect(DEFECTS.map((defect) => defect.id)).toEqual(['4.1', '4.2', '4.3', '4.4']);
    for (const defect of DEFECTS) {
      expect(defect.tests.length, `${defect.id}: не названы оракулы`).toBeGreaterThan(0);
      expect(defect.from, `${defect.id}: пустая замена`).not.toBe(defect.to);
      expect(defect.from.length, `${defect.id}: строка замены слишком короткая`).toBeGreaterThan(10);
      expect(defect.file, `${defect.id}: файл вне src`).toMatch(/^src\//);
    }
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: сломанная мутация — «контроль недействителен», а не «оракул слеп»', () => {
    // Подложенная мутация с незакрытой скобкой: файл не разбирается, проверок собрано ноль.
    const broken = good({ caught: 0, caughtBy: [], mutatedCollected: 0 });
    const problems = verdictOf(broken);
    expect(problems.join(' | '), 'не названа поломка мутации').toMatch(/собрал 0 проверок/);
    expect(problems.join(' | '), 'не сказано, что контроль недействителен').toMatch(/недействителен/);
    expect(problems.join(' | '), 'не названа причина «ни один не покраснел»').toMatch(/ни один оракул не покраснел/);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: остальные поломки контроля тоже названы', () => {
    expect(verdictOf(good({ mutatedChanged: false })).join(' ')).toMatch(/мутация не изменила файл/);
    expect(verdictOf(good({ shaMatch: false })).join(' ')).toMatch(/sha256 разошёлся/);
    expect(verdictOf(good({ restoredFailed: 1 })).join(' ')).toMatch(/осталось красным/);
    expect(verdictOf(good({ restoredCollected: 0 })).join(' ')).toMatch(/после восстановления собрал 0/);
    expect(verdictOf(good({ restoredCollected: 14 })).join(' ')).toMatch(/разные объекты/);
    // Оракул не покраснел при состоявшемся прогоне — это уже «контроль ничего не проверяет».
    const blind = verdictOf(good({ caught: 0, caughtBy: [] }));
    expect(blind.join(' ')).toMatch(/ни один оракул не покраснел/);
    expect(blind.join(' '), 'поломка мутации не должна упоминаться').not.toMatch(/собрал 0 проверок/);
  });
});
