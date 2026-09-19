/**
 * ОРАКУЛ ИЗВЛЕЧЕНИЯ: `docs/e2k-loop-mode.md`, `docs/e2k-spec-bit.md`,
 * `docs/brainstorm/06-next-steps.md`.
 *
 * # Зачем
 *
 * Это документы **извлечения из чужих источников**. У них две обязанности, и обе проверяемы
 * машиной:
 *
 * 1. **каждое утверждение имеет источник** — `файл:строка` в извлечённых исходниках
 *    (`.tmp/e2k-sources/`, `.tmp/elbrus-prog.txt`) или страница руководства. Ссылка обязана
 *    указывать на **существующий** файл и существующую строку;
 * 2. **отсутствие названо** — если чего-то в источниках нет, это сказано словами
 *    «НЕТ В ИСТОЧНИКЕ» / «НЕ ИЗВЛЕЧЕНО», а не умолчано. Правило проекта:
 *    `docs/verification-debt.md:73-84` («мнемоника либо скопирована посимвольно, либо её нет»).
 *
 * # Граница честности
 *
 * Проверка **не** подтверждает, что строка говорит именно то, что о ней написано: это недоступно
 * машине и остаётся на человеке. Проверяется существование ссылки и наличие слова об отсутствии.
 * Это названо здесь, чтобы оракул не выглядел сильнее, чем он есть.
 *
 * # Негативный контроль
 *
 * Подложенная ссылка на несуществующую строку обязана ловиться тем же кодом (правило случая 10:
 * контроль проверяет свой прогон, а не только результат).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const SOURCES = path.join(ROOT, '.tmp', 'e2k-sources');

/** Документы извлечения и их обязательные разделы. */
export const EXTRACTION_DOCS: Readonly<Record<string, readonly string[]>> = {
  'docs/e2k-loop-mode.md': [
    '## 1.',
    '## 2.',
    '## 3.',
    '## 4.',
    '## 5.',
    '## 7. ЧТО ОСТАЛОСЬ НЕ ИЗВЛЕЧЕНО',
    '## 8. ГИПОТЕЗА: выигрыш',
  ],
  'docs/e2k-spec-bit.md': ['## 1.', '## 2.', '## 3.', '## 4.', '## 6. Чего НЕТ В ИСТОЧНИКЕ'],
  'docs/brainstorm/06-next-steps.md': ['## 1.', '## 2.', '## 3. Какой замер', '## 4. Риски'],
};

/** Корни, по которым разворачивается ссылка. Порядок важен: сначала источники, потом проект. */
export const REF_ROOTS: readonly string[] = [
  SOURCES,
  path.join(SOURCES, 'qemu-e2k', 'qemu'),
  // Голые имена из QEMU ссылаются на `target/e2k` и на его `tcg` — это два частых случая.
  path.join(SOURCES, 'qemu-e2k', 'qemu', 'target', 'e2k'),
  path.join(SOURCES, 'qemu-e2k', 'qemu', 'target', 'e2k', 'tcg'),
  path.join(SOURCES, 'binutils-gdb'),
  path.join(SOURCES, 'llvm-project'),
  ROOT,
  path.join(ROOT, 'src', 'e2k'),
];

export interface Citation {
  readonly file: string;
  readonly from: number;
  readonly to: number;
}

