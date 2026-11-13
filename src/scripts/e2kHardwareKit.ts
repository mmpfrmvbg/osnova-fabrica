/**
 * УПАКОВЩИК КИТА ДЛЯ ЖИВОГО ЭЛЬБРУСА.
 *
 * Наш компилятор — TypeScript под Node, и на контейнер Эльбруса он не поедет. Значит на машину
 * везут **готовые e2k-ELF**, собранные здесь, вместе с эталонами и скриптами прогона. Этот
 * скрипт собирает такой кит: бинари, хеши, ожидаемые значения и «что доказывает» из корпуса.
 *
 *   npx tsx src/scripts/e2kHardwareKit.ts
 *
 * Источник истины — корпус: берутся примеры, у которых `meta.e2k.status === "работает"`,
 * плюс `tests/dsp/kernels/fir.osnova` как граница (он на цель не идёт, но его эталон 181 полезен
 * как контроль: тот же алгоритм, но встроенным вариантом — пример 01).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { buildElfImage } from './e2kProgramRun';
import { parseV3 } from '../compiler-v3';
import { программаПротоколаB2 } from '../compiler-v3/parser-protocol-b2';
import { программаПротоколаB2b } from '../compiler-v3/parser-protocol-b2b';
import { ПРОГРАММЫ_B2B as ФОРМЫ_B2B } from '../compiler-v3/parserProtocolB2bForms';
import { эталоннаяЛента } from '../compiler-v3/parser-protocol-probe';
import { buildElfFromCode, MINIMAL_BASE, WRITE_ZONE_EXTRA_MEMORY } from '../e2k/elfMinimal';
import { loweredProgram } from '../e2k/lowered';

const ROOT = path.resolve(__dirname, '..', '..');
const EXAMPLES = path.join(ROOT, 'examples');
const KIT = path.join(ROOT, 'tools', 'e2k-hardware');
const BIN = path.join(KIT, 'bin');

interface Meta {
  name?: string;
  shows?: string;
  hardware?: string;
  e2k?: { status?: string; reason?: string };
  expected?: { origin?: string; via?: string };
}

interface KitEntry {
  example: string;
  name: string;
  elf: string;
  elfSha256: string;
  elfBytes: number;
  expected: string;
  /**
   * КАНАЛ ЭТАЛОНА: чем программа отдаёт результат наружу.
   *
   * `возврат` — кодом возврата процесса (его и сверяет `run.sh`); `вывод` — БАЙТАМИ stdout
   * (печать `система.лог.вывести`). Без этого поля кит врал бы на записях с печатью: эталон «10»
   * сравнивался бы с кодом возврата 0, и машина отчитывалась бы о расхождении там, где всё верно
   * (`docs/hardware-debt.md` §3.43).
   */
  via: string;
  expectedOrigin: string;
  shows: string;
  hardware: string;
}

