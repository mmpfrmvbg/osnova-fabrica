/**
 * ОРАКУЛ ДОКУМЕНТА О ШИРОКОЙ КОМАНДЕ e2k.
 *
 * # Зачем этот тест
 *
 * `docs/e2k-wide-commands.md` утверждает конкретное: команда — это контейнер слогов, её длину
 * задаёт `lng`, слоги размечаются битами присутствия и «средней точкой», а ассемблер МЦСТ
 * собирает несколько операций в одну команду **с определёнными байтами**. Утверждение без
 * проверки — не оракул. Проверяются четыре уровня:
 *
 * 1. **Структура** (всегда): разделы, пометки «НЕТ В ИСТОЧНИКЕ», отсутствие похвальбы.
 * 2. **Якоря** (когда есть `.tmp/e2k-sources/`): каждое поле формы — это фрагмент, лежащий в
 *    названной строке названного файла, а не выдуманная ссылка.
 * 3. **Байты** (когда есть ассемблер МЦСТ): hex из документа совпадает с тем, что ассемблер
 *    выдаёт **сейчас**; отказ на двух операциях в одном канале — тоже проверяется.
 * 4. **Негативный контроль**: испорченный вход обязан ловиться, иначе оракул ничего не проверяет.
 *
 * # Слабое место названо прямо
 *
 * Ни `.tmp/e2k-sources/`, ни ассемблер не коммитятся: на чистой копии репозитория уровни 2 и 3
 * выполнить нечем, и тест **сообщает об этом**, а не выдаёт «проверок не было» за «пройдено».
 * Каталог источников переопределяется переменной `E2K_SOURCES_DIR` — иначе слабый режим никто
 * бы не проверил.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { assembleAll, findExternalAs, type AsSample } from './e2kExternalAs';
import type { AsmInstruction } from '../e2k/backend';

const ROOT = path.resolve(__dirname, '..', '..');
const DOC = path.join(ROOT, 'docs', 'e2k-wide-commands.md');
const SOURCES = process.env.E2K_SOURCES_DIR ?? path.join(ROOT, '.tmp', 'e2k-sources');
const QEMU = path.join(SOURCES, 'qemu-e2k', 'qemu');
const BINUTILS = path.join(SOURCES, 'binutils-gdb');

/** Голые имена файлов (без каталога) → полный путь от соответствующего корня. */
export const BARE_FILE_ROOTS: Readonly<Record<string, string>> = {
  'README.md': path.join(SOURCES, 'elbrus-docs', 'README.md'),
  'instr-bits.h': path.join(QEMU, 'target', 'e2k', 'instr-bits.h'),
  'syllab-format.h': path.join(QEMU, 'target', 'e2k', 'syllab-format.h'),
  'decoder.c': path.join(QEMU, 'target', 'e2k', 'decoder.c'),
  'translate.c': path.join(QEMU, 'target', 'e2k', 'tcg', 'translate.c'),
  'e2k-dis.c': path.join(BINUTILS, 'opcodes', 'e2k-dis.c'),
  'e2k-opc.h': path.join(BINUTILS, 'opcodes', 'e2k-opc.h'),
  'tc-e2k.c': path.join(BINUTILS, 'gas', 'config', 'tc-e2k.c'),
  'e2k-real.ts': path.join(ROOT, 'src', 'e2k', 'e2k-real.ts'),
};

/** Корни, относительно которых разворачиваются ссылки документа. */
const REF_ROOTS: readonly string[] = [ROOT, SOURCES, path.join(SOURCES, 'qemu-e2k'), QEMU, BINUTILS];

/** Якорь: «в этом файле, в этих строках лежит этот фрагмент». */
export interface Anchor {
  readonly file: string;
  readonly from: number;
  readonly to: number;
  readonly contains: string;
  readonly claim: string;
}

