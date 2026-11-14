/**
 * ОРАКУЛ СТОРОЖА ЗОНДА D12 — проба блока рантайма массивов против системного вызова.
 *
 * Предмет — `src/scripts/d12Probe.audit.ts`. Он держит в репозитории ПРИБОР, которым §3.187 был
 * превращён из «тихой лжи» в названный механизм. Дефект: на модели всё зелено, на цели число
 * неверное, отказов ноль (случай 52 реестра проверяемости).
 *
 * # Негативные контроли и их имена
 *
 * | N | что ломается | что обязано покраснеть |
 * |---|---|---|
 * | **1** | проба читает не ту клетку, что закреплена за её именем | «ответ приписан не той клетке» |
 * | **2** | из пробы убран холостой вызов `write` (осталс�� только `exit`) | «вызовов 1, а должно 2» |
 * | **3** | из отчёта убран контроль `b14-nowrite` | «контроль без вызова отсутствует» |
 * | **4** | контроль вернул 0 (проба читает не ту клетку) | «контроль вернул 0» |
 * | **5** | клетка блока не помечена (блок рантайма задан не полностью) | «клетка %b[N] не помечена» |
 * | **6** | каталог зонда отсутствует целиком | «прибор отсутствует в репозитории» |
 *
 * Шесть контролей — на шесть разных утверждений. Один контроль на сторож, у которого шесть
 * утверждений, доказывал бы, что работает одна шестая.
 */

import { describe, it, expect } from 'vitest';
import {
  D12_CELLS,
  D12_DIR,
  D12_GATE_CODE,
  D12_PROBES,
  D12_REPORT,
  auditCellRoles,
  auditD12Dir,
  auditProbeReport,
  auditProbeSource,
} from './d12Probe.audit';
import { ARRAY_REGISTERS } from '../e2k/arrayRuntime';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');

/** Минимальная исправная проба: блок целиком, один вызов, чтение своей клетки. */
function probeSource(cell: number, calls = 2): string {
  const lines = [
    '\t.text',
    '_start:',
    '\tsetwd wsz = 0x10',
    '\tsetbn rbs = 0x0, rsz = 0x7, rcur = 0x0',
    '\tmovts,0 0x0, %b[12]',
    '\tmovts,0 0x1, %b[13]',
    '\tmovts,0 0x8, %b[14]',
    '\tmovts,0 0x11, %b[15]',
  ];
  for (let i = 0; i < calls - 1; i += 1) {
    lines.push('\tmovts,0 0x4, %r8', '\tcall %ctpr1, wbs = 0x4');
  }
  lines.push(
    '\tmovts,0 0x0, %b[11]',
    `\tadds,0 %b[${String(cell)}], %b[11], %r9`,
    '\tcall %ctpr1, wbs = 0x4',
  );
  return lines.join('\n');
}

describe('зонд D12: разбор одной пробы', () => {
  it('исправная проба: блок целиком, два вызова, читается своя клетка', () => {
    const audit = auditProbeSource('probe-b14.s', probeSource(14));
    expect(audit.read).toBe(14);
    expect(audit.calls).toBe(2);
    for (const { cell } of D12_CELLS) expect(audit.written).toContain(cell);
    expect(audit.problems).toEqual([]);
  });

  it('контроль: один вызов (только exit) — и это НЕ нарушение', () => {
    // Ровно то, на чём покраснела первая редакция сторожа: «нет вызова» проверить нельзя,
    // потому что без exit значение не вернуть вовсе.
    const audit = auditProbeSource('probe-b14-nowrite.s', probeSource(14, 1));
    expect(audit.calls).toBe(1);
    expect(audit.read).toBe(14);
    expect(audit.problems).toEqual([]);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ 5: клетка блока не помечена — красное, номер назван', () => {
    const broken = probeSource(14).replace('\tmovts,0 0x8, %b[14]\n', '');
    const audit = auditProbeSource('probe-b14.s', broken);
    expect(audit.problems.length).toBeGreaterThan(0);
    const joined = audit.problems.join('\n');
    expect(joined).toContain(D12_GATE_CODE);
    expect(joined, 'номер клетки назван').toMatch(/%b\[14\]/);
    expect(joined, 'сказано, что блок неполон').toMatch(/не помечена/);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: проба без чтения клетки краснеет', () => {
    const broken = probeSource(14).replace(/\tadds,0 %b\[14\], %b\[11\], %r9\n/u, '');
    const audit = auditProbeSource('probe-b14.s', broken);
    expect(audit.read).toBeNull();
    expect(audit.problems.join('\n')).toMatch(/не найдено чтение клетки/);
  });

  it('комментарии не считаются ни записью, ни чтением', () => {
    // В пробах комментарии кириллицей и содержат `%b[12..15]`; если бы разбор их читал,
    // «записано» совпало бы с «упомянуто», и проба без единой команды прошла бы проверку.
    const onlyComments = ['# movts,0 0x8, %b[14]', '# adds,0 %b[14], %b[11], %r9'].join('\n');
    const audit = auditProbeSource('probe-b14.s', onlyComments);
    expect(audit.read).toBeNull();
    expect(audit.written).toEqual([]);
    expect(audit.calls).toBe(0);
  });
});

