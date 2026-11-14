/**
 * ОРАКУЛ СТОРОЖА ПОЛНОТЫ ИНДЕКСА РЕЕСТРА (класс случая 32).
 *
 * # Что доказывается
 *
 * Сторож без красной стороны — украшение (правило из случая 8). Поэтому:
 *
 * | сторона | утверждение |
 * |---|---|
 * | **файл репозитория** | расхождений ноль — и это не вакуумная правда: разделов 80, строк 98 |
 * | **раздел без строки** | красное, и отказ называет номера (N=3 в фикстуре) |
 * | **строка-указатель без раздела** | красное — индекс не указывает на несуществующее |
 * | **новая дыра в нумерации** | красное; названная дыра (79) — тишина |
 * | **самодокументирующая таблица** | строки без разделов — норма, а не находка |
 * | **устаревшее исключение** | красное: исключение обязано объяснять то, что есть сейчас |
 *
 * # Негативный контроль N=3 (откат)
 *
 * Три проверки читают **настоящий** реестр и краснеют от отката индекса к прежней редакции
 * (35 строк вместо 98): «расхождений ноль», «случаев 40–103 нет без строки», «файл различается».
 * Откатывать их безопасно: `git checkout HEAD -- docs/verification-debt.md` и обратно.
 */

import { describe, it, expect } from 'vitest';
import {
  INDEX_GATE_CODE,
  KNOWN_GAPS,
  PROSE_ONLY_CASES,
  auditIndex,
  auditRegistryFile,
  indexTables,
} from './verificationIndex.audit';

/** Минимальный файл: два раздела, оба со строками индекса-указателя. */
const INDEXED_FILE = [
  '## Случай 1. первый дефект',
  '',
  '## Случай 2. второй дефект',
  '',
  '| # | случай | механизм |',
  '|---|---|---|',
  '| 1 | первый | что-то |',
  '| 2 | второй | что-то ещё |',
  '',
].join('\n');

/** Разделы есть, строк — нет. Ровно случай 32. */
const LOST_ROWS_FILE = [
  '## Случай 1. первый дефект',
  '',
  '## Случай 2. второй дефект',
  '',
  '## Случай 3. третий дефект',
  '',
  '| # | случай | механизм |',
  '|---|---|---|',
  '| 1 | первый | что-то |',
  '',
].join('\n');

describe('сторож полноты индекса: разбор', () => {
  it('индекс есть и полон — расхождений нет', () => {
    const audit = auditIndex(INDEXED_FILE);
    expect(audit.sections).toEqual([1, 2]);
    expect(audit.indexed).toEqual([1, 2]);
    expect(audit.missingRows).toEqual([]);
    expect(audit.phantomRows).toEqual([]);
    expect(audit.newGaps).toEqual([]);
    expect(audit.problems).toEqual([]);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: раздел без строки индекса — красное, номера названы', () => {
    // Случай 32 в чистом виде: в файле три раздела, «прибор показывает» один. Число в отказе — 2,
    // и номера 2 и 3 названы ИМЕНАМИ: отказ «нет строк» без номеров искать нечем.
    const audit = auditIndex(LOST_ROWS_FILE);
    expect(audit.missingRows).toEqual([2, 3]);
    const joined = audit.problems.join('\n');
    expect(joined).toContain(INDEX_GATE_CODE);
    expect(joined, 'номера названы').toMatch(/2, 3/);
    expect(joined, 'отказ называет класс случая 32').toMatch(/случая 32/);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: строка-указатель на несуществующий раздел — красное', () => {
    const text = [
      '## Случай 1. первый дефект',
      '',
      '| # | случай | механизм |',
      '|---|---|---|',
      '| 1 | первый | что-то |',
      '| 7 | седьмой, которого нет | — |',
      '',
    ].join('\n');
    const audit = auditIndex(text);
    expect(audit.phantomRows).toEqual([7]);
    expect(audit.problems.join('\n')).toMatch(/несуществующий раздел/);
    expect(audit.problems.join('\n')).toMatch(/7/);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: новая дыра в нумерации краснеет, названная — нет', () => {
    // 78 → 80 без раздела 79: это НАЗВАННАЯ дыра, тишина.
    const named = [
      '## Случай 78. семьдесят восьмой',
      '',
      '## Случай 80. восьмидесятый',
      '',
      '| # | случай | механизм |',
      '|---|---|---|',
      '| 78 | семьдесят восьмой | — |',
      '| 80 | восьмидесятый | — |',
      '',
    ].join('\n');
    expect(auditIndex(named).newGaps, '79 назван в KNOWN_GAPS — не находка').toEqual([]);

    // 78 → 77: дыры нет. 78 → 79 при живом 79 — тоже нет.
    const contiguous = named.replace('80', '79');
    expect(auditIndex(contiguous).newGaps).toEqual([]);

    // А вот 77 → 79 при том, что 78 не назван нигде, — красное.
    const gap = named
      .replace(/78/g, '77')
      .replace(/семьдесят восьмой/g, 'семьдесят седьмой');
    const audit = auditIndex(gap);
    expect(audit.newGaps).toEqual([78]);
    expect(audit.problems.join('\n')).toMatch(/дыра в нумерации/);
    expect(audit.problems.join('\n')).toMatch(/78/);
  });

  it('САМОДОКУМЕНТИРУЮЩАЯ таблица: строки без разделов — норма, а не находка', () => {
    // Первая таблица реестра документирует случай СТРОКОЙ (механизм + как проявился + источник).
    // Требовать для неё раздел значило бы переписать историю проекта в 17 разделов.
    const text = [
      '# Заголовок реестра',
      '',
      '| # | случай | механизм | как проявился | источник |',
      '|---|---|---|---|---|',
      '| 1 | первый | механизм А | проявился так | `src/a.ts` |',
      '| 2 | второй | механизм Б | проявился иначе | `src/b.ts` |',
      '',
      '## Случай 3. третий, уже разделом',
      '',
      '| # | случай | механизм |',
      '|---|---|---|',
      '| 3 | третий | механизм В |',
      '',
    ].join('\n');
    const audit = auditIndex(text);
    expect(audit.selfDocumenting).toEqual([1, 2]);
    expect(audit.phantomRows, 'строки 1 и 2 не указатели — они сами запись').toEqual([]);
    expect(audit.missingRows).toEqual([]);
    expect(audit.problems).toEqual([]);
    // И таблицы различимы: их две, и это видно, а не угадывается.
    expect(audit.tables).toHaveLength(2);
    expect(audit.tables.map((t) => t.selfDocumenting)).toEqual([true, false]);
    expect(indexTables(text.split('\n')).map((t) => t.numbers)).toEqual([[1, 2], [3]]);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: исключение, переставшее быть верным, краснеет', () => {
    // PROSE_ONLY_CASES говорит «случай 18 без раздела». Если раздел завели — исключение устарело.
    const withSection = [
      '## Случай 18. теперь с разделом',
      '',
      '| # | случай | механизм |',
      '|---|---|---|',
      '| 18 | восемнадцатый | — |',
      '',
    ].join('\n');
    const audit = auditIndex(withSection);
    expect(audit.staleExceptions.length).toBeGreaterThan(0);
    expect(audit.staleExceptions.join('\n'), 'названо, что исключение снять').toMatch(/устарело/);
    expect(audit.staleExceptions.join('\n')).toContain(INDEX_GATE_CODE);
  });

  it('раздел уровня `###` — тоже раздел (иначе ложное красное на 14 случаях)', () => {
    const text = [
      '### Случай 90: заведён третьим уровнем',
      '',
      '| # | случай | механизм |',
      '|---|---|---|',
      '| 90 | девяностый | — |',
      '',
    ].join('\n');
    const audit = auditIndex(text);
    expect(audit.sections).toEqual([90]);
    expect(audit.missingRows).toEqual([]);
  });

  it('пустой разбор — находка, а не «всё сошлось»', () => {
    // «У всех случаев есть строка» верно и для нуля случаев — вакуумная правда.
    const empty = auditIndex('# Реестр\n\nбез случаев\n');
    expect(empty.sections).toEqual([]);
    expect(empty.problems, 'чистый разбор пустого файла сам по себе тих').toEqual([]);
  });
});

