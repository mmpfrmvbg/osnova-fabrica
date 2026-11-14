/**
 * СТОРОЖ УНИКАЛЬНОСТИ НОМЕРА РАЗДЕЛА — OSN-GATE-SECTION.
 *
 * # Дефект, из-за которого это написано
 *
 * Реестр железа (`docs/hardware-debt.md`, 15 799 строк) адресуется НОМЕРОМ: «§3.187», «§3.137.5».
 * На номер ссылаются реестр проверяемости, коммиты, README зондов и пробы — то есть это не
 * оформление, а АДРЕС. Два раздела с одним номером делают адрес неоднозначным молча: `grep §3.193`
 * находит две разные истории, и которая из них «та самая» — не видно ниоткуда.
 *
 * # Что уже случилось (замер 2026-11-14, до правки)
 *
 * `§3.193` встречался ДВА раза, и это два разных предмета:
 *   * L15243 — «139 на пробе P2a — ПЕРЕПОЛНЕНИЕ КУЧИ, а не дефект кодогенератора»;
 *   * L15550 — «Глубина 3 P3a: место кода расширено до 128 КиБ».
 *
 * # Три вещи, которые замер изменил в постановке (названы, а не сглажены)
 *
 * 1. **Ложных дублей больше, чем настоящих.** Три пары выглядели дублями, и две из них — НЕТ:
 *    `3.95.5` и `3.170.2` продолжены КИРИЛЛИЧЕСКОЙ БУКВОЙ (`3.95.5а`, `3.95.5б`, `3.170.2а`), то есть
 *    это отдельные подпункты со своим адресом. Сторож, считающий их дублями, краснел бы на исправном
 *    файле — ложное красное снимают первым же PR (случай 31 реестра проверяемости), и вместе с ним
 *    снимают весь сторож. Поэтому буквенный суффикс — ЧАСТЬ НОМЕРА, а не мусор.
 * 2. **Раздел и подраздел — разные адреса.** `## §3.193` и `### 3.193` совпадают по номеру, но
 *    живут на разных уровнях, и второй — подраздел первого ПО СМЫСЛУ (обе записи от 2026-11-09 про
 *    пробу протокола). Уникальность требуется по УРОВНЮ: `##` не должен повторяться среди `##`.
 *    Требование уникальности по всей глубине свалило бы в кучу `3.187`, `3.187.1` и `3.187.1.1`,
 *    которые друг другу не мешают ничем.
 * 3. **Старый стиль нумерации существует.** Часть разделов записана `## 3.188.` (без `§`), часть —
 *    `## §3.193.`. Сторож, ищущий только `§`, не увидел бы половину файла и отрапортовал бы «дублей
 *    нет» — ровно дефект случая 22 («сторож смотрит не туда и молчит»).
 *
 * # Границы
 *
 * * Сторож НЕ требует, чтобы номера шли подряд, и не ищет дыры: дыра в нумерации — это пропущенный
 *   номер, но не неоднозначный адрес, и требование непрерывности заставило бы выдумывать номера.
 * * Сторож НЕ проверяет, что номер соответствует смыслу раздела. Это не проверяемо машиной.
 * * Сторож работает по ЗАГОЛОВКАМ Markdown. Номер, названный в тексте («см. §3.193»), предметом не
 *   является: ссылка может указывать на любой раздел, и это правильно.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Код отказа — он же строка поиска в логах. */
export const SECTION_GATE_CODE = 'OSN-GATE-SECTION';

/** Реестр железа — единственный файл, который адресуется номерами разделов. */
export const HARDWARE_DEBT = path.join('docs', 'hardware-debt.md');

/**
 * Заголовок с номером раздела.
 *
 * Ловушка, на которой первая редакция соврала: суффикс `а`/`б` в `3.95.5а` — КИРИЛЛИЧЕСКИЙ, и
 * `\w` в JS-регексе его не берёт так, как ожидается для латиницы; поэтому суффикс вынесен в
 * отдельную группу явным классом.
 */
export interface SectionHeading {
  /** Номер строки (1-based). */
  readonly line: number;
  /** Уровень заголовка: 2 для `##`, 3 для `###`. */
  readonly level: number;
  /** Номер с буквенным суффиксом, если он есть: `3.95.5а`. */
  readonly number: string;
  /** Номер без суффикса: `3.95.5`. */
  readonly bare: string;
  /** Буквенный суффикс или пустая строка. */
  readonly suffix: string;
  /** Число частей в номере: 2 у раздела, 3 у подраздела. */
  readonly parts: number;
  /** Был ли знак `§`: он не часть адреса, но полезен для отчёта. */
  readonly sectionSign: boolean;
  readonly title: string;
}

