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
    entries.push({
      example: dir,
      name: meta.name ?? dir,
      elf: path.relative(KIT, elfPath).replace(/\\/g, '/'),
      elfSha256: crypto.createHash('sha256').update(elf).digest('hex'),
      elfBytes: elf.length,
      expected: fs.readFileSync(path.join(dirPath, 'expected.txt'), 'utf-8').trim(),
      expectedOrigin: meta.expected?.origin ?? 'не назван',
      shows: meta.shows ?? '',
      hardware: meta.hardware ?? '',
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
  fs.writeFileSync(
    path.join(KIT, 'expected.tsv'),
    entries.map((entry) => `${entry.elf}\t${entry.expected}`).join('\n') + '\n',
    'utf-8',
  );
  console.log(`кит собран: ${String(entries.length)} бинарей в ${path.relative(ROOT, BIN)}`);
  for (const entry of entries) {
    console.log(`  ${entry.elf}  sha256=${entry.elfSha256.slice(0, 16)}…  ожидается ${entry.expected}`);
  }
  for (const note of skipped) console.log(`  пропущено — ${note}`);
}

main();
