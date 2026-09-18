// ============================================================
// src/scripts/languageV2Requirements.ts
//
// Оракул ДОКУМЕНТА требований (docs/language-v2-requirements.md).
//
// Проверяет ровно две вещи: что каждый требуемый пункт на месте и что в каждом
// пункте есть ЧИСЛО. Корректность самих предложений не проверяется и не может:
// это предмет решения владельца, а не теста.
//
// Чистая функция вынесена отдельно, чтобы её можно было проверить негативными
// контролями на синтетических документах, а не только на настоящем файле.
// ============================================================

/** Пункты, которые обязаны присутствовать в документе требований. */
export const REQUIRED_ITEM_IDS = ['1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '1.7'] as const;

export interface RequirementsAudit {
  /** Найденные пункты. */
  readonly present: string[];
  /** Обязательные пункты, которых нет. */
  readonly missing: string[];
  /** Пункты без единой цифры — значит без числа случаев. */
  readonly sectionsWithoutNumber: string[];
  readonly ok: boolean;
}

/**
 * Разбирает markdown-документ требований на пункты вида `## 1.N.` и проверяет
 * наличие числа в каждом.
 *
 * @param text содержимое документа
 * @param required список обязательных идентификаторов
 */
export function auditRequirementsDoc(
  text: string,
  required: readonly string[] = REQUIRED_ITEM_IDS,
): RequirementsAudit {
  const marks = [...text.matchAll(/^##\s+(1\.\d+)\./gm)];
  const present: string[] = [];
  const sectionsWithoutNumber: string[] = [];

  for (let i = 0; i < marks.length; i++) {
    const id = marks[i]![1]!;
    const start = marks[i]!.index!;
    const end = i + 1 < marks.length ? marks[i + 1]!.index! : text.length;
    // Заголовок `## 1.1.` сам содержит цифры — без его отбрасывания проверка
    // «есть ли число» проходит всегда. Негативный контроль это и поймал.
    const body = text.slice(start, end).replace(/^##\s+1\.\d+\..*(\n|$)/, '');
    present.push(id);
    if (!/\d/.test(body)) sectionsWithoutNumber.push(id);
  }

  const missing = required.filter((id) => !present.includes(id));
  return {
    present,
    missing,
    sectionsWithoutNumber,
    ok: missing.length === 0 && sectionsWithoutNumber.length === 0,
  };
}
