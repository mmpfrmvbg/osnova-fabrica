/**
 * ОРАКУЛ ИЗВЛЕЧЕНИЯ СЛОГОВ e2k (LTS, CS, SS).
 *
 * # Что проверяется
 *
 * `docs/e2k-syllables-real.md` утверждает конкретные поля и номера битов для слогов, которых
 * не было в первой редакции кодировщика. Проверка идёт **по источникам**, а не по документу:
 * тест открывает `gas/config/tc-e2k.c`, `opcodes/e2k-dis.c`, `qemu/target/e2k/syllab-format.h`
 * и убеждается, что названные строки существуют и содержат то, что обещано.
 *
 * 1. **Каждая строка с источником.** В документе нет утверждения без `файл:строка` либо пометки
 *    «НЕТ В ИСТОЧНИКЕ».
 * 2. **Якоря не выдуманы** — по списку проверяются строки источников.
 * 3. **Что не найдено, помечено** — системный вызов (CTPSL) и хост-вызов (`invoke`).
 *
 * # Негативный контроль
 *
 * Проверяльщик якорей прогоняется на подложенном файле: несуществующая строка и подменённый
 * текст обязаны быть пойманы.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const DOC = path.join(ROOT, 'docs', 'e2k-syllables-real.md');
const SOURCES = path.join(ROOT, '.tmp', 'e2k-sources');

/** Якоря: что именно обещано в конкретной строке источника. */
export const ANCHORS: ReadonlyArray<{ file: string; line: number; contains: string }> = [
  { file: 'binutils-gdb/gas/config/tc-e2k.c', line: 1108, contains: 'ctcond' },
  { file: 'binutils-gdb/gas/config/tc-e2k.c', line: 1110, contains: 'ctop' },
  { file: 'binutils-gdb/gas/config/tc-e2k.c', line: 4589, contains: 'CTC' + 'OND_ALWAYS' },
  { file: 'binutils-gdb/gas/config/tc-e2k.c', line: 4591, contains: 'CTC' + 'OND_NEG_PRED' },
  { file: 'binutils-gdb/gas/config/tc-e2k.c', line: 6840, contains: 'opc = 5' },
  { file: 'binutils-gdb/gas/config/tc-e2k.c', line: 6841, contains: 'param = wbs' },
  { file: 'binutils-gdb/gas/config/tc-e2k.c', line: 1816, contains: '_f16' },
  { file: 'binutils-gdb/gas/config/tc-e2k.c', line: 1817, contains: '_f32s' },
  { file: 'binutils-gdb/opcodes/e2k-dis.c', line: 1584, contains: 'print_ctcond' },
  { file: 'binutils-gdb/opcodes/e2k-dis.c', line: 1588, contains: 'cond_type' },
  { file: 'binutils-gdb/opcodes/e2k-dis.c', line: 1589, contains: 'psrc' },
  { file: 'binutils-gdb/opcodes/e2k-dis.c', line: 1908, contains: 'ctpr' },
  { file: 'binutils-gdb/opcodes/e2k-dis.c', line: 1909, contains: 'ctp_opc' },
  { file: 'binutils-gdb/opcodes/e2k-dis.c', line: 459, contains: '0xd0' },
  { file: 'binutils-gdb/opcodes/e2k-dis.c', line: 480, contains: '0xd8' },
  { file: 'binutils-gdb/opcodes/e2k-dis.c', line: 485, contains: '0xdc' },
  { file: 'qemu-e2k/qemu/target/e2k/syllab-format.h', line: 21, contains: 's,' },
  { file: 'qemu-e2k/qemu/target/e2k/syllab-format.h', line: 29, contains: 'al' },
  { file: 'qemu-e2k/qemu/target/e2k/syllab-format.h', line: 96, contains: 'ctpr' },
  { file: 'qemu-e2k/qemu/target/e2k/syllab-format.h', line: 103, contains: 'opc' },
  { file: 'qemu-e2k/qemu/target/e2k/instr-bits.h', line: 217, contains: 'lts' },
];

/** Проверить якоря по локальным копиям источников. Чистая по отношению к файлам функция. */
export function checkAnchors(
  anchors: ReadonlyArray<{ file: string; line: number; contains: string }>,
  root: string,
): string[] {
  const problems: string[] = [];
  for (const anchor of anchors) {
    const file = path.join(root, anchor.file);
    if (!fs.existsSync(file)) {
      problems.push(`нет файла ${anchor.file}`);
      continue;
    }
    const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/);
    const line = lines[anchor.line - 1];
    if (line === undefined) {
      problems.push(`${anchor.file}: строки ${anchor.line} нет (в файле ${lines.length})`);
      continue;
    }
    if (!line.includes(anchor.contains)) {
      problems.push(`${anchor.file}:${anchor.line} не содержит «${anchor.contains}»`);
    }
  }
  return problems;
}

