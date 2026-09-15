/**
 * ОРАКУЛ ОБРАЗЦОВ e2k ДЛЯ ВНЕШНЕЙ ПРОВЕРКИ.
 *
 * # Что проверяется
 *
 * Набор образцов (`src/scripts/extractE2kSamples.ts`) — переносимое доказательство для внешней
 * сверки: байты, инструкция и её форма. Если образцы неверны, внешняя проверка проверит не то.
 *
 * 1. **Состав.** Образцов 5–10; представлены **все три формы** (`ALF1`, `ALF2`, `ALF11`) и оба
 *    размера (8 и 16 байт).
 * 2. **Байты не выдуманы.** Для каждого образца байты заново берутся у кодировщика, и проверяется,
 *    что образец их воспроизводит; `decode` возвращает ту же инструкцию (круговорот на образце).
 * 3. **Запись не разошлась с генератором.** Если `.tmp/e2k-samples.json` есть, он обязан
 *    совпадать с `buildSamples()`; если его нет — проверка слабая, и это названо.
 * 4. **Негативный контроль.** Проверяльщик обязан поймать пустую hex-строку, неверный размер
 *    и пропавшую форму.
 *
 * # Чего оракул НЕ доказывает
 *
 * Что байты верны для e2k: внешней проверки нет — компилятора e2k на Compiler Explorer нет
 * (`docs/e2k-external-validation.md` §1), MCST-objdump и QEMU не собраны.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import { getEncoder, sameInstruction, type AsmInstruction } from '../e2k/backend';
import { realOpcode } from '../e2k/e2k-real';
import {
  SAMPLES_FILE,
  SAMPLES_FORMAT,
  SAMPLES_VERSION,
  buildSamples,
  samplesDocument,
  validateSamples,
  type E2kSample,
} from './extractE2kSamples';

const encoder = getEncoder('e2k');
const samples = buildSamples();

describe('образцы e2k: состав и байты', () => {
  it('образцов 5–10, представлены все три формы и оба размера', () => {
    expect(validateSamples(samples)).toEqual([]);
    expect(samples.length).toBeGreaterThanOrEqual(5);
    expect(samples.length).toBeLessThanOrEqual(10);
    expect([...new Set(samples.map((sample) => sample.form))].sort()).toEqual(['ALF1', 'ALF11', 'ALF2']);
    expect([...new Set(samples.map((sample) => sample.size))].sort((a, b) => a - b)).toEqual([8, 16]);
  });

  it('байты каждого образца воспроизводятся кодировщиком и читаются обратно', () => {
    for (const sample of samples) {
      const instruction: AsmInstruction = {
        mnemonic: sample.mnemonic,
        channel: sample.channel,
        operands: sample.operands,
      };
      const encoded = encoder.encode(instruction);
      const hex = Array.from(encoded, (byte) => byte.toString(16).padStart(2, '0')).join(' ');
      expect(hex, `${sample.mnemonic}: hex расходится с кодировщиком`).toBe(sample.hex);
      expect(encoded.length, `${sample.mnemonic}: размер`).toBe(sample.size);
      const back = encoder.decode(encoded);
      expect(sameInstruction(back, instruction), `${sample.mnemonic}: круговорот`).toBe(true);
    }
  });

  it('форма и код операции образца совпадают с таблицей реального бэкенда', () => {
    for (const sample of samples) {
      const entry = realOpcode(sample.mnemonic);
      expect(entry, `${sample.mnemonic}: нет записи в таблице`).toBeDefined();
      expect(sample.form, `${sample.mnemonic}: форма`).toBe(entry!.form);
      expect(sample.opc, `${sample.mnemonic}: код операции`).toBe(`0x${entry!.opc.toString(16)}`);
      expect(sample.source, `${sample.mnemonic}: источник`).toBe(entry!.source);
    }
  });

  it('ассемблерная форма пригодна для внешнего инструмента', () => {
    for (const sample of samples) {
      expect(sample.assembly, `${sample.mnemonic}`).toMatch(/^[a-z0-9_]+,\d /);
      expect(sample.assembly, `${sample.mnemonic}`).toContain(`%r1`);
    }
  });

  it('запись .tmp/e2k-samples.json не разошлась с генератором', () => {
    if (!fs.existsSync(SAMPLES_FILE)) {
      // Слабая проверка: файла нет. Он не коммитится (.tmp), поэтому это законное состояние;
      // слабость названа, а не замалчена.
      expect(samplesDocument(samples)).toContain(SAMPLES_FORMAT);
      return;
    }
    const written = JSON.parse(fs.readFileSync(SAMPLES_FILE, 'utf-8')) as {
      format: string;
      version: number;
      samples: E2kSample[];
    };
    expect(written.format).toBe(SAMPLES_FORMAT);
    expect(written.version).toBe(SAMPLES_VERSION);
    expect(written.samples).toEqual(samples);
  });

  it('негативный контроль: испорченный образец ловится', () => {
    const healthy = samples[0]!;
    expect(validateSamples([healthy])).not.toEqual([]); // одного образца мало — уже нарушение

    const base = samples.map((sample) => ({ ...sample }));
    expect(validateSamples(base)).toEqual([]);

    const emptyHex = base.map((sample, index) => (index === 0 ? { ...sample, hex: '' } : sample));
    expect(validateSamples(emptyHex).join(' ')).toMatch(/пустая hex-строка/);

    const wrongSize = base.map((sample, index) => (index === 0 ? { ...sample, size: 7 } : sample));
    expect(validateSamples(wrongSize).join(' ')).toMatch(/байт 8, заявлено 7/);

    const badBytes = base.map((sample, index) => (index === 0 ? { ...sample, bytes: '0110' } : sample));
    expect(validateSamples(badBytes).join(' ')).toMatch(/не вида 0xNN/);

    const noAlf11 = base.filter((sample) => sample.form !== 'ALF11');
    expect(validateSamples(noAlf11).join(' ')).toMatch(/нет ни одного образца формы ALF11/);

    const tooMany = [...base, { ...base[0]!, mnemonic: 'adds' }];
    expect(validateSamples(tooMany).join(' ')).toMatch(/ожидалось от 5 до 10/);
  });
});
