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
  /**
   * Конфиг vitest для этих оракулов. Нужен для ресурсозависимых: они вынесены из полного прогона
   * в отдельный шлюз (случай 12), и с обычным конфигом прогон собрал бы НОЛЬ проверок — а ноль
   * собранных это «контроль недействителен», а не «оракул слеп» (случай 10).
   */
  readonly config?: string;
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
    config: 'vitest.e2k.config.ts',
  },
  {
    id: '4.2',
    title: 'размер длинной формы взят коротким: 8 вместо 16',
    file: 'src/e2k/twoPassLayout.ts',
    from: '{ mnemonic: "muls", form: "ALF11", size: REAL_LONG_FORM_SIZE, source: LONG_SOURCE }',
    to: '{ mnemonic: "muls", form: "ALF11", size: REAL_SHORT_FORM_SIZE, source: LONG_SOURCE /* ДЕФЕКТ 4.2 */ }',
    tests: ['src/e2k/twoPassLayout.test.ts', 'src/e2k/e2kRealRun.test.ts'],
    config: 'vitest.e2k.config.ts',
  },
  {
    id: '4.3',
    title: 'смещение в байтах, а не в восьмибайтных единицах',
    file: 'src/e2k/twoPassLayout.ts',
    from: 'const disp = delta / DISP_UNITS;',
    to: 'const disp = delta; // ДЕФЕКТ 4.3: байты вместо единиц',
    tests: ['src/e2k/twoPassLayout.test.ts'],
    config: 'vitest.e2k.config.ts',
  },
  {
    id: '4.4',
    title: 'знаковое расширение не учтено (переход назад)',
    file: 'src/e2k/e2k-real.ts',
    from: '  return raw >= 2 ** (DISP_BITS - 1) ? raw - 2 ** DISP_BITS : raw;',
    to: '  return raw; // ДЕФЕКТ 4.4: поле прочитано беззнаково',
    tests: ['src/e2k/twoPassLayout.test.ts'],
    config: 'vitest.e2k.config.ts',
  },
  // ── Дефекты СОПОСТАВЛЕНИЯ ПАРЫ «сравнение → условный переход» (шаг 3) ───────
  {
    id: '5.1',
    title: 'сопоставление снято — пар нет вовсе',
    file: 'src/e2k/predicatePairing.ts',
    from: '  return { pairs, refusals };',
    to: '  return { pairs: [], refusals }; // ДЕФЕКТ 5.1: сопоставление снято',
    tests: ['src/e2k/e2kPredicatePairs.test.ts'],
    config: 'vitest.e2k.config.ts',
  },
  {
    id: '5.2',
    title: 'полярность перепутана (переход проверяет предикат вместо инверсного)',
    file: 'src/e2k/predicatePairing.ts',
    from: 'const inverted = (jump.mnemonic === "IR.jmp_if_not") !== comparison.flipped;',
    to: 'const inverted = (jump.mnemonic === "IR.jmp_if_not") === comparison.flipped; // ДЕФЕКТ 5.2',
    tests: ['src/e2k/e2kPredicatePairs.test.ts'],
    config: 'vitest.e2k.config.ts',
  },
  {
    id: '5.3',
    title: 'сравнение пишет %pred1, а переход читает %pred0',
    file: 'src/e2k/predicatePairing.ts',
    from: '      predicate: PREDICATE_FOR_PAIRS,',
    to: '      predicate: PREDICATE_FOR_PAIRS + 1, // ДЕФЕКТ 5.3: предикат пары разошёлся с условием',
    tests: ['src/e2k/e2kPredicatePairs.test.ts'],
    config: 'vitest.e2k.config.ts',
  },
  {
    id: '5.4',
    title: 'предпосылка ослаблена: пара разрешена при лишнем читателе',
    file: 'src/e2k/predicatePairing.ts',
    from: '    if (readers.length > 1) {',
    to: '    if (readers.length > 2) { // ДЕФЕКТ 5.4: лишний читатель пропущен',
    tests: ['src/e2k/e2kPredicatePairs.test.ts'],
    config: 'vitest.e2k.config.ts',
  },
  // ── ПЛОСКОСТЬ ЯЗЫКА: символ строки по индексу (2026-10-04, долг §3.105.4) ─────────────────────
  //
  // Дефекты внесены в ЯЗЫКОВУЮ плоскость, а не в e2k, и это намеренно: правка живёт в семантике и
  // действует на ОБЕИХ VM. Ломать её надо там, где она есть, — иначе контроль проверял бы не тот
  // слой, в котором величина живёт (признак 4 линии).
  //
  // Два дефекта, а не один: у правки ДВЕ половины, и они независимы. 16.1 проверяет, что символ
  // вообще приходит; 16.2 — что выход за границу ОТКАЗЫВАЕТ. Реализация «символ есть, а за границей
  // null» прошла бы 16.1 и провалила только 16.2 — а это и был исходный дефект (null складывался с
  // числом как ноль, и лексер молча получил бы пустые токены).
  {
    id: '16.1',
    title: 'разворот индекса по строке снят — `с[0]` снова даёт null',
    file: 'src/compiler/compiler.ts',
    from: '            expr.name = "система.строка.символ";',
    to: '            // ДЕФЕКТ 16.1: разворот снят — строка снова индексируется как массив',
    tests: ['src/self-host/stringIndex.test.ts'],
    // Config назван ЯВНО, и сторож счёта проверок краснеет на записи без него — по делу: прогон с
    // умолчанием может собрать НОЛЬ проверок, а такой контроль выглядит зелёным, ничего не проверив
    // (docs/verification-debt.md, случай 22). Здесь полный прогон: оракул работает на обеих VM и
    // внешних ресурсов не требует.
    config: 'vitest.config.ts',
  },
  {
    id: '16.2',
    title: 'граница строки не проверяется — выход за конец молча даёт undefined',
    file: 'src/runtime/vm/stringChar.ts',
    from: '  if (i < 0 || i >= points.length) {',
    to: '  if (false) { // ДЕФЕКТ 16.2: выход за границу не проверяется',
    tests: ['src/self-host/stringIndex.test.ts'],
    config: 'vitest.config.ts',
  },
  // ── ПЛОСКОСТЬ ЦЕЛИ: раскладка ЗАПИСИ (2026-10-04, `obj.get` через блок элементов) ─────────────
  //
  // Дефект бьёт в ТУ САМУЮ величину, ради которой план записи и написан: индекс поля в блоке.
  // Перевёрнутый порядок — не «примерно то же»: `т.х` читало бы `у`, и на модели ответ стал бы 4
  // вместо 3. Оракул обязан покраснеть ДВАЖДЫ (`src/e2k/recordPlan.test.ts`): и разбором раскладки,
  // и прогоном — поэтому config здесь полный, а не шлюзовый.
  {
    id: '16.3',
    title: 'индекс поля перевёрнут — `т.х` читает другое поле',
    file: 'src/e2k/recordPlan.ts',
    from: '  const индекс = поля.indexOf(поле);',
    to: '  const индекс = поля.length - 1 - поля.indexOf(поле); // ДЕФЕКТ 16.3: порядок полей перевёрнут',
    tests: ['src/e2k/recordPlan.test.ts'],
    config: 'vitest.config.ts',
  },
];

