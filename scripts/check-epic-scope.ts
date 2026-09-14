/**
 * Детектор ложных отчётов планового слоя `.osnova`.
 *
 * Повод: аудит (см. `docs/state-audit.md`) показал 11 эпиков из 20, закрытых с
 * неподтверждённым `scope`, из них 6 — с вердиктом `ok` / `passrate: 1.0`.
 * Механизм: `done:` у этих эпиков — `npx vitest run <каталог>`, а такой прогон
 * даёт exit 0 при любых прошедших тестах в каталоге. Отсутствие целевого файла
 * не обнаруживается ни кодом возврата, ни проверкой каталога.
 *
 * Что делает детектор: сверяет `scope` каждого эпика с деревом файлов. Это
 * дешёвая проверка без запуска тестов, и она ловит все 6 ложно-«ok» эпиков.
 *
 * Использование:
 *   npx tsx scripts/check-epic-scope.ts          # новые ложные «ok» (exit 1)
 *   npx tsx scripts/check-epic-scope.ts --all    # все эпики с отсутствующими путями
 *   npx tsx scripts/check-epic-scope.ts --strict # падать и на известных случаях
 *
 * Переименования, уже задокументированные в `state.yaml.codebase.pending`
 * (формат «реальный путь — epic старый путь»), не считаются ложью: это известный
 * и записанный факт, а не подмена.
 *
 * Известные исторические случаи перечислены явно и не роняют сборку: это
 * зафиксированное прошлое, а не то, что нужно ловить сейчас. Любой новый
 * ложный «ok» — ошибка. Список — часть отчёта `docs/state-audit.md`.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const ROOT = path.resolve(__dirname, '..');
const STATE_PATH = path.join(ROOT, '.osnova', 'state.yaml');
const EPICS_DIR = path.join(ROOT, '.osnova', 'epics');
const SHOW_ALL = process.argv.includes('--all');
const STRICT = process.argv.includes('--strict');

/**
 * Эпики, закрытые как `ok` при неподтверждённом scope ДО появления этого
 * детектора. Оставлены как есть намеренно: это исторические записи, и
 * переписывать их «под успех» — то же самое враньё, только задним числом.
 */
const KNOWN_FALSE_OK: ReadonlySet<string> = new Set([
  'EPK-260329-021',
  'EPK-260329-022',
  'EPK-260329-023',
  'EPK-260329-025',
  'EPK-260329-026',
]);

interface RecentEntry {
  epic?: string;
  result?: string;
  status?: string;
  passrate?: number;
}

interface EpicDoc {
  id?: string;
  scope?: string[];
  done?: string;
}

/** Существует ли путь эпика на диске. */
function exists(rel: string): boolean {
  if (!rel || rel.trim() === '') return false;
  return fs.existsSync(path.join(ROOT, rel));
}

/** Карта задокументированных переименований: старый путь → реальный. */
function documentedRenames(state: { codebase?: { pending?: string[] } }): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of state.codebase?.pending ?? []) {
    // Формат: «src/agents/index.ts — epic agents/base.ts»
    const parts = line.split(/\s+—\s+/);
    if (parts.length < 2) continue;
    const real = parts[0]!.trim();
    const old = parts[1]!.replace(/^epic\s+/, '').trim();
    if (old) map.set(old, real);
  }
  return map;
}

/** Найти задокументированное переименование для пути эпика. */
function findRename(renames: Map<string, string>, p: string): string | undefined {
  const direct = renames.get(p);
  if (direct !== undefined) return direct;
  // В `pending` путь записан без префикса `src/` («agents/base.ts»), в scope — с
  // ним. Сопоставляем по хвосту, в обе стороны.
  for (const [old, real] of renames) {
    if (p.endsWith(`/${old}`) || old.endsWith(`/${p}`)) return real;
  }
  return undefined;
}

/**
 * Пути, упомянутые в `done:`-команде.
 *
 * Каталоги здесь бесполезны как проверка (они существуют), но файл, названный
 * в `done:` и отсутствующий, — прямая улика ложного критерия.
 */