/** Вырезать ссылки `путь:строка[-строка]` из обратных кавычек. */
export function citationsOf(text: string): Citation[] {
  const found: Citation[] = [];
  for (const line of text.split(/\r?\n/)) {
    for (const match of line.matchAll(/`([^`\n]+)`/g)) {
      const rx = /((?:[A-Za-z0-9_.\-/]+)?[A-Za-z0-9_.\-]+\.(?:ts|md|c|h|cpp|td|txt|def)):(\d+)(?:\s*[-–]\s*(\d+))?/g;
      for (const hit of match[1]!.matchAll(rx)) {
        found.push({
          file: hit[1]!.replace(/\\/g, '/'),
          from: Number(hit[2]),
          to: hit[3] === undefined ? Number(hit[2]) : Number(hit[3]),
        });
      }
    }
  }
  return found;
}

/** Число строк файла без учёта переводов строк (случай 15 реестра проверяемости). */
export function lineCountOf(file: string): number {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

/** Развернуть ссылку в файл: либо путь от корня репозитория, либо от корня источника. */
export function resolveCited(file: string): string | undefined {
  const candidates = [
    ...(file.includes('/') ? [] : REF_ROOTS.map((root) => path.join(root, file))),
    ...REF_ROOTS.map((root) => path.join(root, file)),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}

/** Проблемы ссылки: файл не найден или строки нет. */
export function checkCitation(citation: Citation): string[] {
  const resolved = resolveCited(citation.file);
  if (resolved === undefined) return [`${citation.file}:${citation.from} — файла нет ни в одном корне источников`];
  const total = lineCountOf(resolved);
  if (citation.from < 1 || citation.to < citation.from || citation.to > total) {
    return [`${citation.file}:${citation.from}-${citation.to} — в файле ${total} строк`];
  }
  return [];
}

/** Признаки названного отсутствия — обязаны встречаться в каждом документе извлечения. */
export const ABSENCE_MARKERS: readonly string[] = ['НЕТ В ИСТОЧНИКЕ', 'НЕ ИЗВЛЕЧЕНО'];

describe('документы извлечения: состав и обязательные разделы', () => {
  it('каждый документ существует и содержит свои разделы', () => {
    const problems: string[] = [];
    for (const [doc, sections] of Object.entries(EXTRACTION_DOCS)) {
      const full = path.join(ROOT, doc);
      if (!fs.existsSync(full)) {
        problems.push(`${doc}: файла нет`);
        continue;
      }
      const text = fs.readFileSync(full, 'utf8');
      for (const section of sections) {
        if (!text.includes(section)) problems.push(`${doc}: нет раздела «${section}»`);
      }
    }
    expect(problems, 'разделы документов извлечения').toEqual([]);
  });

  it('каждый документ называет, чего в источниках нет', () => {
    const problems: string[] = [];
    for (const doc of Object.keys(EXTRACTION_DOCS)) {
      const text = fs.readFileSync(path.join(ROOT, doc), 'utf8');
      if (!ABSENCE_MARKERS.some((marker) => text.includes(marker))) {
        problems.push(`${doc}: ни «НЕТ В ИСТОЧНИКЕ», ни «НЕ ИЗВЛЕЧЕНО»`);
      }
    }
    expect(problems, 'названное отсутствие').toEqual([]);
  });

  it('документ о loop mode содержит помеченную ГИПОТЕЗУ про выигрыш', () => {
    const text = fs.readFileSync(path.join(ROOT, 'docs/e2k-loop-mode.md'), 'utf8');
    expect(text, 'пометка гипотезы').toContain('ГИПОТЕЗА');
    expect(text, 'требование замера').toMatch(/требует замера/);
  });

  it('карта следующих шагов не обещает реализации', () => {
    const text = fs.readFileSync(path.join(ROOT, 'docs/brainstorm/06-next-steps.md'), 'utf8');
    expect(text, 'запрет на обещание').toContain('без реализации');
    // Ни одного множителя эффекта без пометки: если появится «×5», проверка покраснеет.
    expect(/(?<!ГИПОТЕЗА.{0,40})×\s?\d/.test(text), 'множитель без пометки в карте').toBe(false);
  });
});

describe('ссылки документов извлечения: каждая существует', () => {
  it('все ссылки разворачиваются в существующие строки источников', () => {
    const problems: string[] = [];
    let total = 0;
    for (const doc of Object.keys(EXTRACTION_DOCS)) {
      const citations = citationsOf(fs.readFileSync(path.join(ROOT, doc), 'utf8'));
      total += citations.length;
      for (const citation of citations) problems.push(...checkCitation(citation));
    }
    expect(problems, 'проблемные ссылки').toEqual([]);
    // Ноль ссылок означал бы, что разбор сломан, а не что документ хорош (случай 10).
    expect(total, 'всего ссылок').toBeGreaterThan(40);
  });

  it('ссылки ведут в разные источники, а не в один файл', () => {
    const files = new Set<string>();
    for (const doc of Object.keys(EXTRACTION_DOCS)) {
      for (const citation of citationsOf(fs.readFileSync(path.join(ROOT, doc), 'utf8'))) {
        const resolved = resolveCited(citation.file);
        if (resolved !== undefined) files.add(path.basename(resolved));
      }
    }
    expect(files.size, 'разных файлов-источников').toBeGreaterThan(6);
    expect(files.has('syllab-format.h'), 'ссылка на формат слогов').toBe(true);
    expect(files.has('tc-e2k.c'), 'ссылка на ассемблер МЦСТ').toBe(true);
  });
});

describe('НЕГАТИВНЫЙ КОНТРОЛЬ: ссылки и отсутствие ловятся', () => {
  it('ссылка на несуществующий файл ловится', () => {
    const planted = citationsOf('См. `qemu/target/e2k/no-such-file.h:10`.');
    expect(planted.length, 'собрано ссылок').toBe(1);
    expect(checkCitation(planted[0]!).length, 'проблем').toBeGreaterThan(0);
  });

  it('ссылка на существующий файл с невозможной строкой ловится', () => {
    const real = 'syllab-format.h';
    const resolved = resolveCited(real)!;
    expect(resolved, 'файл найден').toBeTruthy();
    const planted = citationsOf(`См. \`${real}:99999\`.`);
    expect(checkCitation(planted[0]!).length, 'проблем').toBeGreaterThan(0);
  });

  it('настоящая ссылка проходит — контроль не «красный всегда»', () => {
    const planted = citationsOf('См. `syllab-format.h:20`.');
    expect(planted.length, 'собрано ссылок').toBe(1);
    expect(checkCitation(planted[0]!), 'настоящая ссылка').toEqual([]);
  });

  it('текст без признака отсутствия не проходит проверку на названное отсутствие', () => {
    const fake = 'Документ без слова об отсутствии.';
    expect(ABSENCE_MARKERS.some((marker) => fake.includes(marker)), 'признак найден').toBe(false);
  });
});

describe('оракул собран и проверяет непустое множество', () => {
  it('все три документа прочитаны и непустые', () => {
    for (const doc of Object.keys(EXTRACTION_DOCS)) {
      const text = fs.readFileSync(path.join(ROOT, doc), 'utf8');
      expect(text.length, `${doc}: длина`).toBeGreaterThan(1200);
    }
  });

  it('корни источников на месте — иначе проверка ссылок выродилась бы', () => {
    expect(fs.existsSync(SOURCES), 'каталог извлечённых источников').toBe(true);
    expect(fs.existsSync(path.join(ROOT, '.tmp', 'elbrus-prog.txt')), 'текст руководства МЦСТ').toBe(true);
  });
});
