/**
 * СТОРОЖ ПОЛНОТЫ ИНДЕКСА `docs/verification-debt.md` — ЛЕКАРСТВО КЛАССА ИЗ СЛУЧАЯ 32.
 *
 * # Дефект, ради которого это написано
 *
 * Случай 32 реестра (`docs/verification-debt.md`, строка «РЕЕСТР ПОЙМАЛ САМ СЕБЯ») — единственный
 * случай, где **сломался сам реестр**, а не проверяемый код: таблица случаев в начале файла была
 * доведена до **21**, а разделов в файле стало **31**. Читатель индекса видел «21 случай»; правило
 * «прибор не различает то, что должен» лежало в середине файла и находилось только чтением подряд.
 *
 * В самом же случае 32 записано, что лекарство — **сторож**, и что **он ещё не написан**:
 *
 *   «ЛЕКАРСТВО КЛАССА — СТОРОЖ, И ОН ЕЩЁ НЕ НАПИСАН. … у индекса обязан быть контроль, который
 *    проверяет, что КАЖДОМУ случаю в файле соответствует строка в указателе»
 *
 * # Что стало к моменту, когда сторож написан (замер 2026-11-14)
 *
 * Расхождение **не закрылось, а выросло вдвое**: разделов с номером — 80 (23…103), строк индекса
 * было **35** (таблица 1…17 и указатель 22…39), и **63 случая** (40…103 за вычетом отсутствующего
 * 79) не имели в индексе **ни одной** строки. То есть соглашение продержалось ровно до следующего
 * случая — как и было предсказано в случае 32.
 *
 * # Три направления, и все три проверяются
 *
 * | направление | что значит | почему это дефект |
 * |---|---|---|
 * | **раздел есть, строки нет** | 63 случая 40–103 | ровно случай 32: индекс выглядит полным |
 * | **строка есть, раздела нет** | номера 18–21, 22 | индекс указывает на то, чего в файле нет |
 * | **номер пропущен между соседями** | 79 отсутствует и в разделах, и в индексе | дыра в нумерации: «случая 79 нет» — это тоже факт, и он должен быть назван |
 *
 * # Почему исключения, а не «подогнать проверку»
 *
 * Случаи **18–21** и **22** действительно **не имеют раздела**: они описаны абзацем в шапке файла
 * (строки 44–50) и таблицей, а разделы заведены начиная с 23. Подгонять сторож под это (например,
 * «искать только `## Случай N` и молча пропускать остальное») значило бы сделать его неспособным
 * краснеть ровно на том дефекте, ради которого он написан. Поэтому они названы в
 * {@link PROSE_ONLY_CASES} **с причиной**, и список проверяется на устаревание: если такой случай
 * получит раздел, исключение станет лишним и покраснеет.
 *
 * # Чего сторож НЕ делает
 *
 * Не судит о содержании случая и не проверяет, что класс в индексе назван **верно**. Он отвечает на
 * один вопрос: «каждому номеру источника соответствует строка указателя, и наоборот». Смысл строки
 * доказывается чтением раздела, а не разбором таблицы.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Код отказа — он же строка поиска в логах. */
export const INDEX_GATE_CODE = 'OSN-GATE-INDEX';

/** Реестр, полноту индекса которого сторож и проверяет. */
export const REGISTRY_PATH = path.join('docs', 'verification-debt.md');

/**
 * Случай, у которого **нет своего раздела**, но строка в индексе есть и верна.
 *
 * `reason` — не украшение: устаревшее исключение обязано краснеть (правило из случая 1 —
 * «имена вместо наличия»). Проверка ниже требует, чтобы случай **всё ещё** не имел раздела.
 */