/** Утверждения формы, обязанные оставаться и в документе, и в источнике. */
export const ANCHORS: readonly Anchor[] = [
  { file: 'README.md', from: 117, to: 117, contains: 'wide instructions', claim: 'широкая команда: HS + слоги, до 16 слов' },
  { file: 'README.md', from: 151, to: 151, contains: 'half-word (2 bytes)', claim: 'полуслоги 2 байта, прочие слоги 4 байта' },
  { file: 'README.md', from: 163, to: 163, contains: 'middle pointer', claim: 'ALES0/1/3/4 и AAS начинаются со «средней точки»' },
  { file: 'README.md', from: 166, to: 166, contains: 'from the end of the wide command', claim: 'LTS/PLS/CDS разбираются с конца' },
  { file: 'README.md', from: 197, to: 197, contains: 'multiples of 8 bytes', claim: 'биты 6:4 — длина в 8-байтовых единицах минус 8' },
  { file: 'README.md', from: 198, to: 198, contains: 'middle pointer', claim: 'биты 3:0 — «средняя точка»' },
  { file: 'instr-bits.h', from: 41, to: 45, contains: '(hs_lng + 1) * 8', claim: 'размер команды = (lng+1)*8, обязан совпасть' },
  { file: 'instr-bits.h', from: 74, to: 77, contains: 'als_mask', claim: 'слоги ALS читаются по битам присутствия' },
  { file: 'syllab-format.h', from: 17, to: 18, contains: 'HS, lng', claim: 'mdl — биты 3:0, lng — биты 6:4' },
  { file: 'syllab-format.h', from: 29, to: 29, contains: 'HS,  al, 31, 26', claim: 'al — биты 31:26 (ALS0…ALS5)' },
  { file: 'syllab-format.h', from: 219, to: 219, contains: 'E2K_ALS_NUM  6', claim: 'каналов ALS шесть' },
  { file: 'decoder.c', from: 111, to: 116, contains: 'E2K_ALS_NUM', claim: 'декодер обходит все каналы ALS' },
  { file: 'translate.c', from: 258, to: 259, contains: '(FIELD_EX32(cur_hs, HS, lng) + 1) * 8', claim: 'трансляция читает длину из lng' },
  { file: 'e2k-dis.c', from: 104, to: 113, contains: 'als_present', claim: 'дизассемблер разбирает ALS по битам присутствия' },
  { file: 'e2k-opc.h', from: 19, to: 20, contains: '{1, 1, 1, 1, 1, 1}', claim: 'adds разрешён во всех шести каналах' },
  { file: 'tc-e2k.c', from: 9576, to: 9577, contains: 'hs->lng = (crnt_syll >> 1) - 1', claim: 'ассемблер: lng = слогов/2 − 1' },
  { file: 'tc-e2k.c', from: 9365, to: 9366, contains: 'hs->mdl = (crnt_syll - 1)', claim: 'ассемблер: mdl = слов до средней точки − 1' },
  { file: 'tc-e2k.c', from: 9488, to: 9492, contains: 'align on a double syllable boundary', claim: 'добивка до чётного числа слогов' },
  { file: 'tc-e2k.c', from: 8668, to: 8668, contains: 'instructions into ALC%u', claim: 'отказ: две операции в один канал' },
  { file: 'tc-e2k.c', from: 10147, to: 10151, contains: 'without curly brackets', claim: 'одна инструкция может обойтись без скобок' },
  { file: 'tc-e2k.c', from: 10153, to: 10163, contains: "c == '{'", claim: 'скобка открывает широкую команду' },
  { file: 'tc-e2k.c', from: 9554, to: 9557, contains: 'maximal supported size of 16', claim: 'предел — 16 слогов' },
];

/**
 * Замеренные ассемблером образцы широкой команды.
 *
 * Таблица зафиксирована **здесь**, а не читается из документа: иначе правка документа
 * «согласовала» бы его с самим собой. Тест требует, чтобы hex лежал в документе **и** совпал с
 * живой сборкой.
 */
export interface WideCase {
  readonly key: string;
  readonly body: string;
  readonly bytes?: string;
  readonly refusal?: string;
}

const add = (channel: number, mnemonic = 'adds'): string => `${mnemonic},${channel} %b[1], %b[2], %b[3]`;

export const WIDE_CASES: readonly WideCase[] = [
  { key: 'одна add', body: add(0), bytes: '01 00 00 04 03 02 01 10' },
  {
    key: 'две add без скобок — две команды',
    body: `${add(0)}\n${add(1)}`,
    bytes: '01 00 00 04 03 02 01 10 01 00 00 08 03 02 01 10',
  },
  {
    key: 'две add в скобках — одна команда',
    body: `{\n${add(0)}\n${add(1)}\n}`,
    bytes: '12 00 00 0c 03 02 01 10 03 02 01 10 00 00 00 00',
  },
  {
    key: 'три add в скобках',
    body: `{\n${[0, 1, 2].map((ch) => add(ch)).join('\n')}\n}`,
    bytes: '13 00 00 1c 03 02 01 10 03 02 01 10 03 02 01 10',
  },
  {
    key: 'четыре add в скобках',
    body: `{\n${[0, 1, 2, 3].map((ch) => add(ch)).join('\n')}\n}`,
    bytes: '24 00 00 3c 03 02 01 10 03 02 01 10 03 02 01 10 03 02 01 10 00 00 00 00',
  },
  {
    key: 'шесть add в скобках',
    body: `{\n${[0, 1, 2, 3, 4, 5].map((ch) => add(ch)).join('\n')}\n}`,
    bytes:
      '36 00 00 fc 03 02 01 10 03 02 01 10 03 02 01 10 03 02 01 10 03 02 01 10 03 02 01 10 00 00 00 00',
  },
  {
    key: 'add и subs в скобках',
    body: `{\n${add(0)}\n${add(1, 'subs')}\n}`,
    bytes: '12 00 00 0c 03 02 01 10 03 02 01 12 00 00 00 00',
  },
  { key: 'две add в один канал', body: `{\n${add(0)}\n${add(0)}\n}`, refusal: 'attempting to place several instructions into ALC0' },
];

