/**
 * ОРАКУЛ ЗАКОНОВ ОКНА — OSN-GATE-WINDOW.
 *
 * Предмет — `src/e2k/windowLaws.audit.ts`. Законы §3.111/§3.113 применяются к КОНСТАНТАМ ДЕРЕВА, и
 * каждый несёт имя ПЛОСКОСТИ, в которой живёт.
 *
 * # Негативные контроли и их имена
 *
 * | N | что ломается | что обязано покраснеть |
 * |---|---|---|
 * | **1** | закон 1: `rbs + rsz + 1 > wsz` | «З1 годность» |
 * | **2** | закон 2: старшая клетка за `2·(rsz+1)` | «З2 предел клеток входа» |
 * | **3** | закон 3: `wsz − wbs ≠ 4` | «З3 ровно четыре у вызова» |
 * | **4** | закон 4: `wsz ≤ wbs` у вызываемой | «З4 бюджет вызываемой» |
 * | **5** | закон 3 применён НЕ ТУДА (к окну функции) | ЛОЖНОЕ красное — контроль в обратную сторону |
 * | **6** | дублированная константа разошлась | «закрытие вернёт не то окно» |
 *
 * # Контроль 5 — самый важный
 *
 * Обычный контроль доказывает, что сторож КРАСНЕЕТ на дефекте. У этого сторожа есть второй способ
 * быть вредным: краснеть на исправном дереве, применив закон не в той плоскости. Я сам так сделал
 * при первом прогоне: проверил `wsz − wbs = 4` на окне ФУНКЦИИ (`16 − 4 = 12`) и записал «нарушен».
 * Это тот же перенос вывода, который §3.166 поймал в реестре. Контроль 5 закрепляет, что закон 3
 * живёт в плоскости ЛОКАЛЬНОГО окна и что подстановка окна функции в него — ошибка применения.
 */

import { describe, it, expect } from 'vitest';
import {
  WINDOW_GATE_CODE,
  calleeCellLimit,
  entryCellLimit,
  windowDuplicateProblems,
  windowFactsFromTree,
  windowLawProblems,
  windowLaws,
  type WindowFacts,
} from './windowLaws.audit';
import { ARRAY_REGISTERS, ARRAY_WINDOW_RSZ, ARRAY_WINDOW_WSZ } from '../e2k/arrayRuntime';
import { ENTRY_SYSCALL_FRAME, GROWN_SYSCALL_FRAME } from '../e2k/syscallRuntime';
import { INNER_CALL_WBS, WINDOW_GROW_WSZ } from '../e2k/procedureCall';

/** Базовый набор — ИЗ ДЕРЕВА, чтобы контроль менял ровно одно число. */
const BASE = windowFactsFromTree();

const withFacts = (patch: Partial<WindowFacts>): WindowFacts => ({ ...BASE, ...patch });

/** Найти закон по id: имя проверки читается в падении. */
const law = (facts: WindowFacts, id: string) => {
  const found = windowLaws(facts).find((l) => l.id === id);
  if (found === undefined) throw new Error(`закона «${id}» нет — переименован?`);
  return found;
};

describe('законы окна: формулы', () => {
  it('предел клеток входа — 2·(rsz+1), а не 2·wsz', () => {
    // Различающая пара: при rsz = 7 и wsz = 12 формулы дают 16 против 24.
    expect(entryCellLimit(7)).toBe(16);
    expect(entryCellLimit(7)).not.toBe(2 * 12);
  });

  it('клеток вызываемой — 2·(wsz−wbs), и это то же, что замер §3.166', () => {
    // Замер 1: wsz 12/13/14/16 → первая недоступная клетка 16/18/20/24.
    expect([12, 13, 14, 16].map((w) => calleeCellLimit(w, 4))).toEqual([16, 18, 20, 24]);
  });
});

