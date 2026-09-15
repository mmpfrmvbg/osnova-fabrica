/**
 * ИЗВЛЕЧЕНИЕ ТЕСТОВЫХ БАЙТОВ e2k ДЛЯ ВНЕШНЕЙ ПРОВЕРКИ.
 *
 * # Зачем
 *
 * Внешней проверки кодировки нет: MCST-objdump и QEMU в этом окружении не собраны
 * (`docs/e2k-qemu-build.md` §2), а компилятора e2k на Compiler Explorer нет
 * (`docs/e2k-external-validation.md` §1). Чтобы внешняя проверка была возможна **позже** —
 * на любой машине, где найдётся подходящий инструмент, — нужен переносимый набор образцов:
 * байты, инструкция, из которой они получены, и её форма.
 *
 * # Что попадает в образец
 *
 * | поле | что это |
 * |---|---|
 * | `mnemonic` | мнемоника e2k — копия из таблицы МЦСТ (`adds`, `movts`, `muls`) |
 * | `form` | форма слога: `ALF1`, `ALF2` или `ALF11` (ALS + ALES) |
 * | `opc` | код операции из таблицы МЦСТ |
 * | `channel` | индекс слога ALS (0…5) |
 * | `operands` | регистры в порядке формы |
 * | `bytes` | байты в виде `0xNN 0xNN …` — то, что можно вставить в дизассемблер |
 * | `hex` | те же байты без префиксов — для машинной сверки |
 * | `size` | длина: 8 (короткая форма) или 16 (длинная) |
 * | `assembly` | документированная ассемблерная форма `мнемоника,канал операнды` (стр. 19) |
 * | `source` | источник кода операции: `файл:строка` |
 *
 * **Образцы не выдуманы:** каждый собирается вызовом `encode` реального бэкенда, а форма и код
 * операции берутся из таблицы `REAL_OPCODES` (`src/e2k/e2k-real.ts`), где у каждой записи стоит
 * источник вида `opcodes/e2k-opc.h:строка`.
 *
 * Использование:
 *   npx tsx src/scripts/extractE2kSamples.ts          # проверить и показать
 *   npx tsx src/scripts/extractE2kSamples.ts --write  # записать .tmp/e2k-samples.json
 */

import * as fs from 'fs';
import * as path from 'path';
import { getEncoder, type AsmInstruction, type Operand } from '../e2k/backend';
import { REAL_OPCODES, realOpcode, type RealForm } from '../e2k/e2k-real';

const ROOT = path.resolve(__dirname, '..', '..');

/** Куда пишутся образцы. `.tmp` не коммитится: это рабочий обмен с внешним инструментом. */
export const SAMPLES_FILE = path.join(ROOT, '.tmp', 'e2k-samples.json');

/** Формат файла образцов — НАШЕ РЕШЕНИЕ (внешнего стандарта нет). */
export const SAMPLES_FORMAT = 'osnova-e2k-samples';

/** Версия формата — НАШЕ РЕШЕНИЕ. */
export const SAMPLES_VERSION = 1;

/** Один образец: инструкция, её форма и полученные байты. */
export interface E2kSample {
  readonly mnemonic: string;
  readonly form: RealForm;
  readonly opc: string;
  readonly channel: number;
  readonly operands: readonly Operand[];
  readonly bytes: string;
  readonly hex: string;
  readonly size: number;
  readonly assembly: string;
  readonly source: string;
}

const reg = (index: number): Operand => ({ kind: 'reg', index });

/**
 * Состав образцов: по одному на каждую форму и ещё несколько, чтобы были разные коды операций,
 * разные каналы и оба размера. Мнемоники и каналы выбраны так, чтобы образец **проходил**
 * кодировщик (у длинной формы источник разрешает каналы 0, 1, 3, 4 — без 2 и 5).
 */
export const SAMPLE_PLAN: ReadonlyArray<{ mnemonic: string; channel: number }> = [
  { mnemonic: 'adds', channel: 0 },
  { mnemonic: 'subs', channel: 3 },
  { mnemonic: 'ands', channel: 5 },
  { mnemonic: 'shls', channel: 1 },
  { mnemonic: 'xors', channel: 2 },
  { mnemonic: 'movts', channel: 0 },
  { mnemonic: 'movtd', channel: 4 },
  { mnemonic: 'muls', channel: 1 },
  { mnemonic: 'umulx', channel: 3 },
  { mnemonic: 'smulhd', channel: 4 },
];

const hexByte = (value: number): string => value.toString(16).padStart(2, '0');

/** Ассемблерная форма: `мнемоника,канал` затем операнды через запятую (стр. 19 руководства). */
function assemblyOf(mnemonic: string, channel: number, operands: readonly Operand[]): string {
  const rendered = operands
    .map((operand) => (operand.kind === 'reg' ? `%r${operand.index}` : `#${operand.value}`))
    .join(', ');
  return `${mnemonic},${channel} ${rendered}`;
}

