/**
 * ОРАКУЛ ПЕЧАТИ НА ЦЕЛИ: ЧИСЛО → ТЕКСТ, СВЕРКА БАЙТАМИ ЭТАЛОНА, КОД ВОЗВРАТА 0.
 *
 * # Что здесь утверждается — два утверждения, и оба обязательны
 *
 * 1. **Байты вывода гостя равны эталону записи корпуса побайтово** (не `includes` и не `trim`):
 *    `39` = `31 30 0a`, `40` = `30 0a`, `41` = `2d 37 0a`, `42` = `39 37 38 0a`, `44` = `31 30 30 0a`
 *    (`docs/hardware-debt.md` §3.42.1). Нынешняя единственная проверка печати в дереве ищет
 *    подстроку `hello` и не различает «10» и «100» — эта различает, и различие берётся из эталона.
 * 2. **Код возврата = 0.** §3.39 измерено: программа без своего `exit` на цели падает (134),
 *    поэтому ноль против 134 и есть разница между «напечатала и вышла» и «напечатала и провалилась».
 *
 * # Канал наблюдения — названный, а не «как получилось»
 *
 * Читать память гостя после прогона в дереве **нечем**. Модель запускается с `-d strace` и шимом
 * (`guest_base` без шима не встаёт): гостевой текст приходит в stdout, а журнал системных вызовов —
 * в stderr, и в нём видно `write(1,<адрес>,<длина>)`. Адрес и длина сверяются с посчитанными в TS
 * ПО ЧИСЛУ — независимый свидетель арифметики адреса, а не её пересказ.
 *
 * # Границы
 *
 * Модель — не железо: числа с неё не переносятся на Эльбрус без прогона на железе
 * (`tools/e2k-hardware/`). Файл живёт в шлюзе `gate:qemu` и в полном прогоне не участвует.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getEncoder, type AsmInstruction, type Operand } from './backend';
import { buildElfFromCode, MINIMAL_BASE, WRITE_ZONE_EXTRA_MEMORY } from './elfMinimal';
import { ARRAY_REGISTERS, arrayPrologue } from './arrayRuntime';
import { HEAP_OFFSET, loweredProgram } from './programImage';
import {
  ASCII_NEWLINE,
  PRINT_AREA_LAYOUT,
  PRINT_DIGITS,
  PRINT_PRIMITIVE_REGISTERS,
  numberToTextPrimitives,
  writeTextPrimitives,
  exitPrimitives,
  printAreaOf,
  numberToTextLeanPrimitives,
} from './printPrimitives';
import { buildShim, toWslPath } from '../scripts/e2kQemuExec';
import { ENTRY_SYSCALL_FRAME, GROWN_SYSCALL_FRAME, WINDOW_NUMBER_REGISTER } from './syscallRuntime';

const ROOT = path.resolve(__dirname, '..', '..');
const encoder = getEncoder('e2k');
const HEAP = MINIMAL_BASE + HEAP_OFFSET;
const AREA = printAreaOf(HEAP);
const imm = (value: number): Operand => ({ kind: 'imm', value });
const reg = (index: number): Operand => ({ kind: 'reg', index });

/** Регистр аргумента пробы: последовательность копирует его в свой рабочий сама. */
const ARGUMENT = PRINT_PRIMITIVE_REGISTERS.input + 1;