/** sha256 файла — им сверяется «до» и «после». */
export function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
}

/**
 * Найти в тексте файла якорь дефекта — с учётом того, **какие переводы строк в файле**.
 *
 * Это не украшение, а снятая ловушка. Замена — строковая (`String.includes`), а якорь в таблице
 * дефектов записан с `\n`. В файле с CRLF такой якорь **не находится**, и дефект молча не
 * вносится: `String.replace` по ненайденной строке возвращает текст без изменений. Дальше
 * сработала бы проверка «мутация не изменила файл» — но только как «контроль пустой», а числа в
 * документации к тому времени уже стояли. Замер: из 21 дефекта не находился ровно один — 6.3
 * (перестановка слов литерала), потому что `src/e2k/e2k-real.ts` целиком в CRLF.
 *
 * Поэтому якорь подгоняется под переводы строк файла, а не наоборот: переписывать чужие файлы
 * ради удобства контроля — значит менять предмет проверки. Возвращается **найденный** вариант
 * якоря: им же подгоняется и замена, иначе в файле получилась бы смесь `\n` и `\r\n`.
 */
export function locateAnchor(source: string, from: string): string | undefined {
  if (source.includes(from)) return from;
  // Якорь с LF в файле с CRLF (и наоборот) — тот же текст, разные переводы строк.
  const crlf = from.replace(/(?<!\r)\n/g, '\r\n');
  if (crlf !== from && source.includes(crlf)) return crlf;
  const lf = from.replace(/\r\n/g, '\n');
  if (lf !== from && source.includes(lf)) return lf;
  return undefined;
}

