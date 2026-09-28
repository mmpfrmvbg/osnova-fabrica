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
import * as os from 'node:os';
import * as path from 'node:path';
import {
  EXPECTED_EXCLUSIONS,
  allControlRecords,
  auditTestFiles,
  deadControlFindings,
  decodeGitOutput,
  encodingProbe,
  evidenceLines,
  relative,
  rootProblem,
  zeroCollectionFindings,
} from './testFiles.audit';

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
    const audit = auditTestFiles([A, B], ['D:/PROJECTS/OSNOVA-FABRIKA/src/e2k/one.test.ts', 'D:/PROJECTS/OSNOVA-FABRIKA/src/e2k/two.test.ts']);
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

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: неверный ROOT ловится, а не даёт «ноль расхождений»', () => {
    // Наблюдённое 2026-09-19: сторож печатал «на диске 145», а прямая проверка говорила «нет на
    // диске», и по выводу нельзя было понять, какое измерение врёт. Теперь корень проверяется
    // отдельно: каталог без package.json/src — красное, а не «всё сошлось».
    const notRepo = path.join(os.tmpdir(), 'osnova-нет-такого-корня');
    const problem = rootProblem(notRepo);
    expect(problem, 'неверный корень обязан быть назван').toBeDefined();
    expect(problem).toContain(notRepo);
    expect(problem, 'не сказано, чего нет в корне').toMatch(/package\.json|src\//);
    expect(problem, 'выводы при неверном корне не объявлены недействительными').toMatch(/недействительн/);
    // А настоящий корень (от этого файла — два уровня вверх) проблемой не считается.
    const here = path.resolve(__dirname, '..', '..');
    expect(rootProblem(here), `корень ${here} должен выглядеть как репозиторий`).toBeUndefined();
  });

  it('по КАЖДОМУ расхождению печатается доказательство с обоими ответами', () => {
    const audit = auditTestFiles([A, B, 'src/e2k/absent.test.ts'], [A, B, 'src/e2k/extra.test.ts'], []);
    const lines = evidenceLines(audit, path.resolve(__dirname, '..', '..'));
    const joined = lines.join('\n');
    // Файл, которого нет на диске: tracked=да onDisk=нет — это утверждение о дереве, не о прогоне.
    expect(joined, 'нет доказательства по отсутствующему на диске').toContain('src/e2k/absent.test.ts');
    expect(joined).toMatch(/tracked=да onDisk=нет|tracked=да onDisk=да/);
    // Файл, исполнявшийся, но не отслеживаемый: tracked=нет.
    expect(joined, 'нет доказательства по неотслеживаемому').toContain('src/e2k/extra.test.ts');
    expect(joined).toContain('tracked=нет');
    expect(lines.length, 'доказательств должно быть по одному на расхождение').toBe(2);
  });
it('НЕГАТИВНЫЙ КОНТРОЛЬ: файл приложения Osiris объясняется исключением, а не объявляется выпавшим', () => {
    // Здесь сторож оклеветал 14 файлов: правило срезало всё до /src/, путь
    // apps/osiris/src/core/x.test.ts превращался в src/core/x.test.ts, префикс apps/osiris/
    // исчезал вместе с совпадением с исключением apps/osiris из vitest.config.ts, а existsSync по
    // срезанному пути отвечал «нет» — такого файла и нет. Отсюда мнимое противоречие измерений:
    // сторож был прав в ДАННЫХ и неправ в ИМЕНИ.
    const osiris = 'apps/osiris/src/core/memory-engine.test.ts';
    const exclusions = [{ match: 'apps/osiris', reason: 'приложение Osiris: свой пакет и свой прогон' }];
    const audit = auditTestFiles([osiris], [], exclusions);
    expect(audit.dropped, 'приложение Osiris объявлено выпавшим оракулом').toEqual([]);
    expect(audit.staleExclusions, 'исключение apps/osiris обязано быть использовано').toEqual([]);
    expect(relative(osiris)).toBe(osiris);
    expect(relative('D:/PROJECTS/OSNOVA-FABRIKA/apps/osiris/src/core/x.test.ts')).toBe('apps/osiris/src/core/x.test.ts');
    expect(relative('D:/PROJECTS/OSNOVA-FABRIKA/src/e2k/one.test.ts')).toBe('src/e2k/one.test.ts');
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: вывод git разбирается и по нулю, и по переводам строк', () => {
    // Замер 2026-09-19: git отдаёт UTF-8 (байт = символов), поэтому счёт не зависит от разделителя
    // — tracked(-z) и tracked(перевод строки) дают одно число. Гипотеза «UTF-16» опровергнута.
    const lines = Buffer.from('a.test.ts\nb.test.ts\n', 'utf-8');
    const nul = Buffer.from('a.test.ts\u0000b.test.ts\u0000', 'utf-8');
    expect(decodeGitOutput(lines, false)).toEqual(['a.test.ts', 'b.test.ts']);
    expect(decodeGitOutput(nul, true)).toEqual(['a.test.ts', 'b.test.ts']);
    const probe = encodingProbe(lines, 2, false);
    expect(probe[0]!.bytes, 'в UTF-8 байт равно символам').toBe(probe[0]!.characters);
    expect(probe[0]!.twoBytesPerCharacter).toBe(false);
  });
});

