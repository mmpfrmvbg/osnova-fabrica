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
    match: 'e2kSyscallRuntime.test.ts',
    reason: 'исполняет QEMU (hello через syscall write), вынесен из полного прогона в gate:qemu по случаю 12',
  },
  {
    match: 'e2kQemuRun.audit.test.ts',
    reason: 'то же: проба живого прогона QEMU, не в полном прогоне',
  },
  {
    match: 'qemuModelIdentity.test.ts',
    reason:
      'паспорт модели: спрашивает версию и sha256 у живой сборки qemu-e2k в WSL, ' +
      'вынесен в gate:qemu по случаю 12',
  },
  {
    match: 'e2kWideQemu.test.ts',
    reason: 'исполняет широкие команды в QEMU (exit-коды), вынесен в gate:qemu по случаю 12',
  },
  {
    match: 'e2kMemoryQemu.test.ts',
    reason: 'исполняет запись/чтение памяти в QEMU (exit-коды), вынесен в gate:qemu по случаю 12',
  },
  {
    match: 'e2kArraysQemu.test.ts',
    reason: 'исполняет массивы (память вместо invoke) в QEMU, вынесен в gate:qemu по случаю 12',
  },
  {
    match: 'e2kCallWindowQemu.test.ts',
    reason: 'измеряет окно вызываемой процедуры и `return` прогоном в QEMU, вынесен в gate:qemu по случаю 12',
  },
  {
    match: 'e2kConvolutionQemu.test.ts',
    reason: 'ресурсозависимый, живёт в gate:qemu: встраивание свёртки измеряется прогоном в QEMU (случай 12)',
  },
  {
    match: 'e2kMathQemu.test.ts',
    reason: 'ресурсозависимый, живёт в gate:qemu: математические ядра исполняются в QEMU (случай 12)',
  },
  {
    match: 'examplesE2k.audit.test.ts',
    reason:
      'ресурсозависимый, живёт в gate:qemu: исполняет на цели примеры корпуса, объявленные исполняемыми, и сверяет с тем же expected.txt (случай 12)',
  },
  // Пять тест-ЦЕЛЕЙ e2k: не состояние, а требование завершённой работы линии.
  // Красные одинаково на всех ветках (docs/hardware-debt.md §3.23), поэтому в
  // полном прогоне они стирали различие «сломали» и «ещё не доделали».
  {
    match: 'e2kPredicatePairs.test.ts',
    reason: 'тест-цель, живёт в test:e2k-targets: раскладка даёт регистр вне поля слога',
  },
  {
    match: 'elfMinimal.test.ts',
    reason: 'тест-цель, живёт в test:e2k-targets: ожидания под короткую форму 0xc0|N не перемерены',
  },
  {
    match: 'regAlloc.test.ts',
    reason: 'тест-цель, живёт в test:e2k-targets: звуковая правка раскладки в дерево не внесена',
  },
  {
    match: 'rematerialize.test.ts',
    reason: 'тест-цель, живёт в test:e2k-targets: `фильтр` требует 11 живых при окне вызываемой 8',
  },
  {
    match: 'twoPassLayout.test.ts',
    reason: 'тест-цель, живёт в test:e2k-targets: длина носителя IR.invoke ждёт правки рантайма массивов',
  },
  {
    match: 'e2kRealRun.test.ts',
    reason: 'тест-цель, живёт в test:e2k-targets: падает на загрузке — регистр 193 вне поля слога',
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
export function relative(file: string): string {
  const normalized = file.replace(/\\/g, '/');
  const marker = normalized.toLowerCase().lastIndexOf('/osnova-fabrika/');
  const withoutRoot = marker >= 0 ? normalized.slice(marker + '/osnova-fabrika/'.length) : normalized;
  return withoutRoot.startsWith('./') ? withoutRoot.slice(2) : withoutRoot;
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

/**
 * Сырой вывод `git ls-files` — **без** декодирования, чтобы увидеть кодировку.
 *
 * Зачем: 2026-09-19 сторож печатал `tracked=145, onDisk=145`, тогда как прямые проверки тех же имён
 * давали «нет ни на диске, ни в индексе». Оба входа сторожа врали одновременно — значит смотреть
 * надо не на разбор, а на **сырые байты**: если вывод не UTF-8 (в этом окружении `wsl.exe` уже
 * отдаёт UTF-16LE, `src/scripts/e2kExternalAs.ts` разбирает это явно), то `split('\n')` режет
 * байты пополам и даёт мусорные записи.
 */
export function rawGitOutput(nullSeparated: boolean): { bytes: Buffer; lines: readonly string[] } {
  const args = nullSeparated ? ['ls-files', '-z', '*.test.ts'] : ['ls-files', '*.test.ts'];
  const bytes = execFileSync('git', args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }) as Buffer;
  return { bytes, lines: decodeGitOutput(bytes, nullSeparated) };
}

/** Разобрать вывод git: `-z` — по `\0`, иначе по переводам строк; без обрезки пробелов. */
export function decodeGitOutput(bytes: Buffer, nullSeparated: boolean): string[] {
  const text = bytes.toString('utf-8');
  return text
    .split(nullSeparated ? '\u0000' : /\r?\n/)
    .filter((line) => line !== '' && line.endsWith('.test.ts'));
}

/** Отчёт о кодировке: байты против символов. */
export interface EncodingProbe {
  readonly line: string;
  readonly hex: string;
  readonly bytes: number;
  readonly characters: number;
  /** Байт вдвое больше символов — признак двухбайтовой кодировки (UTF-16). */
  readonly twoBytesPerCharacter: boolean;
}

/** Побайтовый разбор первых строк вывода: hex, длина в байтах и в символах. */
export function encodingProbe(bytes: Buffer, limit = 5, nullSeparated = false): readonly EncodingProbe[] {
  const parts = bytes
    .toString('latin1')
    .split(nullSeparated ? '\u0000' : /\r?\n/)
    .filter((line) => line !== '');
  return parts.slice(0, limit).map((line) => {
    const raw = Buffer.from(line, 'latin1');
    return {
      line,
      hex: raw.subarray(0, 32).toString('hex').replace(/(..)/g, '$1 ').trim(),
      bytes: raw.length,
      characters: line.length,
      twoBytesPerCharacter: raw.length === line.length * 2 && line.length > 0,
    };
  });
}

/**
 * Файлы оракулов, отслеживаемые git.
 *
 * `-z` (null-terminated) — разделитель `\0`, поэтому **кодировка не важна**: узкие и широкие
 * строки разделяются одинаково. Обычный режим оставлен для сравнения замеров.
 *
 * `undefined` — git недоступен (причина называется).
 */
export function trackedTestFiles(nullSeparated = true): string[] | undefined {
  try {
    const args = nullSeparated ? ['ls-files', '-z', '*.test.ts'] : ['ls-files', '*.test.ts'];
    const bytes = execFileSync('git', args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }) as Buffer;
    return decodeGitOutput(bytes, nullSeparated);
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
 * Строки доказательства по каждому расхождению: **точный** путь, переданный в `existsSync`, и ответ.
 *
 * Путь печатается сырым (абсолютным), а не нормализованным ключом: нормализация уже один раз
 * скрыла, что именно проверялось, и из-за этого спор о «145» нельзя было решить по выводу.
 */
export function evidenceLines(
  audit: TestFileAudit,
  root: string,
): readonly string[] {
  const lines: string[] = [];
  const exact = (file: string): string => path.resolve(root, file);
  for (const file of audit.absentFromDisk) {
    const target = exact(file);
    lines.push(`  ДОКАЗАТЕЛЬСТВО: ${file} — tracked=да onDisk=${fs.existsSync(target) ? 'да' : 'нет'} путь=${target}`);
  }
  for (const file of audit.dropped) {
    // Оба ответа ИЗМЕРЯЮТСЯ, а не подставляются: подставленное «onDisk=да» было бы утверждением
    // без проверки — ровно тем дефектом, ради которого этот сторож и написан.
    const target = exact(file);
    const present = fs.existsSync(target);
    lines.push(`  ДОКАЗАТЕЛЬСТВО: ${file} — tracked=да onDisk=${present ? 'да' : 'нет'} collected=нет путь=${target}`);
  }
  for (const file of audit.untracked) {
    const target = exact(file);
    lines.push(`  ДОКАЗАТЕЛЬСТВО: ${file} — tracked=нет onDisk=${fs.existsSync(target) ? 'да' : 'нет'} collected=да путь=${target}`);
  }
  return lines;
}

/** Отчёт о кодировке вывода git: сырые строки, hex, длины, вердикт. */
export function rawReport(nullSeparated = false): readonly string[] {
  const { bytes, lines } = rawGitOutput(nullSeparated);
  const probes = encodingProbe(bytes, 5, nullSeparated);
  const out: string[] = [];
  out.push(`сырые данные git ls-files${nullSeparated ? ' -z' : ''}: байт всего ${bytes.length}, строк после разбора ${lines.length}`);
  out.push(`первые байты буфера: ${bytes.subarray(0, 16).toString('hex').replace(/(..)/g, '$1 ').trim()}`);
  for (const probe of probes) {
    out.push(
      `  строка «${probe.line}»: hex=${probe.hex} | байт=${probe.bytes} символов=${probe.characters} ` +
        `| вдвое=${probe.twoBytesPerCharacter ? 'да' : 'нет'}`,
    );
  }
  const twoByte = probes.filter((probe) => probe.twoBytesPerCharacter).length;
  out.push(
    twoByte === probes.length && probes.length > 0
      ? 'вердикт: байт вдвое больше символов — вывод ДВУХБАЙТОВЫЙ (UTF-16-подобный), split по \\n режет байты пополам'
      : `вердикт: двухбайтовых строк ${twoByte} из ${probes.length} — вывод похож на UTF-8`,
  );
  return out;
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
  // Оба режима разбора рядом: если счёт разойдётся, дело в разделителе (то есть в кодировке).
  const trackedNull = trackedTestFiles(true);
  const trackedLines = trackedTestFiles(false);
  console.log(
    `сторож счёта файлов: tracked(-z)=${trackedNull?.length ?? 'нет'} tracked(перевод строки)=${trackedLines?.length ?? 'нет'}`,
  );
  const tracked = trackedNull;
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
  if (process.argv.includes('--raw')) {
    for (const line of rawReport(process.argv.includes('-z'))) console.log(line);
  } else {
    process.exitCode = runAudit();
  }
}
