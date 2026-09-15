/**
 * ОРАКУЛ ДОКУМЕНТА «ПЕРВОЕ ЧИСЛО ТАКТОВ НА ОБОЛОЧКЕ».
 *
 * # Как проверяет
 *
 * **Симулятор не запускается.** Тест читает два файла: артефакт `tests/e2k/shell-ticks.json`
 * (числа симулятора, зафиксированные артефактом, — тот же приём, что с `tests/dsp/reference.json`)
 * и документ `docs/e2k-shell-ticks.md`. Числа документа обязаны совпадать с артефактом
 * строка в строку. Иначе документ — независимый источник, который может разойтись с кодом и
 * никто этого не заметит.
 *
 * # Что ещё проверяется
 *
 * - паспорт документа: статус `ДОПУЩЕНИЕ`, источник (`docs/vliw-e2k-model.md`) и ограничение
 *   «не валидировано на железе»;
 * - раздел сравнения порядков: равенство тактов на пяти ядрах названо, а не умолчано;
 * - **тест действительно не запускает симулятор**: собственный исходник не импортирует
 *   `simulatorShell` — проверка структурная, а не на честном слове.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');
const DOC_REL = path.join('docs', 'e2k-shell-ticks.md');
const ARTIFACT_REL = path.join('tests', 'e2k', 'shell-ticks.json');
const SELF_REL = path.join('src', 'scripts', 'shellTicks.audit.test.ts');

const KERNEL_NAMES = ['fir', 'iir', 'fft', 'convolution', 'correlation'];
const CLASS_LABELS = ['ALU', 'MUL', 'MEM', 'BRANCH', 'НЕТ КЛАССА'];

interface ClassEntry {
  label: string;
  executed: number;
  ticks: number;
  stalls: number;
}

interface KernelEntry {
  algorithm: string;
  atom: string;
  checksum: number;
  staticInstructions: number;
  instructions: number;
  ticks: number;
  ticksLinear: number;
  cpi: number;
  classes: ClassEntry[];
}

interface Artifact {
  format: string;
  version: number;
  passport: { status: string; limitation: string; source: string; note: string };
  kernels: Record<string, KernelEntry>;
  total: { staticInstructions: number; instructions: number; ticks: number; ticksLinear: number };
}

function read(rel: string): string {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) throw new Error(`нет файла: ${rel}`);
  return fs.readFileSync(full, 'utf-8');
}

function readArtifact(): Artifact {
  return JSON.parse(read(ARTIFACT_REL)) as Artifact;
}

/** Ячейки markdown-строки таблицы. */
function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/** Строка таблицы ядер: `| fir | A5 | 111 | 727 | 802 | 802 | 1.103 | 70 |`. */
function kernelRows(doc: string): Map<string, string[]> {
  const rows = new Map<string, string[]>();
  for (const line of doc.split('\n')) {
    if (!line.startsWith('|')) continue;
    const parts = cells(line);
    if (parts.length < 8) continue;
    if (!KERNEL_NAMES.includes(parts[0]!)) continue;
    rows.set(parts[0]!, parts);
  }
  return rows;
}

/** Строки таблицы классов: `| fir | ALU | 512 | 512 | 60 |`. */
function classRows(doc: string): Map<string, Map<string, string[]>> {
  const rows = new Map<string, Map<string, string[]>>();
  for (const line of doc.split('\n')) {
    if (!line.startsWith('|')) continue;
    const parts = cells(line);
    if (parts.length !== 5) continue;
    if (!KERNEL_NAMES.includes(parts[0]!) || !CLASS_LABELS.includes(parts[1]!)) continue;
    const perKernel = rows.get(parts[0]!) ?? new Map<string, string[]>();
    perKernel.set(parts[1]!, parts);
    rows.set(parts[0]!, perKernel);
  }
  return rows;
}

/** Строка итога: `| итого | — | 517 | 2077 | 2338 | 2338 | 1.126 | 236 |`. */
function totalRow(doc: string): string[] | undefined {
  for (const line of doc.split('\n')) {
    if (!line.startsWith('|')) continue;
    const parts = cells(line);
    if (parts.length >= 8 && /^итого/i.test(parts[0]!)) return parts;
  }
  return undefined;
}

function num(text: string | undefined, what: string): number {
  const value = Number((text ?? '').replace(/\s/g, ''));
  if (!Number.isFinite(value)) throw new Error(`${what}: не число («${String(text)}»)`);
  return value;
}

