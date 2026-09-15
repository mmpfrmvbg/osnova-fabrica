/**
 * ОРАКУЛ ОТОБРАЖЕНИЯ «НОСИТЕЛЬ IR → КЛАСС ЗАДЕРЖКИ».
 *
 * # Что проверяется
 *
 * 1. **Полнота.** Каждый носитель из кода оболочки (`IR_CARRIERS` в `src/e2k/shell.ts`)
 *    либо отображён на класс, либо помечен «НЕТ КЛАССА» с причиной.
 * 2. **Чистота.** В таблице нет носителей, которых в коде нет. Отдельно названы носители,
 *    которые упоминает задание, но которых в оболочке не существует (`IR.load`, `IR.store`):
 *    проверка ищет их **и** в коде, **и** в таблице, и требует отсутствия в обеих.
 * 3. **Источник.** У каждого отображения указан источник (`ПО ПРИРОДЕ` / `НАШЕ РЕШЕНИЕ` /
 *    `НЕТ КЛАССА`), ссылка на документ и — для неочевидных — обоснование.
 * 4. **Согласие с моделью.** Латентность каждого отображённого носителя равна строке модели
 *    (`src/vliw/e2kDevices.ts`, таблица стр. 71–72). Расхождение — падение, а не «почти».
 * 5. **Класс без носителей назван явно.** `MEM` объявлен, но носителей у него нет: чтения и
 *    записи памяти в IR оболочки не существует. Молчать об этом нельзя — иначе отсутствие
 *    `MEM` выглядело бы как забытый класс.
 *
 * # Оракул написан ДО реализации
 *
 * Правило проекта «оракул раньше кода»: этот файл внесён отдельным коммитом, до появления
 * `src/e2k/latencyMap.ts`, и на том коммите прогон красный (модуля нет).
 */

import { describe, it, expect } from 'vitest';
import { IR_CARRIERS } from './shell';
import { CARRIER_OF_OP } from './emitterShell';
import { latencyFor, opClassOf } from '../vliw/e2kDevices';
import {
  CARRIERS_ABSENT_FROM_SHELL,
  CLASS_LATENCY,
  LATENCY_CLASSES,
  LATENCY_MAP,
  LATENCY_MAP_PASSPORT,
  classlessCarriers,
  latencyEntry,
  usedClasses,
} from './latencyMap';

/** Обратное соответствие «носитель → операция IR» (та же таблица, что у эмиттера). */
const OP_OF_CARRIER: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(CARRIER_OF_OP).map(([op, carrier]) => [carrier, op]),
);

/** Источники, допустимые в таблице. */
const SOURCES = ['ПО ПРИРОДЕ', 'НАШЕ РЕШЕНИЕ', 'НЕТ КЛАССА'];

/** Как симулятор обходится с носителем без класса. */
const BEHAVIORS = ['считать за 1 такт', 'игнорировать', 'останавливаться'];

describe('latencyMap: полнота и чистота', () => {
  it('каждый носитель оболочки отображён или помечен «НЕТ КЛАССА»', () => {
    const missing = Object.keys(IR_CARRIERS).filter(
      (carrier) => LATENCY_MAP[carrier] === undefined,
    );
    expect(missing, `носители без записи в таблице: ${missing.join(', ')}`).toEqual([]);
  });

  it('в таблице нет носителей, которых нет в коде', () => {
    const extra = Object.keys(LATENCY_MAP).filter(
      (carrier) => IR_CARRIERS[carrier] === undefined,
    );
    expect(extra, `в таблице есть то, чего нет в оболочке: ${extra.join(', ')}`).toEqual([]);
  });

  it('ИМЕНОВАННЫЕ В ЗАДАНИИ IR.load и IR.store в оболочке отсутствуют и в таблицу не внесены', () => {
    for (const carrier of ['IR.load', 'IR.store']) {
      expect(IR_CARRIERS[carrier], `${carrier} оказался в коде оболочки`).toBeUndefined();
      expect(LATENCY_MAP[carrier], `${carrier} оказался в таблице`).toBeUndefined();
      const reason = CARRIERS_ABSENT_FROM_SHELL[carrier];
      expect(reason, `${carrier}: отсутствие не объяснено`).toBeTruthy();
      expect((reason ?? '').length, `${carrier}: объяснение короче фразы`).toBeGreaterThan(20);
    }
  });

  it('число записей таблицы равно числу носителей оболочки', () => {
    expect(Object.keys(LATENCY_MAP).length).toBe(Object.keys(IR_CARRIERS).length);
  });
});

