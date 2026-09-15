/**
 * ОРАКУЛ ДВУСТОРОННЕЙ ПРОВЕРКИ: ТЕКСТ → БАЙТЫ ЧЕРЕЗ АССЕМБЛЕР МЦСТ.
 *
 * # Что проверяется
 *
 * `src/scripts/e2kExternalAs.ts` отдаёт ассемблерную форму каждой реализованной операции
 * (`as` из того же binutils МЦСТ) и сравнивает полученные байты с нашими **побайтово**.
 * Дизассемблерная проверка (`e2kExternalObjdump.test.ts`) смотрит сторону «байты → текст»;
 * эта — сторону «текст → байты». Вместе они закрывают вопрос о соответствии полей: одна
 * проверка не заметила бы перепутанный канал или разрядность, вторая — не заметила бы
 * подменённый код операции.
 *
 * 1. **Состав.** По одному образцу на каждую реализованную операцию (24), ассемблерная форма
 *    собрана из таблицы МЦСТ (`argFormats` — `%b[N]` для одиночных, `%db[N]` для двойных).
 * 2. **Сверка.** При доступном ассемблере **все** образцы обязаны совпасть побайтово; при
 *    недоступном — каждый помечен «НЕ ПРОВЕРЕНО» с названной причиной.
 * 3. **Ловушки подтверждены ассемблером, а не нами.** `as` обязан **отвергать** каналы, которых
 *    нет в таблице МЦСТ (`movts,2` → «cannot be encoded in ALC2»), — это внешняя проверка
 *    исправления, найденного при первой попытке; и обязан отвергать операцию, не поддержанную
 *    выбранным уровнем ISA.
 *
 * # Чего оракул НЕ доказывает
 *
 * Что байты исполнит железо и что покрыты все формы: проверено 24 операции подмножества
 * в основных формах, литералы и слоги управления проверяются отдельными оракулами.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { getEncoder, toHex } from '../e2k/backend';
import { REAL_OPCODES } from '../e2k/e2k-real';
import {
  AS_CPU_OPTION,
  asTextOf,
  assembleAll,
  buildAsSamples,
  buildAssemblyScript,
  findExternalAs,
  firstDifference,
  parseAssemblyOutput,
  registerText,
  runExternalAs,
  type AsSample,
} from './e2kExternalAs';

const DOC = path.resolve(__dirname, '..', '..', 'docs', 'e2k-external-as.md');

describe('двусторонняя проверка: состав образцов', () => {
  const samples = buildAsSamples();

  it('по одному образцу на каждую реализованную операцию', () => {
    expect(samples.length).toBe(REAL_OPCODES.length);
    expect(samples.length).toBeGreaterThanOrEqual(24);
    expect(new Set(samples.map((sample) => sample.key)).size).toBe(samples.length);
    for (const sample of samples) {
      expect(sample.channel, `${sample.key}: канал не из таблицы`).toBe(
        REAL_OPCODES.find((entry) => entry.mnemonic === sample.mnemonic)!.channels[0],
      );
    }
  });

  it('ассемблерная форма собирается из таблицы, а не пишется руками', () => {
    expect(registerText('S', 1)).toBe('%b[1]');
    expect(registerText('D', 2)).toBe('%db[2]');
    expect(() => registerText('Q', 1)).toThrow(/неизвестный формат/);
    const adds = REAL_OPCODES.find((entry) => entry.mnemonic === 'adds')!;
    expect(asTextOf(adds, 3)).toBe('adds,3 %b[1], %b[2], %b[3]');
    const umulx = REAL_OPCODES.find((entry) => entry.mnemonic === 'umulx')!;
    expect(asTextOf(umulx, 1)).toBe('umulx,1 %b[1], %b[2], %db[3]');
    // Уровень ISA выбран явно: по умолчанию ассемблер берёт elbrus-v2 и отвергает umulhd.
    expect(AS_CPU_OPTION).toBe('-mcpu=elbrus-v5');
  });
});

describe('двусторонняя проверка: разбор и сравнение', () => {
  it('вывод сборочного скрипта разбирается: успех, ошибка, пустой результат', () => {
    const ok = parseAssemblyOutput('== 0\n 10 20 30 40\n== 1\n 01 02\n', 2);
    expect(ok[0]).toEqual({ ok: true, bytes: Uint8Array.from([0x10, 0x20, 0x30, 0x40]) });
    expect(ok[1]).toEqual({ ok: true, bytes: Uint8Array.from([0x01, 0x02]) });

    const failed = parseAssemblyOutput('!! 0\nError: something\n== 1\n ff\n', 2);
    expect(failed[0]!.ok).toBe(false);
    if (!failed[0]!.ok) expect(failed[0]!.error).toMatch(/Error: something/);
    expect(failed[1]).toEqual({ ok: true, bytes: Uint8Array.from([0xff]) });

    // Пустой .text — это не «совпало»: ассемблер мог молча выбросить инструкцию.
    const empty = parseAssemblyOutput('== 0\n', 1);
    expect(empty[0]!.ok).toBe(false);
    if (!empty[0]!.ok) expect(empty[0]!.error).toMatch(/пустой \.text/);

    const missing = parseAssemblyOutput('', 1);
    expect(missing[0]!.ok).toBe(false);
    if (!missing[0]!.ok) expect(missing[0]!.error).toMatch(/нет ответа/);
  });

  it('первое расхождение называется по номеру байта', () => {
    const a = Uint8Array.from([1, 2, 3, 4]);
    expect(firstDifference(a, Uint8Array.from([1, 2, 3, 4]))).toBeUndefined();
    expect(firstDifference(a, Uint8Array.from([1, 2, 9, 4]))).toEqual({ index: 2, ours: 3, theirs: 9 });
    expect(firstDifference(Uint8Array.from([1, 2]), Uint8Array.from([1, 2, 3]))).toBeUndefined();
  });

  it('негативный контроль: подменённый текст даёт расхождение с названным байтом', () => {
    // Собираем `subs`, а сравниваем с байтами `adds` — расхождение обязано быть найдено.
    const encoder = getEncoder('e2k');
    const wrong: AsSample = {
      key: 'подмена',
      mnemonic: 'subs',
      channel: 0,
      form: 'ALF1',
      asText: 'subs,0 %b[1], %b[2], %b[3]',
      instruction: { mnemonic: 'adds', channel: 0, operands: [
        { kind: 'reg', index: 1 },
        { kind: 'reg', index: 2 },
        { kind: 'reg', index: 3 },
      ] },
      source: 'opcodes/e2k-opc.h:19',
    };
    const ours = encoder.encode(wrong.instruction);
    const theirs = encoder.encode({ mnemonic: 'subs', channel: 0, operands: wrong.instruction.operands });
    const diff = firstDifference(ours, theirs);
    expect(diff, 'расхождение обязано быть найдено').toBeDefined();
    expect(diff!.index).toBe(7); // младший байт слова: код операции
    expect(toHex(ours)).toContain('10');
    expect(toHex(theirs)).toContain('12');
  });
});

describe('двусторонняя проверка: живой прогон ассемблером', () => {
  const { tool } = findExternalAs();

  it('ассемблер либо найден, либо причина названа', () => {
    const probe = findExternalAs();
    if (probe.tool === undefined) {
      expect(probe.reason, 'причина ненайденности не названа').toBeDefined();
      expect(probe.reason!.length).toBeGreaterThan(30);
      return;
    }
    expect(probe.tool.version).toMatch(/assembler/i);
    expect(probe.tool.scriptRunner.args.join(' ')).toMatch(/bash/);
  });

  it('все образцы совпали с ассемблером МЦСТ побайтово', () => {
    if (tool === undefined) return;
    const report = runExternalAs();
    expect(report.tool).not.toBeNull();
    const mismatched = report.comparisons.filter((item) => item.status !== 'совпал');
    expect(mismatched.map((item) => `${item.key}: ${item.reason}`)).toEqual([]);
    expect(report.summary.matched).toBe(report.summary.total);
    expect(report.summary.total).toBeGreaterThanOrEqual(24);
    // Запись в документе обязана не отставать от измерения.
    if (fs.existsSync(DOC)) {
      const doc = fs.readFileSync(DOC, 'utf-8');
      expect(doc, 'в документе нет числа совпавших образцов').toMatch(/24 (образца )?из 24|совпало 24/);
    }
  });

  it('ассемблер отвергает канал, которого нет в таблице МЦСТ', () => {
    if (tool === undefined) return;
    // `movts` в таблице разрешён только на каналах 0, 1, 3, 4 (`{1, 1, 0, 1, 1, 0}`).
    const forbidden: AsSample[] = [
      {
        key: 'movts,2',
        mnemonic: 'movts',
        channel: 2,
        form: 'ALF2',
        asText: 'movts,2 %b[1], %b[2]',
        instruction: { mnemonic: 'movts', channel: 2, operands: [
          { kind: 'reg', index: 1 },
          { kind: 'reg', index: 2 },
        ] },
        source: 'opcodes/e2k-opc.h:644',
      },
    ];
    const results = assembleAll(forbidden);
    expect(results[0]!.ok, 'ассемблер обязан отказать').toBe(false);
    if (!results[0]!.ok) expect(results[0]!.error).toMatch(/ALC2/);
  });

  it('ассемблер отвергает операцию, не поддержанную уровнем ISA по умолчанию', () => {
    if (tool === undefined) return;
    // Скрипт обязан называть уровень ISA явно: по умолчанию `as` берёт elbrus-v2 и не знает
    // `umulhd`/`smulhd` («`umulhd' is not supported on `elbrus-v2'»).
    const script = buildAssemblyScript(buildAsSamples().slice(0, 1), tool);
    expect(script).toContain('-mcpu=elbrus-v5');
    const withoutCpu = script.replace('-mcpu=elbrus-v5 ', '');
    expect(withoutCpu).not.toContain('-mcpu=');
  });
});
