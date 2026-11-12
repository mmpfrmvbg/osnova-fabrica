// ============================================================
// src/scripts/languageV2Requirements.audit.test.ts
//
// Оракул документа docs/language-v2-requirements.md.
//
// Проверяет: документ существует, содержит пункты 1.1–1.7, в каждом есть число,
// и у каждого объявлен СТАТУС, совпадающий с зафиксированным. Корректность
// предложений НЕ проверяется — это решение владельца.
//
// Негативные контроли обязательны: без них оракул, который всегда зелёный,
// неотличим от работающего. Контроли намеренно изолируют ОДНУ причину каждый —
// иначе нельзя понять, что именно поймано.
// ============================================================
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  REQUIRED_ITEM_IDS,
  EXPECTED_STATUSES,
  auditRequirementsDoc,
  statusPhrase,
} from './languageV2Requirements';

const DOC = path.resolve('docs', 'language-v2-requirements.md');

/**
 * Пункт синтетического документа.
 *
 * `status` — ячейка целиком (как в документе: с выделением, датой и причиной);
 * `status: null` — строки `**Статус**` нет вовсе; `undefined` — как в документе
 * (статус, зафиксированный в карте).
 */
function item(
  id: string,
  opts: { number?: string; status?: string | null } = {},
): string {
  const lines = [`## ${id}. Пункт ${id}`];
  lines.push(opts.number ?? '52 случая');
  const status =
    opts.status === undefined
      ? `| **Статус** | **${EXPECTED_STATUSES[id] ?? 'реализовано'}** |`
      : opts.status === null
        ? null
        : `| **Статус** | ${opts.status} |`;
  if (status !== null) lines.push(status);
  lines.push('');
  return lines.join('\n');
}

