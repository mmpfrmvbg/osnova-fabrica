/**
 * ОРАКУЛ ФЛАГА ЦЕЛИ `--target e2k`: ЧЕЛОВЕК ОБЯЗАН УЗНАТЬ, ЧТО НА ЦЕЛИ ПРОГРАММА НЕ СОБЕРЁТСЯ.
 *
 * # Что закрывается
 *
 * До этой правки замер давал: файл с телом `вернуть 17 % 5` (формы понижения у `IR.rem` нет) —
 * **код 0 и одна строка «Скомпилировано»** у обоих входов, при том что конвейер цели собирал образ
 * **112 байт с одним выброшенным носителем**. Программа «собралась», а число на цели будет неверным:
 * самый дорогой класс расхождений — тихая ложь.
 *
 * # Три утверждения приёмки (все обязательны)
 *
 * 1. отказ + `--target e2k` → код **1**, назван класс и носитель;
 * 2. та же программа **без** флага → код **0** (совместимость: поведение команды не изменилось);
 * 3. программа без отказов + `--target e2k` → код **0**.
 *
 * # Отрицательные контроли — их три, и они разного рода
 *
 * - **класс берётся из данных, а не из константы:** вторая проба (строка в пул констант) обязана
 *   напечатать ДРУГОЙ класс (`константа-невыразима`), а не тот же самый;
 * - **класс следует за КОДОМ, а не за текстом причины:** две пробы одного вида с разными значениями
 *   дают разные тексты (`= привет` против `= пока`) и один класс; незнакомый код даёт
 *   `код-вне-контракта`, а не «похоже на…»;
 * - **значение флага не становится входным файлом:** `compile проба.osnova --target e2k` до правки
 *   искал файл с именем `e2k` — опыт ставит флаг и ПОСЛЕ файла, и ПЕРЕД ним.
 *
 * # Канал
 *
 * Наблюдатель цели (`src/scripts/e2kLoweringDiagnostics.ts`) — единственный источник формы вывода;
 * оракул проверяет ровно то, что он печатает, и не заводит второго формата. Машинный канал
 * (`--diagnostics=json`) обязан остаться чистым JSONL: человеческого предупреждения в stdout быть
 * не должно.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { classOfCode, loweringDiagnosticsOf, parseRefusalText } from './e2kLoweringDiagnostics';

const ROOT = path.resolve(__dirname, '..', '..');

/** Точки входа команды: установленная (`src/cli.ts` → `dist/cli.js`) и вторая (`src/cli/index.ts`). */
const MAIN_ENTRY = 'src/cli.ts';
const SECOND_ENTRY = 'src/cli/index.ts';

const WARNING = 'ВНИМАНИЕ: образ собран, но носители выброшены — на цели число будет неверным';

