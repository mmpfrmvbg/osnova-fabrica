/**
 * СТОРОЖ СЧЁТА ФАЙЛОВ ОРАКУЛОВ: ПОЛНЫЙ ПРОГОН НЕ ЗНАЕТ, СКОЛЬКО ИХ ДОЛЖНО БЫТЬ.
 *
 * # Дефект, ради которого это написано
 *
 * Полный прогон сообщает «126 файлов, 0 падений» — и это **не оракул**: он не знает, что файлов
 * должно быть 128. Молчание выглядит как факт. Измерено 2026-09-19: `src/scripts/
 * e2kQemuRun.audit.test.ts` в полном прогоне **отсутствовал**, а в статическом сборе
 * присутствовал с 8 проверками; арифметика (126 + 2 шлюза = 128, 2146 + 13 = 2159) говорит, что
 * его не было и до правки. Механизм **не найден** (`docs/verification-debt.md`, случай 13).
 *
 * # Что делает сторож
 *
 * Берёт **два** списка и сравнивает их:
 *
 * | список | откуда |
 * |---|---|
 * | что обязано проверяться | `git ls-files` по `*.test.ts` — то, что лежит **в репозитории** |
 * | что проверялось | отчёт прогона (`vitest run --reporter=json --outputFile=…`) |
 *
 * Расхождение называется **по имени файла**, а не числом:
 *
 * | расхождение | что это значит |
 * |---|---|
 * | файл есть в репозитории, но не попал в прогон и не назван исключением | **оракул выпал** (случай 13) |
 * | файл попал в прогон, но его нет в репозитории | проверка исполняется, а **в коммит не попадёт** (случай 7) |
 * | исключение не объясняет ни одного файла | исключение устарело и прикрывает уже несуществующее (случай 1: «имена вместо наличия») |
 *
 * # Почему список исключений — здесь, а не выведен из конфига
 *
 * Вывести его из `vitest.config.ts` значило бы **повторить ошибку**: конфиг и проверка сверялись бы
 * друг с другом, а не с репозиторием. Здесь исключение — это **утверждение с причиной**, и оно
 * проверяется на непустоту: устаревшее исключение краснеет, потому что прикрывает несуществующее.
 *
 * # Чего сторож НЕ делает
 *
 * Не проверяет, что внутри собранных файлов есть проверки: файл, собранный с нулём тестов, для
 * этого сторожа выглядит собранным. Это следующий долг, названный явно, а не скрытый.
 *
 * Использование:
 *   npm run check:test-files      # после прогона с --reporter=json
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const REPORT = path.join(ROOT, '.tmp', 'vitest-report.json');

/**
 * Исключение: файл, который **не обязан** попадать в полный прогон.
 *
 * `match` — подстрока пути. Простота намеренная: сложный шаблон сам стал бы предметом доверия, а
 * проверяется здесь другое — что исключение **что-то объясняет**.
 */
export interface TestFileExclusion {
  readonly match: string;
  readonly reason: string;
  /**
   * Структурный шаблон (из самого itest.config.ts): он охраняет и то, чего в репозитории ещё
   * нет, поэтому «не объяснил ни одного файла» для него не дефект. Наши собственные исключения
   * (QEMU) обязаны объяснять файл, иначе они прикрывают несуществующее.
   */
  readonly structural?: boolean;
}

/** Исключения с причиной. Каждое обязано объяснять хотя бы один файл. */
export const EXPECTED_EXCLUSIONS: readonly TestFileExclusion[] = [
  { match: 'node_modules', reason: 'зависимости: не наши оракулы', structural: true },
  { match: '.e2e.test.ts', reason: 'e2e-набор живёт в отдельном конфиге (npm run test:e2e-osiris)', structural: true },
  { match: 'apps/osiris', reason: 'приложение Osiris: свой пакет и свой прогон', structural: true },
  { match: 'Fabrika2.0', reason: 'legacy-копия прежней фабрики, не отслеживается git (см. BIG-PICTURE.md)', structural: true },
  { match: 'dist/', reason: 'сборка, а не исходники', structural: true },
  { match: 'vitest.config.test.ts', reason: 'исключён самим vitest.config.ts (шаблон **/vitest.config.test.ts)', structural: true },
  {
    match: 'e2kQemuExec.test.ts',
    reason: 'вынесен в gate:qemu: живой qemu-e2k, ресурсозависимый (случай 12 реестра проверяемости)',
  },
  {
    match: 'e2kQemuRun.audit.test.ts',
    reason: 'то же: проба живого прогона QEMU, не в полном прогоне',
  },
];

