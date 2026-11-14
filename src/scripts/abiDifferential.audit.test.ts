/**
 * ОРАКУЛ ABI-DIFFERENTIAL — OSN-GATE-ABIDIFF.
 *
 * Предмет — `src/scripts/abiDifferential.audit.ts` и документ `docs/e2k-abi-differential.md`.
 *
 * # Негативные контроли (N = 6)
 *
 * | N | что ломается | что обязано покраснеть |
 * |---|---|---|
 * | **1** | число в документе сдвинуто (wsz 16 → 8) | сверка «`wsz = 16`» |
 * | **2** | из документа убрана цена резерва | сверка «6 свободных» |
 * | **3** | документ сгладил расхождение (убрано «объяснения нет») | признание расхождения |
 * | **4** | убран раздел «Чего этот файл НЕ делает» | граница «не замер» |
 * | **5** | пропала пометка «РАСХОЖДЕНИЕ» | сверка трёх пометок |
 * | **6** | документ объявляет предел клеток, которого нет | сверка `= 16` |
 *
 * # Контроль 2 — тот, ради которого сторож и написан
 *
 * «Цена резерва» — единственное место, где документ называет ЦЕНОВОЕ следствие нашего решения:
 * 6 свободных клеток из 16. Если резерв поднимут в коде до 12, число свободных станет 4, а документ
 * продолжит утверждать 6 — и выглядеть будет правдиво. Сторож ловит именно это.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ABIDIFF_DOC,
  ABIDIFF_GATE_CODE,
  ABIDIFF_MARKS,
  abiClaims,
  abiDifferentialProblems,
  entryCellLimit,
} from './abiDifferential.audit';
import { ARRAY_WINDOW_RSZ, ARRAY_WINDOW_WSZ, RESERVED_FROM } from '../e2k/arrayRuntime';
import { CALL_WBS } from '../e2k/twoPassLayout';
import { INNER_CALL_WBS, WINDOW_GROW_WSZ } from '../e2k/procedureCall';
import { MAX_CALL_ARGS } from '../e2k/emitterShell';

const ROOT = path.join(__dirname, '..', '..');
const DOC = path.join(ROOT, ABIDIFF_DOC);

/** Документ как текст — источник для контроля, который портит копию, а не репозиторий. */
const docText = (): string => fs.readFileSync(DOC, 'utf8');

/** Временный корень с испорченной копией документа: репозиторий не трогается. */
function withBrokenDoc(mutate: (text: string) => string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abidiff-'));
  const target = path.join(dir, ABIDIFF_DOC);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, mutate(docText()), 'utf8');
  return dir;
}

describe('ABI-differential: документ согласован с деревом', () => {
  it('расхождений ноль', () => {
    const problems = abiDifferentialProblems(ROOT);
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('числа документа берутся ИЗ ДЕРЕВА, а не закреплены в стороже', () => {
    const byWhat = new Map(abiClaims().map((c) => [c.what, c.actual]));
    expect(byWhat.get('окно пролога образа')).toBe(ARRAY_WINDOW_WSZ);
    expect(byWhat.get('область вращения')).toBe(ARRAY_WINDOW_RSZ);
    expect(byWhat.get('ширина вызова')).toBe(CALL_WBS);
    expect(byWhat.get('выросшее окно')).toBe(WINDOW_GROW_WSZ);
    expect(byWhat.get('вложенный вызов')).toBe(INNER_CALL_WBS);
    expect(byWhat.get('резерв клеток с')).toBe(RESERVED_FROM);
    expect(byWhat.get('предел аргументов носителя')).toBe(MAX_CALL_ARGS);
  });

  it('предел клеток — 2·(rsz+1), и он же стоит в документе', () => {
    expect(entryCellLimit(ARRAY_WINDOW_RSZ)).toBe(16);
    expect(entryCellLimit(7)).toBe(16);
    // Различающая пара: при rsz = 7 формулы «2·(rsz+1)» и «2·wsz» дают 16 против 32.
    expect(entryCellLimit(ARRAY_WINDOW_RSZ)).not.toBe(2 * ARRAY_WINDOW_WSZ);
    expect(docText()).toContain('= 16');
  });

  it('три пометки на месте: закон, наше, расхождение', () => {
    const text = docText();
    for (const mark of ABIDIFF_MARKS) {
      expect(text, `пометка «${mark}» обязана быть`).toContain(mark);
    }
    expect(ABIDIFF_MARKS).toHaveLength(3);
  });

  it('код отказа и путь — те, на которые ссылаются', () => {
    expect(ABIDIFF_GATE_CODE).toBe('OSN-GATE-ABIDIFF');
    expect(fs.existsSync(DOC)).toBe(true);
  });
});

describe('ABI-differential: негативные контроли', () => {
  it('НЕГАТИВНЫЙ КОНТРОЛЬ 1: сдвинутое в документе число краснеет', () => {
    const dir = withBrokenDoc((t) => t.replace('`wsz = 16`', '`wsz = 8`'));
    const problems = abiDifferentialProblems(dir);
    expect(problems.join('\n')).toContain('`wsz = 16`');
    expect(problems.join('\n')).toContain('окно пролога образа');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ 2: убранная цена резерва краснеет — 6 свободных клеток', () => {
    const dir = withBrokenDoc((t) => t.replace('**6 свободных**', '**сколько-то свободных**'));
    const problems = abiDifferentialProblems(dir);
    expect(problems.join('\n')).toContain('свободных клеток 6');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ 3: сглаженное расхождение краснеет', () => {
    // Ровно то, что легче всего сделать «причёсывая» документ: убрать признание.
    const dir = withBrokenDoc((t) => t.replace('объяснения у нас нет', 'механизм ясен').replace('объяснения нет', 'механизм ясен'));
    const problems = abiDifferentialProblems(dir);
    expect(problems.join('\n')).toContain('сглаживает расхождение');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ 4: убранная граница «это не замер» краснеет', () => {
    const dir = withBrokenDoc((t) =>
      t.replace('## 12. Чего этот файл НЕ делает', '## 12. Итог').replace('**Не замер.**', '**Замер.**'),
    );
    const problems = abiDifferentialProblems(dir);
    expect(problems.join('\n')).toContain('Чего этот файл НЕ делает');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ 5: пропавшая пометка «РАСХОЖДЕНИЕ» краснеет', () => {
    const dir = withBrokenDoc((t) => t.split('РАСХОЖДЕНИЕ').join('ОСОБЕННОСТЬ'));
    const problems = abiDifferentialProblems(dir);
    expect(problems.join('\n')).toContain('пометку «РАСХОЖДЕНИЕ»');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ 6: пропавший предел клеток краснеет', () => {
    const dir = withBrokenDoc((t) => t.replace(/= 16/g, '= 24'));
    const problems = abiDifferentialProblems(dir);
    expect(problems.join('\n')).toContain('предел клеток 16');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