describe('зонд D12: разбор отчёта прогона', () => {
  const GOOD = [
    'host: a1d3a4a788e9 / e2k / 6.1.0-0.8-e8c2',
    'exit(b12) = 0',
    'exit(b13) = 0',
    'exit(b14) = 0',
    'exit(b15) = 0',
    'exit(b14-nowrite) = 8',
  ].join('\n');

  it('исправный отчёт: пять замеров, один контроль, ноль нарушений', () => {
    const audit = auditProbeReport(GOOD);
    expect(audit.codes.get('b12')).toBe(0);
    expect(audit.codes.get('b15')).toBe(0);
    expect(audit.codes.get('b14-nowrite')).toBe(8);
    expect(audit.controls).toEqual(['b14-nowrite']);
    expect(audit.problems).toEqual([]);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ 3: контроль убран из отчёта — красное', () => {
    const broken = GOOD.split('\n')
      .filter((line) => !line.includes('nowrite'))
      .join('\n');
    const audit = auditProbeReport(broken);
    expect(audit.controls).toEqual([]);
    expect(audit.problems.join('\n')).toMatch(/нет КОНТРОЛЯ без системного вызова/);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ 4: контроль вернул 0 — красное, имя названо', () => {
    // Если проба «без вызова» тоже даёт 0, она читает не ту клетку, которую записала —
    // и тогда четыре нуля в отчёте не значат ничего.
    const broken = GOOD.replace('exit(b14-nowrite) = 8', 'exit(b14-nowrite) = 0');
    const audit = auditProbeReport(broken);
    expect(audit.problems.join('\n')).toMatch(/b14-nowrite/);
    expect(audit.problems.join('\n')).toMatch(/НЕ ту клетку/);
  });

  it('пустой отчёт — не замер, а его отсутствие', () => {
    const audit = auditProbeReport('host: x\nникто ничего не мерил\n');
    expect(audit.codes.size).toBe(0);
    expect(audit.problems.join('\n')).toMatch(/это не замер/);
  });
});