export const PROSE_ONLY_CASES: readonly { readonly n: number; readonly reason: string }[] = [
  { n: 18, reason: 'описан абзацем в шапке (строка 46): «отчётное число считалось не по тому множеству»' },
  { n: 19, reason: 'описан абзацем в шапке (строка 47): «модель оптимизации замерила не то преобразование»' },
  { n: 20, reason: 'описан абзацем в шапке (строка 48): «отказ инструмента прочитан как свойство объекта»' },
  { n: 21, reason: 'описан абзацем в шапке (строка 50): найден при попытке исполнить FIR, §3.20' },
  { n: 22, reason: 'заведён строкой таблицы 626 и абзацем; отдельного раздела не заводился' },
];

/**
 * Номер, у которого **нет ни раздела, ни строки индекса**, — названный факт, а не тишина.
 *
 * `reason` обязателен и проверяется на устаревание: если номер появится в файле или в индексе,
 * запись краснеет, потому что перестала объяснять. Так исключение не может «прикрывать
 * несуществующее» (правило из случая 1 — «имена вместо наличия»).
 */
export const KNOWN_GAPS: readonly { readonly n: number; readonly reason: string }[] = [
  {
    n: 18,
    reason: 'описан только абзацем в шапке (строка 46): «отчётное число считалось не по тому множеству»',
  },
  {
    n: 19,
    reason: 'описан только абзацем в шапке (строка 47): «модель оптимизации замерила не то преобразование»',
  },
  {
    n: 20,
    reason: 'описан только абзацем в шапке (строка 48): «отказ инструмента прочитан как свойство объекта»',
  },
  {
    n: 21,
    reason: 'описан только абзацем в шапке (строка 50): найден при попытке исполнить FIR, §3.20',
  },
  {
    n: 79,
    reason: 'номера нет нигде: нумерация случаев 78 → 80 идёт подряд, раздел 79 не заводился',
  },
];

/**
 * Строка индекса, документирующая случай **собой**, а не указателем на раздел.
 *
 * # Почему это отдельная категория, а не «исключение”
 *
 * Первая таблица файла (`| # | случай | механизм | как проявился | источник |`, случаи 1–17) —
 * не указатель, а **сама запись**: в ней стоит и механизм, и как дефект проявился, и источник.
 * Требовать для её строк раздел значило бы требовать переписать историю проекта в 17 разделов —
 * а сторож, красный на исправном файле, будет снят первым же PR (случай 31: ложное красное — тот
 * же дефект, что ложное зелёное).
 *
 * Признак назван по **шапке таблицы**, а не по диапазону номеров: диапазон пришлось бы двигать
 * вручную при каждой новой строке — то есть повторять дефект случая 32 внутри сторожа.
 */
export interface IndexTable {
  /** Номер первого столбца — номер случая. */
  readonly numbers: readonly number[];
  /** Строка — сама запись (нести механизм и источник), а не указатель на раздел. */
  readonly selfDocumenting: boolean;
}

/** Шапка, по которой таблица признаётся САМОДОКУМЕНТИРУЮЩЕЙ: у неё есть «как проявился» и «источник». */
function isSelfDocumentingHeader(cells: readonly string[]): boolean {
  const flat = cells.join(' ').toLowerCase();
  return /как проявил/.test(flat) || /источник/.test(flat);
}

/** Разбор файла: номера в разделах и номера в индексе. */
export interface IndexAudit {
  /** Номера, у которых есть свой раздел («## Случай N»). */
  readonly sections: readonly number[];
  /** Номера, названные строкой индекса. */
  readonly indexed: readonly number[];
  /** Номера, документированные САМОЙ строкой таблицы (без раздела). */
  readonly selfDocumenting: readonly number[];
  /** Раздел есть, строки индекса нет. */
  readonly missingRows: readonly number[];
  /** Строка-указатель есть, раздела нет (с учётом названных исключений). */
  readonly phantomRows: readonly number[];
  /** Дыра в нумерации, не названная в {@link KNOWN_GAPS}. */
  readonly newGaps: readonly number[];
  /** Исключение из {@link PROSE_ONLY_CASES} или {@link KNOWN_GAPS}, переставшее быть верным. */
  readonly staleExceptions: readonly string[];
  /** Таблицы индекса: сколько их и какая из них самодокументирующая. */
  readonly tables: readonly IndexTable[];
  /** Все нарушения одним списком — то, что печатает отказ. */
  readonly problems: readonly string[];
}