/** Один конфликт: номер, занятый более одного раза. */
export interface SectionCollision {
  readonly number: string;
  readonly lines: readonly number[];
  readonly levels: readonly number[];
  readonly titles: readonly string[];
}

export interface SectionAudit {
  readonly headings: readonly SectionHeading[];
  readonly collisions: readonly SectionCollision[];
  readonly problems: readonly string[];
}

/** Разбор заголовков: чистая функция, ни файлов, ни сети. */
export function parseSectionHeadings(text: string): SectionHeading[] {
  const headings: SectionHeading[] = [];
  const lines = text.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    // `## §3.193. Заголовок`, `### 3.95.5а. Заголовок`, `## 3.188. Заголовок`.
    // Знак `§` необязателен; точка после номера необязательна; точка внутри номера обязательна.
    const m = /^(#{1,6})\s*(§?)\s*(\d+(?:\.\d+)+)([а-яё]?)\s*\.?\s*(.*)$/iu.exec(line);
    if (m === null) continue;
    const suffix = m[4] ?? '';
    const bare = m[3]!;
    headings.push({
      line: i + 1,
      level: m[1]!.length,
      number: `${bare}${suffix}`,
      bare,
      suffix,
      parts: bare.split('.').length,
      sectionSign: m[2] === '§',
      title: (m[5] ?? '').replace(/\s+/gu, ' ').trim(),
    });
  }
  return headings;
}

/**
 * Поиск конфликтов: один номер у разных заголовков.
 *
 * # Почему ключ — ТОЛЬКО номер, без уровня заголовка
 *
 * Первая редакция включала уровень в ключ, и на настоящем файле дала **ноль** конфликтов — при том
 * что `§3.193` занят дважды. Причина: настоящий дубль стоит как `## §3.193` (L15243) и `### 3.193`
 * (L15550), то есть на РАЗНЫХ уровнях, и правило «уникальность по уровню» его не видело. Это ровно
 * дефект случая 22 — сторож посмотрел не туда и отрапортовал «чисто».
 *
 * Адрес раздела — НОМЕР, а не номер с уровнем: `§3.193` и `### 3.193` читатель находит одним и тем
 * же поиском, и которая запись «та самая» — не видно ниоткуда. Поэтому уникален НОМЕР.
 *
 * Ключ включает СУФФИКС: `3.95.5` и `3.95.5а` — разные адреса, а не дубль (буква — часть номера).
 */
export function findSectionCollisions(headings: readonly SectionHeading[]): SectionCollision[] {
  const byNumber = new Map<string, SectionHeading[]>();
  for (const h of headings) {
    const list = byNumber.get(h.number) ?? [];
    list.push(h);
    byNumber.set(h.number, list);
  }
  const collisions: SectionCollision[] = [];
  for (const list of byNumber.values()) {
    if (list.length < 2) continue;
    collisions.push({
      number: list[0]!.number,
      lines: list.map((h) => h.line),
      levels: list.map((h) => h.level),
      titles: list.map((h) => h.title),
    });
  }
  return collisions.sort((a, b) => a.number.localeCompare(b.number, 'ru'));
}

/** Разбор файла реестра железа. */
export function auditHardwareDebt(root = path.resolve(__dirname, '..', '..')): SectionAudit {
  const file = path.join(root, HARDWARE_DEBT);
  const problems: string[] = [];
  if (!fs.existsSync(file)) {
    return {
      headings: [],
      collisions: [],
      problems: [
        `${SECTION_GATE_CODE}: реестр ${HARDWARE_DEBT} не найден — проверять нечего, и это красное, ` +
          `а не «дублей нет».`,
      ],
    };
  }
  const headings = parseSectionHeadings(fs.readFileSync(file, 'utf8'));
  const collisions = findSectionCollisions(headings);

  // Пустой разбор обязан краснеть: иначе сменившийся формат заголовков даст «дублей нет» —
  // ровно то, что случилось бы у сторожа, ищущего только `§` (случай 22).
  if (headings.length === 0) {
    problems.push(
      `${SECTION_GATE_CODE}: ни одного заголовка с номером не найдено — формат реестра изменился, ` +
        `и «дублей нет» здесь означает «не смотрел» (случай 22).`,
    );
  }

  for (const c of collisions) {
    const levels = c.levels.map((l) => '#'.repeat(l)).join('/');
    problems.push(
      `${SECTION_GATE_CODE}: номер ${c.number} занят ${String(c.lines.length)} раза (уровни ` +
        `${levels}) — строки ${c.lines.join(', ')}. Адрес неоднозначен: ` +
        `${c.titles.map((t, idx) => `«${t.slice(0, 50)}» (L${String(c.lines[idx]!)})`).join(' ПРОТИВ ')}.`,
    );
  }

  return { headings, collisions, problems };
}
