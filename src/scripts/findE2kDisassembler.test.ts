/**
 * ОРАКУЛ ПОИСКА ОНЛАЙН-ДИЗАССЕМБЛЕРА ДЛЯ e2k.
 *
 * # Что проверяется
 *
 * Compiler Explorer компилятора e2k не дал (`docs/e2k-external-validation.md` §1), поэтому
 * проверены альтернативные онлайн-сервисы: дизассемблеры (принимают байты) и ассемблеры
 * (принимают текст и выдают байты). Тест проверяет **записи** об этой проверке:
 *
 * 1. **Каждый проверенный сервис назван** и имеет ответ (код или «недоступен»), а не общее
 *    «проверяли — нет».
 * 2. **Ответ про поддержку e2k есть у каждого** сервиса: «нет», «—» или названный сервис.
 * 3. **Маркер и положительный результат не могут стоять вместе**: если строка объявляет
 *    поддержку e2k, маркер «ОНЛАЙН-ДИЗАССЕМБЛЕР ДЛЯ e2k НЕ НАЙДЕН» обязан исчезнуть —
 *    иначе документ противоречит сам себе. Это защита от устаревания в обе стороны.
 * 4. **Путь «ручная сверка по документации МЦСТ» записан с числами**: в PDF нет ни «формата
 *    команды», ни «опкода»; поиск по формам дал 0 вхождений, а найденные «код операции» и
 *    «битовое поле» относятся к другому (страницы названы).
 *
 * # Негативный контроль
 *
 * Проверяльщик строк прогоняется на подложенном тексте: без строки сервиса, без ответа,
 * с поддержкой e2k при стоящем маркере.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { CE_NO_DISASSEMBLER } from './compilerExplorer';

const ROOT = path.resolve(__dirname, '..', '..');
const DOC = path.join(ROOT, 'docs', 'e2k-external-validation.md');

/** Сервисы, которые обязаны быть в таблице §3 (проверены вручную 2026-09-15). */
export const REQUIRED_SERVICES: readonly string[] = [
  'godbolt.org',
  'onlinedisassembler.com',
  'disasm.pro',
  'dogbolt.org',
  'retdec.com',
  'wandbox.org',
  'defuse.ca',
];

/** Разобранная строка таблицы §3. */
export interface ServiceRow {
  readonly service: string;
  readonly response: string;
  readonly e2k: string;
}

/** Разобрать таблицу сервисов (`| сервис | что это | ответ | e2k |`). */
export function parseServiceRows(doc: string): ServiceRow[] {
  const rows: ServiceRow[] = [];
  for (const line of doc.split(/\r?\n/)) {
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length < 6) continue;
    const service = (cells[1] ?? '').replace(/`/g, '');
    if (!/^[a-z0-9.-]+\.[a-z]{2,}/.test(service)) continue;
    rows.push({ service, response: cells[3] ?? '', e2k: cells[4] ?? '' });
  }
  return rows;
}

/** Проверки строк сервисов: пустой список — про каждый сервис записан ответ. */
export function checkServiceRows(
  required: readonly string[],
  rows: readonly ServiceRow[],
  markerPresent: boolean,
): string[] {
  const problems: string[] = [];
  for (const name of required) {
    const row = rows.find((candidate) => candidate.service.startsWith(name));
    if (row === undefined) {
      problems.push(`${name}: нет строки в таблице сервисов`);
      continue;
    }
    if (!/(200|502|404|недоступен|таймаут|закрыт)/i.test(row.response)) {
      problems.push(`${name}: ответ «${row.response}» не назван`);
    }
    if (row.e2k.trim() === '') problems.push(`${name}: не сказано, поддерживает ли сервис e2k`);
    // «нет» и «не поддерживает» — отрицания, а не заявка: иначе проверка ловила бы саму себя.
    const cell = row.e2k.trim().replace(/\*/g, '');
    const negative = /^нет\b/i.test(cell) || /^не\s/i.test(cell) || cell === '—';
    const claimsSupport = !negative && /(^|[^а-яa-z])(да|есть|поддерживает)([^а-яa-z]|$)/i.test(cell);
    if (claimsSupport && markerPresent) {
      problems.push(`${name}: строка объявляет поддержку e2k, но в документе стоит маркер «не найден»`);
    }
  }
  return problems;
}

describe('онлайн-дизассемблер для e2k: результат записан', () => {
  const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf-8') : '';
  const rows = parseServiceRows(doc);
  const markerPresent = doc.includes(CE_NO_DISASSEMBLER);

  it('таблица сервисов заполнена: у каждого ответ и вывод про e2k', () => {
    expect(rows.length, 'разобрано строк сервисов').toBeGreaterThanOrEqual(REQUIRED_SERVICES.length);
    expect(checkServiceRows(REQUIRED_SERVICES, rows, markerPresent)).toEqual([]);
  });

  it('результат поиска записан явно', () => {
    expect(markerPresent, `нет записи «${CE_NO_DISASSEMBLER}»`).toBe(true);
  });

  it('путь «ручная сверка по документации МЦСТ» проверен и записан с числами', () => {
    // Формы поиска и их вхождения — из целенаправленной проверки PDF (208 страниц).
    expect(doc).toContain('208');
    expect(doc).toMatch(/`формат команды`\s*\|\s*\*\*0\*\*/);
    expect(doc).toMatch(/`опкод`, `opcode`\s*\|\s*\*\*0\*\*/);
    expect(doc).toMatch(/битовые поля \*\*языка C\*\*/);
    expect(doc, 'не сказано, чем именно проверялся PDF').toMatch(/pymupdf|350 272|350272/);
  });

  it('записано, что остаётся и чего не хватает каждому пути', () => {
    for (const path_ of ['binutils', 'QEMU', 'Compiler Explorer', 'железо', 'МЦСТ']) {
      expect(doc, `не назван путь: ${path_}`).toContain(path_);
    }
    expect(doc, 'не сказано, что для своего инстанса CE нужен бинарь компилятора').toMatch(
      /нужен сам бинарь/i,
    );
  });

  it('негативный контроль: пропуск сервиса, ответ без кода и противоречие маркеру ловятся', () => {
    const healthy: ServiceRow[] = [
      { service: 'godbolt.org', response: '**200**: 6 277 компиляторов', e2k: '**нет**' },
      { service: 'disasm.pro', response: '**недоступен**: таймаут 45 с', e2k: '—' },
    ];
    expect(checkServiceRows(['godbolt.org', 'disasm.pro'], healthy, true)).toEqual([]);

    expect(checkServiceRows(['godbolt.org', 'retdec.com'], healthy, true).join(' ')).toMatch(
      /retdec\.com: нет строки/,
    );

    const noCode: ServiceRow[] = [{ service: 'godbolt.org', response: 'отвечает', e2k: 'нет' }];
    expect(checkServiceRows(['godbolt.org'], noCode, true).join(' ')).toMatch(/ответ «отвечает» не назван/);

    const noE2k: ServiceRow[] = [{ service: 'godbolt.org', response: '200', e2k: '' }];
    expect(checkServiceRows(['godbolt.org'], noE2k, true).join(' ')).toMatch(/не сказано, поддерживает/);

    const contradiction: ServiceRow[] = [{ service: 'godbolt.org', response: '200', e2k: 'да, поддерживает' }];
    expect(checkServiceRows(['godbolt.org'], contradiction, true).join(' ')).toMatch(/стоит маркер/);
    // И обратная сторона: если маркера нет, поддержка не считается противоречием.
    expect(checkServiceRows(['godbolt.org'], contradiction, false)).toEqual([]);
  });
});