/**
 * Раздел ли это случая.
 *
 * Уровень заголовка **не** ограничен двумя: часть случаев заведена `###` (90…98, 103), и сторож,
 * требовавший ровно `##`, назвал бы их отсутствующими — то есть краснел бы ложно на 14 случаях.
 * Ложное красное — тот же дефект, что ложное зелёное (случай 31).
 */
function sectionNumber(line: string): number | null {
  const m = /^#{1,6}\s*(?:\S+\s*)?Случай\s+(\d+)\b/i.exec(line);
  return m ? Number(m[1]) : null;
}

/**
 * Разбор таблиц индекса.
 *
 * Индексом считается строка таблицы, чей **первый** столбец — число, стоящая **под** шапкой вида
 * `| # | случай | …`. Без этой привязки под проверку попадали бы любые таблицы файла (`| 999 |`,
 * таблицы форм, таблицы `3.x`) — и сторож краснел бы на данных, не имеющих к индексу отношения.
 *
 * Шапка решает и второе: таблица с колонками «как проявился»/«источник» документирует случай
 * **собой**, и раздела для её строк не требуется (иначе сторож краснел бы на случаях 1–17, которые
 * описаны полнее, чем разделами).
 */
export function indexTables(lines: readonly string[]): IndexTable[] {
  const tables: IndexTable[] = [];
  let current: { numbers: number[]; selfDocumenting: boolean } | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) {
      if (current !== null) {
        tables.push({ numbers: [...current.numbers], selfDocumenting: current.selfDocumenting });
        current = null;
      }
      continue;
    }
    const cells = trimmed.split('|').map((c) => c.trim());
    // cells[0] пуст (до первой `|`), cells[1] — первый столбец.
    const first = cells[1] ?? '';
    const second = cells[2] ?? '';
    if (first === '#' && /случа/i.test(second)) {
      current = { numbers: [], selfDocumenting: isSelfDocumentingHeader(cells.slice(1)) };
      continue;
    }
    if (current === null) continue;
    // Разделитель шапки `|---|---|` — не строка индекса.
    if (/^:?-{2,}:?$/.test(first)) continue;
    // Продолжение таблицы без новой шапки: заголовок группы в первом столбце — не номер.
    if (/^\d+$/.test(first)) current.numbers.push(Number(first));
  }
  if (current !== null) {
    tables.push({ numbers: [...current.numbers], selfDocumenting: current.selfDocumenting });
  }
  return tables;
}

