/**
 * НЕГАТИВНЫЙ КОНТРОЛЬ ДВУХПРОХОДНОЙ РАСКЛАДКИ: ЧЕТЫРЕ ДЕФЕКТА, ВНЕСЁННЫЕ В ИСХОДНИК.
 *
 * # Зачем это отдельный инструмент, а не тест
 *
 * Негативный контроль проверяет **оракул**, а не функцию: нужно испортить **сам исходник** и
 * убедиться, что оракул покраснеет. Тест так не может — он не правит исходники. Поэтому дефект
 * вносится в файл, прогоняется оракул, файл **восстанавливается из копии, снятой до мутации**
 * (восстановление из испорченного файла ничего не доказывает), и сверяется sha256 до и после.
 *
 * # Что именно ломается
 *
 * | # | дефект | что обязан поймать оракул |
 * |---|---|---|
 * | 4.1 | второй проход снят, смещения нулевые | 1.3 (смещение и адрес цели) |
 * | 4.2 | размер длинной команды взят коротким (8 вместо 16) | 1.2 (размер из формы), 1.5 (круг) |
 * | 4.3 | смещение в байтах, а не в восьмибайтных единицах | 1.3 |
 * | 4.4 | поле `disp` прочитано беззнаково (переход назад) | 1.4 (разрядность), 1.5 (круг) |
 *
 * Дефект 4.4 проверяет **знаковое** чтение поля: без него переход назад даёт `0x0fffffff`
 * (268 435 455) вместо −1, и цель уезжает на гигабайт.
 *
 * # Правило
 *
 * Ни один прогон с дефектом не считается успехом контроля, если после восстановления оракул не
 * позеленел: значит сломалось что-то ещё, и «поймано» ничего не значит.
 *
 * Использование:
 *   npx tsx src/scripts/e2kLayoutNegativeControl.ts
 *   отчёт: .tmp/e2k-layout-negative-control.json, копии «до» — .tmp/e2k-layout-negative-control/
 */

import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const WORK = path.join(ROOT, '.tmp', 'e2k-layout-negative-control');
const REPORT = path.join(ROOT, '.tmp', 'e2k-layout-negative-control.json');
const VITEST = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');

/** Один дефект: файл, точная замена и оракулы, которые обязаны покраснеть. */
interface Defect {
  readonly id: string;
  readonly title: string;
  readonly file: string;
  /** Что заменить — дословно, как в исходнике. */
  readonly from: string;
  readonly to: string;
  /** Оракулы, на которых проверяется дефект. */
  readonly tests: readonly string[];
}

/**
 * Таблица дефектов.
 *
 * Замены — **точные строки исходника**: если строка не найдена, инструмент останавливается, а не
 * «примерно» правит (иначе контроль проверял бы не то, что записано в таблице).
 */
export const DEFECTS: readonly Defect[] = [
  {
    id: '4.1',
    title: 'второй проход снят — смещения остаются нулевыми',
    file: 'src/e2k/twoPassLayout.ts',
    from: 'const disp = delta / DISP_UNITS;',
    to: 'const disp = 0; // ДЕФЕКТ 4.1: второй проход снят',
    tests: ['src/e2k/twoPassLayout.test.ts'],
  },
  {
    id: '4.2',
    title: 'размер длинной формы взят коротким: 8 вместо 16',
    file: 'src/e2k/twoPassLayout.ts',
    from: '{ mnemonic: "muls", form: "ALF11", size: REAL_LONG_FORM_SIZE, source: LONG_SOURCE }',
    to: '{ mnemonic: "muls", form: "ALF11", size: REAL_SHORT_FORM_SIZE, source: LONG_SOURCE /* ДЕФЕКТ 4.2 */ }',
    tests: ['src/e2k/twoPassLayout.test.ts', 'src/e2k/e2kRealRun.test.ts'],
  },
  {
    id: '4.3',
    title: 'смещение в байтах, а не в восьмибайтных единицах',
    file: 'src/e2k/twoPassLayout.ts',
    from: 'const disp = delta / DISP_UNITS;',
    to: 'const disp = delta; // ДЕФЕКТ 4.3: байты вместо единиц',
    tests: ['src/e2k/twoPassLayout.test.ts'],
  },
  {
    id: '4.4',
    title: 'знаковое расширение не учтено (переход назад)',
    file: 'src/e2k/e2k-real.ts',
    from: '  return raw >= 2 ** (DISP_BITS - 1) ? raw - 2 ** DISP_BITS : raw;',
    to: '  return raw; // ДЕФЕКТ 4.4: поле прочитано беззнаково',
    tests: ['src/e2k/twoPassLayout.test.ts'],
  },
];