function pack(instructions: readonly AsmInstruction[]): Uint8Array {
  const chunks = instructions.map((instruction) => encoder.encode(instruction));
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

/** Значение — в регистр-аргумент. Отрицательное: `subs(ноль, v)` — литералом знак не кладётся. */
function valueInto(argument: number, value: number): AsmInstruction[] {
  if (value >= 0) return [{ mnemonic: 'movts', channel: 0, operands: [imm(value), reg(argument)] }];
  return [
    { mnemonic: 'movts', channel: 0, operands: [imm(-value), reg(argument)] },
    { mnemonic: 'subs', channel: 0, operands: [reg(ARRAY_REGISTERS.zero), reg(argument), reg(argument)] },
  ];
}

/** Программа печати одного числа: пролог, значение, последовательность. */
function printProgram(value: number): AsmInstruction[] {
  return [
    ...arrayPrologue(HEAP),
    ...valueInto(ARGUMENT, value),
    ...numberToTextPrimitives(ARGUMENT, HEAP).instructions,
    ...writeTextPrimitives(HEAP),
    ...exitPrimitives(0),
  ];
}

/** Программа «три вызова печати подряд»: буфер переиспользуется между вызовами (запись `43`). */
function printManyProgram(values: readonly number[]): AsmInstruction[] {
  const instructions: AsmInstruction[] = [...arrayPrologue(HEAP)];
  for (const value of values) {
    instructions.push(
      ...valueInto(ARGUMENT, value),
      ...numberToTextPrimitives(ARGUMENT, HEAP).instructions,
      ...writeTextPrimitives(HEAP),
    );
  }
  instructions.push(...exitPrimitives(0));
  return instructions;
}

/** Прогон модели с журналом системных вызовов: stdout — текст гостя, stderr — журнал. */
function runWithJournal(instructions: readonly AsmInstruction[], name: string): { stdout: Buffer; stderr: string; status: number | null } {
  const elf = path.join(ROOT, '.tmp', `print-primitives-${name}.elf`);
  fs.writeFileSync(elf, buildElfFromCode(pack(instructions), MINIMAL_BASE, { writable: true, extraMemory: WRITE_ZONE_EXTRA_MEMORY }).bytes);
  const result = spawnSync(
    'wsl',
    ['-d', 'e2k', '--', ...(shim === undefined ? [] : ['env', `LD_PRELOAD=${toWslPath(shim)}`]),
      '/root/qemu-build/qemu-e2k', '-d', 'strace', toWslPath(elf)],
    { encoding: 'buffer', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
  );
  return { stdout: result.stdout ?? Buffer.alloc(0), stderr: (result.stderr ?? Buffer.alloc(0)).toString('latin1'), status: result.status };
}

/**
 * Ожидаемые адрес и длина `write` по числу — считаются в TS независимо от программы.
 *
 * Длина: разряды + знак + перевод строки. Адрес: старший разряд стоит по младшему адресу, значит
 * текст начинается со слота `10 − разряды` и сдвигается на байт влево у отрицательного.
 */
function expectedWrite(value: number): { address: number; length: number; bytes: string } {
  const magnitude = Math.abs(value);
  const digits = magnitude === 0 ? 1 : String(magnitude).length;
  const negative = value < 0 ? 1 : 0;
  return {
    address: AREA + PRINT_AREA_LAYOUT.digits + (PRINT_DIGITS - digits) - negative,
    length: digits + negative + 1,
    bytes: [...Buffer.from(`${value < 0 ? '-' : ''}${String(magnitude)}\n`, 'latin1')]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join(' '),
  };
}

const hex = (buffer: Buffer): string => [...buffer].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');

/** Журнал: `write(1,<адрес>,<длина>) = <сколько>` — первая запись. */
function firstWrite(journal: string): { address: number; length: number } | undefined {
  const match = /(\d+) write\(1,(0x[0-9a-f]+),(\d+)\) = (-?\d+)/i.exec(journal);
  if (match === null) return undefined;
  return { address: Number.parseInt(match[2]!, 16), length: Number.parseInt(match[3]!, 10) };
}

/** Записи эталонов корпуса: `examples/39…44`, `expected.txt` — байты целиком (§3.42.1). */
const RECORDS: readonly { readonly record: string; readonly value: number; readonly bytes: string }[] = [
  { record: '39 (эталон 31 30 0a)', value: 10, bytes: '31 30 0a' },
  { record: '40 (эталон 30 0a)', value: 0, bytes: '30 0a' },
  { record: '41 (эталон 2d 37 0a)', value: -7, bytes: '2d 37 0a' },
  { record: '42 (эталон 39 37 38 0a)', value: 978, bytes: '39 37 38 0a' },
  { record: '44 (эталон 31 30 30 0a)', value: 100, bytes: '31 30 30 0a' },
];

const shim = buildShim();

describe('печать на цели: число → текст, сверка байтами эталона', () => {
  it('шим и модель доступны — или причина названа', () => {
    if (shim === undefined) {
      expect(shim, 'шим не собран: в WSL-дистрибутиве нет компилятора C (docs/e2k-qemu-run.md §2.5)').toBeUndefined();
      return;
    }
    expect(shim.length).toBeGreaterThan(3);
  });

  for (const item of RECORDS) {
    it(`запись ${item.record}: в stdout ровно ${item.bytes}, код возврата 0`, () => {
      if (shim === undefined) return;
      const run = runWithJournal(printProgram(item.value), `rec-${String(item.value).replace('-', 'min')}`);
      const expected = expectedWrite(item.value);
      if (run.status !== 0 && run.stdout.length === 0) {
        expect(run.status, `модель не дошла до печати: ${run.stderr.slice(0, 200)}`).toBe(0);
        return;
      }
      expect(hex(run.stdout), `байты вывода обязаны совпасть с эталоном записи целиком`).toBe(item.bytes);
      expect(item.bytes).toBe(expected.bytes);
      expect(run.status, 'печатающая программа обязана завершиться СВОИМ exit(0), иначе 134 (§3.39)').toBe(0);
      const write = firstWrite(run.stderr);
      expect(write, 'журнал модели обязан назвать write(1, адрес, длина)').toBeDefined();
      expect(write?.address, 'адрес текста — независимый расчёт по числу').toBe(expected.address);
      expect(write?.length, 'длина текста — независимый расчёт по числу').toBe(expected.length);
    });
  }

  it('два вызова подряд: буфер переиспользуется, каждая печать даёт свою строку', () => {
    if (shim === undefined) return;
    const run = runWithJournal(printManyProgram([1, 2]), 'two-calls');
    expect(hex(run.stdout), 'два вызова дают две строки: 31 0a 32 0a').toBe('31 0a 32 0a');
    expect(run.status).toBe(0);
    expect(run.stderr.match(/write\(1,/g)?.length, 'в журнале обязаны быть ДВА вызова write').toBe(2);
  });

  it('ПРИЁМКА ПЕРЕЕЗДА: три печати ПОДРЯД (прежде — падение) печатают ВСЕ три строки', () => {
    if (shim === undefined) return;
    // БЫЛО (§3.90.7, замер): три прямые развёртки — конец кода 0x101138 — писали разряды в СТРАНИЦУ,
    // где лежит код, и модель падала `QEMU internal SIGSEGV {code=ACCERR}` (код 139) после двух
    // строк. Тот же образ и есть различающий: код входит в старую страницу площадки (0x101000), а
    // работает — значит изменилась РАСКЛАДКА, а не программа.
    //
    // СТАЛО (§3.91): область записи вынесена на свою страницу (площадка 0x110EC0, куча и арена
    // 0x111000), потолок раскладки — 64 КиБ кода. Предел МОДЕЛИ при этом назван отдельно: печать
    // 76 сайтов (кода 17248) работает, 79 (17872) — утверждение порта `tb-maint.c: tb_record`, и
    // оно НЕ про размер кода: 6000 арифметических носителей (48088 байт) проходят кодом 0
    // (`docs/hardware-debt.md` §3.91).
    const three = printManyProgram([1, 2, 3]);
    const codeEnd = MINIMAL_BASE + pack(three).length;
    expect(codeEnd, 'код обязан заходить в прежнюю страницу площадки (0x101000) — иначе опыт не тот').toBeGreaterThan(MINIMAL_BASE + 0x1000);
    expect(codeEnd, 'но не доходить до самой площадки: 0x110EC0').toBeLessThan(AREA);
    const run = runWithJournal(three, 'three-calls');
    expect(hex(run.stdout), 'все три строки, побайтово').toBe('31 0a 32 0a 33 0a');
    expect(run.status, 'и своё `exit(0)`, а не падение').toBe(0);
    // Сторона «короче»: две развёртки — и они печатают обе строки (соседний случай «два вызова
    // подряд»). Числом здесь показано только то, что сторон две и они разной длины.
    const two = printManyProgram([1, 2]);
    expect(MINIMAL_BASE + pack(two).length, 'две развёртки короче трёх').toBeLessThan(codeEnd);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: подмена числа меняет байты вывода', () => {
    if (shim === undefined) return;
    const first = runWithJournal(printProgram(978), 'neg-978');
    const second = runWithJournal(printProgram(10), 'neg-10');
    expect(hex(first.stdout)).toBe('39 37 38 0a');
    expect(hex(second.stdout)).toBe('31 30 0a');
    expect(hex(first.stdout), 'если байты совпали, проба ничего не сторожит').not.toBe(hex(second.stdout));
    // Различается и ДЛИНА: без этого «10» и «100» неотличимы (ровно тот дефект, что назван в §3.42.1).
    const longRun = runWithJournal(printProgram(100), 'neg-100');
    expect(hex(longRun.stdout)).toBe('31 30 30 0a');
    expect(hex(longRun.stdout)).not.toBe(hex(second.stdout));
    expect(firstWrite(longRun.stderr)?.length).not.toBe(firstWrite(second.stderr)?.length);
  });

  it('перевод строки входит в длину: без него `write` отдал бы на байт меньше', () => {
    if (shim === undefined) return;
    const run = runWithJournal(printProgram(978), 'newline-length');
    const expected = expectedWrite(978);
    expect(expected.length).toBe(4); // «9», «7», «8», «\n»
    expect(expected.bytes.endsWith(ASCII_NEWLINE.toString(16).padStart(2, '0'))).toBe(true);
    expect(firstWrite(run.stderr)?.length).toBe(4);
    expect(hex(run.stdout).split(' ')).toHaveLength(4);
  });

  it('глубина знака: отрицательное печатается с минусом и без минуса у положительного', () => {
    if (shim === undefined) return;
    const negative = runWithJournal(printProgram(-42), 'sign-negative');
    const positive = runWithJournal(printProgram(42), 'sign-positive');
    expect(hex(negative.stdout)).toBe('2d 34 32 0a');
    expect(hex(positive.stdout)).toBe('34 32 0a');
    expect(negative.status).toBe(0);
    expect(positive.status).toBe(0);
  });

  it('модель доступна как модель: причина отказа видна словами, а не только кодом', () => {
    if (shim === undefined) return;
    // Сторож канала: у рабочего прогона журнал есть, у отсутствия модели — нет.
    const run = runWithJournal(printProgram(1), 'channel-guard');
    expect(run.status).toBe(0);
    expect(run.stderr).toContain('write');
  });
});

/** Прогон ГОТОВОГО образа (конвейер целиком) — тем же способом, что ручные программы выше. */
function runImage(bytes: Uint8Array, name: string): { stdout: Buffer; stderr: string; status: number | null } {
  const elf = path.join(ROOT, '.tmp', `print-image-${name}.elf`);
  fs.writeFileSync(elf, bytes);
  const result = spawnSync(
    'wsl',
    ['-d', 'e2k', '--', ...(shim === undefined ? [] : ['env', `LD_PRELOAD=${toWslPath(shim)}`]),
      '/root/qemu-build/qemu-e2k', '-d', 'strace', toWslPath(elf)],
    { maxBuffer: 8 * 1024 * 1024 },
  );
  return { stdout: result.stdout ?? Buffer.alloc(0), stderr: (result.stderr ?? Buffer.alloc(0)).toString('utf-8'), status: result.status };
}

describe('РАЗДЕЛЁННАЯ ПЕЧАТЬ: «число → текст» в листовой процедуре, `write` у вызывающего', () => {
  /** Программа с ЛИСТОВОЙ последовательностью: вход — свой `%b[0]` (окно вызываемой). */
  const leanProgram = (value: number): AsmInstruction[] => [
    ...arrayPrologue(HEAP),
    ...valueInto(PRINT_PRIMITIVE_REGISTERS.input, value),
    ...numberToTextLeanPrimitives(HEAP).instructions,
    ...writeTextPrimitives(HEAP),
    ...exitPrimitives(0),
  ];

  for (const item of RECORDS.slice(0, 4)) {
    it(`листовая последовательность (8 регистров): ${String(item.value)} → ${item.bytes}`, () => {
      if (shim === undefined) return;
      const run = runWithJournal(leanProgram(item.value), `lean-${String(item.value).replace('-', 'min')}`);
      expect(hex(run.stdout), 'листовая последовательность обязана печатать те же байты, что полная').toBe(item.bytes);
      expect(run.status).toBe(0);
    });
  }

  it('ДЕСЯТЬ ПЕЧАТЕЙ в одной программе: конвейер делит развёртку, вывод совпадает побайтово', () => {
    if (shim === undefined) return;
    const values = [0, 1, 7, 10, 42, 100, 978, -7, 12345, 999999];
    const source = `процедура главная()\n${values
      .map((value) => `  система.лог.вывести(${String(value)})`)
      .join('\n')}\nконец_процедуры\n`;
    const image = loweredProgram(source);
    expect(image.refused, 'разделённая печать обязана понижаться без отказов').toEqual([]);
    // ЧИСЛА ПОСЛЕ ПЕРЕЕЗДА ОБЛАСТИ ЗАПИСИ (§3.91): без разделения десять развёрток весили бы
    // ≈14 320 байт, и прежде это был бы ОТКАЗ (потолок 4 КиБ). Теперь потолок — 64 КиБ, поэтому
    // разделение перестало быть условием сборки и осталось тем, чем и было по смыслу: дешевизной
    // (2 900 против 14 320) и независимостью от числа сайтов. Проверяется и то, и другое числом.
    const inline = values.length * pack(numberToTextPrimitives(PRINT_PRIMITIVE_REGISTERS.input, HEAP).instructions).length;
    const shared = image.bytes.length;
    expect(inline, 'без разделения — тяжелее').toBeGreaterThan(shared);
    expect(inline, 'и прежде это не влезало в площадку').toBeGreaterThan(0x1000);
    expect(MINIMAL_BASE + shared, 'с разделением код остаётся ниже области записи').toBeLessThanOrEqual(printAreaOf(HEAP));
    expect(MINIMAL_BASE + inline, 'а без разделения он тоже влез бы — потому что потолок теперь страница').toBeLessThan(printAreaOf(HEAP));
    // `loweredProgram` даёт БАЙТЫ КОДА: обёртка в ELF — тем же вызовом, что у ручных программ выше.
    const run = runImage(buildElfFromCode(image.bytes, MINIMAL_BASE, { writable: true, extraMemory: WRITE_ZONE_EXTRA_MEMORY }).bytes, 'shared-ten');
    const expected = Buffer.from(values.map((value) => `${String(value)}\n`).join(''), 'utf-8');
    expect(hex(run.stdout), 'десять печатей обязаны дать десять строк побайтово').toBe(
      [...expected].map((byte) => byte.toString(16).padStart(2, '0')).join(' '),
    );
    expect(run.status, 'печатающая программа завершается своим exit(0)').toBe(0);
    expect(run.stderr.match(/write\(1,/g)?.length, 'в журнале обязаны быть ДЕСЯТЬ вызовов write').toBe(values.length);
  });
});

/**
 * СТРОКИ НА ЦЕЛИ: приёмка владельца — `длина("🙂")` = 1 (кодпоинт, не 2 и не 4), склейка и вывод.
 *
 * Записи корпуса `02` и `04` сверяет оракул корпуса (тот же шлюз, байты против эталона). Здесь —
 * то, чего в корпусе нет: трёх- и четырёхбайтовые кодпоинты и склейка знаком `+`.
 */
describe('СТРОКИ НА ЦЕЛИ: кодпоинты, склейка, вывод', () => {
  const runSource = (source: string, name: string): { stdout: Buffer; stderr: string; status: number | null } => {
    const image = loweredProgram(source);
    expect(image.refused, `строковая программа «${name}» обязана понижаться без отказов`).toEqual([]);
    return runImage(buildElfFromCode(image.bytes, MINIMAL_BASE, { writable: true, extraMemory: WRITE_ZONE_EXTRA_MEMORY }).bytes, name);
  };
  const wrapped = (body: string): string => `процедура главная()\n${body}\nконец_процедуры\n`;

  it('ПРИЁМКА: длина("🙂") на цели = 1 — кодпоинт, а не 2 и не 4', () => {
    if (shim === undefined) return;
    const run = runSource(wrapped('  система.лог.вывести(система.строка.длина("🙂"))'), 'string-emoji');
    expect(hex(run.stdout), 'один кодпоинт → «1» и перевод строки').toBe('31 0a');
    expect(run.status).toBe(0);
  });

  it('длина по алфавитам: ASCII 6, двухбайтовые 3, склейка 04 даёт 11', () => {
    if (shim === undefined) return;
    const ascii = runSource(wrapped('  система.лог.вывести(система.строка.длина("привет"))'), 'string-ascii');
    expect(hex(ascii.stdout)).toBe('36 0a');
    const cyrillic = runSource(wrapped('  система.лог.вывести(система.строка.длина("Аня"))'), 'string-cyr');
    expect(hex(cyrillic.stdout)).toBe('33 0a');
    const joined = runSource(
      wrapped('  система.лог.вывести(система.строка.длина(система.строка.объединить("Привет, ", "мир")))'),
      'string-joined-length',
    );
    expect(hex(joined.stdout), '20 байт, но 11 КОДООПИНТОВ — эталон записи 04').toBe('31 31 0a');
  });

  it('вывод строки: байты наружу как есть, склейка знаком `+` — тем же путём (канон §2.1)', () => {
    if (shim === undefined) return;
    const text = runSource(wrapped('  система.лог.вывести("Привет, мир")'), 'string-print');
    const expected = Buffer.from('Привет, мир\n', 'utf-8');
    expect(hex(text.stdout)).toBe([...expected].map((byte) => byte.toString(16).padStart(2, '0')).join(' '));
    expect(text.status).toBe(0);
    const plus = runSource(wrapped('  система.лог.вывести("а" + "б")'), 'string-plus');
    const plusExpected = Buffer.from('аб\n', 'utf-8');
    expect(hex(plus.stdout), '`+` склеивает строки, а не складывает адреса').toBe(
      [...plusExpected].map((byte) => byte.toString(16).padStart(2, '0')).join(' '),
    );
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: другой литерал — другие байты вывода', () => {
    if (shim === undefined) return;
    const first = runSource(wrapped('  система.лог.вывести("Аня")'), 'string-neg-anya');
    const second = runSource(wrapped('  система.лог.вывести("Боря")'), 'string-neg-borya');
    expect(hex(first.stdout)).not.toBe(hex(second.stdout));
    expect(hex(first.stdout), 'первый байт «Аня» — d0 90').toBe('d0 90 d0 bd d1 8f 0a');
  });

  it('ГРАНИЦА СТАТИЧЕСКОГО БУФЕРА (20 байт): статика как была, сверх — АРЕНА, отказ переехал', () => {
    // СТОРОЖ РАСШИРЕН, А НЕ УДАЛЁН (решение владельца 2026-09-29). Прежняя редакция требовала на
    // 21 байт ОТКАЗ СБОРКИ. Теперь такую склейку берёт арена, и отказ переехал на её исчерпание —
    // но САМА ГРАНИЦА осталась: двадцать байт это предел СТАТИЧЕСКОГО буфера, и сверх него в буфер
    // не пишется ничего. Порча соседних статических байтов была бы видна в выводе — поэтому вывод
    // и сверяется, побайтово, на ОБОИХ концах границы.
    const runAware = (
      source: string,
      name: string,
    ): { image: ReturnType<typeof loweredProgram>; run: { stdout: Buffer; stderr: string; status: number | null } } => {
      const image = loweredProgram(source);
      expect(image.refused, `программа «${name}» обязана понижаться без отказов`).toEqual([]);
      return {
        image,
        run: runImage(
          // Отображение берётся ИЗ ОТЧЁТА ОБРАЗА: арена лежит выше восьми отображённых килобайт,
          // и прежние «всегда HEAP_OFFSET» сделали бы обращение к ней исключением.
          buildElfFromCode(image.bytes, MINIMAL_BASE, { writable: true, extraMemory: image.arena.extraMemory }).bytes,
          name,
        ),
      };
    };
    const statics = runAware(
      wrapped('  система.лог.вывести(система.строка.объединить("0123456789012345678", "z"))'),
      'string-buffer-20',
    );
    expect(statics.image.arena.used, 'двадцать байт — по-прежнему статический буфер').toBe(false);
    // Отображение определяется ОБЛАСТЬЮ ЗАПИСИ (она выше кода, §3.91), а не ареной: у статической
    // склейки арены нет, но печать есть — и площадке нужна отображённая память.
    expect(statics.image.arena.extraMemory, 'отображение — под область записи').toBe(WRITE_ZONE_EXTRA_MEMORY);
    const staticsExpected = Buffer.from('0123456789012345678z\n', 'utf-8');
    expect(hex(statics.run.stdout), 'статика: вывод — ровно двадцать байт и перевод строки').toBe(
      [...staticsExpected].map((byte) => byte.toString(16).padStart(2, '0')).join(' '),
    );
    expect(statics.run.status).toBe(0);

    const over = runAware(
      wrapped('  система.лог.вывести(система.строка.объединить("0123456789012345678", "zz"))'),
      'string-buffer-21',
    );
    expect(over.image.arena.used, 'двадцать один байт — арена').toBe(true);
    const overExpected = Buffer.from('0123456789012345678zz\n', 'utf-8');
    expect(hex(over.run.stdout), 'арена: вывод — ровно склеенные байты, сосед не тронут').toBe(
      [...overExpected].map((byte) => byte.toString(16).padStart(2, '0')).join(' '),
    );
    expect(over.run.status).toBe(0);
  });
});

/**
 * ПЕЧАТЬ ИЗ ПРОЦЕДУРЫ: СИСТЕМНЫЙ ВЫЗОВ — ЭТО ВЫЗОВ В ЯДРО, АРГУМЕНТЫ ОТНОСИТЕЛЬНО ОКНА (§3.58).
 *
 * Порт читает номер из ОКОННОГО регистра 0 и аргументы из 1..8 (`linux-user/e2k/cpu_loop.c:161-176`),
 * а `call wbs` сдвигает окно на `2·wbs` — поэтому номер обязан лежать в `%r(2·wbs)` вызывающего.
 * В точке входа это `%r8` (wbs = 4), в процедуре с выращенным окном — `%r16` (wbs = 8).
 */
describe('ПЕЧАТЬ ИЗ ПРОЦЕДУРЫ: аргументы системного вызова относительно окна', () => {
  const wrapped = (body: string): string => `процедура главная()\n${body}\nконец_процедуры\n`;
  const runPipeline = (source: string, name: string): { stdout: Buffer; stderr: string; status: number | null } => {
    const image = loweredProgram(source);
    expect(image.refused, `программа «${name}» обязана понижаться без отказов`).toEqual([]);
    return runImage(buildElfFromCode(image.bytes, MINIMAL_BASE, { writable: true, extraMemory: WRITE_ZONE_EXTRA_MEMORY }).bytes, name);
  };

  it('ПРИЁМКА: система.лог.вывести ВНУТРИ процедуры — вывод побайтово, код 0', () => {
    if (shim === undefined) return;
    const source = `процедура печатать(ч: Число)\n  система.лог.вывести(ч)\nконец_процедуры\n\n${wrapped('  печатать(42)')}`;
    const run = runPipeline(source, 'print-from-procedure');
    const expected = Buffer.from('42\n', 'utf-8');
    expect(hex(run.stdout)).toBe([...expected].map((byte) => byte.toString(16).padStart(2, '0')).join(' '));
    expect(run.status, 'печатающая программа завершается своим exit(0)').toBe(0);
  });

  it('печать СТРОКИ из процедуры — тем же путём', () => {
    if (shim === undefined) return;
    const source = `процедура имя()\n  система.лог.вывести("Аня")\nконец_процедуры\n\n${wrapped('  имя()')}`;
    const run = runPipeline(source, 'string-from-procedure');
    const expected = Buffer.from('Аня\n', 'utf-8');
    expect(hex(run.stdout)).toBe([...expected].map((byte) => byte.toString(16).padStart(2, '0')).join(' '));
    expect(run.status).toBe(0);
  });

  it('СТРУКТУРНЫЙ СТОРОЖ: номер вызова идёт в оконный %r(2·wbs), а не в жёсткий %r8', () => {
    // Окно кадра — то, чем понижение адресует syscall. Проверяем ОБА кадра по имени регистра:
    // в точке входа 8, в выращенном 16. Прежняя редакция (жёсткий %r8 в любом кадре) на модели
    // валит порт утверждением `op_descr->is_al` — то есть «тихой лжи» больше нет, но и числа нет.
    const entry = writeTextPrimitives(HEAP);
    const grown = writeTextPrimitives(HEAP, undefined, GROWN_SYSCALL_FRAME);
    const windowIndexes = (instructions: readonly AsmInstruction[]): number[] =>
      instructions.flatMap((instruction) =>
        instruction.operands
          .filter((operand) => operand.kind === 'reg' && operand.file === 'window')
          .map((operand) => (operand as { index: number }).index),
      );
    expect(windowIndexes(entry), 'кадр точки входа: номер в %r8').toContain(WINDOW_NUMBER_REGISTER);
    expect(windowIndexes(grown), 'кадр процедуры: номер в %r16 (оконный r0 ядра)').toContain(GROWN_SYSCALL_FRAME.base);
    expect(windowIndexes(grown), 'и НЕ в жёстком %r8').not.toContain(WINDOW_NUMBER_REGISTER);
    // Ширина вызова — из кадра: 4 в точке входа, 8 в выращенном.
    const callWbs = (instructions: readonly AsmInstruction[]): number[] =>
      instructions
        .filter((instruction) => instruction.mnemonic === 'call')
        .map((instruction) => (instruction.operands[1] as { value: number }).value);
    expect(callWbs(entry)).toEqual([ENTRY_SYSCALL_FRAME.wbs]);
    expect(callWbs(grown)).toEqual([GROWN_SYSCALL_FRAME.wbs]);
  });

  it('ГРАНИЦА НАЗВАНА: непроверенные формы печати из процедуры ОТКАЗЫВАЮТ, а не виснут', () => {
    const shared = `процедура печатать()\n  система.лог.вывести(7)\n  система.лог.вывести(8)\nконец_процедуры\n\n${wrapped('  печатать()')}`;
    const sharedImage = loweredProgram(shared);
    expect(sharedImage.refused.map((item) => item.reason).join(' '), 'разделённая печать из процедуры').toContain(
      'ЗАФИКСИРОВАННАЯ ГРАНИЦА',
    );
    expect(sharedImage.refused.map((item) => item.reason).join(' '), 'причина границы называет замер').toContain(
      'выращенного кадра',
    );
    const recursive = `процедура шаги(н: Число)\n  если н <= 0\n    вернуть 0\n  конец_если\n  система.лог.вывести(н)\n  вернуть шаги(н - 1)\nконец_процедуры\n\n${wrapped('  шаги(3)')}`;
    expect(loweredProgram(recursive).refused.map((item) => item.reason).join(' '), 'печать в самозовущей процедуре').toContain(
      'зовёт СЕБЯ',
    );
  });
});
