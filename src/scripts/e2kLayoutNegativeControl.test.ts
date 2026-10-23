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
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DEFECTS,
  DEFECTS_REGALLOC,
  DEFECTS_STEP6,
  DEFECTS_WIDE,
  DEFECTS_WIRING,
  DEFECTS_INVOKE,
  DEFECTS_CALLEE_WINDOW,
  DEFECTS_CALL_LOWERING,
  DEFECTS_REMATERIALIZE,
  locateAnchor,
  replacementFor,
  verdictOf,
  type DefectReport,
} from './e2kLayoutNegativeControl';

const ROOT = path.resolve(__dirname, '..', '..');

/** Все дефекты всех шагов: таблица одна, а шагов уже пять. */
const ALL_DEFECTS = [
  ...DEFECTS,
  ...DEFECTS_STEP6,
  ...DEFECTS_WIDE,
  ...DEFECTS_REGALLOC,
  ...DEFECTS_WIRING,
  ...DEFECTS_INVOKE,
  ...DEFECTS_CALLEE_WINDOW,
  ...DEFECTS_CALL_LOWERING,
  ...DEFECTS_REMATERIALIZE,
];

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

  it('таблица дефектов описывает тринадцать случаев с названными оракулами', () => {
    // Четыре дефекта раскладки (шаг 2), четыре — сопоставления пар (шаг 3), два — символа строки
    // (языковая плоскость) и один — РАСКЛАДКИ ЗАПИСИ на цели (16.3, 2026-10-04). Рост таблицы обязан
    // быть виден здесь: иначе новый дефект мог бы не проверяться вовсе.
    //
    // Дефекты 16.1/16.2 внесены в `src/compiler/compiler.ts` и `src/runtime/vm/stringChar.ts` — это НЕ
    // e2k-плоскость, и так и задумано: правка `arr[i]` для строки живёт в семантике и действует на
    // обеих VM, поэтому ломать её надо там, где она есть (признак 4 линии: мерить на том слое, где
    // величина живёт). 16.3, наоборот, бьёт ровно в плоскость цели: индекс поля в блоке — величина,
    // ради которой план записи и написан.
    //
    // 16.4/16.5 (2026-10-23, §3.133) — тоже плоскость ЦЕЛИ, и по двум НЕЗАВИСИМЫМ половинам правки
    // `система.строка.символ`: 16.4 бьёт в форму записи таблицы кодов (4 байта вместо 8), 16.5 — в
    // проверку ЗНАКА индекса (`shrs` логический, поэтому знак берётся своим сдвигом). Оба проверены
    // прогоном протокола, а не записью в таблицу: 16.4 краснит 4 проверки, 16.5 — 3.
    expect(DEFECTS.map((defect) => defect.id)).toEqual([
      '4.1', '4.2', '4.3', '4.4', '5.1', '5.2', '5.3', '5.4', '16.1', '16.2', '16.3', '16.4', '16.5',
    ]);
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

/**
 * ОРАКУЛ ВНОСИМОСТИ: дефект, который нельзя внести, — не контроль.
 *
 * # Что здесь ловится
 *
 * Замена в протоколе строковая, а якорь записан в таблице с `\n`. Пока якорь подгонялся под файл
 * только «как есть», дефект **6.3** (перестановка слов 64-битного литерала) не вносился вовсе:
 * `src/e2k/e2k-real.ts` целиком в CRLF, `String.includes` этого не видит, `String.replace` по
 * ненайденной строке возвращает текст без изменений. Инструмент при этом останавливался — но
 * числа для 6.3 в `docs/e2k-real-run.md` §2.4.2 уже стояли, а полного прогона не было.
 *
 * # Почему проверка идёт по **всем** таблицам
 *
 * Шагов уже четыре (4–5, 6, 7, 8), и каждая новая таблица — новый шанс завести якорь, который
 * никуда не попадёт. Проверка «оракулы названы, замена не пустая» была только у `DEFECTS`; теперь
 * она у всех, и добавляется главное — якорь обязан **находиться в файле на диске**.
 */
describe('таблица дефектов: каждый дефект обязан быть вносимым', () => {
  it('якорь каждого дефекта находится в целевом файле', () => {
    const missing: string[] = [];
    for (const defect of ALL_DEFECTS) {
      const file = path.join(ROOT, defect.file);
      expect(fs.existsSync(file), `${defect.id}: нет файла ${defect.file}`).toBe(true);
      const source = fs.readFileSync(file, 'utf-8');
      if (locateAnchor(source, defect.from) === undefined) missing.push(defect.id);
    }
    expect(missing, 'дефекты, которые не будут внесены (якорь не найден)').toEqual([]);
  });

  it('идентификаторы уникальны, оракулы названы, замена не пустая и не совпадает с якорем', () => {
    const ids = ALL_DEFECTS.map((defect) => defect.id);
    expect(new Set(ids).size, `повторяющиеся id: ${ids.join(', ')}`).toBe(ids.length);
    for (const defect of ALL_DEFECTS) {
      expect(defect.tests.length, `${defect.id}: не названы оракулы`).toBeGreaterThan(0);
      expect(defect.file, `${defect.id}: файл вне src`).toMatch(/^src\//);
      expect(defect.from.length, `${defect.id}: якорь слишком короткий`).toBeGreaterThan(10);
      expect(defect.from, `${defect.id}: замена ничего не меняет`).not.toBe(defect.to);
    }
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: якорь с LF в CRLF-файле ищется, а замена не смешивает переводы строк', () => {
    // Именно эта пара и была дефектом 6.3: якорь с LF, файл в CRLF.
    const crlfSource = 'до\r\n  writeWord(a);\r\n  writeWord(b);\r\nпосле\r\n';
    const anchor = locateAnchor(crlfSource, '  writeWord(a);\n  writeWord(b);');
    expect(anchor, 'якорь с LF не найден в CRLF-файле — дефект не будет внесён').toBe(
      '  writeWord(a);\r\n  writeWord(b);',
    );
    const replacement = replacementFor(anchor!, '  writeWord(b); // ДЕФЕКТ\n  writeWord(a);');
    expect(replacement, 'замена обязана иметь переводы строк файла, а не якоря таблицы').not.toMatch(/(?<!\r)\n/);
    expect(crlfSource.replace(anchor!, replacement)).toContain('  writeWord(b); // ДЕФЕКТ\r\n  writeWord(a);');

    // Обратный случай: файл в LF, якорь записан с CRLF — правило работает в обе стороны.
    const lfSource = 'до\n  writeWord(a);\n  writeWord(b);\nпосле\n';
    const lfAnchor = locateAnchor(lfSource, '  writeWord(a);\r\n  writeWord(b);');
    expect(lfAnchor).toBe('  writeWord(a);\n  writeWord(b);');

    // Якоря нет ни в одном стиле — это по-прежнему «не найдено», а не тихая пустышка.
    expect(locateAnchor(crlfSource, '  writeWord(совсем другое);\n  writeWord(и это);')).toBeUndefined();
  });
});
