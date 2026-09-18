// ============================================================
// src/scripts/languageV2Requirements.audit.test.ts
//
// Оракул документа docs/language-v2-requirements.md.
//
// Проверяет: документ существует, содержит пункты 1.1–1.7, и в каждом пункте
// есть число. Корректность предложений НЕ проверяется — это решение владельца.
//
// Негативные контроли обязательны: без них оракул, который всегда зелёный,
// неотличим от работающего.
// ============================================================
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { REQUIRED_ITEM_IDS, auditRequirementsDoc } from './languageV2Requirements';

const DOC = path.resolve('docs', 'language-v2-requirements.md');

describe('auditRequirementsDoc: негативные контроли', () => {
  it('документ без числа в пункте — ловится', () => {
    const doc = [
      '## 1.1. Проблема',
      'Числа нет.',
      '',
      '## 1.2. Другая',
      '52 случая.',
    ].join('\n');
    const r = auditRequirementsDoc(doc, ['1.1', '1.2']);
    expect(r.sectionsWithoutNumber).toEqual(['1.1']);
    expect(r.ok).toBe(false);
  });

  it('пропущенный обязательный пункт — ловится', () => {
    const doc = ['## 1.1. Есть', '52', '', '## 1.2. Есть', '20'].join('\n');
    const r = auditRequirementsDoc(doc, ['1.1', '1.2', '1.6']);
    expect(r.missing).toEqual(['1.6']);
    expect(r.ok).toBe(false);
  });

  it('пустой документ — все пункты отсутствуют', () => {
    const r = auditRequirementsDoc('', ['1.1', '1.2']);
    expect(r.missing).toEqual(['1.1', '1.2']);
    expect(r.present).toEqual([]);
    expect(r.ok).toBe(false);
  });

  it('полный корректный документ — зелёный', () => {
    const doc = ['## 1.1. A', '52', '## 1.2. B', '20'].join('\n');
    const r = auditRequirementsDoc(doc, ['1.1', '1.2']);
    expect(r.ok).toBe(true);
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
    expect(r.ok).toBe(true);
  });

  it('все обязательные идентификаторы найдены', () => {
    const text = fs.readFileSync(DOC, 'utf-8');
    const r = auditRequirementsDoc(text);
    for (const id of REQUIRED_ITEM_IDS) {
      expect(r.present, `пункт ${id}`).toContain(id);
    }
  });

  it('документ объявляет, что ничего не реализовано', () => {
    const text = fs.readFileSync(DOC, 'utf-8');
    expect(text).toMatch(/не реализован/i);
    expect(text).toMatch(/Статус/i);
  });
});