function donePaths(done: string | undefined): string[] {
  if (!done) return [];
  return done
    .split(/\s+/)
    .map((t) => t.replace(/[;&|]+$/, ''))
    .filter((t) => t.includes('/') && !t.startsWith('-'));
}

function main(): void {
  if (!fs.existsSync(STATE_PATH)) {
    console.error(`Нет ${STATE_PATH}`);
    process.exit(2);
  }
  const state = yaml.load(fs.readFileSync(STATE_PATH, 'utf-8')) as {
    recent?: RecentEntry[];
    codebase?: { pending?: string[] };
  };
  const renames = documentedRenames(state);
  const verdicts = new Map<string, RecentEntry>();
  for (const r of state.recent ?? []) {
    if (r.epic) verdicts.set(r.epic, r);
  }

  const epicFiles = fs
    .readdirSync(EPICS_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && /^EPK-.*\.yaml$/.test(e.name))
    .map((e) => e.name)
    .sort();

  const falseOk: string[] = [];
  const withMissing: string[] = [];
  let clean = 0;

  for (const file of epicFiles) {
    const doc = yaml.load(fs.readFileSync(path.join(EPICS_DIR, file), 'utf-8')) as EpicDoc;
    const id = doc.id ?? file.replace(/\.yaml$/, '');
    const scope = doc.scope ?? [];
    const verdict = verdicts.get(id);

    const missing = scope.filter((p) => !exists(p));
    const renamed: string[] = [];
    const realMissing: string[] = [];
    for (const p of missing) {
      if (findRename(renames, p) !== undefined) renamed.push(p);
      else realMissing.push(p);
    }

    const badDone = donePaths(doc.done).filter((p) => !exists(p));
    const claimedOk = verdict?.status === 'ok' || verdict?.result === 'ok' || verdict?.passrate === 1;

    if (realMissing.length === 0 && badDone.length === 0) {
      clean++;
      continue;
    }

    const lines: string[] = [];
    lines.push(`  ${id}  [${verdict?.status ?? 'нет в state.yaml'}]${claimedOk ? '  ← вердикт ok' : ''}`);
    for (const p of realMissing) lines.push(`      нет:        ${p}`);
    for (const p of renamed) lines.push(`      переименован: ${p} → ${findRename(renames, p)}`);
    for (const p of badDone) lines.push(`      нет в done: ${p}`);
    withMissing.push(lines.join('\n'));

    if (claimedOk && realMissing.length > 0) falseOk.push(id);
  }

  console.log('Сверка scope эпиков с деревом файлов');
  console.log(`  эпиков: ${epicFiles.length} | чистых: ${clean} | с отсутствующими путями: ${withMissing.length}`);

  if (SHOW_ALL || falseOk.length > 0) {
    console.log('\nЭпики с отсутствующими путями:');
    console.log(withMissing.join('\n'));
  }

  const known = falseOk.filter((id) => KNOWN_FALSE_OK.has(id));
  const fresh = falseOk.filter((id) => !KNOWN_FALSE_OK.has(id));

  if (known.length > 0) {
    console.log(`\nИзвестные исторические случаи (${known.length}): ${known.join(', ')}`);
    console.log('  Зафиксированы в docs/state-audit.md; записи намеренно не переписаны.');
  }

  const fail = STRICT ? falseOk : fresh;
  if (fail.length > 0) {
    console.error(
      `\nЛОЖНЫЙ ОТЧЁТ: ${fail.length} эпик(ов) закрыты как ok, но scope не подтверждён:`,
    );
    console.error(`  ${fail.join(', ')}`);
    console.error(
      '\nПроверьте `done:`: прогон каталога (`npx vitest run src/`) не доказывает\n' +
        'существование целевых файлов. Замените критерий на прогон конкретных файлов.',
    );
    process.exit(1);
  }

  console.log('\nНовых ложных «ok» нет.');
}

main();