describe('latencyMap: источник у каждого отображения', () => {
  it('источник назван и входит в известный набор', () => {
    for (const [carrier, entry] of Object.entries(LATENCY_MAP)) {
      expect(SOURCES, `${carrier}: источник «${entry.source}»`).toContain(entry.source);
      expect(entry.sourceRef.length, `${carrier}: нет ссылки на источник`).toBeGreaterThan(10);
    }
  });

  it('«НАШЕ РЕШЕНИЕ» и «НЕТ КЛАССА» несут обоснование', () => {
    for (const [carrier, entry] of Object.entries(LATENCY_MAP)) {
      if (entry.source === 'ПО ПРИРОДЕ') continue;
      expect(entry.reason.length, `${carrier}: нет обоснования`).toBeGreaterThan(20);
    }
  });

  it('«НЕТ КЛАССА»: класса нет, поведение названо, список непуст', () => {
    const bare = classlessCarriers();
    expect(bare.length, 'ни одного носителя без класса').toBeGreaterThan(0);
    for (const entry of bare) {
      expect(entry.latencyClass, `${entry.carrier}: класс указан при источнике НЕТ КЛАССА`).toBeNull();
      expect(entry.source).toBe('НЕТ КЛАССА');
      expect(BEHAVIORS, `${entry.carrier}: поведение «${entry.behavior}»`).toContain(entry.behavior);
      expect(Number.isInteger(entry.latency) && entry.latency >= 0, `${entry.carrier}: такты`).toBe(
        true,
      );
    }
  });

  it('у носителя с классом источник не «НЕТ КЛАССА»', () => {
    for (const [carrier, entry] of Object.entries(LATENCY_MAP)) {
      if (entry.latencyClass === null) continue;
      expect(LATENCY_CLASSES, `${carrier}: класс «${entry.latencyClass}»`).toContain(
        entry.latencyClass,
      );
      expect(entry.source, `${carrier}: класс есть, а источник «НЕТ КЛАССА»`).not.toBe('НЕТ КЛАССА');
      expect(Number.isInteger(entry.latency) && entry.latency > 0, `${carrier}: такты`).toBe(true);
    }
  });
});

describe('latencyMap: согласие с моделью задержек', () => {
  it('латентность каждого отображённого носителя равна строке модели (стр. 71–72)', () => {
    for (const [carrier, entry] of Object.entries(LATENCY_MAP)) {
      if (entry.latencyClass === null) continue;
      const op = OP_OF_CARRIER[carrier];
      expect(op, `${carrier}: нет операции IR — отображение нечем сверить`).toBeTruthy();
      const fromModel = latencyFor(opClassOf(op!));
      expect(entry.latency, `${carrier}: ${entry.latency} против модели ${fromModel}`).toBe(
        fromModel,
      );
    }
  });

  it('номинальная латентность классов взята из строк модели', () => {
    expect(CLASS_LATENCY.ALU).toBe(latencyFor('int'));
    expect(CLASS_LATENCY.MUL).toBe(latencyFor('fp'));
    expect(CLASS_LATENCY.MEM).toBe(latencyFor('ld_l1'));
    expect(CLASS_LATENCY.BRANCH).toBe(latencyFor('disp_to_ct'));
    for (const cls of LATENCY_CLASSES) {
      expect(Number.isFinite(CLASS_LATENCY[cls]), `класс ${cls} без латентности`).toBe(true);
    }
  });

  it('класс MEM объявлен, но носителей у него нет — и это сказано, а не умолчано', () => {
    expect(LATENCY_CLASSES).toContain('MEM');
    expect(usedClasses()).not.toContain('MEM');
    // Носителей памяти в IR нет вовсе: ни чтения, ни записи.
    const memory = Object.entries(LATENCY_MAP).filter(([, entry]) => entry.latencyClass === 'MEM');
    expect(memory.map(([carrier]) => carrier)).toEqual([]);
  });
});

describe('latencyMap: обращения к таблице', () => {
  it('latencyEntry возвращает запись, ticks и класс', () => {
    for (const carrier of Object.keys(IR_CARRIERS)) {
      const entry = latencyEntry(carrier);
      expect(entry.carrier).toBe(carrier);
      expect(Number.isInteger(entry.latency)).toBe(true);
    }
  });

  it('неизвестное имя отвергается, а не превращается в ноль', () => {
    expect(() => latencyEntry('IR.нет-такого')).toThrow(/нет-такого/);
  });

  it('паспорт таблицы: статус ДОПУЩЕНИЕ и оговорка о железе', () => {
    expect(LATENCY_MAP_PASSPORT.status).toBe('ДОПУЩЕНИЕ');
    expect(LATENCY_MAP_PASSPORT.limitation).toMatch(/не валидировано/);
    expect(LATENCY_MAP_PASSPORT.source).toMatch(/vliw-e2k-model|e2kDevices/);
  });
});