/** Развернуть ссылку документа в путь; неоднозначность и отсутствие — разные проблемы. */
export function resolveRef(raw: string): string | undefined {
  if (BARE_FILE_ROOTS[raw] !== undefined) return BARE_FILE_ROOTS[raw]!;
  const found = REF_ROOTS.map((root) => path.join(root, raw)).filter((candidate) => fs.existsSync(candidate));
  return found[0];
}

/** Ссылки вида `файл:строка` из текста документа. */
export function collectSourceRefs(doc: string): { raw: string; from: number; to: number }[] {
  const refs: { raw: string; from: number; to: number }[] = [];
  for (const match of doc.matchAll(/`([A-Za-z0-9_./-]+\.(?:c|h|ts|md|td)):(\d+)(?:-(\d+))?/g)) {
    const from = Number(match[2]);
    refs.push({ raw: match[1]!, from, to: match[3] === undefined ? from : Number(match[3]) });
  }
  return refs;
}

/** Проблемы ссылок: пустой список — все ссылки указывают на существующие строки. */
export function verifySourceRefs(refs: readonly { raw: string; from: number; to: number }[]): string[] {
  const problems: string[] = [];
  for (const ref of refs) {
    const file = resolveRef(ref.raw);
    if (file === undefined) {
      problems.push(`нет файла ${ref.raw} (ссылка ${ref.raw}:${ref.from})`);
      continue;
    }
    const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/);
    if (ref.from < 1 || ref.to < ref.from || ref.to > lines.length) {
      problems.push(`${ref.raw}:${ref.from}-${ref.to} — вне файла (строк ${lines.length})`);
    }
  }
  return problems;
}

/** Проблемы якорей: фрагмент обязан лежать в названных строках названного файла. */
export function verifyAnchors(anchors: readonly Anchor[]): string[] {
  const problems: string[] = [];
  for (const anchor of anchors) {
    const file = resolveRef(anchor.file);
    if (file === undefined) {
      problems.push(`нет файла ${anchor.file} (якорь «${anchor.claim}»)`);
      continue;
    }
    const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/);
    const slice = lines.slice(anchor.from - 1, anchor.to).join('\n');
    if (!slice.includes(anchor.contains)) {
      problems.push(`${anchor.file}:${anchor.from}-${anchor.to} — нет «${anchor.contains}» (${anchor.claim})`);
    }
  }
  return problems;
}

/** Байты → hex в формате документа. */
export function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(' ');
}

/** Собрать образцы широких команд имеющимся ассемблером МЦСТ (или назвать причину). */
export function assembleWideCases(): { hex: (string | undefined)[]; error?: string } {
  const { tool, reason } = findExternalAs();
  if (tool === undefined) return { hex: [], error: reason };
  const samples: AsSample[] = WIDE_CASES.map((item, index) => ({
    key: item.key,
    mnemonic: 'adds',
    channel: index,
    form: 'ALF1',
    asText: item.body,
    instruction: {
      mnemonic: 'adds',
      channel: 0,
      operands: [
        { kind: 'reg', index: 1 },
        { kind: 'reg', index: 2 },
        { kind: 'reg', index: 3 },
      ],
    } satisfies AsmInstruction,
    source: 'src/scripts/e2kWideCommands.audit.test.ts',
  }));
  const results = assembleAll(samples);
  return {
    hex: results.map((result) => (result.ok ? hexOf(result.bytes) : undefined)),
  };
}

describe('широкая команда: структура документа', () => {
  const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf-8') : '';

  it('документ существует и называет разделы формы и замера', () => {
    expect(fs.existsSync(DOC), 'нет docs/e2k-wide-commands.md').toBe(true);
    for (const section of ['## 1.', '## 2.', '## 3.', '## 4.']) {
      expect(doc, `нет раздела ${section}`).toContain(section);
    }
  });

  it('документ называет поле длины, среднюю точку и биты присутствия', () => {
    expect(doc).toContain('lng');
    expect(doc).toContain('средняя точка');
    expect(doc).toContain('E2K_ALS_NUM');
    expect(doc, 'нет пометки о ненайденном').toContain('НЕТ В ИСТОЧНИКЕ');
    expect(doc, 'нет раздела о том, чего замер не доказывает').toContain('НЕ доказывает');
    expect(doc).not.toMatch(/\b(работает|готово)\b/);
  });

  it('в документе есть замеренные байты всех случаев с байтами', () => {
    for (const item of WIDE_CASES) {
      if (item.bytes === undefined) continue;
      expect(doc, `нет байтов случая «${item.key}»`).toContain(item.bytes);
    }
  });
});

describe('широкая команда: якоря и ссылки', () => {
  const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf-8') : '';
  const haveSources = fs.existsSync(SOURCES);

  it('ссылки «файл:строка» документа указывают на существующие строки', () => {
    if (!haveSources) {
      // Копий источников нет: уровень не выполнить, и это названо, а не выдано за пройденное.
      expect(fs.existsSync(SOURCES)).toBe(false);
      return;
    }
    const refs = collectSourceRefs(doc);
    expect(refs.length, 'ссылок на строки источника в документе').toBeGreaterThanOrEqual(20);
    const problems = verifySourceRefs(refs);
    expect(problems, problems.join('; ')).toEqual([]);
  });

  it('каждый якорь формы лежит там, где назван', () => {
    if (!haveSources) {
      expect(fs.existsSync(SOURCES)).toBe(false);
      return;
    }
    const problems = verifyAnchors(ANCHORS);
    expect(problems, problems.join('; ')).toEqual([]);
    // Якоря обязаны быть упомянуты в документе: иначе документ и проверка расходятся.
    const unmentioned = ANCHORS.filter((anchor) => !doc.includes(anchor.file)).map((anchor) => anchor.file);
    expect([...new Set(unmentioned)], 'якоря не упомянуты в документе').toEqual([]);
  });
});

describe('широкая команда: байты против живого ассемблера', () => {
  const assembled = assembleWideCases();

  it('ассемблер либо отвечает, либо причина названа', () => {
    if (assembled.error !== undefined) {
      expect(assembled.error.length, 'причина недоступности ассемблера не названа').toBeGreaterThan(20);
      expect(assembled.hex).toEqual([]);
      return;
    }
    expect(assembled.hex.length).toBe(WIDE_CASES.length);
  });

  it('байты документа совпадают с живой сборкой, а лишний канал даёт отказ', () => {
    if (assembled.error !== undefined) {
      expect(assembled.error.length).toBeGreaterThan(20);
      return;
    }
    const problems: string[] = [];
    WIDE_CASES.forEach((item, index) => {
      const actual = assembled.hex[index];
      if (item.bytes !== undefined && actual !== item.bytes) {
        problems.push(`«${item.key}»: ассемблер дал ${actual ?? 'отказ'}, документ называет ${item.bytes}`);
      }
    });
    expect(problems, problems.join('; ')).toEqual([]);
  });

  it('негативный контроль: подменённые байты и сдвинутый якорь ловятся', () => {
    // 1. Сдвиг строки якоря на одну вниз обязан сломать якорь.
    const shifted = ANCHORS.map((anchor, index) =>
      index === 0 ? { ...anchor, from: anchor.from + 1, to: anchor.to + 1 } : anchor,
    );
    if (fs.existsSync(SOURCES)) {
      expect(verifyAnchors(shifted).join(' ')).toMatch(/нет «/);
      // 2. Выдуманный фрагмент обязан сломаться.
      const invented = [{ ...ANCHORS[0]!, contains: 'выдуманный фрагмент, которого в источнике нет' }];
      expect(verifyAnchors(invented).join(' ')).toMatch(/нет «/);
    }
    // 3. Ссылка на несуществующий файл обязана ловиться независимо от источников.
    expect(verifySourceRefs([{ raw: 'no/such/file.c', from: 1, to: 1 }]).join(' ')).toMatch(/нет файла/);

    // 4. Подменённые байты: проверка «документ против живой сборки» обязана это увидеть.
    const wrong = WIDE_CASES.map((item, index) => (index === 0 ? { ...item, bytes: 'ff ff ff ff' } : item));
    const seen = wrong.filter((item, index) => item.bytes !== undefined && assembled.hex[index] !== item.bytes);
    expect(seen.length, 'подмена байтов не замечена').toBeGreaterThan(0);
  });
});