/** Разбор расхождений. */
export interface TestFileAudit {
  /** Сколько файлов оракулов лежит в репозитории. */
  readonly expected: number;
  /** Сколько файлов прогон собрал. */
  readonly collected: number;
  /** Оракул есть в репозитории, но в прогон не попал и исключением не объяснён — ДЕФЕКТ. */
  readonly dropped: readonly string[];
  /**
   * Числится в git, но на диске отсутствует (sparse-checkout или удаление). Это **не** «выпал из
   * прогона»: собирать нечего. Смешивать эти два факта нельзя — иначе сторож обвиняет прогон в
   * том, чего на машине нет (на этом он и ошибся в первой версии, объявив выпавшими пять файлов).
   */
  readonly absentFromDisk: readonly string[];
  /** Файл исполнился в прогоне, но в репозитории его нет — в коммит не попадёт. */
  readonly untracked: readonly string[];
  /** Исключение, которое ничего не объясняет: устарело. */
  readonly staleExclusions: readonly string[];
}

/**
 * Ключ файла — одинаковый для пути из git и для пути из отчёта прогона.
 *
 * Обе стороны обязаны приводиться **одним** правилом, иначе проверка обвиняет невиновных: первая
 * версия срезала по-разному (путь из git `src/scripts/x.test.ts` → `scripts/x.test.ts`, абсолютный
 * `…/src/scripts/x.test.ts` → `src/scripts/x.test.ts`) и на первом же запуске объявила выпавшими
 * 17 файлов, которых прогон как раз собирал. Правило простое: если в пути есть `src/` — ключ от
 * `src/`; иначе (корневые `package.test.ts`, `tsconfig.test.ts`) — имя файла.
 */
function relative(file: string): string {
  const normalized = file.replace(/\\/g, '/');
  const marker = normalized.lastIndexOf('/src/');
  if (marker >= 0) return normalized.slice(marker + 1);
  if (normalized.startsWith('src/')) return normalized;
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

/** Объясняет ли хоть одно исключение этот путь. */
function exclusionFor(file: string, exclusions: readonly TestFileExclusion[]): TestFileExclusion | undefined {
  return exclusions.find((exclusion) => file.includes(exclusion.match));
}

/**
 * Сверить два списка. **Чистая функция** — у неё есть свой негативный контроль
 * (`src/scripts/testFiles.audit.test.ts`), иначе сторож не проверка, а украшение.
 */
export function auditTestFiles(
  tracked: readonly string[],
  collected: readonly string[],
  exclusions: readonly TestFileExclusion[] = EXPECTED_EXCLUSIONS,
  onDisk: readonly string[] = tracked,
): TestFileAudit {
  const trackedSet = new Set(tracked.map(relative));
  const onDiskSet = new Set(onDisk.map(relative));
  const collectedSet = new Set(collected.map(relative));
  const dropped: string[] = [];
  const absentFromDisk: string[] = [];
  const usedExclusions = new Set<string>();
  for (const file of trackedSet) {
    if (!onDiskSet.has(file)) {
      absentFromDisk.push(file);
      continue;
    }
    if (collectedSet.has(file)) continue;
    const exclusion = exclusionFor(file, exclusions);
    if (exclusion === undefined) {
      dropped.push(file);
      continue;
    }
    usedExclusions.add(exclusion.match);
  }
  const untracked = [...collectedSet].filter((file) => !trackedSet.has(file)).sort();
  const staleExclusions = exclusions
    .filter((item) => item.structural !== true && !usedExclusions.has(item.match))
    .map((item) => item.match);
  return {
    expected: trackedSet.size,
    collected: collectedSet.size,
    dropped: dropped.sort(),
    absentFromDisk: absentFromDisk.sort(),
    untracked,
    staleExclusions,
  };
}

/** Файлы оракулов, отслеживаемые git. `undefined` — git недоступен (причина называется). */
export function trackedTestFiles(): string[] | undefined {
  try {
    const output = execFileSync('git', ['ls-files', '*.test.ts'], { cwd: ROOT, encoding: 'utf-8' });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '' && line.endsWith('.test.ts'));
  } catch {
    return undefined;
  }
}

/** Файлы, попавшие в прогон, по его JSON-отчёту. `undefined` — отчёта нет. */
export function collectedTestFiles(reportFile = REPORT): string[] | undefined {
  if (!fs.existsSync(reportFile)) return undefined;
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf-8')) as {
    testResults?: { name?: string }[];
  };
  return (report.testResults ?? []).map((item) => item.name ?? '').filter((name) => name !== '');
}

