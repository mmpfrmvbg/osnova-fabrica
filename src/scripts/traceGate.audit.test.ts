/**
 * ОРАКУЛ ГЕЙТА «ТРАССА ДО ПРАВКИ» (случаи 98 и 103 реестра проверяемости).
 *
 * # Что здесь доказывается
 *
 * Сторож без красной стороны — украшение (правило из случая 8). Поэтому проверяются **обе**
 * стороны и обе по одной функции, которой пользуется сам гейт:
 *
 * | сторона | утверждение |
 * |---|---|
 * | тело PR **без** §2 | красное, и в тексте отказа стоит `OSN-GATE-TRACE` |
 * | тело PR **с** §2 | зелёное |
 * | тело PR с **пустым** §2 (шаблон взят как есть) | красное — иначе гейт ловит всех, кроме причины (случай 30) |
 * | шаблон из репозитория | раздел есть, заполнитель на месте, цена пропуска названа |
 *
 * # Негативный контроль (N=2, откат)
 *
 * Откат шаблона к прежней редакции краснит **две** проверки: «шаблон несёт §2» и «шаблон не
 * заполнен». Обе — ниже, и обе читают **настоящий файл**, а не фикстуру: иначе сторож проверял бы
 * копию шаблона, а не тот, из которого рождаются PR.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  MIN_DIFF_LENGTH,
  TEMPLATE_PATH,
  TRACE_GATE_CODE,
  auditTemplate,
  auditTraceBody,
  classOf,
  fieldValue,
  looksLikePlaceholder,
  traceSectionOf,
} from './traceGate';

const ROOT = path.resolve(__dirname, '..', '..');

/** Тело PR, каким оно приходит из GitHub: раздел есть, поля заполнены. */
const GOOD_BODY = `## Summary

- починил сравнение

## Трасса (обязательно, до кода)

- [x] \`diff\` эталон vs факт: \`site.index <= segment.end\` вместо \`site.index < segment.end\`
- [x] Класс: B — продвижение (граница порчи вызовом была открытой)

## Validation

- [ ] \`npm test\`
`;

/** То же тело, но раздел взят из шаблона и НЕ заполнен — самый вероятный способ пройти гейт даром. */
const UNFILLED_BODY = `## Summary

- что-то

## Трасса (обязательно, до кода)

- [ ] \`diff\` эталон vs факт: [цитата]
- [ ] Класс: (A) запись / (B) продвижение / (C) пропуск / (D) не применимо (docs/infra)

## Validation
`;

const NO_TRACE_BODY = `## Summary

- починил

## Validation

- [ ] \`npm test\`
`;

describe('гейт «трасса до правки»: тело PR', () => {
  it('тело БЕЗ §2 красное, и отказ называет случай 98', () => {
    const audit = auditTraceBody(NO_TRACE_BODY);
    expect(audit.present, 'раздела нет — это и есть нарушение').toBe(false);
    expect(audit.problems.length).toBeGreaterThan(0);
    const joined = audit.problems.join('\n');
    expect(joined).toContain(TRACE_GATE_CODE);
    expect(joined, 'отказ обязан называть случай, ради которого гейт').toMatch(/случай 98/);
  });

  it('тело С §2 зелёное — иначе гейт красный всегда, и его снимут первым же PR', () => {
    const audit = auditTraceBody(GOOD_BODY);
    expect(audit.present).toBe(true);
    expect(audit.problems).toEqual([]);
    expect(audit.klass).toBe('B');
    expect(audit.diff, 'трасса процитирована как была').toContain('segment.end');
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: §2, взятый из шаблона и не заполненный, — красное', () => {
    // Самая вероятная форма обхода: скопировать шаблон целиком. «Проверка наличия раздела» такое
    // пропустила бы, и PR прошёл бы с пустой трассой — это случай 30 реестра (наблюдатель не
    // различает вход, и «проходит» читается как проверка).
    const audit = auditTraceBody(UNFILLED_BODY);
    expect(audit.present).toBe(true);
    expect(audit.problems.length, 'незаполненный раздел обязан краснеть').toBeGreaterThan(0);
    const joined = audit.problems.join('\n');
    expect(joined).toContain(TRACE_GATE_CODE);
    expect(joined, 'названо, что именно оставлено заглушкой').toMatch(/заглушк/);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: класс не назван — красное, и отказ перечисляет A/B/C/D', () => {
    const body = GOOD_BODY.replace(
      '- [x] Класс: B — продвижение (граница порчи вызовом была открытой)',
      '- [x] Класс:',
    );
    const audit = auditTraceBody(body);
    expect(audit.klass).toBeNull();
    const joined = audit.problems.join('\n');
    expect(joined).toContain(TRACE_GATE_CODE);
    expect(joined).toMatch(/A — запись/);
    expect(joined).toMatch(/D — не применимо/);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: diff вместо цитаты — короткая отписка', () => {
    const body = GOOD_BODY.replace(
      '- [x] `diff` эталон vs факт: `site.index <= segment.end` вместо `site.index < segment.end`',
      '- [x] `diff` эталон vs факт: поправил',
    );
    const audit = auditTraceBody(body);
    expect(audit.problems.join('\n')).toContain(TRACE_GATE_CODE);
    expect(audit.problems.join('\n')).toMatch(new RegExp(`короче ${MIN_DIFF_LENGTH}`));
  });

  it('раздел обрывается на следующем заголовке того же уровня, а не тянется до конца', () => {
    const section = traceSectionOf(GOOD_BODY);
    expect(section).not.toBeNull();
    expect(section, 'в раздел не должен попасть «## Validation»').not.toContain('npm test');
  });

  it('поле читается в любом оформлении: жирное, обратные кавычки, двоеточие, тире', () => {
    const variants = [
      '- [x] **diff эталон vs факт:** `a <= b` вместо `a < b`',
      '- diff эталон vs факт — `a <= b` вместо `a < b`',
      '* [x] `diff` эталон vs факт: `a <= b` вместо `a < b`',
    ];
    for (const line of variants) {
      const value = fieldValue(line, 'diff эталон vs факт');
      expect(value, `не прочитано: ${line}`).not.toBeNull();
      expect(looksLikePlaceholder(value!), `оформление принято за заглушку: ${line}`).toBe(false);
    }
  });

  it('класс распознаётся в любом оформлении, а перечисление всех четырёх — нет', () => {
    expect(classOf('(A) запись')).toBe('A');
    expect(classOf('B — продвижение')).toBe('B');
    expect(classOf('выбран: C, пропуск')).toBe('C');
    expect(classOf('D (docs/infra)')).toBe('D');
    expect(classOf('(A) запись / (B) продвижение / (C) пропуск / (D) не применимо (docs/infra)')).toBeNull();
    expect(classOf('')).toBeNull();
    expect(classOf(null)).toBeNull();
  });
});

