// ============================================================
// src/scripts/languageV2Requirements.ts
//
// Оракул ДОКУМЕНТА требований (docs/language-v2-requirements.md).
//
// Проверяет три вещи:
//   1. каждый требуемый пункт на месте;
//   2. в каждом пункте есть ЧИСЛО (пункт без числа — пожелание, а не требование);
//   3. у каждого пункта объявлен СТАТУС, и он совпадает с зафиксированным здесь.
//
// Корректность самих предложений не проверяется и не может: это предмет решения
// владельца, а не теста.
//
// # Почему статусы, а не фраза в шапке (2026-09-25)
//
// Прежде третий пункт проверялся фразой `/не реализован/i` в шапке документа —
// то есть «документ честен, пока он утверждает, что ничего не сделано». К
// 2026-09-23 это стало неправдой (пункты 1.1–1.4 реализованы), и оракул начал
// требовать от документа устаревшую фразу: он охранял не честность, а
// формулировку. Теперь проверяются конкретные статусы: изменение статуса в
// документе — осознанный акт, требующий правки карты ниже, а не молчаливый дрейф.
//
// Чистая функция вынесена отдельно, чтобы её можно было проверить негативными
// контролями на синтетических документах, а не только на настоящем файле.
// ============================================================

/** Пункты, которые обязаны присутствовать в документе требований. */
export const REQUIRED_ITEM_IDS = ['1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '1.7'] as const;

/**
 * Зафиксированные статусы пунктов.
 *
 * Значение — ФРАЗА статуса без даты и обоснования: в документе строка выглядит
 * как `| **Статус** | **реализовано** (2026-09-23): … |`, а здесь — `реализовано`.
 *
 * Менять эту карту можно только вместе со статусом в документе: в этом и смысл —
 * статус пункта не должен меняться незаметно для оракула.
 */
export const EXPECTED_STATUSES: Readonly<Record<string, string>> = {
  '1.1': 'реализовано',
  '1.2': 'реализовано',
  '1.3': 'реализовано',
  '1.4': 'реализовано',
  '1.5': 'реализовано частично',
  '1.6': 'правило добавлено в промпт',
  // 1.7 — сводный: 11 видов с разной судьбой, у каждого своя строка в таблице.
  '1.7': 'разное по видам',
};

/** Расхождение статуса с зафиксированным. */
export interface StatusMismatch {
  readonly id: string;
  readonly expected: string;
  readonly actual: string;
}

export interface RequirementsAudit {
  /** Найденные пункты. */
  readonly present: string[];
  /** Обязательные пункты, которых нет. */
  readonly missing: string[];
  /** Пункты без единой цифры — значит без числа случаев. */
  readonly sectionsWithoutNumber: string[];
  /** Статус каждого найденного пункта, как он записан в документе. */
  readonly statuses: Readonly<Record<string, string>>;
  /** Пункты без строки `| **Статус** | … |`. */
  readonly missingStatus: string[];
  /** Пункты, чей статус разошёлся с зафиксированным. */
  readonly unexpectedStatus: readonly StatusMismatch[];
  readonly ok: boolean;
}

/**
 * Вытащить фразу статуса из ячейки таблицы.
 *
 * В документе ячейка — это markdown с выделением и обоснованием:
 * `**реализовано частично** (2026-09-23): реестр синонимов, 18 пар; …`.
 * Берётся ровно ведущая фраза: жирный шрифт снимается, хвост после первой даты,
 * двоеточия, точки с запятой или вертикальной черты отбрасывается. Иначе
 * оракул зависел бы от даты и от текста обоснования, то есть от того, что
 * меняется свободно.
 */
export function statusPhrase(cell: string): string {
  const bold = cell.replace(/\*\*/g, '').trim();
  const head = bold.split(/[(;:|]/)[0] ?? '';
  return head.trim();
}

/** Найти строку `| **Статус** | … |` внутри тела пункта. */
function statusOf(body: string): string | undefined {
  // Жадный `.+` до последней черты на строке: ячейка может содержать `|` внутри
  // кода, и обрезать по первой черте значило бы потерять часть статуса.
  const row = /^\|\s*\*\*Статус\*\*\s*\|(.+)\|\s*$/m.exec(body);
  if (row === null) return undefined;
  const phrase = statusPhrase(row[1] ?? '');
  return phrase === '' ? undefined : phrase;
}

/**
 * Разбирает markdown-документ требований на пункты вида `## 1.N.` и проверяет
 * в каждом наличие числа и объявленного статуса.
 *
 * Границы пункта — ЛЮБОЙ заголовок `## `, а не только `## 1.N.`: последний пункт
 * иначе тянулся бы до конца файла и подхватывал чужие строки `**Статус**`
 * (Стадия 2, БЛОК 3 — они тоже объявляют статус).
 *
 * @param text содержимое документа
 * @param required список обязательных идентификаторов
 * @param expected зафиксированные статусы пунктов
 */
export function auditRequirementsDoc(
  text: string,
  required: readonly string[] = REQUIRED_ITEM_IDS,
  expected: Readonly<Record<string, string>> = EXPECTED_STATUSES,
): RequirementsAudit {
  const marks = [...text.matchAll(/^##\s+(1\.\d+)\./gm)];
  const boundaries = [...text.matchAll(/^##\s+/gm)].map((m) => m.index ?? 0);
  const present: string[] = [];
  const sectionsWithoutNumber: string[] = [];
  const statuses: Record<string, string> = {};
  const missingStatus: string[] = [];
  const unexpectedStatus: StatusMismatch[] = [];

  for (let i = 0; i < marks.length; i++) {
    const id = marks[i]![1]!;
    const start = marks[i]!.index!;
    const end = boundaries.find((b) => b > start) ?? text.length;
    // Заголовок `## 1.1.` сам содержит цифры — без его отбрасывания проверка
    // «есть ли число» проходит всегда. Негативный контроль это и поймал.
    const body = text.slice(start, end).replace(/^##\s+1\.\d+\..*(\n|$)/, '');
    present.push(id);
    if (!/\d/.test(body)) sectionsWithoutNumber.push(id);

    const status = statusOf(body);
    if (status === undefined) {
      missingStatus.push(id);
      continue;
    }
    statuses[id] = status;
    const want = expected[id];
    if (want !== undefined && want !== status) {
      unexpectedStatus.push({ id, expected: want, actual: status });
    }
  }

  const missing = required.filter((id) => !present.includes(id));
  return {
    present,
    missing,
    sectionsWithoutNumber,
    statuses,
    missingStatus,
    unexpectedStatus,
    ok:
      missing.length === 0 &&
      sectionsWithoutNumber.length === 0 &&
      missingStatus.length === 0 &&
      unexpectedStatus.length === 0,
  };
}