function source(body: string): string {
  return `модуль проба\n\nпроцедура главная(): Число\n${body}\nконец_процедуры\n\nконец_модуля\n`;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osnova-target-'));
/** Проба с отказом понижения: `IR.rem` формы не имеет (замер: образ 112 байт, 1 отказ). */
const REFUSED = path.join(dir, 'отказ.osnova');
/** Проба без отказов: контрольная арифметика. */
const CLEAN = path.join(dir, 'чистая.osnova');
/** Проба с ДРУГИМ классом отказа: строка попадает в пул констант, литералом e2k её не выразить. */
const OTHER_CLASS = path.join(dir, 'другой-класс.osnova');
/** Та же проба с ДРУГИМ значением: текст причины другой, класс обязан совпасть. */
const OTHER_CLASS_TWIN = path.join(dir, 'другой-класс-близнец.osnova');

fs.writeFileSync(REFUSED, source('  вернуть 17 % 5'), 'utf-8');
fs.writeFileSync(CLEAN, source('  вернуть 17 - 5'), 'utf-8');
fs.writeFileSync(OTHER_CLASS, source('  система.лог.вывести("привет")'), 'utf-8');
fs.writeFileSync(OTHER_CLASS_TWIN, source('  система.лог.вывести("пока")'), 'utf-8');

/** Прогон настоящей команды — тем же способом, что и человек из терминала. */
function cli(entry: string, args: readonly string[]): { code: number; out: string; err: string } {
  const quoted = args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ');
  const result = spawnSync(`npx tsx ${entry} compile ${quoted}`, {
    shell: true,
    cwd: ROOT,
    encoding: 'utf-8',
  });
  return { code: result.status ?? 1, out: result.stdout ?? '', err: result.stderr ?? '' };
}

describe('флаг цели: человек узнаёт, что на e2k программа не соберётся', () => {
  it('(а) отказ + `--target e2k` → код 1, класс и носитель названы', () => {
    const r = cli(MAIN_ENTRY, [REFUSED, '--target', 'e2k']);
    expect(r.code, `ожидался код 1, вывод: ${r.out}${r.err}`).toBe(1);
    expect(r.out).toContain('[носитель-без-формы]');
    expect(r.out).toContain('#2 IR.rem');
    expect(r.out).toContain('формы понижения нет');
    expect(r.out).toContain('отказов 1');
    expect(r.out, 'предупреждение наблюдателя обязано дойти до человека').toContain(WARNING);
  });

  it('(а2) флаг стоит ПЕРЕД файлом, и вторая точка входа говорит то же', () => {
    // Опыт различающий: до правки разбор брал «последний позиционный» аргумент, и значение флага
    // (`e2k`) само становилось входным файлом — команда отвечала «Файл не найден».
    const r = cli(SECOND_ENTRY, ['--target', 'e2k', REFUSED]);
    expect(r.code, `ожидался код 1, вывод: ${r.out}${r.err}`).toBe(1);
    expect(r.out).toContain('[носитель-без-формы]');
    expect(r.out, 'значение флага не имеет права искать файл с именем «e2k»').not.toContain('Файл не найден');
  });

  it('(б) та же программа БЕЗ флага → код 0: поведение команды не изменилось', () => {
    const r = cli(MAIN_ENTRY, [REFUSED]);
    expect(r.code, `ожидался код 0 (совместимость), вывод: ${r.out}${r.err}`).toBe(0);
    expect(r.out).toContain('Скомпилировано');
    expect(r.out, 'без флага цели наблюдатель не вызывается').not.toContain(WARNING);
    expect(r.out).not.toContain('отказов');
  });

  it('(в) программа без отказов + `--target e2k` → код 0 и это сказано числом', () => {
    const r = cli(MAIN_ENTRY, [CLEAN, '--target', 'e2k']);
    expect(r.code, `ожидался код 0, вывод: ${r.out}${r.err}`).toBe(0);
    expect(r.out).toContain('отказов 0');
    expect(r.out).not.toContain(WARNING);
  });

  it('(г) НЕГАТИВНЫЙ КОНТРОЛЬ: класс берётся из данных, а не из константы', () => {
    const other = cli(MAIN_ENTRY, [OTHER_CLASS, '--target', 'e2k']);
    expect(other.code).toBe(1);
    expect(other.out).toContain('[константа-невыразима]');
    expect(other.out).toContain('IR.const');
    expect(other.out, 'тот же класс на другой причине означал бы, что класс — константа').not.toContain(
      '[носитель-без-формы]',
    );
    expect(other.out).toContain(WARNING);
    // Вторая проба ТОГО ЖЕ вида, но с другим значением в тексте: класс тот же, текст другой —
    // значит класс не следует за строкой (в строке лежит значение: `константа пула #0 = привет`).
    const twin = cli(MAIN_ENTRY, [OTHER_CLASS_TWIN, '--target', 'e2k']);
    expect(twin.code).toBe(1);
    expect(twin.out).toContain('[константа-невыразима]');
    expect(twin.out).toContain('пока');
    expect(other.out).toContain('привет');
    expect(twin.out, 'тексты причин обязаны различаться — иначе контроль пуст').not.toBe(other.out);
  });

  it('(д) неизвестная цель — названный отказ, а не молчание', () => {
    const r = cli(MAIN_ENTRY, [REFUSED, '--target', 'windows']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('«windows» не поддержана');
    expect(r.err).toContain('e2k');
    // Отказ разбора — ДО компиляции: артефакта и строки «Скомпилировано» быть не должно.
    expect(r.out).not.toContain('Скомпилировано');
  });

  it('(е) машинный канал остаётся машинным: stdout — только JSONL, и в нём класс', () => {
    const r = cli(MAIN_ENTRY, [REFUSED, '--target', 'e2k', '--diagnostics=json']);
    expect(r.code).toBe(1);
    const lines = r.out.split(/\r?\n/).filter((line) => line.trim() !== '');
    expect(lines.length, `ожидалась одна запись, вывод: ${r.out}`).toBe(1);
    const record = JSON.parse(lines[0]!) as { class?: string; carrier?: string; index?: number; message?: string };
    expect(record.class).toBe('носитель-без-формы');
    expect(record.carrier).toBe('IR.rem');
    expect(record.index).toBe(2);
    expect(record.message).toContain('формы понижения нет');
    expect(r.out, 'человеческого предупреждения в машинном stdout быть не должно').not.toContain(WARNING);
  });

  it('(ж) НЕГАТИВНЫЙ КОНТРОЛЬ: класс следует за КОДОМ, а не за текстом причины', () => {
    // Текст отказа несёт ЗНАЧЕНИЕ (`константа пула #0 = привет`), поэтому строка как ключ негодна:
    // две пробы одного вида дают разные строки. Класс обязан совпасть — он читается из кода.
    const first = loweringDiagnosticsOf(source('  система.лог.вывести("привет")'), 'первая.osnova').diagnostics[0]!;
    const second = loweringDiagnosticsOf(source('  система.лог.вывести("пока")'), 'вторая.osnova').diagnostics[0]!;
    expect(first.message, 'тексты причин обязаны различаться — иначе контроль пуст').not.toBe(second.message);
    expect(first.message).toContain('привет');
    expect(second.message).toContain('пока');
    expect(second.code).toBe(first.code);
    expect(second.class).toBe(first.class);
    expect(first.class).toBe('константа-невыразима');
    // Класс — чистая функция КОДА: текста в подписи нет вовсе, и это и есть контракт наблюдателя.
    expect(classOfCode(first.code)).toBe(first.class);
    // Незнакомый код не угадывается: состояние названо, а не подобрано по похожести.
    expect(classOfCode('OSN-LOW-999')).toBe('код-вне-контракта');
    // Разбор строки отказа не выдумывает место, когда его нет.
    expect(parseRefusalText('просто текст').index).toBeUndefined();
    expect(parseRefusalText('#2 IR.rem: причина').carrier).toBe('IR.rem');
    expect(parseRefusalText('#2 IR.rem: причина').index).toBe(2);
  });

  it('(з) установленная команда (`dist/cli.js`) говорит то же — если артефакт есть и не устарел', () => {
    const built = path.join(ROOT, 'dist', 'cli.js');
    if (!fs.existsSync(built)) {
      // `dist/` не в git: его отсутствие — «проверка не выполнена», а не дефект
      // (тот же принцип, что у сторожа свежести `src/scripts/errorChannel.audit.test.ts`).
      expect(fs.existsSync(built), 'dist/cli.js не собран — прогони `npm run build`, тогда проверка включится').toBe(
        false,
      );
      return;
    }
    // СВЕЖЕСТЬ — не моя забота: её стережёт `src/scripts/errorChannel.audit.test.ts`, и он же
    // объявляет несвежий артефакт дефектом. Здесь важно другое: если команда собрана ИЗ
    // ТЕКУЩЕГО кода, она обязана говорить то же, что исходник (иначе «установленный osnova»
    // живёт своей жизнью — ровно тот разъезд, ради которого заведён сторож свежести).
    const fresh = [path.join(ROOT, 'src', 'cli.ts'), path.join(ROOT, 'src', 'cli', 'target.ts')].every(
      (sourceFile) => fs.statSync(built).mtimeMs >= fs.statSync(sourceFile).mtimeMs,
    );
    if (!fresh) {
      expect(fresh, 'dist/cli.js старше исходника — проверка не выполнена (свежесть стережёт errorChannel.audit)').toBe(
        false,
      );
      return;
    }
    const result = spawnSync(`node dist/cli.js compile ${JSON.stringify(REFUSED)} --target e2k`, {
      shell: true,
      cwd: ROOT,
      encoding: 'utf-8',
    });
    const out = result.stdout ?? '';
    expect(result.status, `установленная команда обязана выходить кодом 1, вывод: ${out}${result.stderr ?? ''}`).toBe(1);
    expect(out).toContain('[носитель-без-формы]');
    expect(out).toContain(WARNING);
  });
});