/** Чистый разбор: ни файлов, ни сети — поэтому его и проверяет оракул. */
export function auditIndex(text: string): IndexAudit {
  const lines = text.split(/\r?\n/);

  const sections: number[] = [];
  for (const line of lines) {
    const n = sectionNumber(line);
    if (n !== null && !sections.includes(n)) sections.push(n);
  }
  sections.sort((a, b) => a - b);

  const tables = indexTables(lines);
  const selfDocSet = new Set(tables.filter((t) => t.selfDocumenting).flatMap((t) => t.numbers));
  const indexedSet = new Set(tables.flatMap((t) => t.numbers));
  const indexed = [...indexedSet].sort((a, b) => a - b);
  const selfDocumenting = [...selfDocSet].sort((a, b) => a - b);

  const sectionSet = new Set(sections);
  const proseOnly = new Set(PROSE_ONLY_CASES.map((e) => e.n));
  const knownGapSet = new Set(KNOWN_GAPS.map((e) => e.n));

  const missingRows = sections.filter((n) => !indexedSet.has(n));
  // Строка-указатель без раздела — дефект. Строка САМОДОКУМЕНТИРУЮЩАЯ без раздела — норма.
  const phantomRows = indexed.filter(
    (n) => !sectionSet.has(n) && !proseOnly.has(n) && !selfDocSet.has(n),
  );

  // Дыры: числа между наименьшим и наибольшим известным номером, которых нет нигде.
  const known = [...new Set([...sections, ...indexed])].sort((a, b) => a - b);
  const newGaps: number[] = [];
  for (let n = known[0]!; n <= known.at(-1)!; n += 1) {
    if (sections.includes(n) || indexedSet.has(n)) continue;
    if (knownGapSet.has(n)) continue;
    newGaps.push(n);
  }

  // Устаревшее исключение: случай завёл раздел, а исключение всё ещё говорит «раздела нет».
  const staleExceptions: string[] = [];
  for (const ex of PROSE_ONLY_CASES) {
    if (sectionSet.has(ex.n)) {
      staleExceptions.push(
        `${INDEX_GATE_CODE}: случай ${ex.n} назван в PROSE_ONLY_CASES как «без раздела», но раздел ` +
          `заведён — исключение устарело, снимите его (${ex.reason}).`,
      );
    }
  }
  for (const gap of KNOWN_GAPS) {
    if (sectionSet.has(gap.n) || indexedSet.has(gap.n)) {
      staleExceptions.push(
        `${INDEX_GATE_CODE}: случай ${gap.n} назван в KNOWN_GAPS как отсутствующий, но он появился ` +
          `(раздел или строка) — уберите запись из KNOWN_GAPS.`,
      );
    }
  }

  const problems: string[] = [];
  if (missingRows.length > 0) {
    problems.push(
      `${INDEX_GATE_CODE}: ${missingRows.length} случай(ев) есть в файле, но нет в индексе — ` +
        `${missingRows.join(', ')} (класс случая 32: читатель индекса видит меньше, чем в реестре).`,
    );
  }
  if (phantomRows.length > 0) {
    problems.push(
      `${INDEX_GATE_CODE}: ${phantomRows.length} строк(и) индекса-указателя ссылается на ` +
        `несуществующий раздел — ${phantomRows.join(', ')} (индекс указывает на то, чего в файле нет).`,
    );
  }
  if (newGaps.length > 0) {
    problems.push(
      `${INDEX_GATE_CODE}: дыра в нумерации — нет ни раздела, ни строки для ${newGaps.join(', ')}. ` +
        `Дыра называется в KNOWN_GAPS с причиной, а не оставляется молча.`,
    );
  }
  problems.push(...staleExceptions);

  return {
    sections,
    indexed,
    selfDocumenting,
    missingRows,
    phantomRows,
    newGaps,
    staleExceptions,
    tables,
    problems,
  };
}

/** Разбор файла из репозитория. */
export function auditRegistryFile(root = path.resolve(__dirname, '..', '..')): IndexAudit {
  const file = path.join(root, REGISTRY_PATH);
  if (!fs.existsSync(file)) {
    return {
      sections: [],
      indexed: [],
      selfDocumenting: [],
      missingRows: [],
      phantomRows: [],
      newGaps: [],
      staleExceptions: [],
      tables: [],
      problems: [`${INDEX_GATE_CODE}: реестр не найден: ${REGISTRY_PATH}`],
    };
  }
  const audit = auditIndex(fs.readFileSync(file, 'utf8'));
  // Пустой разбор — тоже находка: «у всех случаев есть строка» верно и для нуля случаев.
  if (audit.sections.length === 0) {
    return {
      ...audit,
      problems: [
        ...audit.problems,
        `${INDEX_GATE_CODE}: в ${REGISTRY_PATH} не найдено ни одного раздела — сторож не различает ` +
          `файл, а это выглядит зелёным (правило «ноль собранного — красное»).`,
      ],
    };
  }
  return audit;
}