/**
 * Собрать образцы: каждая инструкция кодируется реальным бэкендом, форма и код операции
 * берутся из его таблицы.
 *
 * @throws если для мнемоники нет записи в таблице или кодирование не состоялось — молча
 *         пропустить образец нельзя: пропуск выглядел бы как «инструкции нет»
 */
export function buildSamples(): E2kSample[] {
  const encoder = getEncoder('e2k');
  return SAMPLE_PLAN.map(({ mnemonic, channel }) => {
    const entry = realOpcode(mnemonic);
    if (entry === undefined) throw new Error(`нет записи в таблице для «${mnemonic}»`);
    const operands: Operand[] = entry.operands.map((_, index) => reg(index + 1));
    const instruction: AsmInstruction = { mnemonic, channel, operands };
    const encoded = encoder.encode(instruction);
    const hex = Array.from(encoded, hexByte).join(' ');
    return {
      mnemonic,
      form: entry.form,
      opc: `0x${entry.opc.toString(16)}`,
      channel,
      operands,
      bytes: Array.from(encoded, (byte) => `0x${hexByte(byte)}`).join(' '),
      hex,
      size: encoded.length,
      assembly: assemblyOf(mnemonic, channel, operands),
      source: entry.source,
    };
  });
}

/** Проверки образцов: пустой список — образцы пригодны для внешней сверки. */
export function validateSamples(samples: readonly E2kSample[]): string[] {
  const problems: string[] = [];
  if (samples.length < 5 || samples.length > 10) {
    problems.push(`образцов ${samples.length}, ожидалось от 5 до 10`);
  }
  const forms = new Set(samples.map((sample) => sample.form));
  for (const form of ['ALF1', 'ALF2', 'ALF11'] as const) {
    if (!forms.has(form)) problems.push(`нет ни одного образца формы ${form}`);
  }
  for (const sample of samples) {
    if (sample.hex.trim() === '') problems.push(`${sample.mnemonic}: пустая hex-строка`);
    const byteCount = sample.hex.trim().split(/\s+/).filter(Boolean).length;
    if (byteCount !== sample.size) {
      problems.push(`${sample.mnemonic}: байт ${byteCount}, заявлено ${sample.size}`);
    }
    if (!/^(0x[0-9a-f]{2} )*0x[0-9a-f]{2}$/.test(sample.bytes)) {
      problems.push(`${sample.mnemonic}: строка байтов «${sample.bytes}» не вида 0xNN 0xNN`);
    }
    if (sample.channel < 0 || sample.channel > 5) {
      problems.push(`${sample.mnemonic}: канал ${sample.channel} вне 0..5`);
    }
    if (!/^opcodes\/e2k-opc\.h:\d+$/.test(sample.source)) {
      problems.push(`${sample.mnemonic}: источник «${sample.source}» не вида opcodes/e2k-opc.h:строка`);
    }
    if (!sample.assembly.includes(`,${sample.channel} `)) {
      problems.push(`${sample.mnemonic}: ассемблерная форма «${sample.assembly}» без номера канала`);
    }
  }
  return problems;
}

/** Документ для записи в `.tmp/e2k-samples.json`. */
export function samplesDocument(samples: readonly E2kSample[]): string {
  return `${JSON.stringify(
    {
      format: SAMPLES_FORMAT,
      version: SAMPLES_VERSION,
      note:
        'Байты получены кодировщиком src/e2k/e2k-real.ts; предназначены для внешней проверки ' +
        'дизассемблером или компилятором. Внешней проверки пока нет: docs/e2k-external-validation.md',
      backend: getEncoder('e2k').description.id,
      instructionSizes: [...new Set(samples.map((sample) => sample.size))].sort((a, b) => a - b),
      samples,
    },
    null,
    2,
  )}\n`;
}

function main(): void {
  const samples = buildSamples();
  const problems = validateSamples(samples);
  for (const sample of samples) {
    console.log(`${sample.mnemonic},${sample.channel} (${sample.form}, ${sample.opc}) ${sample.size} байт: ${sample.bytes}`);
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`ОШИБКА: ${problem}`);
    process.exit(1);
  }
  console.log(`образцов: ${samples.length}; формы: ${[...new Set(samples.map((s) => s.form))].join(', ')}`);
  if (process.argv.includes('--write')) {
    fs.mkdirSync(path.dirname(SAMPLES_FILE), { recursive: true });
    fs.writeFileSync(SAMPLES_FILE, samplesDocument(samples), 'utf-8');
    console.log(`записано: ${path.relative(ROOT, SAMPLES_FILE)}`);
  } else {
    console.log('файл не записан: нужен --write');
  }
}

if (require.main === module) {
  main();
}

/** Мнемоники, которые обязана знать таблица (проверяется оракулом). */
export const SAMPLE_MNEMONICS: readonly string[] = REAL_OPCODES.filter((entry) =>
  SAMPLE_PLAN.some((plan) => plan.mnemonic === entry.mnemonic),
).map((entry) => entry.mnemonic);