/** sha256 файла — им сверяется «до» и «после». */
export function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
}

/** Прогон оракулов: сколько прошло и какие проверки покраснели. */
export interface OracleRun {
  /**
   * Сколько проверок **собрано** прогоном.
   *
   * Ноль означает, что прогон не состоялся (например, мутация сломала разбор файла). Это нельзя
   * читать как «оракул не поймал»: выводы противоположны — «контроль недействителен» против
   * «оракул слеп». Различать их обязан сам инструмент (случай 10 реестра проверяемости).
   */
  readonly collected: number;
  readonly passed: number;
  readonly failed: readonly string[];
  /** Код возврата vitest: 0 — зелено. */
  readonly exitCode: number;
}

/**
 * Прогнать список оракулов и вернуть имена покрасневших проверок.
 *
 * Отчёт берётся машинным (`--reporter=json --outputFile`), а не из текста: имена проверок —
 * русские, и разбор вывода зависел бы от кодировки консоли.
 */
export function runOracles(tests: readonly string[], jsonFile: string): OracleRun {
  let exitCode = 0;
  try {
    execFileSync(
      process.execPath,
      [VITEST, 'run', ...tests, '--reporter=json', `--outputFile=${jsonFile}`],
      { cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'], timeout: 900_000 },
    );
  } catch (error) {
    exitCode = typeof error === 'object' && error !== null && 'status' in error ? Number((error as { status: unknown }).status) : 1;
  }
  if (!fs.existsSync(jsonFile)) return { collected: 0, passed: 0, failed: ['<нет отчёта оракулов>'], exitCode };
  const report = JSON.parse(fs.readFileSync(jsonFile, 'utf-8')) as {
    testResults: { assertionResults: { status: string; fullName: string }[] }[];
  };
  const all = report.testResults.flatMap((file) => file.assertionResults);
  return {
    collected: all.length,
    passed: all.filter((item) => item.status === 'passed').length,
    failed: all.filter((item) => item.status === 'failed').map((item) => item.fullName),
    exitCode,
  };
}

/** Что записано в отчёт по одному дефекту. */
export interface DefectReport {
  readonly id: string;
  readonly title: string;
  readonly file: string;
  readonly shaBefore: string;
  readonly shaAfter: string;
  readonly shaMatch: boolean;
  /** Изменила ли мутация файл: неизменившая — не контроль. */
  readonly mutatedChanged: boolean;
  readonly caughtBy: readonly string[];
  readonly caught: number;
  /** Сколько проверок собрал прогон с дефектом: ноль — контроль недействителен, а не «оракул слеп». */
  readonly mutatedCollected: number;
  readonly restoredCollected: number;
  readonly restoredFailed: number;
  readonly restoredPassed: number;
}

/** Внести дефект, прогнать, восстановить из копии, сверить sha256 и прогнать снова. */
export function checkDefect(defect: Defect, work = WORK): DefectReport {
  fs.mkdirSync(work, { recursive: true });
  const file = path.join(ROOT, defect.file);
  const backup = path.join(work, `${path.basename(defect.file)}.${defect.id}.bak`);

  // Копия — ДО мутации: восстановление из испорченного файла ничего не доказывает.
  fs.copyFileSync(file, backup);
  const shaBefore = sha256(file);
  const source = fs.readFileSync(file, 'utf-8');
  if (!source.includes(defect.from)) {
    throw new Error(`дефект ${defect.id}: в ${defect.file} не найдено «${defect.from}»`);
  }
  fs.writeFileSync(file, source.replace(defect.from, defect.to), 'utf-8');
  // Мутация обязана изменить файл: правка-пустышка («from» равно «to») выглядела бы как контроль.
  const mutatedChanged = sha256(file) !== shaBefore;

  let caughtBy: readonly string[] = [];
  let mutatedCollected = 0;
  try {
    const mutated = runOracles(defect.tests, path.join(work, `run-${defect.id}.json`));
    caughtBy = mutated.failed;
    mutatedCollected = mutated.collected;
  } finally {
    fs.copyFileSync(backup, file); // восстановление из копии
  }
  const shaAfter = sha256(file);
  const restored = runOracles(defect.tests, path.join(work, `restored-${defect.id}.json`));

  return {
    id: defect.id,
    title: defect.title,
    file: defect.file,
    shaBefore,
    shaAfter,
    shaMatch: shaBefore === shaAfter,
    mutatedChanged,
    caughtBy,
    caught: caughtBy.length,
    mutatedCollected,
    restoredCollected: restored.collected,
    restoredFailed: restored.failed.length,
    restoredPassed: restored.passed,
  };
}

/**
 * Годен ли негативный контроль. Чистая функция — у неё **свой** негативный контроль
 * (`src/scripts/e2kLayoutNegativeControl.test.ts`), иначе она не проверка, а украшение.
 *
 * Проверяются три числа, а не одно: сколько проверок **собрано**, сколько прошло, сколько
 * покраснело. Ноль собранных — это «контроль недействителен», а не «оракул слеп»: выводы
 * противоположны (случай 10 реестра проверяемости).
 */
export function verdictOf(report: DefectReport): string[] {
  const problems: string[] = [];
  if (!report.mutatedChanged) {
    problems.push('мутация не изменила файл — контроль пустой');
  }
  if (report.mutatedCollected === 0) {
    problems.push('прогон с дефектом собрал 0 проверок: мутация сломала файл, а не оракул — контроль недействителен');
  }
  if (report.restoredCollected === 0) {
    problems.push('прогон после восстановления собрал 0 проверок: восстановление не вернуло рабочий файл');
  }
  if (report.mutatedCollected !== report.restoredCollected) {
    problems.push(
      `собрано проверок: с дефектом ${report.mutatedCollected}, после восстановления ` +
        `${report.restoredCollected} — это разные объекты, контроль недействителен`,
    );
  }
  if (report.caught === 0) {
    problems.push('ни один оракул не покраснел — контроль ничего не проверяет');
  }
  if (!report.shaMatch) {
    problems.push(`sha256 разошёлся: ${report.shaBefore} → ${report.shaAfter}`);
  }
  if (report.restoredFailed > 0) {
    problems.push(`после восстановления осталось красным: ${report.restoredFailed}`);
  }
  return problems;
}

/** Прогнать все дефекты, проверить восстановление и записать отчёт. */
export function runAll(defects: readonly Defect[] = DEFECTS, work = WORK): DefectReport[] {
  const reports: DefectReport[] = [];
  let passed = 0;
  let failed = 0;
  for (const defect of defects) {
    const report = checkDefect(defect, work);
    reports.push(report);
    const problems = verdictOf(report);
    console.log(
      `${problems.length === 0 ? 'ПОЙМАН  ' : 'ПРОБЛЕМА'} ${report.id} ${report.title}\n` +
        `         файл ${report.file}\n` +
        `         собрано проверок: с дефектом ${report.mutatedCollected}, после восстановления ${report.restoredCollected}\n` +
        `         покраснело ${report.caught}: ${report.caughtBy.slice(0, 3).join(' | ')}${report.caught > 3 ? ' | …' : ''}\n` +
        `         sha256 до ${report.shaBefore} после ${report.shaAfter} совпал: ${report.shaMatch}\n` +
        `         после восстановления: прошло ${report.restoredPassed}, покраснело ${report.restoredFailed}`,
    );
    for (const problem of problems) console.log(`         ${problem}`);
    if (problems.length === 0) passed++;
    else failed++;
  }
  console.log(`\nитого: дефектов ${defects.length}; поймано без замечаний ${passed}; с замечаниями ${failed}`);
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(
    REPORT,
    `${JSON.stringify({ format: 'osnova-e2k-layout-negative-control', version: 1, defects: reports }, null, 2)}\n`,
    'utf-8',
  );
  console.log(`отчёт: ${path.relative(ROOT, REPORT)}`);
  return reports;
}

if (require.main === module) {
  try {
    runAll();
  } catch (error) {
    console.error(`останов: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
