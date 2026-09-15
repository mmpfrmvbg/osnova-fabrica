/**
 * АУДИТ СИМУЛЯТОРА НА ОБОЛОЧКЕ: защита от регрессии.
 *
 * Проверяется:
 *
 * 1. файл `src/e2k/simulatorShell.ts` существует и его имя содержит `shell`; рядом **нет**
 *    файла с именем вида «симулятор e2k» (имя обязано отражать оболочку — это требование
 *    задания, а не украшение);
 * 2. паспорт модуля несёт статус `ДОПУЩЕНИЕ`, источник модели и ограничение
 *    «не валидировано на железе»;
 * 3. `latencyMap` покрывает **все** носители из кода оболочки (`IR_CARRIERS`), и у каждого
 *    отображения указан источник;
 * 4. пять DSP-ядер дают правильные числа и **зафиксированные** такты (артефакт);
 * 5. негативный контроль зафиксирован: четыре дефекта, `sha256`, падения — в документе, а
 *    инъекция — в коде (`SimulatorDefects`), а не только в отчёте;
 * 6. **стоячий негативный контроль формулировок:** в документах нет «e2k-тактов» и «реальных
 *    тактов» без оговорки, что это модель. Проверка строковая, и у неё есть свой негативный
 *    контроль на подложенном тексте — иначе она была бы декоративной.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { getEncoder } from '../e2k/backend';
import { emitShell } from '../e2k/emitterShell';
import { IR_CARRIERS } from '../e2k/shell';
import { LATENCY_MAP } from '../e2k/latencyMap';
import { SIMULATOR_PASSPORT, simulateShellImage } from '../e2k/simulatorShell';
import { annotateAtomRegions, verifyAtomRegions } from '../compiler/atomRegions';
import { regModuleOf } from '../vliw/regOracle';
import type { RegModule } from '../runtime/vm/regcode';

const ROOT = path.resolve(__dirname, '..', '..');
const SIMULATOR = path.join('src', 'e2k', 'simulatorShell.ts');
const SIMULATOR_TEST = path.join('src', 'e2k', 'simulatorShell.test.ts');
const LATENCY_MAP_FILE = path.join('src', 'e2k', 'latencyMap.ts');
const DOC = path.join('docs', 'e2k-shell-ticks.md');
const ARTIFACT = path.join('tests', 'e2k', 'shell-ticks.json');
const REFERENCE = path.join('tests', 'dsp', 'reference.json');

const KERNELS: Array<{ name: string; atom: string }> = [
  { name: 'fir', atom: 'A5' },
  { name: 'iir', atom: 'A5' },
  { name: 'fft', atom: 'A5' },
  { name: 'convolution', atom: 'A6' },
  { name: 'correlation', atom: 'A6' },
];

/** Документы, к которым применяется стоячая проверка формулировок. */
const TICK_PHRASE_DOCS = [
  path.join('docs', 'e2k-shell-ticks.md'),
  path.join('docs', 'e2k-emitter-shell.md'),
  path.join('docs', 'vliw-e2k-model.md'),
  path.join('docs', 'hardware-debt.md'),
  path.join('docs', 'b-task-candidates.md'),
  path.join('memory', '_index.md'),
];

const encoder = getEncoder('internal-shell');

function read(rel: string): string {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) throw new Error(`нет файла: ${rel}`);
  return fs.readFileSync(full, 'utf-8');
}

function flat(rel: string): string {
  return read(rel).replace(/\s+/g, ' ');
}

function kernelImage(name: string, atom: string): ReturnType<typeof emitShell> {
  const source = fs.readFileSync(path.join(ROOT, 'tests', 'dsp', 'kernels', `${name}.osnova`), 'utf-8');
  const built = regModuleOf(source);
  if (!built) throw new Error(`ядро не компилируется: ${name}`);
  const module: RegModule = built.module;
  const annotated = annotateAtomRegions(module, [
    { atom, procedures: module.procedures.map((p) => p.name) },
  ]);
  const problems = verifyAtomRegions(annotated);
  if (problems.length > 0) throw new Error(`${name}: разметка не прошла проверку`);
  return emitShell(annotated, encoder);
}