describe('гейт «трасса до правки»: шаблон репозитория', () => {
  // Обе проверки читают НАСТОЯЩИЙ файл: при откате шаблона к прежней редакции (без §2 и с пустым
  // заполнителем) краснеют обе — это и есть негативный контроль N=2.
  const text = fs.readFileSync(path.join(ROOT, TEMPLATE_PATH), 'utf8');

  it('шаблон несёт §2 «Трасса» — иначе тело PR рождается без неё', () => {
    const audit = auditTemplate(text);
    expect(audit.present, `в ${TEMPLATE_PATH} нет раздела «## Трасса»`).toBe(true);
    expect(audit.problems, 'шаблон сам нарушает правило, которое вводит').toEqual([]);
  });

  it('в шаблоне стоит ЗАПОЛНИТЕЛЬ, а не готовая трасса', () => {
    const section = traceSectionOf(text);
    expect(section).not.toBeNull();
    const diff = fieldValue(section!, 'diff эталон vs факт');
    expect(diff, 'строка diff в шаблоне есть').not.toBeNull();
    expect(looksLikePlaceholder(diff!), `в шаблоне готовая трасса «${diff}» — PR пройдёт её даром`).toBe(true);
    expect(section, 'цена пропуска названа в шаблоне').toMatch(/не принимается/i);
    expect(section, 'шаблон называет случаи, ради которых гейт').toMatch(/98/);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: шаблон без §2 краснеет той же функцией', () => {
    // Ровно прежняя редакция шаблона (до этого коммита): Summary/Validation/Language change.
    const before = [
      '## Summary', '', '- ', '', '## Validation', '', '- [ ] `npm test`', '',
      '## Language change (Osnova v2.0)', '', 'If this PR changes the language:', '',
    ].join('\n');
    const audit = auditTemplate(before);
    expect(audit.present).toBe(false);
    expect(audit.problems.join('\n')).toContain(TRACE_GATE_CODE);
    expect(audit.problems.join('\n')).toMatch(/нет раздела/);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: шаблон с ЗАПОЛНЕННЫМ diff краснеет', () => {
    const filled = [
      '## Трасса (обязательно, до кода)', '',
      '- [ ] `diff` эталон vs факт: `site.index <= segment.end` вместо `site.index < segment.end`',
      '- [ ] Класс: (A) запись / (B) продвижение / (C) пропуск / (D) не применимо (docs/infra)',
      '',
      'Без трассы — PR не принимается (случай 98).',
      '',
    ].join('\n');
    const audit = auditTemplate(filled);
    expect(audit.present).toBe(true);
    expect(audit.problems.join('\n'), 'готовая трасса в шаблоне обязана краснеть').toMatch(/уже заполнен/);
  });
});