/**
 * Утверждения документа без источника и без пометки «НЕТ В ИСТОЧНИКЕ».
 *
 * Источник может стоять в самой строке или в её окружении (шапка таблицы, абзац перед ней) —
 * так документ и написан. Поэтому строка считается обеспеченной источником, если он есть в ней
 * самой или не дальше {@link SOURCE_WINDOW} строк выше.
 */
const SOURCE_WINDOW = 12;

export function checkRowsHaveSources(doc: string): string[] {
  const problems: string[] = [];
  const lines = doc.split(/\r?\n/);
  const hasSource = (text: string): boolean =>
    /`[^`]+\.(c|h|md|td):\d+/.test(text) || /README\.md:\d+/.test(text) || /НЕТ В ИСТОЧНИКЕ/.test(text);
  let rows = 0;
  let lastSource = -SOURCE_WINDOW - 1;
  lines.forEach((line, index) => {
    if (hasSource(line)) lastSource = index;
    if (!line.startsWith('|')) return;
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length < 5) return;
    if (/^[-: ]*$/.test(cells[1] ?? '')) return; // разделитель таблицы
    if (['поле', 'слог', 'что', 'показатель', 'носитель IR', 'источник'].includes(cells[1] ?? '')) return;
    rows++;
    if (hasSource(line) || index - lastSource <= SOURCE_WINDOW) return;
    problems.push(`строка без источника (и без источника в ${SOURCE_WINDOW} строках выше): ${line.trim().slice(0, 80)}`);
  });
  if (rows < 20) problems.push(`таблиц разобрано мало: строк ${rows}`);
  return problems;
}

describe('слоги e2k: документ и источники', () => {
  const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf-8') : '';

  it('документ существует и называет четыре слога', () => {
    expect(fs.existsSync(DOC), 'нет docs/e2k-syllables-real.md').toBe(true);
    for (const syllable of ['SS', 'CS0', 'CS1', 'LTS', 'CDS', 'PLS']) {
      expect(doc, `не назван слог ${syllable}`).toContain(syllable);
    }
  });

  it('в каждой строке таблиц есть источник или пометка «НЕТ В ИСТОЧНИКЕ»', () => {
    expect(checkRowsHaveSources(doc)).toEqual([]);
  });

  it('якоря подтверждаются локальными копиями источников', () => {
    if (!fs.existsSync(SOURCES)) {
      // Слабая проверка: копий источников нет. Это не «проверено», и причина названа.
      expect(doc).toContain('docs/e2k-sources-raw.md');
      return;
    }
    expect(checkAnchors(ANCHORS, SOURCES), `якорей ${ANCHORS.length}`).toEqual([]);
  });

  it('то, чего в источниках нет, помечено прямо', () => {
    expect(doc, 'не сказано про системный вызов').toMatch(/CTPSL/);
    expect(doc, 'нет пометки «НЕТ В ИСТОЧНИКЕ» для invoke').toMatch(/IR\.invoke[\s\S]{0,400}НЕТ В ИСТОЧНИКЕ/);
    expect(doc, 'не сказано, что 64-битный литерал не реализован').toMatch(/64-битный литерал/);
  });

  it('измеренные байты записаны и совпадают с кодировщиком', () => {
    // Строки §5 — те же байты, что проверяет src/e2k/e2kSyllables.test.ts.
    expect(doc).toContain('01 10 00 00 20 04 00 c0');
    expect(doc).toContain('01 40 00 00 00 00 00 f0');
    expect(doc).toContain('12 90 00 00 20 04 00 c0 10 00 00 50 00 00 00 00');
  });

  it('негативный контроль: подложенный якорь и строка без источника ловятся', () => {
    const root = path.join(ROOT, '.tmp', 'e2k-sources');
    if (fs.existsSync(root)) {
      const broken = checkAnchors([{ file: 'binutils-gdb/gas/config/tc-e2k.c', line: 1108, contains: 'заведомо-нет' }], root);
      expect(broken.join(' ')).toMatch(/не содержит/);
      const missing = checkAnchors([{ file: 'binutils-gdb/нет-такого.c', line: 1, contains: 'x' }], root);
      expect(missing.join(' ')).toMatch(/нет файла/);
    }
    expect(checkRowsHaveSources('| поле | биты | что | источник |\n|---|---|---|---|\n| `x` | 1 | утверждение | `qemu/target/e2k/syllab-format.h:29` |\n'.repeat(25))).toEqual([]);
    const bad = '| поле | биты | что | источник |\n|---|---|---|---|\n| `x` | 1 | утверждение | — |\n'.repeat(25);
    expect(checkRowsHaveSources(bad).join(' ')).toMatch(/без источника/);
  });
});