/**
 * Стоячая проверка формулировок: «e2k-такты» или «реальные такты» без оговорки.
 *
 * Чистая функция — её же проверяет негативный контроль на подложенном тексте.
 */
export function bareTickClaims(text: string): string[] {
  const problems: string[] = [];
  for (const line of text.split('\n')) {
    // `\w` в JavaScript не матчит кириллицу — берём явный диапазон, иначе проверка слепа
    // на словоформы («реальные», «реальных»). Это нашёл собственный негативный контроль.
    if (!/e2k-такты|реальн[а-яё]*\s+такт[а-яё]*/i.test(line)) continue;
    // `\b` в JavaScript тоже ASCII-ный: после кириллицы границы слова он не видит.
    if (/не\s|нет(?![а-яё])|недоступ|без оговорки|оговорк|модел|замер|запрещ|вместо/i.test(line)) {
      continue;
    }
    problems.push(line.trim());
  }
  return problems;
}

describe('аудит симулятора: имя и паспорт', () => {
  it('файл назван по оболочке, и файла «симулятор e2k» рядом нет', () => {
    expect(fs.existsSync(path.join(ROOT, SIMULATOR)), 'нет симулятора на оболочке').toBe(true);
    expect(path.basename(SIMULATOR).toLowerCase()).toContain('shell');
    const names = fs.readdirSync(path.join(ROOT, 'src', 'e2k'));
    const misleading = names.filter(
      (name) => /e2k.*simulat|simulat.*e2k/i.test(name) && !/shell/i.test(name),
    );
    expect(misleading, `имена, выдающие оболочку за e2k: ${misleading.join(', ')}`).toEqual([]);
  });

  it('паспорт модуля: статус ДОПУЩЕНИЕ, источник модели, «не валидировано на железе»', () => {
    const text = flat(SIMULATOR);
    expect(text, 'нет статуса ДОПУЩЕНИЕ').toContain('ДОПУЩЕНИЕ');
    expect(text, 'нет оговорки о железе').toContain('не валидировано на железе');
    expect(text, 'нет источника модели').toMatch(/vliw-e2k-model/);
    expect(SIMULATOR_PASSPORT.status).toBe('ДОПУЩЕНИЕ');
    expect(SIMULATOR_PASSPORT.limitation).toMatch(/не валидировано на железе/);
    expect(SIMULATOR_PASSPORT.title).toMatch(/оболочк/i);
    expect(SIMULATOR_PASSPORT.tickModel, 'правило счёта не названо').toMatch(/RAW/);
    // Паспорт обязан быть в шапке, а не только в объекте: шапку читает человек.
    expect(read(SIMULATOR).slice(0, 1200)).toMatch(/Паспорт|статус/i);
  });

  it('симулятор не выдаёт себя за e2k: в шапке сказано «не симулятор e2k»', () => {
    expect(read(SIMULATOR).slice(0, 1200)).toMatch(/не симулятор e2k/i);
    expect(read(SIMULATOR)).toMatch(/носител/i);
  });
});

describe('аудит симулятора: отображение носителей', () => {
  it('latencyMap покрывает все носители из кода — в обе стороны', () => {
    const fromCode = Object.keys(IR_CARRIERS).sort();
    const fromMap = Object.keys(LATENCY_MAP).sort();
    expect(fromMap, 'в таблице не все носители кода').toEqual(fromCode);
    expect(fromMap.length).toBeGreaterThan(0);
  });

  it('у каждого отображения указан источник, у «НЕТ КЛАССА» — причина', () => {
    for (const [carrier, entry] of Object.entries(LATENCY_MAP)) {
      expect(entry.source, `${carrier}: нет источника`).toMatch(/ПО ПРИРОДЕ|НАШЕ РЕШЕНИЕ|НЕТ КЛАССА/);
      expect(entry.sourceRef.length, `${carrier}: нет ссылки`).toBeGreaterThan(10);
      if (entry.source !== 'ПО ПРИРОДЕ') {
        expect(entry.reason.length, `${carrier}: источник без обоснования`).toBeGreaterThan(20);
      }
      if (entry.latencyClass === null) {
        expect(entry.behavior, `${carrier}: «НЕТ КЛАССА» без поведения`).toBeDefined();
      }
    }
    expect(flat(LATENCY_MAP_FILE), 'нет объяснения, почему MEM пуст').toMatch(/MEM/);
    expect(flat(LATENCY_MAP_FILE), 'нет объяснения отсутствия IR.load/IR.store').toMatch(
      /IR\.load|IR\.store/,
    );
  });
});