function examplesWithE2k(): string[] {
  return fs
    .readdirSync(EXAMPLES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((dir) => {
      const meta = path.join(EXAMPLES, dir, 'meta.json');
      if (!fs.existsSync(meta)) return false;
      const parsed = JSON.parse(fs.readFileSync(meta, 'utf-8')) as Meta;
      return parsed.e2k?.status === 'работает';
    })
    .sort();
}

/**
 * B2: рантайм-цикл по ленте, POST-ORDER. В отличие от корпуса, эти программы требуют
 * `allowDeepArrayWrites` (D12: решение владельца, QEMU — названный отказ, железо — арбитр).
 * Эталон — независимый `эталоннаяЛента` (`parseV01` + `лентаИзAst`), а не вывод пробы.
 */
const ПРОГРАММЫ_B2 = [
  'ф(х)',
  'ф(г(ч(ш(х))))',
  'ф(г(1), х)',
  'ф(х)\n  ф(г(1))',
  'ф(1)\n  ф(2, х)\n  ф(г(ч(3)))',
  'ф(г(х), ч(1))',
  'ф(г(ч(ш(2)), 3), 4)',
  'ф()\n  ф()',
] as const;

function buildB2Elf(тело: string, файл: string): { elf: Buffer; expected: number[] } {
  const источник = `действие главная()\n  ${тело}\nконец главная\n`;
  const сгенерирован = программаПротоколаB2(источник, файл);
  return buildProtocolElf(сгенерирован, источник, файл);
}

/**
 * B2b: пять форм на подэтап (`b2b1` пусть/присваивание/выражения, `b2b2` если/пока/сравнения,
 * `b2b3` комбинация и вызовы). Эталон — `эталоннаяЛента`, как у B2; канал — БАЙТЫ вывода.
 *
 * Таблица переехала в `src/compiler-v3/parserProtocolB2bForms.ts`: её читает и оракул AST
 * (`src/compiler-v3/parserProtocolB2bOracle.test.ts`), а импортировать ЭТОТ файл тест не может —
 * `main()` внизу собирает кит при импорте.
 */
const ПРОГРАММЫ_B2B = ФОРМЫ_B2B;

function buildProtocolElf(
  сгенерирован: string,
  источник: string,
  файл: string,
  dataSegmentBytes = 0x8000,
): { elf: Buffer; expected: number[] } {
  const разобранный = parseV3(сгенерирован, файл);
  if (разобранный.errors.length > 0) {
    throw new Error(`${файл}: ${разобранный.errors.map((error) => String(error)).join('; ')}`);
  }
  const понижен = loweredProgram(сгенерирован, {
    filename: файл,
    allowDeepArrayWrites: true,
    parse: () => ({ ast: разобранный.program ?? null, errors: разобранный.errors }),
  });
  if (!понижен.ок) throw new Error(`${файл}: ${понижен.отказ.причина}`);
  const elf = buildElfFromCode(понижен.значение.bytes, MINIMAL_BASE, {
    writable: true,
    extraMemory: WRITE_ZONE_EXTRA_MEMORY,
    dataSegmentBytes,
  });
  return { elf: Buffer.from(elf.bytes), expected: эталоннаяЛента(источник, файл) };
}

function main(): void {
  fs.mkdirSync(BIN, { recursive: true });
  const entries: KitEntry[] = [];
  const skipped: string[] = [];

  for (const dir of examplesWithE2k()) {
    const dirPath = path.join(EXAMPLES, dir);
    const mainFile = fs.existsSync(path.join(dirPath, 'main.osnova'))
      ? path.join(dirPath, 'main.osnova')
      : fs.readdirSync(dirPath).filter((f) => f.endsWith('.osnova')).map((f) => path.join(dirPath, f))[0];
    if (mainFile === undefined) {
      skipped.push(`${dir}: нет .osnova`);
      continue;
    }
    const meta = JSON.parse(fs.readFileSync(path.join(dirPath, 'meta.json'), 'utf-8')) as Meta;
    const elfPath = path.join(BIN, `${dir}.elf`);
    const elf = buildElfImage(fs.readFileSync(mainFile, 'utf-8'));
    fs.writeFileSync(elfPath, elf);
    const via = meta.expected?.via ?? 'возврат';
    // Эталон канала «вывод» едет ЭКРАНИРОВАННЫМ (`10\n`, `1\n2\n3\n`): в таблице `awk`-строку
    // перевести нечем, а `run.sh` разворачивает `\n` через `printf '%b'` и сверяет БАЙТЫ (`cmp`).
    const expectedText = fs.readFileSync(path.join(dirPath, 'expected.txt'), 'utf-8');
    entries.push({
      example: dir,
      name: meta.name ?? dir,
      elf: path.relative(KIT, elfPath).replace(/\\/g, '/'),
      elfSha256: crypto.createHash('sha256').update(elf).digest('hex'),
      elfBytes: elf.length,
      via,
      expected: via === 'вывод' ? expectedText.replace(/\\/g, '\\\\').replace(/\n/g, '\\n') : expectedText.trim(),
      expectedOrigin: meta.expected?.origin ?? 'не назван',
      shows: meta.shows ?? '',
      hardware: meta.hardware ?? '',
    });
  }

  // ── B2: восемь программ рантайм-разбора, POST-ORDER ─────────────────────────
  for (const [индекс, тело] of ПРОГРАММЫ_B2.entries()) {
    const номер = String(индекс + 1);
    const файл = `b2p${номер}.osnova`;
    const elfPath = path.join(BIN, `b2p${номер}.elf`);
    const { elf, expected } = buildB2Elf(тело, файл);
    fs.writeFileSync(elfPath, elf);
    entries.push({
      example: `b2/p${номер}`,
      name: `B2 P${номер}: ${тело}`,
      elf: path.relative(KIT, elfPath).replace(/\\/g, '/'),
      elfSha256: crypto.createHash('sha256').update(elf).digest('hex'),
      elfBytes: elf.length,
      via: 'вывод',
      expected: expected.join('\\n') + '\\n',
      expectedOrigin: 'эталоннаяЛента (parseV01 + лентаИзAst)',
      shows: 'рантайм-разбор произвольной ленты, POST-ORDER',
      hardware: 'D12: решение владельца, запись из глубины ≥ 2 разрешена; QEMU — #180',
    });
  }

  // ── B2b: пять форм на подэтап, пусть/присваивание/выражения/если/пока ─────────
  for (const этап of ['b2b1', 'b2b2', 'b2b3', 'b2b4', 'b2b5', 'b2b6'] as const) {
    for (const [индекс, тело] of ПРОГРАММЫ_B2B[этап].entries()) {
      const номер = String(индекс + 1);
      const файл = `${этап}p${номер}.osnova`;
      const elfPath = path.join(BIN, `${этап}p${номер}.elf`);
      const источник = `действие главная()\n  ${тело}\nконец главная\n`;
      const сгенерирован = программаПротоколаB2b(источник, файл);
      const { elf, expected } = buildProtocolElf(сгенерирован, источник, файл);
      fs.writeFileSync(elfPath, elf);
      entries.push({
        example: `${этап}/p${номер}`,
        name: `${этап.toUpperCase()} P${номер}: ${тело}`,
        elf: path.relative(KIT, elfPath).replace(/\\/g, '/'),
        elfSha256: crypto.createHash('sha256').update(elf).digest('hex'),
        elfBytes: elf.length,
        via: 'вывод',
        expected: expected.join('\\n') + '\\n',
        expectedOrigin: 'эталоннаяЛента (parseV01 + лентаИзAst)',
        shows: 'разбор пусть/присваивания/выражений/если/пока, POST-ORDER',
        hardware: 'D12: решение владельца, запись из глубины ≥ 2 разрешена; QEMU — #180',
      });
    }
  }

  // ── P4a: союз 15 форм — 126 976 кода, данных 64 КиБ ──────────────────────────
  //
  // Первый прогон шёл с `dataSegmentBytes: 0x8000` и падал: ptrace дал
  // `si_addr=0x127000` — ровно `0x11f000 + 0x8000`, конец сегмента данных, а не
  // потолок кода (`readelf`: `.text` ровно 126976). С `0x10000` тот же `.text`
  // даёт RC=0 и 2908 байт эталона (sha256 `31744b7a…`). Случай в ките.
  {
    const тело = [...ПРОГРАММЫ_B2B.b2b1, ...ПРОГРАММЫ_B2B.b2b2, ...ПРОГРАММЫ_B2B.b2b3].join('\n  ');
    const файл = 'b2b-all.osnova';
    const elfPath = path.join(BIN, 'b2b-all.elf');
    const источник = `действие главная()\n  ${тело}\nконец главная\n`;
    const сгенерирован = программаПротоколаB2b(источник, файл);
    const { elf, expected } = buildProtocolElf(сгенерирован, источник, файл, 0x10000);
    fs.writeFileSync(elfPath, elf);
    entries.push({
      example: 'b2b/all',
      name: 'B2B ALL: 15 форм одной программой (P4a, 126976 кода, данные 64 КиБ)',
      elf: path.relative(KIT, elfPath).replace(/\\/g, '/'),
      elfSha256: crypto.createHash('sha256').update(elf).digest('hex'),
      elfBytes: elf.length,
      via: 'вывод',
      expected: expected.join('\\n') + '\\n',
      expectedOrigin: 'эталоннаяЛента (parseV01 + лентаИзAst)',
      shows: 'P4a: 39 процедур, 0 отказов, вход ≤10, обойти ≤12; 126976 кода + 65536 данных',
      hardware: 'D12: запись из глубины ≥ 2 разрешена; данные 0x10000 — иначе si_addr=0x127000',
    });
  }

  const kit = {
    purpose:
      'Прогон программ Основы на живой машине Эльбрус. Бинари собраны на стороне разработки; ' +
      'машина только исполняет и сравнивает с эталоном.',
    builtAt: new Date().toISOString().slice(0, 10),
    model: 'паспорт модели, на которой получены эталоны: src/e2k/qemuModelPassport.ts',
    entries,
    skipped,
  };
  fs.writeFileSync(path.join(KIT, 'expected.json'), `${JSON.stringify(kit, null, 2)}\n`, 'utf-8');
  // Плоская таблица рядом: на машине может не быть ни python, ни jq, а `awk`/`cut` есть всегда.
  // Три столбца — `бинарь`, канал эталона (`возврат`/`вывод`) и сам эталон; канал нужен потому, что
  // у печатающих записей результат наружу отдаёт `write`, а не код возврата (см. {@link KitEntry.via}).
  fs.writeFileSync(
    path.join(KIT, 'expected.tsv'),
    entries.map((entry) => `${entry.elf}\t${entry.via}\t${entry.expected}`).join('\n') + '\n',
    'utf-8',
  );
  console.log(`кит собран: ${String(entries.length)} бинарей в ${path.relative(ROOT, BIN)}`);
  for (const entry of entries) {
    console.log(`  ${entry.elf}  sha256=${entry.elfSha256.slice(0, 16)}…  ${entry.via}: ${entry.expected}`);
  }
  for (const note of skipped) console.log(`  пропущено — ${note}`);
}

main();