/** Замена с теми же переводами строк, что у найденного якоря (без смеси `\n` и `\r\n`). */
export function replacementFor(anchor: string, to: string): string {
  return anchor.includes('\r\n') ? to.replace(/(?<!\r)\n/g, '\r\n') : to.replace(/\r\n/g, '\n');
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
export function runOracles(tests: readonly string[], jsonFile: string, config?: string): OracleRun {
  let exitCode = 0;
  try {
    execFileSync(
      process.execPath,
      [
        VITEST,
        'run',
        ...tests,
        // Конфиг обязателен для оракулов, исключённых из полного прогона: без него vitest берёт
        // `vitest.config.ts`, чей `exclude` отбрасывает файл ещё до сбора — и дефект выглядел бы
        // не поймёшь чем при 0 собранных проверок (случай 10 реестра проверяемости).
        ...(config === undefined ? [] : [`--config=${config}`]),
        '--reporter=json',
        `--outputFile=${jsonFile}`,
      ],
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
  const anchor = locateAnchor(source, defect.from);
  if (anchor === undefined) {
    throw new Error(`дефект ${defect.id}: в ${defect.file} не найдено «${defect.from}»`);
  }
  fs.writeFileSync(file, source.replace(anchor, replacementFor(anchor, defect.to)), 'utf-8');
  // Мутация обязана изменить файл: правка-пустышка («from» равно «to») выглядела бы как контроль.
  const mutatedChanged = sha256(file) !== shaBefore;

  let caughtBy: readonly string[] = [];
  let mutatedCollected = 0;
  try {
    const mutated = runOracles(defect.tests, path.join(work, `run-${defect.id}.json`), defect.config);
    caughtBy = mutated.failed;
    mutatedCollected = mutated.collected;
  } finally {
    fs.copyFileSync(backup, file); // восстановление из копии
  }
  const shaAfter = sha256(file);
  const restored = runOracles(defect.tests, path.join(work, `restored-${defect.id}.json`), defect.config);

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

/**
 * Дефекты **группировки в широкие команды** (шаг 7).
 *
 * Проверяется не только «поймано», но и **чем именно**: снятие группировки обязано ловиться
 * оракулом раскладки (пакетов становится больше), а прогон в QEMU при этом остаётся зелёным —
 * результат-то не изменился. Нарушение зависимостей, наоборот, обязано ловиться **прогоном**:
 * модель читает источники широкой команды параллельно (§5.1 `docs/e2k-wide-commands.md`).
 */
export const DEFECTS_WIDE: readonly Defect[] = [
  {
    // Ловится оракулом раскладки; прогон в QEMU остаётся зелёным — и это правильный результат:
    // снятие группировки не меняет смысл программы, только число команд.
    id: '7.1',
    title: 'группировка снята — команд столько же, сколько инструкций',
    file: 'src/e2k/widePacker.ts',
    from: '        : dependent({ reads: groupReads, writes: groupWrites }, registers) ??',
    to: '        : "ДЕФЕКТ 16.1: группировка снята" ?? //',
    tests: ['src/e2k/widePackets.test.ts'],
    config: 'vitest.config.ts',
  },
  {
    // Ловится прогоном: зависимые операции в одной команде дают неверный результат (измерено: 5).
    id: '7.2',
    title: 'проверка зависимостей снята — зависимые операции в одной команде',
    file: 'src/e2k/widePacker.ts',
    from: 'function dependent(a: { reads: string[]; writes: string[] }, b: { reads: string[]; writes: string[] }): string | undefined {',
    to: 'function dependent(a: { reads: string[]; writes: string[] }, b: { reads: string[]; writes: string[] }): string | undefined {\n  return undefined; // ДЕФЕКТ 16.2: зависимости не проверяются',
    tests: ['src/e2k/e2kWideQemu.test.ts'],
    config: 'vitest.qemu.config.ts',
  },
  {
    // Ловится внешней сверкой: два слога в один канал дают команду, которой ассемблер не собирает.
    id: '7.3',
    title: 'слоты свалены в один канал — байты расходятся с ассемблером',
    file: 'src/e2k/widePacker.ts',
    from: '  const ordered = [...group].sort((a, b) => a.syllable.channel - b.syllable.channel);',
    to: '  const ordered = [...group].map((slot) => ({ ...slot, syllable: { ...slot.syllable, channel: 0 } })); // ДЕФЕКТ 7.3',
    tests: ['src/e2k/widePackets.test.ts'],
    config: 'vitest.config.ts',
  },
  {
    // WAR/WAW сняты, RAW на месте: оракул раскладки это видит, прогон — нет (параллельное чтение).
    id: '7.4',
    title: 'проверка WAR и WAW снята — осталось только RAW',
    file: 'src/e2k/widePacker.ts',
    from: '  const writeWrite = shared(a.writes, b.writes);\n  if (writeWrite.length > 0) return `WAW по ${writeWrite.join(\', \')}`;',
    to: '  // ДЕФЕКТ 7.4: WAW и WAR не проверяются\n  if (false) return "WAW снят";',
    tests: ['src/e2k/widePackets.test.ts'],
    config: 'vitest.config.ts',
  },
];

/**
 * Дефекты **раскладки регистров** (шаг 8).
 *
 * Проверка идёт оракулом `src/e2k/regAlloc.test.ts`: он быстрый (меньше секунды) и проверяет и
 * интервалы, и раскладку. Каждый дефект обязан быть пойман **своим** предметом: снятая liveness —
 * пиком, снятая интерференция — совпадением регистров у живых значений, захват `%b[10]` — проверкой
 * зарезервированных регистров, перепутанные концы интервалов — пересечением.
 */
export const DEFECTS_REGALLOC: readonly Defect[] = [
  {
    id: '8.1',
    title: 'интервалы растянуты до конца потока — раскладка перестаёт влезать',
    file: 'src/e2k/liveness.ts',
    from: '    end: lastUse.get(vreg) ?? start,',
    to: '    end: Math.max(0, instructions.length - 1), // ДЕФЕКТ 8.1: значение живёт до конца потока',
    tests: ['src/e2k/regAlloc.test.ts'],
    config: 'vitest.e2k.config.ts',
  },
  {
    id: '8.2',
    title: 'проверка интерференции снята: занятые регистры не учитываются',
    file: 'src/e2k/regAlloc.ts',
    from: '    const taken = new Set(active.map((entry) => entry.register));',
    to: '    const taken = new Set<number>(); // ДЕФЕКТ 8.2: интерференция не проверяется',
    tests: ['src/e2k/regAlloc.test.ts'],
    config: 'vitest.e2k.config.ts',
  },
  {
    id: '8.3',
    title: 'захвачен регистр рантайма массивов %b[10]',
    file: 'src/e2k/regAlloc.ts',
    from: 'export const ALLOCATABLE_REGISTERS: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];',
    to: 'export const ALLOCATABLE_REGISTERS: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]; // ДЕФЕКТ 8.3',
    tests: ['src/e2k/regAlloc.test.ts'],
    config: 'vitest.e2k.config.ts',
  },
  {
    id: '8.4',
    title: 'конец интервала потерян: значение умирает на определении',
    file: 'src/e2k/liveness.ts',
    from: '    end: lastUse.get(vreg) ?? start,',
    to: '    end: start, // ДЕФЕКТ 8.4: интервал схлопнут в точку определения',
    tests: ['src/e2k/regAlloc.test.ts'],
    config: 'vitest.e2k.config.ts',
  },
];

/**
 * Дефекты **проводки раскладки в конвейер понижения** (шаг 9).
 *
 * Проверяются оракулами `src/e2k/regAlloc.test.ts` и `src/e2k/e2kRealRun.test.ts`: первый знает про
 * закрепление входящих и про «занято», второй — про укороченный поток, пересчёт целей переходов и
 * согласованность раскладки с кодированием.
 */
export const DEFECTS_WIRING: readonly Defect[] = [
  {
    // Закрепление снято: входящий параметр (v0) раскладывается как обычное значение и уезжает в чужой
    // регистр. Оракул обязан это поймать — параметр приходит в своём регистре, и вызывающий смотрит
    // туда же.
    // Якорь обновлён 2026-10-02 вместе с бюджетом регистров вызываемой (`CALLEE_REGISTERS`) и
    // закреплением параметров по арности вызова (`argumentCountsOf`): прежде вычёркивался один
    // фильтр `free`, теперь закрепление собрано в одно множество `pinned`, и снятие его снимает
    // закрепление целиком — и входящих, и параметров. Смысл дефекта тот же.
    id: '9.1',
    title: 'закрепление входящих снято — параметр уезжает в чужой регистр',
    file: 'src/e2k/regAlloc.ts',
    from: '    const pinned = new Set<number>([...incoming, ...parameters]);',
    to: '    const pinned = new Set<number>(); // ДЕФЕКТ 9.1: закрепление входящих и параметров снято',
    tests: ['src/e2k/regAlloc.test.ts', 'src/e2k/e2kRealRun.test.ts'],
    config: 'vitest.e2k.config.ts',
  },
  {
    // Цели переходов не пересчитаны после укорочения потока: смещения считаются по сдвинутым индексам,
    // и переходы ведут не туда. Ловится сверкой раскладки с кодированием и круговой сверкой.
    id: '9.2',
    title: 'цели переходов не пересчитаны после укорочения потока',
    file: 'src/e2k/regAlloc.ts',
    from: '  const remapped = remapJumpTargets(result, movedTo);',
    to: '  const remapped = { instructions: result, problems: [] as string[] }; // ДЕФЕКТ 9.2: цели не пересчитаны',
    tests: ['src/e2k/e2kRealRun.test.ts'],
    config: 'vitest.e2k.config.ts',
  },
  {
    // «Занято» снова считается по активным отрезкам: число врёт (2 при десяти выданных), и оракул
    // обязан это назвать — иначе непроверенное число снова уедет в документ.
    id: '9.3',
    title: '«занято» вычёркивает освобождённые регистры — число врёт',
    file: 'src/e2k/regAlloc.ts',
    from: '        active.splice(index, 1);\n      }\n    }',
    to: '        used.delete(active[index]!.register); // ДЕФЕКТ 9.3: выданные регистры вычёркиваются\n        active.splice(index, 1);\n      }\n    }',
    tests: ['src/e2k/regAlloc.test.ts'],
    config: 'vitest.e2k.config.ts',
  },
];

/**
 * Дефекты **длины `IR.invoke`** (шаг 10).
 *
 * Проверяются оракулами `src/e2k/twoPassLayout.test.ts` (форма и её сверка с кодировщиком) и
 * `src/e2k/e2kRealRun.test.ts` («раскладка и кодирование не расходятся», покрытие).
 */
export const DEFECTS_INVOKE: readonly Defect[] = [
  {
    // Длина берётся «одна команда на любой вызов»: у `получить` их шесть, у `добавить` девять, поэтому
    // адреса всех следующих команд уезжают, и сумма размеров раскладки перестаёт совпадать с байтами.
    id: '10.1',
    title: 'длина IR.invoke взята фиксированной — адреса уезжают',
    file: 'src/e2k/twoPassLayout.ts',
    from: '  return { form: { carrier: \'IR.invoke\', commands } };',
    to: '  return { form: { carrier: \'IR.invoke\', commands: [commands[0]!] } }; // ДЕФЕКТ 10.1: длина фиксирована',
    tests: ['src/e2k/twoPassLayout.test.ts', 'src/e2k/e2kRealRun.test.ts'],
    config: 'vitest.e2k.config.ts',
  },
  {
    // Контекст (`invokeNames`) не передаётся: `IR.invoke` снова не размещается — то есть шаг 2 отменён
    // целиком, и это обязано быть видно отчётом, а не только «меньшим покрытием».
    id: '10.2',
    title: 'контекст с именами хост-вызовов не передаётся — IR.invoke не размещается',
    file: 'src/e2k/twoPassLayout.ts',
    // Якорь обновлён 2026-09-28 вместе с кодом: раскладка теперь берёт ИТОГ формы
    // (`const outcome = …`), а не пару «форма + причина» — смысл дефекта тот же (контекст потерян),
    // и это тот же класс, что «сдвинулся якорь — правь таблицу тем же коммитом».
    from: '    const outcome = carrierFormWithReason(instruction, context);',
    to: '    const outcome = carrierFormWithReason(instruction, {}); // ДЕФЕКТ 10.2: контекст потерян',
    tests: ['src/e2k/twoPassLayout.test.ts', 'src/e2k/e2kRealRun.test.ts'],
    config: 'vitest.e2k.config.ts',
  },
  {
    // Размеры команд рантайма объявлены длинной формой: раскладка считает адреса по 16 байт, а
    // кодировщик выдаёт 8 — расхождение обязан поймать сверка «раскладка и кодирование не расходятся».
    // Якорь — команда адресной арифметики рантайма; с 2026-09-27 это `addd` (форма `D`), а не `adds`:
    // адрес 64-битный (docs/hardware-debt.md §3.27, §3.30). Дефект тот же — объявленная длина вдвое больше.
    id: '10.3',
    title: 'размер команд рантайма объявлен вдвое больше — раскладка расходится с кодированием',
    file: 'src/e2k/twoPassLayout.ts',
    from: "  ['addd', { mnemonic: 'addd', form: 'ALF1', size: REAL_SHORT_FORM_SIZE, source: ADDD_COMMAND_SOURCE }],",
    to: "  ['addd', { mnemonic: 'addd', form: 'ALF1', size: REAL_LONG_FORM_SIZE, source: ADDD_COMMAND_SOURCE }], // ДЕФЕКТ 10.3",
    tests: ['src/e2k/twoPassLayout.test.ts', 'src/e2k/e2kRealRun.test.ts'],
    config: 'vitest.e2k.config.ts',
  },
];

/**
 * Дефекты **окна вызываемой процедуры** (шаг 11).
 *
 * Проверяется оракулами `src/e2k/regAlloc.test.ts` (измеренный предел 8) и `src/e2k/e2kRealRun.test.ts`
 * (какие вызываемые процедуры в него не влезают). Подмена предела — ровно тот случай, когда
 * «программа собирается, но вызвать её нельзя» остаётся незамеченным.
 */
export const DEFECTS_CALLEE_WINDOW: readonly Defect[] = [
  {
    id: '11.1',
    title: 'окно вызываемой объявлено как у вызывающего (24) — «фильтр» будто бы влезает с запасом',
    file: 'src/e2k/regAlloc.ts',
    from: 'export const WINDOW_REGISTERS_CALLEE = 16;',
    to: 'export const WINDOW_REGISTERS_CALLEE = 24; // ДЕФЕКТ 11.1: окно вызываемой равно вызывающему',
    tests: ['src/e2k/regAlloc.test.ts', 'src/e2k/e2kRealRun.test.ts'],
    config: 'vitest.e2k.config.ts',
  },
  {
    id: '11.2',
    title: 'нужно регистров окна считается только по выданным (закреплённые забыты)',
    file: 'src/e2k/regAlloc.ts',
    from: '    const windowRegistersNeeded = pinnedInWindow.length + allocation.allocation.used.length;',
    to: '    const windowRegistersNeeded = allocation.allocation.used.length; // ДЕФЕКТ 11.2: закреплённые забыты',
    tests: ['src/e2k/regAlloc.test.ts', 'src/e2k/e2kRealRun.test.ts'],
    config: 'vitest.e2k.config.ts',
  },
  {
    // ТИХАЯ ЛОЖЬ, а не отказ: программа собирается, отказов понижения 0, а число чужое.
    // `call wbs = 4` сдвигает окно вызываемой на 8 регистров, поэтому `%b[2..7]` вызываемой —
    // это `%b[10..15]` вызывающего, то есть рантайм массивов; выход программы считает
    // `код = значение + %b[12]` (`src/e2k/printCall.ts#exitCarrierInstructions`), а `%b[4]`
    // вызываемой — ровно `%b[12]` вызывающего. Ловится ПРОГОНОМ В МОДЕЛИ: проба-закрепитель
    // спрашивает модель и сверяет с эталоном языка (11), с откатом правки модель отдаёт 15.
    // Замер различителем и разбор — `docs/hardware-debt.md` §3.96.
    id: '11.3',
    title: 'бюджет регистров вызываемой снят — ей снова отдан весь файл раскладки',
    file: 'src/e2k/programImage.ts',
    from: '    freeFor: (at) => (at === entryAt ? undefined : CALLEE_REGISTERS),',
    to:
      '    freeFor: (at) => (at === entryAt ? undefined : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), ' +
      '// ДЕФЕКТ 11.3: бюджет вызываемой снят',
    tests: ['src/compiler-v3/nativePathE2k.test.ts'],
    config: 'vitest.config.ts',
  },
  {
    // ТОТ ЖЕ дефект, ДРУГОЙ оракул: настоящая программа с вложенными циклами в вызываемых
    // (`src/runtime/fixtures/cycle_nested.osnova`), а не выражение из трёх слагаемых. Она давала
    // 92 против эталона 91 — тот же механизм (выход считает `код = значение + %b[12]`, а `%b[4]`
    // вызываемой — это `%b[12]` вызывающего). Запись отдельная, потому что у оракула ДРУГОЙ конфиг:
    // эта проба ходит в модель и живёт в шлюзе `gate:qemu`, а поле `config` у записи одно.
    // Смысл отдельной записи — не дубль, а охват: фикстуры `src/runtime/fixtures/**` не входят в
    // `examples/**`, и до 2026-10-02 у `cycle_nested` на модели не было НИ ОДНОГО сторожа.
    id: '11.4',
    title: 'бюджет вызываемой снят — фикстура с вложенными циклами даёт 92 вместо 91',
    file: 'src/e2k/programImage.ts',
    from: '    freeFor: (at) => (at === entryAt ? undefined : CALLEE_REGISTERS),',
    to:
      '    freeFor: (at) => (at === entryAt ? undefined : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), ' +
      '// ДЕФЕКТ 11.4: бюджет вызываемой снят',
    tests: ['src/e2k/e2kCallWindowQemu.test.ts'],
    config: 'vitest.qemu.config.ts',
  },
  // ── Дефекты ОСТАТКА, понижаемого СЕРИЕЙ (шаг 14) ────────────────────────────
  {
    // Форма и понижение берут команды из ОДНОГО источника (`src/e2k/remainderRuntime.ts`), и это
    // ровно то, что защищает эта запись: сломай форму — раскладка посчитает 8 байт там, где в образ
    // уйдут 24, и адреса после носителя уедут молча (класс §3.35).
    //
    // ЛОВИТСЯ НЕ ПРОГОНОМ, И ЭТО ЗАМЕР: смещения считаются как РАЗНОСТЬ адресов, поэтому ошибка
    // длины, общая для обеих точек, сокращается — проба с вызовом после серии на прогоне НЕ краснела
    // (замер: стол контроля, запись 14.1 на первой редакции). Ловит её ПРЯМАЯ сверка БАЙТОВ формы и
    // понижения — `src/e2k/layoutWideCrossCheck.test.ts`, проверка 3.7.
    id: '14.1',
    title: 'форма остатка взята от одной команды, а понижение даёт три — байты расходятся',
    file: 'src/e2k/twoPassLayout.ts',
    from: '    const forms = printCarrierForms(remainderInstructions(a.index, b.index, d.index));',
    to:
      '    const forms = printCarrierForms(remainderInstructions(a.index, b.index, d.index).slice(0, 1)); ' +
      '// ДЕФЕКТ 14.1: форма короче понижения',
    tests: ['src/e2k/layoutWideCrossCheck.test.ts'],
    config: 'vitest.config.ts',
  },
  {
    // УСЛОВНОСТЬ РЕЗЕРВА. Резерв `%b[9]` берётся ТОЛЬКО у программы с `IR.rem`; сделай его
    // безусловным — и десятый регистр отнимется у ядра `фильтр` (оно занимает `%b[0..9]`), после
    // чего закреплённые числа пяти ядер поедут. Ловится прогоном ЗАКРЕПЛЁННЫХ чисел (полный прогон),
    // без модели и без QEMU — то есть дёшево и детерминированно.
    //
    // ЧЕГО ЭТА ЗАПИСЬ НЕ ЛОВИТ, И ЭТО НАЗВАНО: затирание ЖИВОГО значения временным регистром
    // требует, чтобы раскладка дошла до `%b[9]`, то есть ≥10 одновременно живых значений. Ни одна
    // проба остатка такого давления не создаёт (замер: стол показал «с замечаниями» на первой
    // редакции). Прямой контроль на затирание — ДОЛГ, названный в `docs/hardware-debt.md` §3.97.5.
    id: '14.2',
    title: 'резерв под частное взят БЕЗУСЛОВНО — у ядра без остатка отнят десятый регистр',
    file: 'src/e2k/regAlloc.ts',
    from: '  if (needsRemainderScratch(instructions)) reserved.add(REMAINDER_SCRATCH_REGISTER);',
    to: '  reserved.add(REMAINDER_SCRATCH_REGISTER); // ДЕФЕКТ 14.2: резерв взят у всех программ подряд',
    tests: ['src/e2k/e2kWideFir.test.ts'],
    config: 'vitest.config.ts',
  },
  // ── Дефекты КОЛЛЕКЦИЙ НА `brk` (шаг ①: выделение) ───────────────────────────
  {
    // АРИФМЕТИКА АДРЕСА, И ЭТО ЗАМЕР: с внесённым дефектом модель отдаёт **32** вместо **40**
    // (разность двух выделений по 4 без слова заголовка). Проба — `.tmp/osnova-collections-probe.ts`.
    // Достоверность именно этой записи держится на том, что разность наблюдаема в 8-битном канале:
    // 40 и 32 различны по модулю 256, и оракул это отдельно проверяет (контроль 1).
    id: '14.3',
    title: 'слово заголовка не прибавлено к границе блока — шаг 32 вместо 40',
    file: 'src/e2k/collectionsRuntime.ts',
    from: '    addd(argument, COLLECTION_WORD_REGISTER, argument),',
    to: '    // ДЕФЕКТ 14.3: слово заголовка не прибавлено',
    tests: ['src/e2k/collectionsBrkQemu.test.ts'],
    config: 'vitest.qemu.config.ts',
  },
  {
    // ЗАБЫТЫЙ РЕЗЕРВ. Это дефект того же класса, что §3.96.9: замер «резерв нужен» верен, а перенос
    // его в код — нет. Без резерва раскладка вправе отдать `%b[8]`/`%b[9]`, и номер системного вызова
    // ляжет поверх живого значения — НЕ отказ, а тихая ложь. Ловится двумя проверками оракула
    // рантайма: и списком резерва, и стражем операнда.
    //
    // ЧЕГО ЭТА ЗАПИСЬ НЕ ЛОВИТ, и это названо, а не умолчано: затирание ЖИВОГО значения требует,
    // чтобы раскладка дошла до `%b[8]`/`%b[9]`, то есть ≥8 одновременно живых значений. Ни одна проба
    // коллекций такого давления не создаёт — прогон остаётся зелёным (замер: стол контроля).
    id: '14.4',
    title: 'резерв под регистры системного вызова забыт — номер вызова ложится поверх значения',
    file: 'src/e2k/collectionsRuntime.ts',
    from: '  return [syscallWindowOf(frame, 0), syscallWindowOf(frame, 1)];',
    to: '  return []; // ДЕФЕКТ 14.4: резерв коллекций забыт',
    tests: ['src/e2k/collectionsRuntime.test.ts'],
    config: 'vitest.config.ts',
  },
  {
    // РАСШИРЕНИЕ КУЧИ СНЯТО: блок не отдан ядру, а второй `brk(0)` вернёт ту же границу — два
    // выделения лягут на ОДИН адрес, и разность станет нулём. Это тот дефект, при котором «адрес
    // ненулевой» остался бы зелёным, а «блоки врозь» — нет: ровно поэтому оракул спрашивает
    // разность, а не адрес.
    id: '14.5',
    title: 'расширение кучи снято — два выделения ложатся на один адрес, разность 0',
    file: 'src/e2k/collectionsRuntime.ts',
    from: '    ...brkInstructions({ address: argument, result: answer, frame }),',
    to: '    // ДЕФЕКТ 14.5: расширение кучи снято',
    tests: ['src/e2k/collectionsBrkQemu.test.ts'],
    config: 'vitest.qemu.config.ts',
  },
  {
    // ЛОЖНОЕ ЗЕЛЁНОЕ, И ОНО БЫЛО ИЗМЕРЕНО, А НЕ ВЫДУМАНО. Отказ о НЕразвёрнутой операции в первой
    // редакции пересказывал подпись — «`положить(база, индекс, значение)` принимает три», — и слово
    // «индекс» из ПЕРЕСКАЗА ПОДПИСИ удовлетворило контроль 1 оракула владельца, который ищет в
    // отказах понижения `/ёмкост|индекс/`. Контроль позеленел, НИЧЕГО не проверив: проверки границы
    // индекса не существовало вовсе (замер: полный шлюз `gate:qemu`, 5 падений вместо 6).
    //
    // ЯКОРЬ ПЕРЕБАЗИРОВАН 2026-10-03: текст отказа переписан (все четыре операции разворачиваются
    // САЙТОМ, и отказ говорит об этом), прежний строки в файле больше нет. Мутация возвращает ровно
    // ту формулировку — «текст поминает границу» — и ловится сторожем, который требует, чтобы отказ о
    // САЙТЕ не выглядел как отказ о ГРАНИЦЕ: проверкой по существу, а не по совпадению.
    id: '14.6',
    title: 'текст отказа о непостроенном сайте поминает границу — контроль владельца зеленеет, ничего не проверив',
    file: 'src/e2k/collectionsRuntime.ts',
    from: "      'и ответа `brk` — это переходы, а цель перехода считается до раскладки), и причина, по которой ' +",
    to: "      'ёмкость и индекс — три', // ДЕФЕКТ 14.6: текст поминает границу",
    tests: ['src/e2k/collectionsRuntime.test.ts'],
    config: 'vitest.config.ts',
  },
  // ── Дефекты РАСШИРЕНИЯ НОСИТЕЛЯ до трёх аргументов (шаг 15) ─────────────────
  {
    // ТРЕТИЙ АРГУМЕНТ НЕ ДОПИСАН — и это ровно та правка, которую делает расширение. Без неё
    // программа с тремя аргументами снова не собиралась бы; форма при этом объявлена
    // шестиоперандной, поэтому расхождение ловится СРАЗУ, а не тихой потерей аргумента.
    id: '15.1',
    title: 'шестой операнд формы не дописан — третий аргумент вызова теряется',
    file: 'src/e2k/emitterShell.ts',
    from: '    if (argc >= 3) operands.push(reg(requireRegister(args[2] ?? 0, op)));',
    to: '    // ДЕФЕКТ 15.1: третий аргумент не дописан',
    tests: ['src/e2k/invokeArity.test.ts'],
    config: 'vitest.config.ts',
  },
  {
    // ГРАНИЦА, А НЕ ПРАВКА. Предел арности — это ЧИСЛО (`MAX_CALL_ARGS`), и проба границы обязана
    // краснеть, когда число возвращают назад: иначе она держит не границу, а своё собственное
    // устройство. Мутация опускает предел до прежних двух — и положительная сторона пробы
    // («три аргумента — законная арность») обязана упасть.
    id: '15.2',
    title: 'предел арности возвращён к двум — три аргумента снова не компилируются',
    file: 'src/e2k/emitterShell.ts',
    from: 'export const MAX_CALL_ARGS = 3;',
    to: 'export const MAX_CALL_ARGS = 2; // ДЕФЕКТ 15.2: предел возвращён к прежнему',
    tests: ['src/compiler-v3/nativePathE2k.test.ts'],
    config: 'vitest.config.ts',
  },
  {
    // ПРОВЕРКА ГРАНИЦЫ СНЯТА. Мутация убирает переход в блок отказа — и запись за ёмкостью
    // происходит МОЛЧА (проба положит по индексу 5 при ёмкости 2). Ловится тем, что оракул требует
    // НАЗВАННЫЙ отказ: код 231 и строку. Без этой записи «код 231» мог бы держаться на чём угодно.
    id: '15.3',
    title: 'переход в блок отказа снят — запись за ёмкостью идёт молча',
    file: 'src/e2k/collectionsRuntime.ts',
    from: "    { mnemonic: 'IR.jmp_if_not', channel: 0, operands: [reg(key), imm(refusalIndex)] },",
    to: "    // ДЕФЕКТ 15.3: проверка границы снята",
    tests: ['src/e2k/collectionsBrkQemu.test.ts'],
    config: 'vitest.qemu.config.ts',
  },
  // ── Дефекты ПЕРЕЕЗДА (`расширить`), шаг ③ ───────────────────────────────────
  {
    // КОПИРОВАНИЕ ТЕРЯЕТ ПОСЛЕДНИЙ ЭЛЕМЕНТ — и это ровно тот негативный контроль, который назван в
    // постановке шага ③. Слово заголовка не прибавлено к КОНЦУ копии: цикл идёт `источник < конец`,
    // и конец становится на слово раньше — последний элемент старого блока не копируется.
    //
    // ЛОВИТСЯ СУММОЙ, А НЕ ФАКТОМ ПЕРЕЕЗДА: адрес новый, блок новый, ошибок нет — не хватает одного
    // значения. Сумма 1+2+3+4+5 = 15 против 11 при пропущенном четвёртом: в 8-битном канале
    // различимо (оракул проверяет это отдельным контролем).
    id: '15.4',
    title: 'конец копирования на слово раньше — последний элемент не переехал, сумма другая',
    file: 'src/e2k/collectionsRuntime.ts',
    from: "    { mnemonic: 'IR.add', channel: 0, operands: [reg(end), reg(end), reg(eight)] },",
    to: "    // ДЕФЕКТ 15.4: слово заголовка не прибавлено к концу копирования",
    tests: ['src/e2k/collectionsResizeQemu.test.ts'],
    config: 'vitest.qemu.config.ts',
  },
  {
    // ПРОВЕРКА ОТВЕТА `brk` СНЯТА, и снята она СРАВНЕНИЕМ С САМИМ СОБОЙ, а не удалением перехода:
    // удаление оставило бы сравнение без читателя, и оракул покраснел бы по ДРУГОЙ причине
    // (сопоставление пар, `OSN-LOW-004`) — то есть запись проверяла бы не тот механизм, который
    // называет. С `answer != answer` пара цела, а проверка не срабатывает никогда.
    //
    // Ловится контролем 2 оракула владельца: ёмкость 2^28 обязана дать код 231 и текст памяти, а без
    // проверки программа кончается своим выходом (заголовок пишется по адресу, которого нет).
    id: '15.5',
    title: 'сравнение ответа `brk` с запросом сведено к самому себе — отказ ядра не наступает',
    file: 'src/e2k/collectionsRuntime.ts',
    from: '        reg(syscallWindowOf(frame, 0)),\n        reg(syscallWindowOf(frame, 1)),',
    to: '        reg(syscallWindowOf(frame, 0)),\n        reg(syscallWindowOf(frame, 0)), // ДЕФЕКТ 15.5',
    tests: ['src/e2k/collectionsQemu.test.ts'],
    config: 'vitest.qemu.config.ts',
  },
  {
    // ПЕРЕЕЗД «В НИКУДА» РАЗРЕШЁН: сравнение «текущая < новая» сведено к самому себе и всегда
    // ложно. Блок с той же ёмкостью выдаётся как расширенный — то есть отказ, который обязан быть
    // НАЗВАН, исчезает.
    id: '15.6',
    title: 'проверка «новая ёмкость не больше текущей» снята — расширение в никуда проходит молча',
    file: 'src/e2k/collectionsRuntime.ts',
    from: "    { mnemonic: 'IR.lt', channel: 0, operands: [reg(key), reg(capacity), reg(newCapacity)] },",
    to: "    { mnemonic: 'IR.lt', channel: 0, operands: [reg(key), reg(capacity), reg(capacity)] }, // ДЕФЕКТ 15.6",
    tests: ['src/e2k/collectionsResizeQemu.test.ts'],
    config: 'vitest.qemu.config.ts',
  },
  // ── Дефект РАЗВЕДЕНИЯ СТРОК ОТКАЗА (случай 34) ──────────────────────────────
  {
    // ТЕКСТ КОЛЛЕКЦИЙ ПОДМЕНЁН ТЕКСТОМ АРЕНЫ — ровно то состояние, из которого случай 34 и вырос:
    // программа с ареной И коллекциями при отказе коллекции называла ЧУЖОЙ механизм. Строка
    // собирается из того же источника, что и блоки, поэтому подмена одного этого поля разводит
    // СТРОКУ и МЕХАНИЗМ, а не ломает сборку.
    id: '15.7',
    title: 'текст отказа коллекций подменён текстом арены — чужой механизм назван своим',
    file: 'src/e2k/collectionsRuntime.ts',
    from: "  index: COLLECTION_REFUSAL_TEXT,",
    to: "  index: 'арена исчерпана: выделение сверх предела', // ДЕФЕКТ 15.7",
    tests: ['src/e2k/refusalStringsQemu.test.ts'],
    config: 'vitest.qemu.config.ts',
  },
  // ── СТОРОЖА, ПОСТАВЛЕННЫЕ ПО РАЗБОРУ ВЛАДЕЛЬЦА (2026-10-03) ─────────────────
  {
    // ФОРМА, КОТОРАЯ МОЛЧА ТЕРЯЕТ СТАРШИЕ РАЗРЯДЫ. `adds` (форма S) пишет только младшую половину
    // приёмника, а старшая остаётся ПРЕЖНЕЙ: для адреса это младшие 32 бита вместо 64 — тихая ложь,
    // найденная замером поведения (случай 37). Сторож стоит НА СБОРЩИКЕ, поэтому мутация обязана
    // уронить не только проверку сторожа, но и саму сборку серии.
    id: '15.8',
    title: 'граница кучи кладётся S-формой — старшие разряды запроса теряются молча',
    file: 'src/e2k/collectionsRuntime.ts',
    from: "    a('addd', [reg(options.address), reg(COLLECTION_ZERO_REGISTER), window_(syscallWindowOf(frame, 1))]),",
    to: "    a('adds', [reg(options.address), reg(COLLECTION_ZERO_REGISTER), window_(syscallWindowOf(frame, 1))]), // ДЕФЕКТ 15.8",
    tests: ['src/e2k/collectionsRuntime.test.ts'],
    config: 'vitest.config.ts',
  },
  {
    // СОГЛАСОВАННОСТЬ ПРИЧИН: причина пропала из ПОРЯДКА, а текст и требование операции остались.
    // Молча это дало бы переход в блок, которого нет, либо блоб без потребителя — оба класса §3.35.
    id: '15.9',
    title: 'причина отказа пропала из порядка — блоков меньше, чем переходов в них',
    file: 'src/e2k/collectionsRuntime.ts',
    from: "export const COLLECTION_REFUSAL_KINDS: readonly CollectionRefusalKind[] = ['index', 'capacity', 'memory'];",
    to: "export const COLLECTION_REFUSAL_KINDS: readonly CollectionRefusalKind[] = ['index', 'capacity']; // ДЕФЕКТ 15.9",
    tests: ['src/e2k/collectionsRuntime.test.ts'],
    config: 'vitest.config.ts',
  },
];

/**
 * Дефекты **понижения вызова и возврата** (шаг 12).
 *
 * Проверяются оракулами `src/e2k/e2kCallLowering.test.ts` (соглашение по байтам) и
 * `src/e2k/e2kRealRun.test.ts` (полнота прогона). Дефекты выбраны так, чтобы каждый ломал именно
 * соглашение, а не «что-нибудь»: сдвиг окна, порядок чтения результата, приёмник возврата.
 */
export const DEFECTS_CALL_LOWERING: readonly Defect[] = [
  {
    id: '12.1',
    title: 'аргументы кладутся не в то окно (сдвиг wbs вместо 2*wbs)',
    file: 'src/e2k/e2kRealRun.ts',
    from: '      instructions.push(movts(source.index, wbs * 2 + argument));',
    to: '      instructions.push(movts(source.index, wbs + argument)); // ДЕФЕКТ 12.1: сдвиг окна перепутан',
    tests: ['src/e2k/e2kCallLowering.test.ts'],
    config: 'vitest.config.ts',
  },
  {
    id: '12.2',
    title: 'результат вызова читается ДО передачи управления (пересылка встала не туда)',
    file: 'src/e2k/e2kRealRun.ts',
    from: '      instructions.push(movts(wbs * 2, destination.index));',
    to: '      instructions.unshift(movts(wbs * 2, destination.index)); // ДЕФЕКТ 12.2: чтение результата до вызова',
    tests: ['src/e2k/e2kCallLowering.test.ts'],
    config: 'vitest.config.ts',
  },
  {
    id: '12.3',
    title: 'возврат кладёт значение не в приёмник соглашения',
    file: 'src/e2k/e2kRealRun.ts',
    from: '    const result = flag.value === 1 ? movts((value as { index: number }).index, 0) : undefined;',
    to: '    const result = flag.value === 1 ? movts((value as { index: number }).index, 8) : undefined; // ДЕФЕКТ 12.3: приёмник возврата не тот (соглашение — свой %r0)',
    tests: ['src/e2k/e2kCallLowering.test.ts'],
    config: 'vitest.config.ts',
  },
  {
    id: '12.4',
    title: 'длина вызова не учитывает пересылку результата — адреса уезжают',
    file: 'src/e2k/twoPassLayout.ts',
    from: "  if (flags.hasDestination) commands.push(CALL_COMMAND_FORMS.get('movts')!);",
    to: "  if (false) commands.push(CALL_COMMAND_FORMS.get('movts')!); // ДЕФЕКТ 12.4: длина вызова занижена",
    tests: ['src/e2k/e2kCallLowering.test.ts', 'src/e2k/e2kRealRun.test.ts'],
    config: 'vitest.config.ts',
  },
];

/**
 * Дефекты **повторной материализации констант** (шаг 13).
 *
 * Проверяются оракулом `src/e2k/rematerialize.test.ts`. Дефекты выбраны так, чтобы каждый ломал именно
 * правило: границу блока, порог «нужны два чтения», карту переезда индексов.
 */
export const DEFECTS_REMATERIALIZE: readonly Defect[] = [
  {
    id: '13.1',
    title: 'граница блока не проверяется — определение материализуется через цель перехода',
    file: 'src/e2k/rematerialize.ts',
    from: '    if (starts.some((start) => start > index && start <= last)) {',
    to: '    if (false && starts.some((start) => start > index && start <= last)) { // ДЕФЕКТ 13.1: граница не проверяется',
    tests: ['src/e2k/rematerialize.test.ts'],
    config: 'vitest.e2k.config.ts',
  },
  {
    id: '13.2',
    title: 'порог чтений снят — определение убирается и при одном чтении',
    file: 'src/e2k/rematerialize.ts',
    from: '    if (reads.length < 2) {',
    to: '    if (reads.length < 1) { // ДЕФЕКТ 13.2: хватит и одного чтения',
    tests: ['src/e2k/rematerialize.test.ts'],
    config: 'vitest.e2k.config.ts',
  },
  {
    id: '13.3',
    title: 'карта переезда индексов не заполняется — вставки не сдвигают цели переходов',
    file: 'src/e2k/rematerialize.ts',
    from: '    fullIndexOf[index] = result.length;',
    to: '    fullIndexOf[index] = index; // ДЕФЕКТ 13.3: вставки не учтены',
    tests: ['src/e2k/rematerialize.test.ts'],
    config: 'vitest.e2k.config.ts',
  },
];

/** Прогнать все дефекты, проверить восстановление и записать отчёт. */
export function runAll(
  defects: readonly Defect[] = [
    ...DEFECTS,
    ...DEFECTS_STEP6,
    ...DEFECTS_WIDE,
    ...DEFECTS_REGALLOC,
    ...DEFECTS_WIRING,
    ...DEFECTS_INVOKE,
    ...DEFECTS_CALLEE_WINDOW,
    ...DEFECTS_CALL_LOWERING,
    ...DEFECTS_REMATERIALIZE,
  ],
  work = WORK,
): DefectReport[] {
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

/**
 * Дефекты формы 0xdc и системного вызова `write` (шаг 6).
 *
 * Тот же протокол, что у дефектов раскладки: внесение, прогон, восстановление из копии,
 * sha256 до и после, повторный прогон.
 */
export const DEFECTS_STEP6: readonly Defect[] = [
  {
    id: '6.1',
    title: 'форма 0xdc снята — 64-битный литерал не перехватывается',
    file: 'src/e2k/e2k-real.ts',
    from: '  const wide = instruction.operands.findIndex((operand) => operand.kind === "imm64");',
    to: '  const wide = -1; // ДЕФЕКТ 6.1: форма 0xdc снята',
    tests: ['src/e2k/e2kImm64.test.ts'],
    config: 'vitest.config.ts',
  },
  {
    id: '6.2',
    title: 'отказ на усечении снят — 0x100000000 даёт 0',
    file: 'src/e2k/e2k-real.ts',
    from: '  const fits32 = literal.value >= -2147483648 && literal.value <= 2147483647;',
    to: '  const fits32 = true; // ДЕФЕКТ 6.2: отказ на усечении снят',
    tests: ['src/e2k/e2kImm64.test.ts'],
    config: 'vitest.config.ts',
  },
  {
    id: '6.3',
    title: 'порядок слов литерала перепутан',
    file: 'src/e2k/e2k-real.ts',
    from: '  writeWord(bytes, 8, Number(bits >> 32n) >>> 0);\n  writeWord(bytes, 12, Number(bits & 0xffffffffn) >>> 0);',
    to: '  writeWord(bytes, 8, Number(bits & 0xffffffffn) >>> 0); // ДЕФЕКТ 6.3\n  writeWord(bytes, 12, Number(bits >> 32n) >>> 0);',
    tests: ['src/scripts/e2kExternalAs.test.ts'],
    config: 'vitest.config.ts',
  },
  {
    id: '6.4',
    title: 'write снят — вывод пуст',
    file: 'src/e2k/syscallRuntime.ts',
    from: "    { mnemonic: 'movts', channel: 0, operands: [imm(SYS_WRITE), wreg(WINDOW_NUMBER_REGISTER)] },",
    to: "    { mnemonic: 'movts', channel: 0, operands: [imm(SYS_EXIT), wreg(WINDOW_NUMBER_REGISTER)] }, // ДЕФЕКТ 6.4",
    tests: ['src/e2k/e2kSyscallRuntime.test.ts'],
    config: 'vitest.qemu.config.ts',
  },
  {
    // Дефект **не** в кодировщике, а в самом вычислении адреса: значение литерала и ожидание
    // `expectDisasm` уезжают вместе, поэтому сверка по префиксу строки остаётся зелёной. Ловится
    // тем, что значение пришпилено к измеренной константе 0x100070 (перемер 2026-09-24: код стал
    // на 32 байта короче после короткой формы `0xc0 | N`), и прогоном в QEMU — то есть
    // проверкой значения, ради которой она и заведена.
    id: '6.5',
    title: 'адрес строки сдвинут на 8 — префиксная сверка слепа, сверка значения нет',
    file: 'src/e2k/syscallRuntime.ts',
    from: '  const textAddress = MINIMAL_BASE + code.length;',
    to: '  const textAddress = MINIMAL_BASE + code.length + 8; // ДЕФЕКТ 6.5',
    tests: ['src/e2k/e2kSyscallRuntime.test.ts'],
    config: 'vitest.qemu.config.ts',
  },
  // ── Дефект БЛОКА РАНТАЙМА МАССИВОВ В ВЫЗЫВАЕМОЙ (§3.131) ────────────────────
  {
    // Дефект ровно тот, что стоял в дереве до §3.131: блок вызываемой берётся из ЕЁ ПУЛА, а не из
    // собственной половины кадра. Клетка `N` вызываемой — это клетка `N + 8` вызывающего, поэтому
    // пятёрка 3..7 накрывает `%b[11..15]` вызывающего, пролог значений вызываемой пишет ЕДИНИЦУ в
    // его клетку 12, а выход программы считает `код = значение + %b[12]` — и ответ уезжает на «+1»:
    // М3 7 вместо 6, М4 6 вместо 5, К3 8 вместо 7 (замер §3.130).
    //
    // Сторож — `src/e2k/arrayBlockOwnership.test.ts`: он краснеет ИМЕННО на растянутом бюджете
    // («НЕГАТИВНЫЙ КОНТРОЛЬ: растянутый бюджет вызываемой — ОТКАЗ, а не чужие клетки»), а числа
    // плоскостей держит исполнением `src/e2k/e2kArraysQemu.test.ts` (шлюз `gate:qemu`).
    id: '17.1',
    title: 'блок вызываемой снова берётся из пула вызывающего (своя половина кадра не проверяется)',
    file: 'src/e2k/regAlloc.ts',
    from: '      if (cells.some((cell) => cell < ownFrom)) continue;',
    to: '      // ДЕФЕКТ 17.1: правило «только своя половина кадра» снято — блок берётся из чужого пула',
    tests: ['src/e2k/arrayBlockOwnership.test.ts'],
    config: 'vitest.config.ts',
  },
];

if (require.main === module) {
  try {
    runAll();
  } catch (error) {
    console.error(`останов: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