describe('auditRequirementsDoc: негативные контроли', () => {
  it('документ без числа в пункте — ловится', () => {
    const doc = item('1.1', { number: 'Числа нет.' }) + item('1.2');
    const r = auditRequirementsDoc(doc, ['1.1', '1.2']);
    expect(r.sectionsWithoutNumber).toEqual(['1.1']);
    expect(r.missingStatus, 'статусы на месте — поймана именно пропажа числа').toEqual([]);
    expect(r.unexpectedStatus).toEqual([]);
    expect(r.ok).toBe(false);
  });

  it('пропущенный обязательный пункт — ловится', () => {
    const doc = item('1.1') + item('1.2');
    const r = auditRequirementsDoc(doc, ['1.1', '1.2', '1.6']);
    expect(r.missing).toEqual(['1.6']);
    expect(r.ok).toBe(false);
  });

  it('пустой документ — все пункты отсутствуют', () => {
    const r = auditRequirementsDoc('', ['1.1', '1.2']);
    expect(r.missing).toEqual(['1.1', '1.2']);
    expect(r.present).toEqual([]);
    expect(r.missingStatus, 'нет пунктов — нет и статусов, и это не «статусы пропали»').toEqual([]);
    expect(r.ok).toBe(false);
  });

  it('полный корректный документ — зелёный', () => {
    const doc = item('1.1') + item('1.2');
    const r = auditRequirementsDoc(doc, ['1.1', '1.2']);
    expect(r.missing).toEqual([]);
    expect(r.missingStatus).toEqual([]);
    expect(r.unexpectedStatus).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('пункт без строки `**Статус**` — ловится', () => {
    const doc = item('1.1', { status: null }) + item('1.2');
    const r = auditRequirementsDoc(doc, ['1.1', '1.2']);
    expect(r.missingStatus).toEqual(['1.1']);
    expect(r.statuses['1.1'], 'статуса нет — и выдуман он не будет').toBeUndefined();
    expect(r.ok).toBe(false);
  });

  it('статус, разошедшийся с зафиксированным, — ловится', () => {
    const doc = item('1.1', { status: '**не реализовано**' }) + item('1.2');
    const r = auditRequirementsDoc(doc, ['1.1', '1.2']);
    expect(r.unexpectedStatus).toEqual([
      { id: '1.1', expected: 'реализовано', actual: 'не реализовано' },
    ]);
    expect(r.missingStatus, 'статус есть, он просто другой').toEqual([]);
    expect(r.ok).toBe(false);
  });

  it('статус последнего пункта не подхватывается из следующего раздела', () => {
    // Границы пункта — любой заголовок `## `, а не только `## 1.N.`. Иначе
    // последний пункт тянулся бы до конца файла и брал чужую строку `**Статус**`
    // (в документе такие есть у «Стадии 2» и у «БЛОК 3, пункт 9»).
    const doc =
      item('1.7', { status: null }) +
      ['## Стадия 2: чужая', '| **Статус** | **реализовано** |', ''].join('\n');
    const r = auditRequirementsDoc(doc, ['1.7']);
    expect(r.missingStatus, 'чужая строка статуса не засчитана своему пункту').toEqual(['1.7']);
    expect(r.statuses['1.7']).toBeUndefined();
  });
});

describe('statusPhrase: фраза статуса без даты и обоснования', () => {
  it('снимает выделение, дату и причину', () => {
    expect(statusPhrase('**реализовано** (2026-09-23): `=` читается как `==`')).toBe('реализовано');
  });

  it('сохраняет составной статус', () => {
    expect(statusPhrase('**реализовано частично** (2026-09-23): реестр, 18 пар')).toBe(
      'реализовано частично',
    );
    expect(statusPhrase('**правило добавлено в промпт** (2026-09-23); эффект ожидает замера')).toBe(
      'правило добавлено в промпт',
    );
    expect(statusPhrase('**разное по видам**: правило — 4, реестр — 2, отложено — 5')).toBe(
      'разное по видам',
    );
  });
});

describe('docs/language-v2-requirements.md', () => {
  it('документ существует', () => {
    expect(fs.existsSync(DOC), `нет файла ${DOC}`).toBe(true);
  });

  it('содержит пункты 1.1–1.7, и в каждом есть число', () => {
    const text = fs.readFileSync(DOC, 'utf-8');
    const r = auditRequirementsDoc(text);
    expect(r.missing, `отсутствуют пункты: ${r.missing.join(', ')}`).toEqual([]);
    expect(
      r.sectionsWithoutNumber,
      `без числа: ${r.sectionsWithoutNumber.join(', ')}`,
    ).toEqual([]);
  });

  it('у каждого пункта объявлен статус', () => {
    const text = fs.readFileSync(DOC, 'utf-8');
    const r = auditRequirementsDoc(text);
    expect(r.missingStatus, `без статуса: ${r.missingStatus.join(', ')}`).toEqual([]);
  });

  it('статусы пунктов совпадают с зафиксированными — и это конкретные статусы', () => {
    const text = fs.readFileSync(DOC, 'utf-8');
    const r = auditRequirementsDoc(text);
    const mismatches = r.unexpectedStatus.map(
      (m) => `${m.id}: в документе «${m.actual}», зафиксировано «${m.expected}»`,
    );
    expect(mismatches, 'статус пункта меняется только вместе с картой EXPECTED_STATUSES').toEqual([]);
    expect(r.statuses).toEqual(EXPECTED_STATUSES);
  });

  it('шапка не утверждает, что ничего не реализовано (факт снят 2026-09-25)', () => {
    // Обратная проверка к прежней: оракул требовал фразу «не реализован» и тем
    // самым охранял формулировку вместо честности. Теперь эта фраза в шапке —
    // дефект: она неправда для 1.1–1.6.
    const text = fs.readFileSync(DOC, 'utf-8');
    const header = text.split('\n').slice(0, 8).join('\n');
    expect(header).not.toMatch(/Ни один пункт не реализован/i);
    expect(header, 'шапка объявляет актуальное состояние').toMatch(/Часть пунктов реализована/i);
  });

  it('оракул не вакуумный: карта статусов непуста и покрывает обязательные пункты', () => {
    for (const id of REQUIRED_ITEM_IDS) {
      expect(EXPECTED_STATUSES[id], `статус пункта ${id} зафиксирован`).toBeTruthy();
    }
  });
});
