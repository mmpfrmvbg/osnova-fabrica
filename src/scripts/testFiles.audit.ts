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
 * # ПРАВИЛО: НОЛЬ СОБРАННЫХ ПРОВЕРОК — ЭТО КРАСНОЕ (2026-09-28)
 *
 * Сторож, который не собрал ни одной проверки, выглядит зелёным **ровно так же**, как работающий:
 * «файл собран» и «в файле есть проверки» — разные утверждения, и первое без второго ничего не
 * значит. Замер, ради которого правило заведено: механизм негативных контролей раскладки
 * (`src/scripts/e2kLayoutNegativeControl.ts`, 36 записей) был наполовину мёртв — **23 записи из 36**
 * собирали ноль проверок с 23.09, потому что их оракулы вынесли из полного прогона в отдельные
 * конфиги (`afca551`), а конфиг у записей не проставили. Половина утверждения «дефекты ловятся» была
 * проверена на бумаге четыре дня — и выглядела зелёной.
 *
 * Проверяются **два** источника, и оба без исполнения:
 *
 * | что | откуда | что краснеет |
 * |---|---|---|
 * | файл собран, но проверок в нём ноль | отчёт прогона (`assertionResults`) | имя файла |
 * | запись негативного контроля собирает ноль | `vitest list --config=…` по её оракулам | id записи, конфиг и файл |
 *
 * Записи, которые собирают ноль по структурной причине (оракулы живут в двух разных конфигах, а
 * инструмент запускает один), названы в `KNOWN_DEAD_CONTROLS` — **с причиной и числом**, и список
 * проверяется на устаревание: ожившая запись краснеет, потому что исключение перестало объяснять.
 *
 * # Чего сторож НЕ делает
 *
 * Не исполняет ни одного теста: `vitest list` собирает проверки, не запуская их.
 *
 * Использование:
 *   npm run check:test-files      # после прогона с --reporter=json
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as controlTables from './e2kLayoutNegativeControl';

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
    match: 'stringPrintLie.test.ts',
    reason:
      'девятая тихая ложь (случай 71): без модели файл обязан краснеть (случай 12), поэтому в полном ' +
      'прогоне ему места нет — он живёт в gate:qemu и там ЗЕЛЁНЫЙ (7 из 7, замер 2026-11-04, ПОСЛЕ ' +
      'починки обеих половин: лист печати возвращает постоянные точки входа, ноль разделённого сайта ' +
      'не берёт живые через сайт)',
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
    match: 'arrayWriteDepthTwo.test.ts',
    reason:
      'минимальное репро петли записи в массив на глубине 2 (§3.137): петля и различающий контроль ' +
      'спрашиваются у модели, вынесено в gate:qemu по случаю 12',
  },
  {
    match: 'arrayCalleeCreate.test.ts',
    reason:
      'создание массива из вызываемой процедуры (§3.137): числа 7 и 11 и обе границы (глубина 2, ' +
      '`добавить` в вызываемой) отвечает только модель, вынесено в gate:qemu по случаю 12',
  },
  {
    match: 'e2kCallWindowQemu.test.ts',
    reason: 'измеряет окно вызываемой процедуры и `return` прогоном в QEMU, вынесен в gate:qemu по случаю 12',
  },
  {
    match: 'callWindowRefusals.test.ts',
    reason:
      'разложение 43 отказов «окно вызываемой» по видам (§3.138): работающая сторона границ ' +
      'спрашивается у модели (3/1/11/21), вынесено в gate:qemu по случаю 12',
  },
  {
    match: 'spillCallee.test.ts',
    reason:
      'вытеснение в вызываемой (§3.140.3, K2 среза 5): граница по числу живых и работающая сторона ' +
      '(двойник в ДЕЙСТВИИ, модель 35/44/54/65) отвечает только прогон в модели, вынесено в gate:qemu ' +
      'по случаю 12',
  },
  {
    match: 'spillAcrossCall.test.ts',
    reason:
      'порча окна вызовом (случай 86, решение D35, 2026-11-07): число даёт только прогон в модели — ' +
      'вынесен в gate:qemu по случаю 12. Пока дефект был жив, сторож был КРАСНЫМ ПО ПОСТРОЕНИЮ ' +
      '(n9 = 38 вместо 45, n14 = 98 вместо 105); после правки он зелёный (36 / 45 / 105) и остаётся ' +
      'в шлюзе по той же причине — внешний ресурс',
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
    match: 'collectionsQemu.test.ts',
    reason:
      'ресурсозависимый, живёт в gate:qemu: коллекции на `brk` спрашиваются у МОДЕЛИ (сквозной прогон 100 записей), ' +
      'и путь до цели обязателен — коллекция, работающая только на VM, цели не достигает (§3.30, §3.95.5)',
  },
  {
    match: 'collectionsBrkQemu.test.ts',
    reason:
      'ресурсозависимый, живёт в gate:qemu: шаг блока коллекций (`8 + ёмкость·8`) — это РАЗНОСТЬ АДРЕСОВ, ' +
      'а адрес блока рантайм берёт у `brk` уже на цели; без прогона в модели величины не существует',
  },
  {
    match: 'invokeArityQemu.test.ts',
    reason:
      'ресурсозависимый, живёт в gate:qemu: «третий аргумент доехал до памяти» формой носителя не доказывается — ' +
      'нужен прогон в модели (форму держит src/e2k/invokeArity.test.ts в полном прогоне)',
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
  {
    match: 'calleeJoinLie.test.ts',
    reason:
      'сторож СЕДЬМОЙ тихой лжи (A4-5д, задача 6): число ПОД несомым отказом конъюнкции в ' +
      'ВЫЗЫВАЕМОЙ плоскости; ответ даёт только модель — та же причина, что у соседей.',
  },
  {
    match: 'calleePlaneAcceptance.test.ts',
    reason:
      'ПРИЁМКА седьмой тихой лжи МАТРИЦЕЙ КЛАССОВ (A4-5е, задача 4, D9): число контрольной точки ' +
      'входа даёт только модель, поэтому файл живёт в gate:qemu (случай 12) и без модели обязан ' +
      'КРАСНЕТЬ, а не пропускать проверку',
  },
  {
    match: 'printCalleeLie.test.ts',
    reason:
      'СТОРОЖ ВОСЬМОЙ тихой лжи (A4-5е, задача 5): печать внутри вызываемой + значение, возвращённое ' +
      'через вызов; и эталон обеих VM, и число модели спрашивает прогон, поэтому файл живёт в ' +
      'gate:qemu (случай 12) и без модели обязан КРАСНЕТЬ, а не пропускать проверку. Лживые числа ' +
      'записаны как KNOWN BAD — замер дефекта, починка 5ж',
  },
  {
    match: 'printCalleeAcceptance.test.ts',
    reason:
      'ПРИЁМКА восьмой тихой лжи МАТРИЦЕЙ КЛАССОВ (A4-5ж, задача 3, D9): печать внутри вызываемой плюс ' +
      'значение, возвращённое через вызов; число каждой из 33 проб даёт только прогон в живом QEMU ' +
      '(случай 12), поэтому файл живёт в gate:qemu и без модели обязан КРАСНЕТЬ, а не пропускать проверку',
  },
  {
    match: 'joinValueLie.test.ts',
    reason:
      'сторож класса «склейка» (A4, срез 5г): спрашивает ЧИСЛО под несущим отказом, а ответ даёт ' +
      'только прогон в живом QEMU (случай 12) — вынесен в gate:qemu, где модель гарантирована, и ' +
      'обязан там КРАСНЕТЬ без модели, а не пропускать проверку',
  },
  {
    match: 'calleeConjunctionAcceptance.test.ts',
    reason:
      'ПРИЁМКА седьмой тихой лжи МАТРИЦЕЙ КЛАССОВ (A4-5з, задача 4, D9/D11/D13): короткое замыкание ' +
      '`и` в плоскости ВЫЗЫВАЕМОЙ, 40 проб в 8 классах — число каждой даёт только прогон в живом QEMU ' +
      '(случай 12), поэтому файл живёт в gate:qemu и без модели обязан КРАСНЕТЬ, а не пропускать ' +
      'проверку. Механизм держит `calleeJoinLie.test.ts` (в полном прогоне, зелёный на честном отказе); ' +
      '2 аварии порта (форма `если не (…)` перед конъюнкцией) объявлены владельцем ПОИМЁННО и идут ' +
      'отдельным счётом — устаревшее объявление краснеет, авария вне списка краснит сразу',
  },
  {
    match: 'resultLowering.test.ts',
    reason:
      'понижение `Результат<Т, Е>` (срез 6, атом ATOM-06-02-01): различающая проба (оба исхода ' +
      '`добыть`, ветвь «Неудача» берётся только по прочитанному тегу) отвечает числом, а число даёт ' +
      'только прогон в живом QEMU — тот же случай 12, поэтому файл живёт в `gate:qemu`. Устройство ' +
      '(регистры тега `%r8` и нагрузки `%r9`, формы раскладки, порядок «вызов → чтение нагрузки») ' +
      'проверяется и без модели, но лежит в том же файле',
  },
  {
    match: 'resultStringDepth.test.ts',
    reason:
      'условие владельца перед `Строка.срез`/`склейкой` (срез 6, атом ATOM-06-02-02, задача 1): пара со ' +
      'СТРОКОЙ в нагрузке (адрес байтов = 1114106) и вызов пары ИЗ ВЫЗЫВАЕМОЙ (глубина ≥ 2, канал ' +
      '`%r33`) отвечают числами, а числа даёт только прогон в живом QEMU — тот же случай 12, поэтому ' +
      'файл живёт в `gate:qemu`. Устройство (две клетки канала, два сайта разбора), названные отказы ' +
      '(`OSN-LOW-003` на строковом параметре), литерал структуры и свидетель тихой лжи (случай 73) — в ' +
      'том же файле; без модели он обязан КРАСНЕТЬ, а не пропускать проверку',
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

// ─────────────────── ПРАВИЛО: НОЛЬ СОБРАННЫХ ПРОВЕРОК — ЭТО КРАСНОЕ ───────────────────

/** Сколько проверок собрано: имя (файл или запись) и число. */
export interface CollectedChecks {
  /** Имя файла либо запись негативного контроля — то, что печатает вердикт. */
  readonly name: string;
  readonly checks: number;
  /** Подпись для человека: что именно за прогон. */
  readonly what: string;
}

/**
 * ВЕРДИКТ по нулю: имя того, кто собрал **НОЛЬ**, и чем это опасно. Пусто — собрали все.
 *
 * Чистая функция: принимает счётчики, поэтому негативный контроль подсовывает сюда нули, не
 * трогая ни прогон, ни конфиги.
 */
export function zeroCollectionFindings(items: readonly CollectedChecks[]): string[] {
  return items
    .filter((item) => item.checks === 0)
    .map(
      (item) =>
        `${item.what}: ${item.name} — ноль собранных проверок; такой сторож выглядит зелёным ровно ` +
        'так же, как работающий (docs/verification-debt.md, случай 22)',
    );
}

/** Запись негативного контроля: чем запускается и какие оракулы обязана собрать. */
export interface ControlRecord {
  readonly id: string;
  readonly config?: string;
  readonly tests: readonly string[];
}

/**
 * Записи, которые собирают ноль по **структурной** причине, названной здесь с числом.
 *
 * Список — не оправдание, а долг с именем: он проверяется на устаревание (ожившая запись
 * краснеет), и каждая запись здесь обязана быть действительно мёртвой.
 */
/**
 * КОНФИГИ ПРОГОНОВ, между которыми делится дерево. Вердикт записей ищет конфиг на КАЖДЫЙ файл
 * (2026-09-28): оракулы одной записи могут жить в разных конфигах, и прежний вопрос «под каким
 * конфигом запись собирается целиком» делал такую запись ложно мёртвой.
 */
export const KNOWN_CONFIGS: readonly string[] = [
  'vitest.config.ts',
  'vitest.e2k.config.ts',
  'vitest.qemu.config.ts',
  'vitest.e2e.config.ts',
];

/**
 * Записи негативных контролей, которые собирают ноль **по структурной причине**, названной здесь.
 * Такая запись не краснеет, но обязана быть действительно мёртвой: если оживёт, вердикт скажет
 * «устаревшее исключение» (случай 1: «имена вместо наличия»).
 */
export const KNOWN_DEAD_CONTROLS: readonly { readonly id: string; readonly reason: string }[] = [];

/**
 * ВЕРДИКТ по записям негативных контролей: у каждой обязан быть названный конфиг, и каждый её
 * оракул обязан собирать **не ноль** проверок.
 *
 * `collected` — счётчики по ключу `` `${config}|${file}` ``. `known` — названные структурные
 * исключения: запись из списка не краснеет, но **обязана быть мёртвой**, иначе исключение
 * устарело (случай 1: «имена вместо наличия»).
 */
export function deadControlFindings(
  records: readonly ControlRecord[],
  collected: ReadonlyMap<string, number>,
  known: readonly { readonly id: string; readonly reason: string }[] = KNOWN_DEAD_CONTROLS,
): string[] {
  const findings: string[] = [];
  const knownIds = new Set(known.map((item) => item.id));
  const dead = new Set<string>();
  for (const record of records) {
    if (record.config === undefined) {
      findings.push(
        `запись ${record.id}: не назван config — прогон пойдёт с умолчанием и может собрать ноль ` +
          '(именно так 23 записи из 36 были мертвы с 23.09; docs/verification-debt.md, случай 22)',
      );
    }
    for (const file of record.tests) {
      // КОНФИГ ИЩЕТСЯ НА КАЖДЫЙ ФАЙЛ, А НЕ НА ЗАПИСЬ (2026-09-28).
      //
      // Почему: запись 12.4 держит оракулы в ДВУХ конфигах (`e2kCallLowering.test.ts` под
      // умолчанием, `e2kRealRun.test.ts` — в `vitest.e2k.config.ts`), а прежний вердикт брал
      // ОДИН конфиг на всю запись и объявлял её мёртвой, хотя её оракулы собираются — просто
      // в разных прогонах. Это ошибка того же рода, что и повод случая 22: «ноль собранных»
      // означал не мёртвый контроль, а неверный вопрос к нему. Теперь файл зачитывается, если
      // его собирает ХОТЬ ОДИН из объявленных/известных конфигов; названный конфиг остаётся
      // первым кандидатом (и его отсутствие по-прежнему называется отдельной находкой выше).
      const candidates = [record.config ?? 'vitest.config.ts', ...KNOWN_CONFIGS.filter((c) => c !== (record.config ?? 'vitest.config.ts'))];
      const best = Math.max(...candidates.map((config) => collected.get(`${config}|${file}`) ?? 0));
      if (best > 0) continue;
      dead.add(record.id);
      if (knownIds.has(record.id)) continue;
      findings.push(
        `запись ${record.id}: оракул ${file} собирает ноль проверок НИ ОДНИМ из конфигов ` +
          `(${candidates.join(', ')}) — контроль недействителен ` +
          '(docs/verification-debt.md, случай 22)',
      );
    }
  }
  for (const item of known) {
    if (!dead.has(item.id)) {
      findings.push(
        `устаревшее исключение ${item.id}: запись собирает проверки — исключение прикрывает живое ` +
          '(docs/verification-debt.md, случай 1)',
      );
    }
  }
  return findings;
}

/** Путь к vitest: тот же, каким пользуется инструмент негативных контролей. */
const VITEST = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');

/** Все записи всех таблиц инструмента негативных контролей — динамически, чтобы новые попали. */
export function allControlRecords(): ControlRecord[] {
  const records: ControlRecord[] = [];
  for (const [name, value] of Object.entries(controlTables)) {
    if (!name.startsWith('DEFECTS') || !Array.isArray(value)) continue;
    for (const item of value as readonly { id?: string; config?: string; tests?: readonly string[] }[]) {
      if (typeof item.id !== 'string' || !Array.isArray(item.tests)) continue;
      records.push({ id: item.id, config: item.config, tests: item.tests });
    }
  }
  return records;
}

/**
 * Сбор **без исполнения**: `vitest list --config=… <файлы>` — сколько проверок у каждого файла.
 *
 * Ноль означает, что конфиг этот файл не собирает (именно так выглядит мёртвый контроль).
 */
export function listCollected(config: string, files: readonly string[]): Map<string, number> {
  const per = new Map<string, number>();
  for (const file of files) per.set(file, 0);
  if (files.length === 0) return per;
  const out = execFileSync(process.execPath, [VITEST, 'list', `--config=${config}`, ...files], {
    cwd: ROOT,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  for (const line of out.split(/\r?\n/)) {
    const file = line.split(' > ')[0]?.trim();
    if (file !== undefined && per.has(file)) per.set(file, (per.get(file) ?? 0) + 1);
  }
  return per;
}

/** Счётчики по всем записям: ключ `` `${config}|${file}` `` — по одному прогону сбора на конфиг. */
export function collectForControls(records: readonly ControlRecord[]): Map<string, number> {
  const collected = new Map<string, number>();
  // Файлы записей собираются под КАЖДЫМ из известных конфигов: вердикт ищет конфиг на файл,
  // а не на запись (см. пояснение в `controlVerdict`). Прогонов столько же, сколько конфигов.
  const files = [...new Set(records.flatMap((record) => [...record.tests]))];
  for (const config of KNOWN_CONFIGS) {
    for (const [file, checks] of listCollected(config, files)) {
      collected.set(`${config}|${file}`, checks);
      // Запись без названного конфига считается по умолчанию: вердикт скажет об этом отдельно.
      if (config === 'vitest.config.ts') collected.set(`|${file}`, checks);
    }
  }
  return collected;
}

/** Сколько проверок собрал каждый файл отчёта прогона. `undefined` — отчёта нет. */
export function reportCollected(reportFile = REPORT): Map<string, number> | undefined {
  if (!fs.existsSync(reportFile)) return undefined;
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf-8')) as {
    testResults?: { name?: string; assertionResults?: unknown[] }[];
  };
  const per = new Map<string, number>();
  for (const item of report.testResults ?? []) {
    const name = relative(item.name ?? '');
    if (name === '') continue;
    per.set(name, (item.assertionResults ?? []).length);
  }
  return per;
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

  // ─── ПРАВИЛО: НОЛЬ СОБРАННЫХ ПРОВЕРОК — ЭТО КРАСНОЕ (случай 22) ───
  //
  // Два источника, оба без исполнения: отчёт прогона (в файле ноль проверок) и `vitest list`
  // по записям негативных контролей (ноль собранных = контроль недействителен).
  const checksInFiles = reportCollected();
  const emptyFiles: CollectedChecks[] = [];
  if (checksInFiles !== undefined) {
    for (const [file, checks] of checksInFiles) {
      emptyFiles.push({ name: file, checks, what: 'файл прогона' });
    }
  }
  const emptyFileFindings = zeroCollectionFindings(emptyFiles);
  console.log(
    `сторож счёта проверок: файлов в отчёте ${emptyFiles.length}, собрали ноль ${emptyFileFindings.length}`,
  );

  let controlFindings: string[] = [];
  try {
    const records = allControlRecords();
    const collectedControls = collectForControls(records);
    controlFindings = deadControlFindings(records, collectedControls);
    const named = records.filter((r) => KNOWN_DEAD_CONTROLS.some((k) => k.id === r.id)).length;
    console.log(
      `сторож счёта проверок: записей негативного контроля ${records.length}, ` +
        `названных мёртвыми ${named}, безымянных находок ${controlFindings.length}`,
    );
    for (const item of KNOWN_DEAD_CONTROLS) {
      console.log(`  НАЗВАННАЯ МЁРТВАЯ ЗАПИСЬ ${item.id}: ${item.reason}`);
    }
  } catch (error) {
    // Инструмент недоступен — это «проверка не выполнена», а не «пройдено».
    controlFindings = [
      `записи негативных контролей не проверены: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  problems.push(...emptyFileFindings, ...controlFindings);

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
  console.log(
    'расхождений нет: каждый файл оракула собран с проверками, каждая запись контроля собирает свои',
  );
  return 0;
}

if (require.main === module) {
  if (process.argv.includes('--raw')) {
    for (const line of rawReport(process.argv.includes('-z'))) console.log(line);
  } else {
    process.exitCode = runAudit();
  }
}
