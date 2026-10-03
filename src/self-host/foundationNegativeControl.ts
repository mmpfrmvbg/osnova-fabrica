/**
 * НЕГАТИВНЫЙ КОНТРОЛЬ ОРАКУЛА ФУНДАМЕНТА: ОРАКУЛ ОБЯЗАН РАЗЛИЧАТЬ ПОДМЕНУ.
 *
 * # Правило, из которого это следует
 *
 * «Сторож, собравший НОЛЬ проверок, выглядит зелёным так же, как работающий» (`AGENTS.md`, случай 22).
 * То же и здесь: оракул, который зеленеет при ЛЮБОМ исходе, ничего не утверждает. Значит мало
 * показать зелёный — надо показать, что при ПОДМЕНЕ он краснеет, и что красное называет СВОЮ
 * причину, а не соседнюю.
 *
 * # Как это делается
 *
 * 1. Копия файла снимается ДО правки (восстановление из испорченного файла не доказывает ничего).
 * 2. Вносится ровно одна замена — по дословной строке; не нашлась строка → СТОП, а не «примерно».
 * 3. Прогон оракула: он обязан покраснеть, и текст обязан содержать ожидаемое.
 * 4. Файл восстанавливается из копии, сверяется sha256 до и после.
 * 5. Пустой прогон (повтор без дефекта) обязан быть зелёным — иначе «поймано» ничего не значит.
 *
 * Использование:
 *   npx tsx src/self-host/foundationNegativeControl.ts
 *   отчёт: .tmp/self-host-foundation-negative-control.json
 */
import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const VITEST = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const REPORT = path.join(ROOT, '.tmp', 'self-host-foundation-negative-control.json');
const BACKUP = path.join(ROOT, '.tmp', 'self-host-foundation-nc-backup');

/** Один дефект: файл, дословная замена и текст, который обязан появиться в красном. */
interface Defect {
  readonly id: string;
  readonly title: string;
  readonly file: string;
  readonly from: string;
  readonly to: string;
  readonly tests: readonly string[];
  /** Подстрока, которой обязан отличаться красный вывод: «покраснел» и «покраснел ПО ТОЙ причине» — разное. */
  readonly expects: readonly string[];
}

/**
 * Дефекты выбраны по одному на КАЖДУЮ сторону оракула, а не «побольше»:
 *
 * | # | что ломается | что обязано покраснеть |
 * |---|---|---|
 * | Н1 | номер `open` взят как на x86_64 (2 вместо 5) | сверка номеров И опыт с файлами |
 * | Н2 | `read` пишет в сегмент КОДА (`R|X`) | опыт чтения: `EFAULT` вместо байтов |
 * | Н3 | `read` снят из программы (замена «прочитай» на «ничего») | контроль без чтения обязан поймать |
 * | Н4 | сторож формы: `sdisp` не проверяется | негативный контроль формы перестаёт ловить |
 *
 * Н2 — самый ценный: это ровно тот дефект, который был найден замером, и оракул обязан уметь его
 * назвать, а не «просто упасть».
 */
