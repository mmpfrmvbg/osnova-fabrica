/**
 * ОРАКУЛ ВНЕШНЕЙ ПРОВЕРКИ ОБРАЗЦОВ e2k.
 *
 * # Что проверяется
 *
 * Внешней проверки нет — компилятора e2k на Compiler Explorer нет
 * (`docs/e2k-external-validation.md` §1), MCST-objdump и QEMU не собраны. Постановка требует
 * другого: чтобы **про каждый образец** было записано либо «совпало / не совпало», либо
 * **явное** «НЕ ПРОВЕРЕНО» с причиной. Тест проверяет именно это, и проверяет по образцам,
 * а не по общим словам:
 *
 * 1. **Каждый образец назван** в документе и имеет ровно один статус.
 * 2. **У «НЕ ПРОВЕРЕНО» есть причина** — не короче фразы, и с указанием, чего не хватает.
 * 3. **Статус «совпало» требует основания**: если строка объявляет совпадение, в ней обязан
 *    быть назван внешний инструмент (id компилятора, `objdump`, `qemu`). Иначе «совпало» —
 *    слово без измерения.
 * 4. **Конвейер запроса к сервису проверен на доступном компиляторе** (не на e2k): повторная
 *    отправка тривиальной C-функции на amd64-компилятор обязана дать `code: 0` и непустой
 *    ассемблер. Без сети тест называет проверку слабой, а не выдаёт её за пройденную.
 *
 * # Негативный контроль
 *
 * Проверяльщик строк прогоняется на подложенном тексте: без строки образца, без статуса,
 * с «совпало» без инструмента.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { buildSamples } from './extractE2kSamples';
import {
  CE_NO_E2K,
  compileOnCompilerExplorer,
  findAmd64Compilers,
} from './compilerExplorer';

const ROOT = path.resolve(__dirname, '..', '..');
const DOC = path.join(ROOT, 'docs', 'e2k-external-validation.md');

/** Статусы, которыми может обладать образец. */
export type SampleStatus = 'совпал' | 'не совпал' | 'НЕ ПРОВЕРЕНО';

/** Разобранная строка таблицы §2.3. */
export interface SampleRecord {
  readonly key: string;
  readonly status: SampleStatus;
  readonly note: string;
}

/** Разобрать строки образцов из документа (`| # | `мнемоника,канал` | форма | байт | байты | статус | основание |`). */
export function parseSampleRecords(doc: string): SampleRecord[] {
  const records: SampleRecord[] = [];
  for (const line of doc.split(/\r?\n/)) {
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length < 8) continue;
    const key = /^`([a-z0-9_]+,\d)`$/.exec(cells[2] ?? '');
    if (key === null) continue;
    const statusCell = (cells[6] ?? '').replace(/\*/g, '');
    const status: SampleStatus | undefined =
      statusCell === 'НЕ ПРОВЕРЕНО' ? 'НЕ ПРОВЕРЕНО' : /^совпал/.test(statusCell) ? 'совпал' : /^не совпал/.test(statusCell) ? 'не совпал' : undefined;
    if (status === undefined) continue;
    records.push({ key: key[1]!, status, note: cells[7] ?? '' });
  }
  return records;
}

/** Проверки записей об образцах: пустой список — про каждый образец записано состояние. */
export function checkSampleRecords(
  keys: readonly string[],
  records: readonly SampleRecord[],
): string[] {
  const problems: string[] = [];
  const byKey = new Map<string, SampleRecord[]>();
  for (const record of records) {
    byKey.set(record.key, [...(byKey.get(record.key) ?? []), record]);
  }
  for (const key of keys) {
    const found = byKey.get(key) ?? [];
    if (found.length === 0) {
      problems.push(`${key}: нет строки в документе — про образец ничего не записано`);
      continue;
    }
    if (found.length > 1) problems.push(`${key}: статус записан ${found.length} раза`);
    const record = found[0]!;
    if (record.status === 'НЕ ПРОВЕРЕНО') {
      if (record.note.length < 20) problems.push(`${key}: «НЕ ПРОВЕРЕНО» без причины`);
    } else if (!/objdump|qemu|gcc|clang|compiler explorer/i.test(record.note)) {
      problems.push(`${key}: объявлено «${record.status}», но внешний инструмент не назван`);
    }
  }
  return problems;
}