describe('аудит симулятора: пять ядер и такты', () => {
  it('пять ядер дают числа эталона и зафиксированные такты', async () => {
    const artifact = JSON.parse(read(ARTIFACT)) as {
      kernels: Record<string, { checksum: number; ticks: number; instructions: number }>;
    };
    const reference = JSON.parse(read(REFERENCE)) as Record<string, { checksum: number }>;
    for (const { name, atom } of KERNELS) {
      const result = await simulateShellImage(kernelImage(name, atom).image, encoder);
      expect(Number(result.value), `${name}: число`).toBe(reference[name]!.checksum);
      expect(result.report.ticks, `${name}: такты`).toBe(artifact.kernels[name]!.ticks);
      expect(result.report.instructions, `${name}: инструкций`).toBe(
        artifact.kernels[name]!.instructions,
      );
    }
  });
});

describe('аудит симулятора: негативный контроль зафиксирован', () => {
  it('документ называет четыре дефекта, падения и sha256', () => {
    const doc = flat(DOC);
    for (const defect of ['4.1', '4.2', '4.3', '4.4']) {
      expect(doc, `нет дефекта ${defect}`).toContain(`| ${defect} |`);
    }
    expect(doc, 'нет sha256').toMatch(/sha256/i);
    expect(doc, 'нет полного sha256 до мутации').toContain('0B19A62E');
    expect(doc, 'не сказано про повторный зелёный прогон').toMatch(/зелён/i);
    expect(doc, 'нет дословных подмен — контроль не повторить').toMatch(/было[\s\S]*стало/i);
  });

  it('инъекция живёт в коде, а тесты дефектов — в репозитории', () => {
    const source = read(SIMULATOR);
    const tests = read(SIMULATOR_TEST);
    for (const flag of [
      'ignoreDependencies',
      'latencyClassOverride',
      'ignoreReorder',
      'swapAddToSub',
    ]) {
      expect(source, `в коде нет инъекции ${flag}`).toContain(flag);
      expect(tests, `в тестах нет дефекта ${flag}`).toContain(flag);
    }
    expect(source, 'инъекция не помечена как негативный контроль').toMatch(
      /только.*негативн|негативн.*контрол/i,
    );
  });
});

describe('стоячий контроль формулировок: «e2k-такты» и «реальные такты» без оговорки', () => {
  it('в документах нет этих формулировок без оговорки, что речь о модели', () => {
    const problems = TICK_PHRASE_DOCS.flatMap((file) =>
      bareTickClaims(read(file)).map((line) => `${file}: ${line}`),
    );
    expect(problems, `формулировка без оговорки:\n${problems.join('\n')}`).toEqual([]);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: проверка ловит подложенный текст', () => {
    const bad = [
      'Наши e2k-такты посчитаны точно.',
      'Реальные такты на Эльбрусе мы не измеряли.',
      'Это симулятор на оболочке, а не e2k-такты.',
      'Реальные такты даст только железо.',
    ].join('\n');
    const problems = bareTickClaims(bad);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('посчитаны точно');
    expect(problems[1]).toContain('даст только железо');
    // И чистый текст проверкой не задевается — иначе контроль был бы красен всегда.
    expect(bareTickClaims('Такты по модели, а не измерение: см. docs/vliw-e2k-model.md.')).toEqual([]);
  });
});