/**
 * ПРАВИЛО «НОЛЬ СОБРАННЫХ ПРОВЕРОК — ЭТО КРАСНОЕ» (случай 22).
 *
 * Замер 2026-09-28: 23 записи из 36 в инструменте негативных контролей собирали ноль проверок с
 * 23.09 и выглядели зелёными. Здесь проверяются **чистые** вердикты (`zeroCollectionFindings`,
 * `deadControlFindings`): исполнение (git, отчёт прогона, `vitest list`) проверяется самим запуском
 * `npm run check:test-files` — тем же порядком, что и у сторожа счёта файлов.
 */
describe('ноль собранных проверок — это красное', () => {
  it('все собрали — находок нет', () => {
    expect(
      zeroCollectionFindings([
        { name: 'src/a.test.ts', checks: 3, what: 'файл прогона' },
        { name: 'src/b.test.ts', checks: 1, what: 'файл прогона' },
      ]),
    ).toEqual([]);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: файл с нулём назван ИМЕНЕМ, а не числом', () => {
    const findings = zeroCollectionFindings([
      { name: 'src/dead.test.ts', checks: 0, what: 'файл прогона' },
      { name: 'src/alive.test.ts', checks: 7, what: 'файл прогона' },
    ]);
    expect(findings, 'файл с нулём проверок обязан краснеть').toHaveLength(1);
    expect(findings[0], 'имя файла, а не число').toContain('src/dead.test.ts');
    expect(findings[0], 'названа причина, а не «что-то не так»').toMatch(/ноль собранных/);
    expect(findings[0], 'назван документ с правилом').toMatch(/случай 22/);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: запись без config краснеет — именно так 23 из 36 были мертвы', () => {
    const records = [{ id: '4.1', tests: ['src/e2k/twoPassLayout.test.ts'] }];
    const collected = new Map([['vitest.config.ts|src/e2k/twoPassLayout.test.ts', 0]]);
    const findings = deadControlFindings(records, collected, []);
    // Две стороны одного дефекта, и обе названы: конфиг не указан — И сбор с умолчанием нулевой
    // (оракул живёт в конфиге e2k). Оба вердикта называют запись по имени.
    expect(findings, 'запись без названного конфига обязана краснеть дважды').toHaveLength(2);
    for (const finding of findings) expect(finding).toContain('4.1');
    expect(findings.some((f) => /не назван config/.test(f)), 'подсказка, чем чинить').toBe(true);
    expect(findings.some((f) => /собирает ноль проверок/.test(f)), 'назван и нулевой сбор').toBe(true);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: названный конфиг, а сбор нулевой — красное с id и файлом', () => {
    const records = [{ id: '5.1', config: 'vitest.e2k.config.ts', tests: ['src/runtime/vm.test.ts'] }];
    const collected = new Map([['vitest.e2k.config.ts|src/runtime/vm.test.ts', 0]]);
    const findings = deadControlFindings(records, collected, []);
    expect(findings, 'нулевой сбор при названном конфиге обязан краснеть').toHaveLength(1);
    expect(findings[0]).toContain('5.1');
    expect(findings[0]).toContain('src/runtime/vm.test.ts');
    expect(findings[0]).toMatch(/контроль недействителен/);
  });

  it('обратный контроль: запись, собравшая проверки, не краснеет', () => {
    const records = [{ id: '5.1', config: 'vitest.e2k.config.ts', tests: ['src/e2k/e2kPredicatePairs.test.ts'] }];
    const collected = new Map([['vitest.e2k.config.ts|src/e2k/e2kPredicatePairs.test.ts', 12]]);
    expect(deadControlFindings(records, collected, [])).toEqual([]);
  });

  it('НАЗВАННАЯ мёртвая запись молчит — но только пока она действительно мёртвая', () => {
    const known = [{ id: '12.4', reason: 'оракулы живут в двух конфигах, инструмент запускает один' }];
    const records = [
      {
        id: '12.4',
        config: 'vitest.config.ts',
        tests: ['src/e2k/e2kCallLowering.test.ts', 'src/e2k/e2kRealRun.test.ts'],
      },
    ];
    const dead = new Map([
      ['vitest.config.ts|src/e2k/e2kCallLowering.test.ts', 10],
      ['vitest.config.ts|src/e2k/e2kRealRun.test.ts', 0],
    ]);
    expect(deadControlFindings(records, dead, known), 'названная мёртвая запись не краснеет').toEqual([]);

    // А если она ожила — исключение устарело и обязано краснеть (случай 1: «имена вместо наличия»).
    const alive = new Map([
      ['vitest.config.ts|src/e2k/e2kCallLowering.test.ts', 10],
      ['vitest.config.ts|src/e2k/e2kRealRun.test.ts', 45],
    ]);
    const stale = deadControlFindings(records, alive, known);
    expect(stale, 'ожившая запись обязана снять исключение красным').toHaveLength(1);
    expect(stale[0]).toMatch(/устаревшее исключение 12\.4/);
  });

  it('пустая таблица записей — это находка, а не «всё сошлось»', () => {
    // Вакуумная правда: «у всех записей сбор не ноль» верно и для пустого списка. Поэтому сторож
    // обязан отдельно убедиться, что записи вообще есть: ноль записей — это мёртвый механизм,
    // который выглядит зелёным (та же болезнь, от которой лечим).
    expect(deadControlFindings([], new Map(), [])).toEqual([]);
    expect(allControlRecords().length, 'записей негативного контроля в дереве').toBeGreaterThan(0);
  });
});