describe('внешняя проверка образцов e2k: состояние записано про каждый', () => {
  const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf-8') : '';
  const samples = buildSamples();
  const records = parseSampleRecords(doc);

  it('про каждый из десяти образцов записан статус', () => {
    const keys = samples.map((sample) => `${sample.mnemonic},${sample.channel}`);
    expect(keys.length).toBeGreaterThanOrEqual(5);
    expect(checkSampleRecords(keys, records), `записей разобрано ${records.length}`).toEqual([]);
  });

  it('ни один образец не объявлен проверенным: внешнего инструмента не было', () => {
    const claimed = records.filter((record) => record.status !== 'НЕ ПРОВЕРЕНО');
    // Если однажды появится внешний инструмент и сверка состоится, эта проверка станет
    // красной — и это правильно: тогда документ обязан переписаться вместе с результатом.
    expect(claimed.map((record) => record.key)).toEqual([]);
    expect(doc).toContain(CE_NO_E2K);
  });

  it('конвейер запроса к Compiler Explorer проверен на доступном компиляторе', async () => {
    const candidates = await findAmd64Compilers();
    if (candidates.length === 0) {
      expect(doc).toMatch(/нет доступа|недоступ/i);
      return;
    }
    // Пробуются несколько кандидатов: в списке языка `c` на amd64 есть записи, которые не
    // являются компиляторами C (c2rust и подобные) — их падение не означает, что конвейер сломан.
    const attempts: string[] = [];
    for (const compilerId of candidates) {
      const result = await compileOnCompilerExplorer(compilerId, 'int f(int a,int b){return a+b;}');
      attempts.push(`${compilerId}: ${result.problem ?? `code ${String(result.code)}`}`);
      if (result.ok) {
        expect(result.code, compilerId).toBe(0);
        expect(result.asm?.length ?? 0).toBeGreaterThan(0);
        // Документ обязан называть эту проверку именно как проверку конвейера, не как проверку e2k.
        expect(doc).toContain('caocc320');
        expect(doc).toMatch(/конвейер запроса/i);
        return;
      }
    }
    throw new Error(`ни один компилятор не собрал исходник: ${attempts.join('; ')}`);
  });

  it('негативный контроль: незаписанный образец, статус без причины, «совпало» без инструмента', () => {
    const keys = ['adds,0', 'muls,1'];
    const healthy: SampleRecord[] = [
      { key: 'adds,0', status: 'НЕ ПРОВЕРЕНО', note: 'компилятора e2k на Compiler Explorer нет' },
      { key: 'muls,1', status: 'НЕ ПРОВЕРЕНО', note: 'внешнего инструмента с поддержкой e2k нет' },
    ];
    expect(checkSampleRecords(keys, healthy)).toEqual([]);

    expect(checkSampleRecords(keys, healthy.slice(0, 1)).join(' ')).toMatch(/нет строки/);

    const silent = [{ ...healthy[0]!, note: 'нет' }, healthy[1]!];
    expect(checkSampleRecords(keys, silent).join(' ')).toMatch(/без причины/);

    const claimed = [{ ...healthy[0]!, status: 'совпал' as const, note: 'похоже' }, healthy[1]!];
    expect(checkSampleRecords(keys, claimed).join(' ')).toMatch(/внешний инструмент не назван/);

    const doubled = [healthy[0]!, healthy[0]!, healthy[1]!];
    expect(checkSampleRecords(keys, doubled).join(' ')).toMatch(/записан 2 раза/);
  });
});