/**
 * Проблема с корнем проверки. `undefined` — корень выглядит как корень репозитория.
 *
 * Зачем это отдельная функция: **уверенный вывод проверки, которая не показывает, что именно она
 * проверяла, перепроверить нельзя**. Наблюдённое 2026-09-19: сторож печатал «на диске 145», тогда
 * как прямая проверка тех же файлов давала «на диске нет» — два измерения противоречили, и по
 * выводу нельзя было понять, какое из них врёт. Поэтому корень, cwd и счётчики печатаются всегда,
 * а несуществующий корень — красное, а не «ноль расхождений».
 */
export function rootProblem(root: string): string | undefined {
  const missing: string[] = [];
  if (!fs.existsSync(path.join(root, 'package.json'))) missing.push('package.json');
  if (!fs.existsSync(path.join(root, 'src'))) missing.push('src/');
  if (missing.length === 0) return undefined;
  return (
    `корень проверки не похож на корень репозитория: ${root} — нет ${missing.join(', ')}; ` +
    'выводы сторожа при таком корне недействительны'
  );
}

/**
 * Строки доказательства по каждому расхождению: путь и **оба** ответа про него.
 *
 * `tracked=true onDisk=false` читается однозначно: файл числится в git и на диске его нет — это
 * утверждение о дереве, а не о прогоне.
 */
export function evidenceLines(
  audit: TestFileAudit,
  root: string,
): readonly string[] {
  const lines: string[] = [];
  for (const file of audit.absentFromDisk) {
    lines.push(`  ДОКАЗАТЕЛЬСТВО: ${file} — tracked=да onDisk=нет (существует: ${fs.existsSync(path.join(root, file))})`);
  }
  for (const file of audit.dropped) {
    // Оба ответа ИЗМЕРЯЮТСЯ, а не подставляются: подставленное «onDisk=да» было бы утверждением
    // без проверки — ровно тем дефектом, ради которого этот сторож и написан.
    const present = fs.existsSync(path.join(root, file));
    lines.push(`  ДОКАЗАТЕЛЬСТВО: ${file} — tracked=да onDisk=${present ? 'да' : 'нет'} collected=нет`);
  }
  for (const file of audit.untracked) {
    lines.push(`  ДОКАЗАТЕЛЬСТВО: ${file} — tracked=нет onDisk=${fs.existsSync(path.join(root, file)) ? 'да' : 'нет'} collected=да`);
  }
  return lines;
}

/** Собрать расхождения и напечатать их с именами файлов и доказательствами. */
export function runAudit(): number {
  console.log(`сторож счёта файлов: ROOT=${ROOT}`);
  console.log(`сторож счёта файлов: cwd=${process.cwd()}`);
  console.log(`сторож счёта файлов: отчёт=${REPORT} (есть: ${fs.existsSync(REPORT) ? 'да' : 'нет'})`);
  const problem = rootProblem(ROOT);
  if (problem !== undefined) {
    console.error(`  КРАСНО: ${problem}`);
    return 1;
  }
  const tracked = trackedTestFiles();
  if (tracked === undefined) {
    console.error('сторож счёта файлов: git недоступен — проверка не выполнена (это не «пройдено»)');
    return 1;
  }
  const onDisk = tracked.filter((file) => fs.existsSync(path.join(ROOT, file)));
  const collected = collectedTestFiles();
  if (collected === undefined) {
    console.error(
      `сторож счёта файлов: нет отчёта прогона ${path.relative(ROOT, REPORT)} — ` +
        'прогон обязан идти с --reporter=json --outputFile (см. scripts.test)',
    );
    return 1;
  }
  const audit = auditTestFiles(tracked, collected, EXPECTED_EXCLUSIONS, onDisk);
  console.log(
    `сторож счёта файлов: tracked=${audit.expected}, onDisk=${onDisk.length}, collected=${audit.collected}`,
  );
  for (const line of evidenceLines(audit, ROOT)) console.log(line);
  const problems: string[] = [];
  for (const file of audit.dropped) {
    problems.push(
      `оракул выпал из прогона: ${file} — в репозитории есть, в прогоне нет и исключением не объяснён ` +
        '(docs/verification-debt.md, случай 13)',
    );
  }
  for (const file of audit.untracked) {
    problems.push(
      `проверка вне репозитория: ${file} — исполнилась в прогоне, но в коммит не попадёт ` +
        '(docs/verification-debt.md, случай 7)',
    );
  }
  for (const pattern of audit.staleExclusions) {
    problems.push(
      `устаревшее исключение «${pattern}»: не объясняет ни одного файла — прикрывает несуществующее ` +
        '(docs/verification-debt.md, случай 1)',
    );
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`  КРАСНО: ${problem}`);
    console.error(`итого расхождений: ${problems.length}`);
    return 1;
  }
  console.log('расхождений нет: каждый файл оракула либо собран, либо объяснён исключением с причиной');
  return 0;
}

if (require.main === module) {
  process.exitCode = runAudit();
}