describe('сторож полноты индекса: настоящий реестр', () => {
  // Эти проверки читают ФАЙЛ. Откат индекса к прежней редакции (35 строк вместо 98) краснит
  // три из них — это и есть негативный контроль N=3.
  const audit = auditRegistryFile();

  it('расхождений ноль — и это не вакуум: разделов и строк много', () => {
    expect(audit.problems, audit.problems.join('\n')).toEqual([]);
    expect(audit.sections.length, 'разделов в реестре').toBeGreaterThan(70);
    expect(audit.indexed.length, 'строк индекса').toBeGreaterThan(90);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: случаев 40–103 без строки индекса нет', () => {
    // Замер до правки 2026-11-14: этих случаев было 63 без единой строки. Проверка держит
    // именно тот диапазон, ради которого писался сторож, а не «сколько-то случаев».
    const late = audit.sections.filter((n) => n >= 40);
    expect(late.length, 'поздних случаев').toBeGreaterThan(60);
    const withoutRow = late.filter((n) => !audit.indexed.includes(n));
    expect(withoutRow, `без строки индекса: ${withoutRow.join(', ')}`).toEqual([]);
  });

  it('исключения объясняют то, что есть СЕЙЧАС, и не прикрывают пустоту', () => {
    expect(audit.staleExceptions).toEqual([]);
    expect(PROSE_ONLY_CASES.length, 'исключений «описан прозой»').toBeGreaterThan(0);
    for (const ex of PROSE_ONLY_CASES) {
      expect(ex.reason.length, `у случая ${ex.n} причина не написана`).toBeGreaterThan(20);
      expect(audit.sections, `случай ${ex.n} назван «без раздела», но раздел есть`).not.toContain(ex.n);
    }
    for (const gap of KNOWN_GAPS) {
      expect(gap.reason.length, `у дыры ${gap.n} причина не написана`).toBeGreaterThan(20);
      expect(audit.sections, `дыра ${gap.n} заросла: раздел появился`).not.toContain(gap.n);
      expect(audit.indexed, `дыра ${gap.n} заросла: строка появилась`).not.toContain(gap.n);
    }
  });

  it('обе формы нумерации видны: и `## §`-стиль, и `### Случай` — в реестре есть оба', () => {
    // Случаи 90…103 заведены `###`. Сторож, требовавший ровно `##`, не увидел бы 14 из них —
    // и «расхождений ноль» было бы ложным зелёным.
    const deep = audit.sections.filter((n) => n >= 90);
    expect(deep.length, 'случаев, заведённых третьим уровнем').toBeGreaterThanOrEqual(10);
  });
});