export const DEFECTS: readonly Defect[] = [
  {
    id: 'Н1',
    title: 'номер `open` взят по x86_64 (2 вместо 5)',
    file: 'src/self-host/fileRuntime.ts',
    from: 'export const SYS_OPEN = 5;',
    to: 'export const SYS_OPEN = 2; // ДЕФЕКТ Н1: номер как на x86_64',
    tests: ['src/self-host/foundationE2k.test.ts'],
    expects: ['open'],
  },
  {
    id: 'Н2',
    title: 'буфер `read` перенесён в сегмент КОДА (R|X) — запись туда запрещена',
    file: 'src/self-host/foundationE2k.test.ts',
    from: 'const BUFFER = DATA_SEGMENT_BASE + 0x100;',
    to: 'const BUFFER = MINIMAL_BASE + 0x200; // ДЕФЕКТ Н2: буфер в сегменте кода',
    tests: ['src/self-host/foundationE2k.test.ts'],
    expects: ['open-read-close', 'байты нашего файла'],
  },
  {
    id: 'Н3',
    title: 'из программы чтения снят `read` — байты файла взять неоткуда',
    file: 'src/self-host/foundationE2k.test.ts',
    from: '        ...readInstructions({ fd: 1, bufferAddress: адреса.буфер, count: 16, result: 2 }),\n        a(\'movtd\', [literal(адреса.буфер), reg(7)]),',
    to: '        a(\'movtd\', [literal(адреса.буфер), reg(7)]), // ДЕФЕКТ Н3: read снят',
    tests: ['src/self-host/foundationE2k.test.ts'],
    expects: ['байты нашего файла'],
  },
  {
    id: 'Н4',
    title: 'сторож формы перестал видеть `sdisp` (сравнение вывернуто)',
    file: 'src/self-host/fileRuntime.ts',
    from: '  if (sdisp < 0) problems.push(\'нет sdisp: без тега CTPSL call уйдёт в процедуру, а не в ядро\');',
    to: '  if (sdisp > 0) problems.push(\'нет sdisp: без тега CTPSL call уйдёт в процедуру, а не в ядро\'); // ДЕФЕКТ Н4',
    tests: ['src/self-host/foundationE2k.test.ts'],
    expects: ['CTPSL'],
  },
];

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function runOracle(tests: readonly string[]): { ok: boolean; output: string } {
  try {
    const output = execFileSync(process.execPath, [VITEST, 'run', ...tests], {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 900_000,
      env: { ...process.env, TEMP: 'D:\\tmp-osnova', TMP: 'D:\\tmp-osnova' },
    });
    return { ok: true, output };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

interface Result {
  id: string;
  title: string;
  caught: boolean;
  restored: boolean;
  reason: string;
}

function main(): void {
  fs.mkdirSync(BACKUP, { recursive: true });
  const results: Result[] = [];

  // КОПИИ «ДО» НЕ ЖИВУТ ПОСЛЕ РАБОТЫ — и это не уборка, а требование.
  //
  // Замер 2026-10-04 (первый прогон этого инструмента): копия `foundationE2k.test.ts`, оставленная
  // в `.tmp/self-host-foundation-nc-backup/`, была СОБРАНА витстом как второй файл оракула — и
  // сторож счёта файлов покраснел сразу по двум классам: «ноль собранных проверок» (случай 22) и
  // «проверка вне репозитория» (случай 7). Копия теста — не мусор, а второй оракул, который
  // выглядит зелёным ровно так же, как настоящий.
  if (fs.existsSync(BACKUP)) fs.rmSync(BACKUP, { recursive: true, force: true });
  fs.mkdirSync(BACKUP, { recursive: true });

  // ШАГ 0: без дефектов оракул обязан быть ЗЕЛЁНЫМ — иначе контроль недействителен.
  console.log('шаг 0: пустой прогон (дефекта нет)…');
  const clean = runOracle(['src/self-host/']);
  if (!clean.ok) {
    console.error('ОСТАНОВ: оракул красный БЕЗ дефекта — контроль недействителен.');
    console.error(clean.output.slice(-2000));
    process.exit(1);
  }
  console.log('  зелёный — можно вносить дефекты.\n');

  for (const defect of DEFECTS) {
    const file = path.join(ROOT, defect.file);
    const backup = path.join(BACKUP, path.basename(defect.file));
    const before = sha256(file);
    fs.copyFileSync(file, backup);

    const source = fs.readFileSync(file, 'utf-8');
    if (!source.includes(defect.from)) {
      console.error(`ОСТАНОВ ${defect.id}: дословная строка не найдена в ${defect.file}.`);
      console.error(`  искалось: ${JSON.stringify(defect.from.slice(0, 120))}`);
      fs.copyFileSync(backup, file);
      process.exit(1);
    }
    fs.writeFileSync(file, source.replace(defect.from, defect.to), 'utf-8');
    console.log(`дефект ${defect.id}: ${defect.title}`);

    const run = runOracle(defect.tests);
    const названо = defect.expects.every((needle) => run.output.includes(needle));
    const caught = !run.ok;
    fs.copyFileSync(backup, file);
    const restored = sha256(file) === before;

    const reason = caught ? (названо ? 'пойман, причина названа' : 'пойман, но причина НЕ названа') : 'НЕ ПОЙМАН';
    console.log(`  ${reason}; файл восстановлен: ${restored ? 'да' : 'НЕТ'}\n`);
    results.push({ id: defect.id, title: defect.title, caught: caught && названо, restored, reason });
  }

  // ШАГ ПОСЛЕ: восстановленное дерево обязано снова быть зелёным. Копии «до» убираются ДО прогона:
  // пока они лежат в дереве, прогон видит их как файлы оракулов (см. разбор в начале `main`).
  fs.rmSync(BACKUP, { recursive: true, force: true });
  console.log('шаг после: прогон после восстановления…');
  const after = runOracle(['src/self-host/']);
  const allCaught = results.every((r) => r.caught && r.restored);
  const report = { clean: true, after: after.ok, defects: results, ok: allCaught && after.ok };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2), 'utf-8');
  // Отдельная проверка УБОРКИ, а не «мы её сделали»: пустая папка копий обязана остаться пустой
  // (или исчезнуть). Без неё следующая правка инструмента могла бы вернуть копии в дерево молча.
  const copiesLeft = fs.existsSync(BACKUP) ? fs.readdirSync(BACKUP).length : 0;
  report.clean = copiesLeft === 0;
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`  ${after.ok ? 'зелёный' : 'КРАСНЫЙ — восстановление неполное'}`);
  console.log(`  копий «до» осталось в дереве: ${String(copiesLeft)} (обязано быть 0)`);
  console.log(`\nИТОГ: поймано ${String(results.filter((r) => r.caught).length)} из ${String(results.length)}; отчёт ${REPORT}`);
  if (!report.ok) process.exit(1);
}

main();