describe('законы окна: числа дерева согласованы', () => {
  it('все четыре закона выполнены и нарушений ноль', () => {
    const problems = windowLawProblems();
    expect(problems, problems.join('\n')).toEqual([]);
    expect(windowDuplicateProblems()).toEqual([]);
  });

  it('у каждого закона названа ПЛОСКОСТЬ — иначе «нарушен» и «применён не туда» неразличимы', () => {
    const laws = windowLaws(BASE);
    expect(laws).toHaveLength(4);
    for (const l of laws) {
      expect(['вход', 'сайт вызова', 'вызываемая']).toContain(l.plane);
      expect(l.detail.length, `${l.id}: подробность обязана быть числом`).toBeGreaterThan(3);
    }
    // Плоскости распределены так, а не все в одной.
    expect(laws.map((l) => l.plane)).toEqual(['вход', 'вход', 'сайт вызова', 'вызываемая']);
  });

  it('числа берутся ИЗ ДЕРЕВА, а не закреплены в стороже', () => {
    // Сдвиг константы в дереве обязан сдвинуть факты: иначе сторож сторожит сам себя.
    expect(BASE.entryWsz).toBe(ARRAY_WINDOW_WSZ);
    expect(BASE.entryRsz).toBe(ARRAY_WINDOW_RSZ);
    expect(BASE.entryTopCell).toBe(Math.max(...Object.values(ARRAY_REGISTERS)));
    expect(BASE.localWbs).toBe(ENTRY_SYSCALL_FRAME.wbs);
    expect(BASE.grownWsz).toBe(WINDOW_GROW_WSZ);
    expect(BASE.grownWbs).toBe(INNER_CALL_WBS);
    expect(GROWN_SYSCALL_FRAME.wbs).toBe(INNER_CALL_WBS);
  });

  it('код отказа — OSN-GATE-WINDOW', () => {
    expect(WINDOW_GATE_CODE).toBe('OSN-GATE-WINDOW');
  });
});

describe('законы окна: негативные контроли', () => {
  it('НЕГАТИВНЫЙ КОНТРОЛЬ 1: годность нарушена — окно негодно целиком', () => {
    // rsz 7 → 20 при wsz = 16: 0+20+1 = 21 > 16. На железе это SEGV_BNDERR на ПЕРВОМ обращении.
    const laws = windowLaws(withFacts({ entryRsz: 20 }));
    const z1 = laws.find((l) => l.id === 'З1 годность');
    expect(z1?.holds, 'закон 1 обязан покраснеть').toBe(false);
    const problems = windowLawProblems(withFacts({ entryRsz: 20 }));
    expect(problems.join('\n')).toContain('З1 годность');
    expect(problems.join('\n')).toContain('плоскость «вход»');
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ 2: клетка за пределом 2·(rsz+1)', () => {
    // Клетка 16 при rsz = 7: 16 < 16 ложно. Это ровно строка «rsz=7, %b[16] → авария» замера.
    const problems = windowLawProblems(withFacts({ entryTopCell: 16 }));
    expect(problems.join('\n')).toContain('З2 предел клеток входа');
    expect(law(withFacts({ entryTopCell: 16 }), 'З2 предел клеток входа').holds).toBe(false);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ 3: «ровно четыре» — не «не меньше четырёх»', () => {
    // Шире: 9 − 4 = 5 → SIGKILL. Уже: 7 − 4 = 3 → трап не берётся. Обе стороны обязаны краснеть.
    for (const localWsz of [7, 9, 12]) {
      const problems = windowLawProblems(withFacts({ localWsz }));
      expect(problems.join('\n'), `локальное окно ${String(localWsz)} обязано покраснеть`).toContain(
        'З3 ровно четыре у вызова',
      );
    }
    // И ровно 8 — зелено.
    expect(windowLawProblems(withFacts({ localWsz: 8 }))).toEqual([]);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ 4: бюджет вызываемой неположителен', () => {
    const problems = windowLawProblems(withFacts({ grownWsz: 16, grownWbs: 16 }));
    expect(problems.join('\n')).toContain('З4 бюджет вызываемой');
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ 5: закон 3, применённый К ОКНУ ФУНКЦИИ, — ложное красное', () => {
    // Ровно моя ошибка первого прогона: wsz функции 16 минус CALL_WBS 4 = 12 ≠ 4, и это выглядит
    // нарушением. Но закон 3 живёт в плоскости ЛОКАЛЬНОГО окна: сайт открывает `wbs + 4`.
    const wrongPlane = windowLawProblems(withFacts({ localWsz: ARRAY_WINDOW_WSZ }));
    expect(wrongPlane.join('\n'), 'подстановка окна функции в закон 3 обязана «краснеть»').toContain(
      'З3 ровно четыре у вызова',
    );
    // Смысл контроля: это красное — ОШИБКА ПРИМЕНЕНИЯ, а не дефект дерева. Дерево зелено.
    expect(windowLawProblems(), 'дерево при этом согласовано').toEqual([]);
    // И правильная плоскость считается от кадра, а не от окна функции.
    expect(BASE.localWsz).toBe(BASE.localWbs + 4);
    expect(BASE.localWsz).not.toBe(ARRAY_WINDOW_WSZ);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ 6: дублированная константа разошлась с источником', () => {
    const problems = windowDuplicateProblems();
    expect(problems, 'в дереве дубликаты обязаны совпадать').toEqual([]);
    // Сверка живёт в плоскости ЗНАЧЕНИЙ; форма команд стережётся syscallLocalWindow.test.ts.
    expect(ENTRY_SYSCALL_FRAME.wbs + 4).toBe(BASE.localWsz);
  });
});