describe('зонд D12: настоящий каталог в репозитории', () => {
  const audit = auditD12Dir();

  it('каталог на месте, все пять проб разобраны, нарушений ноль', () => {
    expect(fs.existsSync(path.join(ROOT, D12_DIR)), `${D12_DIR} существует`).toBe(true);
    expect(audit.problems, audit.problems.join('\n')).toEqual([]);
    expect(audit.probes).toHaveLength(5);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ 1: имя пробы совпадает с читаемой клеткой', () => {
    // Проба probe-b14.s, читающая %b[15], дала бы «0» и это «0» приписали бы %b[14].
    for (const probe of D12_PROBES) {
      const found = audit.probes.find((p) => p.file === probe.file);
      expect(found, `${probe.file} разобран`).toBeDefined();
      expect(found?.read, `${probe.file} читает свою клетку`).toBe(probe.reads);
    }
    // И закреплено именно то, что было измерено: 12/13/14/15 → 0 и контроль 14 → 8.
    expect(D12_PROBES.map((p) => p.reads)).toEqual([12, 13, 14, 15, 14]);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ 2: у вопроса два вызова, у контроля один', () => {
    const question = audit.probes.filter((p) => p.calls === 2);
    const control = audit.probes.filter((p) => p.calls === 1);
    expect(question.length, 'проб-вопросов (write + exit)').toBe(4);
    expect(control.map((p) => p.file), 'проба-контроль (только exit)').toEqual([
      'probe-b14-nowrite.s',
    ]);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ 6: прибор лежит В РЕПОЗИТОРИИ, а не в .tmp', () => {
    // Смысл всего сторожа: проба, оставшаяся в `.tmp`, исчезает при первой уборке, и
    // единственный прибор, РАЗЛИЧАЮЩИЙ модель и цель, пропадает молча.
    const dir = path.join(ROOT, D12_DIR);
    expect(D12_DIR.startsWith('.tmp'), 'каталог зонда не во временных файлах').toBe(false);
    for (const probe of D12_PROBES) {
      expect(fs.existsSync(path.join(dir, probe.file)), `${probe.file} в репозитории`).toBe(true);
    }
    expect(fs.existsSync(path.join(dir, D12_REPORT)), `${D12_REPORT} в репозитории`).toBe(true);
    // И он НЕ в .tmp: git видит файлы как отслеживаемые либо готовые к добавлению.
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('замер в отчёте — тот, который записан в реестр железа', () => {
    // Четыре клетки прочитаны после системного вызова и дали 0; контроль без вызова дал 8.
    // Если отчёт подменят, оракул это назовёт — ожидание не выводится из отчёта, а закреплено.
    const report = audit.report;
    expect(report, 'отчёт разобран').not.toBeNull();
    expect(report?.codes.get('b12')).toBe(0);
    expect(report?.codes.get('b13')).toBe(0);
    expect(report?.codes.get('b14')).toBe(0);
    expect(report?.codes.get('b15')).toBe(0);
    expect(report?.codes.get('b14-nowrite')).toBe(8);
    expect(report?.controls).toEqual(['b14-nowrite']);
  });

  it('контроль НАЗВАН ровно один — и это правда о замере, а не о желании', () => {
    // §3.187.1 показывает в колонке «контроль БЕЗ вызова» четыре значения (0/1/8/17), но отчёт
    // прогона 2026-11-08 записал ТОЛЬКО exit(b14-nowrite) = 8. Сторож держит записанное, а
    // расхождение с таблицей дока названо в шапке модуля — сглаживать его он не имеет права.
    expect(audit.report?.controls.length).toBe(1);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ 7: клетки пробы сверены с РОЛЯМИ в коде', () => {
    // Класс случая 27: код переселил роль в другую клетку, зонд меряет старую, и оба файла
    // «согласованы». Сверка с настоящим `ARRAY_REGISTERS` — единственное, что это ловит.
    //
    // Берётся `ARRAY_REGISTERS`, а не `ENTRY_ARRAY_CELLS`: адрес ячейки кучи (`heapSlot`) живёт
    // ТОЛЬКО в первом (`ENTRY_ARRAY_CELLS` = zero/one/eight/scratch/scratch2, §3.136: указатель
    // кучи уехал в память, а `%b[15]` несёт её адрес). Зонд меряет все четыре роли плоскости —
    // значит сверять надо с тем объединением, которое их все и называет.
    const ok = auditCellRoles(D12_CELLS, ARRAY_REGISTERS);
    expect(ok.problems, ok.problems.join('\n')).toEqual([]);

    // А теперь сдвинем роль на одну клетку — как если бы код сделал это молча.
    const drifted = auditCellRoles(D12_CELLS, { ...ARRAY_REGISTERS, eight: 15 });
    expect(drifted.problems.length, 'сдвиг роли краснеет').toBe(1);
    expect(drifted.problems.join('\n')).toContain(D12_GATE_CODE);
    expect(drifted.problems.join('\n')).toMatch(/%b\[15\]/);
    expect(drifted.problems.join('\n')).toMatch(/%b\[14\]/);

    // И пропавшая роль — тоже красное, а не «пропущено»: молчание здесь было бы согласием.
    const missing = auditCellRoles(D12_CELLS, { zero: 12, one: 13, eight: 14 });
    expect(missing.problems.join('\n')).toMatch(/не найдена в ENTRY_ARRAY_CELLS/);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ 8: сверка идёт с ОБЪЕДИНЕНИЕМ ролей, а не с клетками входа', () => {
    // Замер, который это закрепил: `ENTRY_ARRAY_CELLS` НЕ содержит `heapSlot`, поэтому сверка с
    // ним краснела бы на исправном зонде — ложное красное, которое снимают первым же PR
    // (случай 31). Проверено: роли расходятся между двумя таблицами, и это ожидаемо.
    expect(Object.keys(ARRAY_REGISTERS)).toContain('heapSlot');
    const drift = auditCellRoles(D12_CELLS, ARRAY_REGISTERS);
    expect(drift.problems).toEqual([]);
  });
});