describe('документ «первое число тактов на оболочке»: паспорт', () => {
  it('документ существует и называет себя моделью, а не железом', () => {
    const doc = read(DOC_REL);
    expect(doc).toMatch(/ДОПУЩЕНИЕ/);
    expect(doc, 'нет оговорки о железе').toMatch(/не валидировано на железе/);
    expect(doc, 'нет источника модели').toMatch(/vliw-e2k-model\.md/);
    expect(doc, 'не сказано, что это оболочка').toMatch(/оболочк/i);
    expect(doc, 'не сказано, что это не e2k').toMatch(/НЕ\s*(симулятор\s*)?e2k/i);
  });

  it('документ объясняет правило счёта тактов и не обещает железных тактов', () => {
    const doc = read(DOC_REL);
    expect(doc, 'нет правила счёта (RAW)').toMatch(/RAW/);
    expect(doc, 'не сказано про однослотовую выдачу').toMatch(/однослот/i);
    expect(doc, 'нет раздела допущений').toMatch(/Что осталось допущением/);
    expect(doc, 'нет раздела про сравнение порядков').toMatch(/порядк/i);
  });
});

describe('документ «первое число тактов на оболочке»: числа против артефакта', () => {
  it('артефакт несёт паспорт и пять ядер', () => {
    const artifact = readArtifact();
    expect(artifact.passport.status).toBe('ДОПУЩЕНИЕ');
    expect(artifact.passport.limitation).toMatch(/не валидировано на железе/);
    expect(Object.keys(artifact.kernels).sort()).toEqual([...KERNEL_NAMES].sort());
  });

  it('строка каждого ядра совпадает с артефактом: атом, инструкции, такты, CPI', () => {
    const artifact = readArtifact();
    const rows = kernelRows(read(DOC_REL));
    for (const name of KERNEL_NAMES) {
      const entry = artifact.kernels[name]!;
      const row = rows.get(name);
      expect(row, `${name}: нет строки в таблице документа`).toBeDefined();
      expect(row![1], `${name}: атом`).toBe(entry.atom);
      expect(num(row![2], `${name}: статических инструкций`)).toBe(entry.staticInstructions);
      expect(num(row![3], `${name}: исполнено инструкций`)).toBe(entry.instructions);
      expect(num(row![4], `${name}: тактов по модели`)).toBe(entry.ticks);
      expect(num(row![5], `${name}: тактов линейно`)).toBe(entry.ticksLinear);
      expect(num(row![6], `${name}: CPI`)).toBeCloseTo(entry.cpi, 3);
    }
  });

  it('итоговая строка совпадает с артефактом', () => {
    const artifact = readArtifact();
    const row = totalRow(read(DOC_REL));
    expect(row, 'нет строки «итого»').toBeDefined();
    expect(num(row![2], 'итого: статических инструкций')).toBe(artifact.total.staticInstructions);
    expect(num(row![3], 'итого: исполнено инструкций')).toBe(artifact.total.instructions);
    expect(num(row![4], 'итого: тактов')).toBe(artifact.total.ticks);
    expect(num(row![5], 'итого: тактов линейно')).toBe(artifact.total.ticksLinear);
  });

  it('классы задержек в документе совпадают с артефактом', () => {
    const artifact = readArtifact();
    const rows = classRows(read(DOC_REL));
    for (const name of KERNEL_NAMES) {
      const entry = artifact.kernels[name]!;
      const perKernel = rows.get(name);
      expect(perKernel, `${name}: нет таблицы классов`).toBeDefined();
      expect([...perKernel!.keys()].sort(), `${name}: состав классов`).toEqual(
        entry.classes.map((stat) => stat.label).sort(),
      );
      for (const stat of entry.classes) {
        const row = perKernel!.get(stat.label)!;
        expect(num(row[2], `${name}/${stat.label}: инструкций`)).toBe(stat.executed);
        expect(num(row[3], `${name}/${stat.label}: занятость`)).toBe(stat.ticks);
        expect(num(row[4], `${name}/${stat.label}: простоя`)).toBe(stat.stalls);
      }
    }
  });

  it('равенство тактов при перестановке названо в документе, а не умолчано', () => {
    const artifact = readArtifact();
    const equal = KERNEL_NAMES.filter((name) => {
      const entry = artifact.kernels[name]!;
      return entry.ticks === entry.ticksLinear;
    });
    expect(equal.length, 'артефакт перестал показывать равенство — текст документа устарел').toBe(
      KERNEL_NAMES.length,
    );
    expect(read(DOC_REL), 'нет объяснения, почему такты не изменились').toMatch(
      /слот|широк/,
    );
  });
});

describe('оракул документа: читает артефакт, а не считает', () => {
  it('тест не импортирует симулятор', () => {
    const self = read(SELF_REL);
    expect(self, 'тест документа запускает симулятор — это нарушает «читает артефакт»').not.toMatch(
      /from\s+['"][^'"]*simulatorShell['"]/,
    );
    expect(self, 'тест документа не читает артефакт').toMatch(/shell-ticks\.json/);
  });
});
