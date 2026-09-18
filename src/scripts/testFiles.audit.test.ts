/**
 * ОРАКУЛ СТОРОЖА СЧЁТА ФАЙЛОВ.
 *
 * Сторож (`src/scripts/testFiles.audit.ts`) решает, **не выпал ли оракул из прогона**. Пока у
 * этого решения нет своего негативного контроля, оно — украшение (правило из случая 8 реестра
 * проверяемости). Проверяется **чистая** функция `auditTestFiles`: исполнение (git + отчёт прогона)
 * проверяется самим запуском `npm run check:test-files`.
 *
 * # Что важно различить
 *
 * Три разных расхождения — три разных вывода, и сливать их нельзя:
 *
 * | что | вывод |
 * |---|---|
 * | файл в репозитории, но не в прогоне и не объяснён | **оракул выпал** — тот самый случай 13 |
 * | файл в прогоне, но не в репозитории | проверка исполнилась, а в коммит не попадёт — случай 7 |
 * | исключение ничего не объясняет | исключение устарело — случай 1 («имена вместо наличия») |
 */

import { describe, it, expect } from 'vitest';
import { EXPECTED_EXCLUSIONS, auditTestFiles } from './testFiles.audit';

const A = 'src/e2k/one.test.ts';
const B = 'src/e2k/two.test.ts';
const QEMU = 'src/e2k/e2kQemuExec.test.ts';

describe('сторож счёта файлов оракулов', () => {
  it('всё собрано — расхождений нет', () => {
    const audit = auditTestFiles([A, B, QEMU], [A, B], []);
    expect(audit.expected).toBe(3);
    expect(audit.collected).toBe(2);
    expect(audit.dropped, 'выпавшим назван файл, объяснённый исключением').toEqual([QEMU]);
    expect(audit.untracked).toEqual([]);
    expect(audit.staleExclusions).toEqual([]);
    // С исключением файл выпавшим не считается — но исключение обязано быть использовано.
    const explained = auditTestFiles([A, B, QEMU], [A, B], [{ match: 'e2kQemuExec', reason: 'вынесен в gate:qemu' }]);
    expect(explained.dropped).toEqual([]);
    expect(explained.staleExclusions).toEqual([]);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: выпавший оракул назван ИМЕНЕМ, а не числом', () => {
    // Именно случай 13: файл лежит в репозитории, в прогон не попал, и **никакое** исключение его
    // не объясняет. Забытый оракул не должен иметь исключения — иначе он и не забытый.
    const forgotten = 'src/e2k/forgotten.test.ts';
    const audit = auditTestFiles([A, B, forgotten], [A, B], EXPECTED_EXCLUSIONS);
    expect(audit.dropped, `выпавшим должен быть назван ${forgotten}`).toEqual([forgotten]);
    expect(audit.dropped[0], 'имя файла, а не число').toContain('forgotten.test.ts');
  });

  it('файл, объяснённый исключением, выпавшим не считается', () => {
    // Исключений ровно столько, сколько нужно этому списку: устаревшее исключение — тоже дефект
    // (случай 1), поэтому «лишние» записи здесь честно считаются устаревшими.
    const exclusions = [{ match: 'e2kQemuExec', reason: 'вынесен в gate:qemu: ресурсозависимый' }];
    const explained = auditTestFiles([A, B, QEMU], [A, B], exclusions);
    expect(explained.dropped, 'исключение обязано снимать обвинение').toEqual([]);
    expect(explained.staleExclusions, 'использованное исключение не устарело').toEqual([]);
    expect(explained.expected).toBe(3);
    expect(explained.collected).toBe(2);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: проверка вне репозитория и устаревшее исключение', () => {
    const untracked = auditTestFiles([A], [A, 'src/e2k/new.test.ts'], []);
    expect(untracked.untracked).toEqual(['src/e2k/new.test.ts']);
    expect(untracked.dropped).toEqual([]);

    const stale = auditTestFiles([A], [A], [{ match: 'несуществующий.test.ts', reason: 'прикрывает несуществующее' }]);
    expect(stale.staleExclusions).toEqual(['несуществующий.test.ts']);
  });

  it('пути из отчёта приводятся к виду репозитория (абсолютные против относительных)', () => {
    const audit = auditTestFiles([A, B], ['D:/PROJECTS/OSNOVA-FABRIKA/src/e2k/one.test.ts', 'D:/x/src/e2k/two.test.ts']);
    expect(audit.dropped).toEqual([]);
    expect(audit.untracked).toEqual([]);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: путь из git и абсолютный путь сходятся одним правилом', () => {
    // Тот самый случай, на котором первая версия сторожа объявила выпавшими 17 собранных файлов:
    // путь из `git ls-files` не начинается со слэша, поэтому «срез по /scripts/» давал другое имя,
    // чем срез по /src/ у абсолютного пути из отчёта.
    const gitStyle = ['src/scripts/analyze-dataset-health.test.ts', 'package.test.ts'];
    const reportStyle = [
      'D:/PROJECTS/OSNOVA-FABRIKA/src/scripts/analyze-dataset-health.test.ts',
      'D:/PROJECTS/OSNOVA-FABRIKA/package.test.ts',
    ];
    const audit = auditTestFiles(gitStyle, reportStyle, []);
    expect(audit.dropped, 'собранные файлы названы выпавшими — правило сведения путей разошлось').toEqual([]);
    expect(audit.untracked).toEqual([]);
  });

  it('у каждого исключения названа причина, и подстрока не пустая', () => {
    expect(EXPECTED_EXCLUSIONS.length).toBeGreaterThan(0);
    for (const exclusion of EXPECTED_EXCLUSIONS) {
      expect(exclusion.match.length, 'пустая подстрока исключения').toBeGreaterThan(2);
      expect(exclusion.reason.length, `«${exclusion.match}»: причина не названа`).toBeGreaterThan(10);
    }
  });
});
