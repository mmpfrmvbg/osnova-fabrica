/**
 * СТОРОЖ КАТАЛОГА: каталог, компилятор и списки потребителей обязаны сходиться.
 *
 * # Зачем
 *
 * Замер 2026-09-28, до каталога: виды ошибок жили тремя несогласованными
 * перечнями — `semantic.ts` порождал 15 видов, `semanticKinds.ts` знал 9
 * (6 блокирующих + 3 неблокирующих), канон перечислял 11. Шесть видов —
 * `arg_count_mismatch`, `chained_compare`, `keyword_param`, `sentinel_pattern`,
 * `unknown_module`, `export_collision` — не входили **ни в один**, и на вопрос
 * «блокирует ли это сборку» (`compiler.ts` — `BuildReport.success`,
 * `gateChecker.ts` — шлюз G2) ответить было нечем. Ничто в дереве это согласие не
 * проверяло: расхождение вносилось правкой одной строки в любом из трёх мест и не
 * краснело.
 *
 * # Что проверяется (буквы — из ТЗ задачи T1)
 *
 * (а) имена видов уникальны — дубль значит, что один вид притворяется двумя;
 * (б) коды уникальны и формата `OSN-SEM-NNN`, номера идут подряд с 001;
 * (в) каждый вид, который `semantic.ts` порождает, есть в каталоге — **скан
 * исходника**, а не ручной список: ручной список разошёлся бы так же, как
 * разошлись прежние три;
 * (г) каждый вид каталога либо порождается, либо помечен долгом — иначе в
 * каталоге заводится вид, которого язык не знает;
 * (д) `BLOCKING_SEMANTIC_KINDS` в точности равен множеству `blocking: true`,
 * неблокирующий список — множеству «не блокирует **и** долга нет», а
 * `ALL_SEMANTIC_KINDS` — их сумме.
 *
 * # Негативный контроль
 *
 * Двенадцать мутаций **копии** каталога: файл на диске не трогается — вердикт
 * `catalogueFindings` принимает каталог параметром. Каждая мутация обязана
 * покраснеть, и проверка называет, ЧТО покраснело: без этого «контроль прошёл»
 * неотличимо от «сторож слеп». Среди мутаций две несущие: снятие долга с
 * `arg_count_mismatch` расширяет неблокирующий список с 3 видов до 4, а снятие
 * всех шести долгов — до 9, и это уже поведение `DiagnosticAgent`,
 * `RepairEngineer` и схемы записей журнала, а не текст.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DIAGNOSTIC_KINDS,
  CLI_CODES,
  INTERNAL_CODES,
  PHASE_CODES,
  UNCATALOGUED_CODES,
  diagnosticCodeOf,
  diagnosticKindInfo,
  isBlockingKind,
} from './diagnosticCatalogue';
import {
  ALL_SEMANTIC_KINDS,
  BLOCKING_SEMANTIC_KINDS,
  NON_BLOCKING_SEMANTIC_KINDS,
} from './semanticKinds';
import { compileSource, compileToBuildReport } from './compiler';
import { analyzeProgram } from './semantic';
import { LANGUAGE_REGISTRY } from './language-registry';
import type { Procedure, Program, Stmt } from './ast';

// ─────────────────── источник: исходник, а не ручной список ───────────────────

const SEMANTIC_SOURCE = fs.readFileSync(path.join(__dirname, 'semantic.ts'), 'utf-8');

/** Площадка порождения вида: `kind: "имя"` в семантике. */
const KIND_SITE = /kind:\s*"([a-z][a-z0-9_]*)"/g;

/** Виды, которые `semantic.ts` порождает на самом деле — скан файла. */
function producedKinds(source: string): string[] {
  return [...source.matchAll(KIND_SITE)].map((m) => m[1]!);
}

/** Замер 2026-09-28: 25 площадок `kind: "..."`, 15 уникальных видов. */
const SITES_MEASURED = 25;
const KINDS_MEASURED = 15;

// ─────────────────── вердикт: чистая функция от каталога ───────────────────

/** Имя проверки. Негативный контроль называет по нему, что именно покраснело. */
type CheckId =
  | 'уникальность вида'
  | 'уникальность кода'
  | 'формат кода'
  | 'порождённый вид вне каталога'
  | 'вид каталога без порождения и без долга'
  | 'блокирующий список'
  | 'неблокирующий список';

interface Finding {
  check: CheckId;
  detail: string;
}

/**
 * Запись в том виде, в каком её видит сторож: мутация может подсунуть что угодно,
 * поэтому вердикт не опирается на литеральные типы каталога.
 */
interface EntryLike {
  kind: string;
  code: string;
  blocking: boolean;
  description: string;
  debt?: string;
}

/** Долг назван — значит вид имеет право не порождаться и стоять вне списков. */
function hasDebt(entry: EntryLike): boolean {
  return typeof entry.debt === 'string' && entry.debt.trim() !== '';
}

/** Значения, встретившиеся больше одного раза (в порядке первого повтора). */
function duplicated(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) twice.add(value);
    else seen.add(value);
  }
  return [...twice];
}

/** Расхождение перечней — в обе стороны, с именами разошедшихся видов. */
function listFindings(
  check: CheckId,
  actual: readonly string[],
  derived: readonly string[],
): Finding[] {
  const findings: Finding[] = [];
  for (const kind of derived) {
    if (!actual.includes(kind)) {
      findings.push({ check, detail: `каталог говорит «${kind}», список его не содержит` });
    }
  }
  for (const kind of actual) {
    if (!derived.includes(kind)) {
      findings.push({ check, detail: `список содержит «${kind}», каталог его так не называет` });
    }
  }
  return findings;
}

/**
 * ВЕРДИКТ сторожа: пустой список — каталог, компилятор и списки сходятся.
 * Принимает каталог параметром, поэтому негативный контроль подсовывает сюда
 * мутированную копию, не трогая файл на диске.
 */
function catalogueFindings(entries: readonly EntryLike[], produced: readonly string[]): Finding[] {
  const findings: Finding[] = [];
  const kinds = entries.map((entry) => entry.kind);
  const producedSet = new Set(produced);

  // (а) имя вида — личность: дубль значит, что один вид притворяется двумя.
  for (const kind of duplicated(kinds)) {
    findings.push({ check: 'уникальность вида', detail: `вид «${kind}» записан дважды` });
  }

  // (б) код — машинная личность: дубль и чужой формат ломают журналы.
  for (const code of duplicated(entries.map((entry) => entry.code))) {
    findings.push({ check: 'уникальность кода', detail: `код «${code}» выдан дважды` });
  }
  for (const entry of entries) {
    if (!/^OSN-SEM-\d{3}$/.test(entry.code)) {
      findings.push({
        check: 'формат кода',
        detail: `«${entry.kind}»: код «${entry.code}» не вида OSN-SEM-NNN`,
      });
    }
  }

  // (в) компилятор порождает вид — значит он обязан быть в каталоге.
  for (const kind of producedSet) {
    if (!kinds.includes(kind)) {
      findings.push({
        check: 'порождённый вид вне каталога',
        detail: `semantic.ts порождает «${kind}», каталог его не знает`,
      });
    }
  }

  // (г) вид каталога обязан быть порождён — или назван долгом.
  for (const entry of entries) {
    if (!producedSet.has(entry.kind) && !hasDebt(entry)) {
      findings.push({
        check: 'вид каталога без порождения и без долга',
        detail: `«${entry.kind}» не порождается ни одной площадкой и долга за ним нет`,
      });
    }
  }

  // (д) блокирующий список — в точности множество `blocking: true`.
  findings.push(
    ...listFindings(
      'блокирующий список',
      BLOCKING_SEMANTIC_KINDS,
      entries.filter((entry) => entry.blocking).map((entry) => entry.kind),
    ),
  );

  // (д) неблокирующий — «не блокирует И долга нет»: снятый долг обязан
  // покраснеть, потому что он расширит список, а с ним поведение потребителей.
  findings.push(
    ...listFindings(
      'неблокирующий список',
      NON_BLOCKING_SEMANTIC_KINDS,
      entries.filter((entry) => !entry.blocking && !hasDebt(entry)).map((entry) => entry.kind),
    ),
  );

  return findings;
}

/** Что именно покраснело — без дублей, в порядке появления. */
function checksOf(findings: readonly Finding[]): CheckId[] {
  return [...new Set(findings.map((finding) => finding.check))];
}

/** Снимок каталога на момент загрузки: мутации не имеют права его сдвинуть. */
const CATALOGUE_SNAPSHOT = JSON.stringify(DIAGNOSTIC_KINDS);

// ─────────────────── (а)–(г): каталог и компилятор сходятся ───────────────────

const PRODUCED = producedKinds(SEMANTIC_SOURCE);

describe('каталог видов: один источник правды', () => {
  it('каталог, компилятор и списки сходятся — находок нет', () => {
    expect(catalogueFindings(DIAGNOSTIC_KINDS, PRODUCED)).toEqual([]);
  });

  it('(а) имена видов уникальны', () => {
    const kinds = DIAGNOSTIC_KINDS.map((entry) => entry.kind);
    expect(duplicated(kinds), 'виды, записанные дважды').toEqual([]);
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it('(б) коды уникальны, формата OSN-SEM-NNN, номера идут подряд с 001', () => {
    const codes = DIAGNOSTIC_KINDS.map((entry) => entry.code);
    expect(duplicated(codes), 'коды, выданные дважды').toEqual([]);
    // Подряд — значит «следующий свободный номер», а не «красивый по алфавиту»:
    // пропуск в нумерации виден сразу.
    expect(codes).toEqual(
      DIAGNOSTIC_KINDS.map((_, index) => `OSN-SEM-${String(index + 1).padStart(3, '0')}`),
    );
  });

  it('(в) каждый вид, который порождает semantic.ts, есть в каталоге', () => {
    const known = new Set(DIAGNOSTIC_KINDS.map((entry) => entry.kind));
    const unknown = [...new Set(PRODUCED)].filter((kind) => !known.has(kind));
    expect(unknown, 'виды, порождённые компилятором и каталогу неизвестные').toEqual([]);
  });

  it('(г) каждый вид каталога либо порождается, либо помечен долгом', () => {
    const producedSet = new Set(PRODUCED);
    const silent = DIAGNOSTIC_KINDS.filter(
      (entry) => !producedSet.has(entry.kind) && entry.debt === undefined,
    ).map((entry) => entry.kind);
    expect(silent, 'виды каталога без порождения и без долга').toEqual([]);
  });

  it('скан исходника не слеп: 25 площадок порождения, 15 видов', () => {
    // Число площадок — замер, а не украшение: если сканер ослепнет (переписали
    // кавычки, сломали регулярку), проверка (г) покраснеет вслед за этой, и
    // причина будет названа, а не выдана за находку в каталоге.
    expect(PRODUCED).toHaveLength(SITES_MEASURED);
    expect(new Set(PRODUCED).size).toBe(KINDS_MEASURED);
  });
});

// ─────────────────── (д): списки выводятся из каталога ───────────────────

describe('списки выводятся из каталога, а не пишутся рядом', () => {
  it('(д) BLOCKING_SEMANTIC_KINDS в точности равен множеству `blocking: true`', () => {
    const derived = DIAGNOSTIC_KINDS.filter((entry) => entry.blocking).map((entry) => entry.kind);
    expect([...BLOCKING_SEMANTIC_KINDS]).toEqual(derived);
    expect(derived, 'блокирующих видов').toHaveLength(6);
  });

  it('(д) NON_BLOCKING_SEMANTIC_KINDS в точности равен множеству «не блокирует и без долга»', () => {
    const derived = DIAGNOSTIC_KINDS.filter(
      (entry) => !entry.blocking && entry.debt === undefined,
    ).map((entry) => entry.kind);
    expect([...NON_BLOCKING_SEMANTIC_KINDS]).toEqual(derived);
    expect(derived, 'неблокирующих видов').toHaveLength(3);
  });

  it('шесть видов с долгом не входят ни в один список — названы, а не спрятаны', () => {
    const withDebt = DIAGNOSTIC_KINDS.filter((entry) => entry.debt !== undefined).map(
      (entry) => entry.kind,
    );
    expect(withDebt).toEqual([
      'arg_count_mismatch',
      'chained_compare',
      'keyword_param',
      'sentinel_pattern',
      'unknown_module',
      'export_collision',
    ]);
    for (const kind of withDebt) {
      expect(BLOCKING_SEMANTIC_KINDS as readonly string[]).not.toContain(kind);
      expect(NON_BLOCKING_SEMANTIC_KINDS as readonly string[]).not.toContain(kind);
      expect(ALL_SEMANTIC_KINDS as readonly string[]).not.toContain(kind);
    }
  });

  it('ALL_SEMANTIC_KINDS = блокирующие + неблокирующие: 9 из 15', () => {
    expect([...ALL_SEMANTIC_KINDS]).toEqual([
      ...BLOCKING_SEMANTIC_KINDS,
      ...NON_BLOCKING_SEMANTIC_KINDS,
    ]);
    expect(ALL_SEMANTIC_KINDS).toHaveLength(9);
    expect(ALL_SEMANTIC_KINDS.length).toBeLessThan(DIAGNOSTIC_KINDS.length);
  });

  it('значения списков заморожены: 6 блокирующих и 3 неблокирующих, как до каталога', () => {
    // Эти два перечня импортируют ~15 файлов, включая замороженный пайплайн и
    // `src/agents/**`. Порядок неблокирующих стал каталожным (прежде —
    // `break_outside_loop`, `continue_outside_loop`, `keyword_as_identifier`):
    // поведение не меняется — потребители строят `Set` или спрашивают `includes`,
    // — но перестановка названа вслух, чтобы не была тихой.
    expect([...BLOCKING_SEMANTIC_KINDS]).toEqual([
      'unknown_syscall',
      'undeclared_var',
      'unknown_procedure',
      'syscall_argc',
      'redeclare_var',
      'invented_syntax',
    ]);
    expect([...NON_BLOCKING_SEMANTIC_KINDS]).toEqual([
      'keyword_as_identifier',
      'break_outside_loop',
      'continue_outside_loop',
    ]);
  });
});

// ─────────────────── (е): негативный контроль ───────────────────

/**
 * Копия каталога: правки мутаций идут по ней, файл на диске не трогается.
 * Каждая мутация возвращает НОВЫЙ массив — исходный каталог не изменяется
 * (проверка гигиены в конце).
 */
function copy(): EntryLike[] {
  return DIAGNOSTIC_KINDS.map((entry) => ({ ...entry }));
}

function renameKind(entries: readonly EntryLike[], from: string, to: string): EntryLike[] {
  return entries.map((entry) => (entry.kind === from ? { ...entry, kind: to } : { ...entry }));
}

function dropKind(entries: readonly EntryLike[], kind: string): EntryLike[] {
  return entries.filter((entry) => entry.kind !== kind).map((entry) => ({ ...entry }));
}

function setCode(entries: readonly EntryLike[], kind: string, code: string): EntryLike[] {
  return entries.map((entry) => (entry.kind === kind ? { ...entry, code } : { ...entry }));
}

function setBlocking(entries: readonly EntryLike[], kind: string, blocking: boolean): EntryLike[] {
  return entries.map((entry) => (entry.kind === kind ? { ...entry, blocking } : { ...entry }));
}

function clearDebt(entries: readonly EntryLike[], kind: string): EntryLike[] {
  return entries.map((entry) => {
    if (entry.kind !== kind) return { ...entry };
    const without: EntryLike = { ...entry };
    delete without.debt;
    return without;
  });
}

function clearAllDebts(entries: readonly EntryLike[]): EntryLike[] {
  return entries.map((entry) => {
    const without: EntryLike = { ...entry };
    delete without.debt;
    return without;
  });
}

function addEntry(entries: readonly EntryLike[], entry: EntryLike): EntryLike[] {
  return [...entries.map((e) => ({ ...e })), entry];
}

function duplicateEntry(entries: readonly EntryLike[], kind: string): EntryLike[] {
  const found = entries.find((entry) => entry.kind === kind)!;
  return [...entries.map((entry) => ({ ...entry })), { ...found }];
}

/**
 * Вход для контроля мутаций: «как если бы каждый вид каталога порождался».
 *
 * Намеренно НЕ читается из `semantic.ts`. Иначе дрейф исходника краснил бы сразу
 * полтора десятка проверок, и «что именно покраснело» стало бы неразличимо —
 * тот же случай, что «ноль собранных проверок против ноль покрасневших»
 * (`docs/verification-debt.md`). Исходник проверяется отдельно, в первом блоке.
 */
const PRODUCED_AS_CATALOGUED = DIAGNOSTIC_KINDS.map((entry) => entry.kind);

describe('(е) негативный контроль: мутация копии каталога обязана покраснеть', () => {
  it('чистая копия находок не даёт — сторож не «красный всегда»', () => {
    expect(catalogueFindings(copy(), PRODUCED_AS_CATALOGUED)).toEqual([]);
  });

  it('подмена одного вида (chained_compare → опечатка) краснит проверку (в)', () => {
    const mutated = renameKind(copy(), 'chained_compare', 'chained_compare_typo');
    expect(catalogueFindings(mutated, PRODUCED_AS_CATALOGUED).map((f) => f.check)).toEqual([
      'порождённый вид вне каталога',
    ]);
  });

  it('потеря вида, который порождает semantic.ts, краснит проверку (в)', () => {
    const mutated = dropKind(copy(), 'arg_count_mismatch');
    expect(catalogueFindings(mutated, PRODUCED_AS_CATALOGUED).map((f) => f.check)).toEqual([
      'порождённый вид вне каталога',
    ]);
  });

  it('выдуманный вид без долга краснит проверки (г) и неблокирующий список', () => {
    const mutated = addEntry(copy(), {
      kind: 'ghost_kind',
      code: 'OSN-SEM-016',
      blocking: false,
      description: 'вид, которого язык не знает',
    });
    // Две находки, и вторая — не шум: вид «не блокирует и долга нет» по выводу
    // попадает в `NON_BLOCKING_SEMANTIC_KINDS`, то есть расширяет список, которым
    // пользуются потребители. Именно это и обязан поймать сторож.
    expect(catalogueFindings(mutated, PRODUCED_AS_CATALOGUED).map((f) => f.check)).toEqual([
      'вид каталога без порождения и без долга',
      'неблокирующий список',
    ]);
  });

  it('пустой долг долгом не считается: проверки (г) и список краснеют', () => {
    const mutated = addEntry(copy(), {
      kind: 'ghost_kind',
      code: 'OSN-SEM-016',
      blocking: false,
      description: 'вид с пустой отпиской вместо долга',
      debt: '   ',
    });
    expect(catalogueFindings(mutated, PRODUCED_AS_CATALOGUED).map((f) => f.check)).toEqual([
      'вид каталога без порождения и без долга',
      'неблокирующий список',
    ]);
  });

  it('вид без порождения, но С ДОЛГОМ — не находка (обратный контроль (г))', () => {
    const mutated = addEntry(copy(), {
      kind: 'ghost_kind',
      code: 'OSN-SEM-016',
      blocking: false,
      description: 'вид, названный долгом заранее',
      debt: 'заведён до первой площадки порождения — долг назван, сторож молчит',
    });
    expect(catalogueFindings(mutated, PRODUCED_AS_CATALOGUED)).toEqual([]);
  });

  it('дубль вида краснит проверки (а) и (б)', () => {
    const mutated = duplicateEntry(copy(), 'keyword_as_identifier');
    expect(catalogueFindings(mutated, PRODUCED_AS_CATALOGUED).map((f) => f.check)).toEqual([
      'уникальность вида',
      'уникальность кода',
    ]);
  });

  it('дубль кода краснит проверку (б)', () => {
    const mutated = setCode(copy(), 'unknown_procedure', 'OSN-SEM-001');
    expect(catalogueFindings(mutated, PRODUCED_AS_CATALOGUED).map((f) => f.check)).toEqual(['уникальность кода']);
  });

  it('чужой формат кода краснит проверку (б)', () => {
    const mutated = setCode(copy(), 'keyword_as_identifier', 'SEM-10');
    expect(catalogueFindings(mutated, PRODUCED_AS_CATALOGUED).map((f) => f.check)).toEqual(['формат кода']);
  });

  it('снятие долга с arg_count_mismatch краснит неблокирующий список: 3 вида → 4', () => {
    const mutated = clearDebt(copy(), 'arg_count_mismatch');
    expect(catalogueFindings(mutated, PRODUCED_AS_CATALOGUED).map((f) => f.check)).toEqual([
      'неблокирующий список',
    ]);
  });

  it('снятие всех шести долгов расширяет неблокирующий список с 3 до 9 — красное', () => {
    const mutated = clearAllDebts(copy());
    const findings = catalogueFindings(mutated, PRODUCED_AS_CATALOGUED);
    expect(checksOf(findings)).toEqual(['неблокирующий список']);
    expect(findings, 'виды, которые молча вошли бы в список').toHaveLength(6);
    const wouldJoin = mutated.filter((entry) => !entry.blocking).map((entry) => entry.kind);
    expect(wouldJoin, 'неблокирующих стало бы').toHaveLength(9);
  });

  it('подмена признака blocking краснит обе проверки (д)', () => {
    const mutated = setBlocking(copy(), 'unknown_syscall', false);
    expect(catalogueFindings(mutated, PRODUCED_AS_CATALOGUED).map((f) => f.check)).toEqual([
      'блокирующий список',
      'неблокирующий список',
    ]);
  });

  it('каталог на диске мутациями не сдвинут', () => {
    // Сторож работает по копиям: если бы мутации правили сам каталог, «красное»
    // перетекло бы в соседние проверки — и в чужие тесты того же воркера.
    expect(JSON.stringify(DIAGNOSTIC_KINDS)).toBe(CATALOGUE_SNAPSHOT);
    expect(DIAGNOSTIC_KINDS).toHaveLength(KINDS_MEASURED);
  });
});

// ═══════════ таблица замеров: достижимость вида и судьба сборки ═══════════

/**
 * ТАБЛИЦА ЗАМЕРА (2026-09-28). По каждому виду: можно ли написать программу,
 * которая порождает **его одного**, и собирается ли такая программа.
 *
 * # Зачем это отдельно от `blocking`
 *
 * Поле `blocking` отвечает только за вхождение в блокирующий список. Судьбу
 * сборки решает ещё и кодоген, поэтому «неблокирующий» ≠ «собирается»: замер
 * показал два расхождения (`прервать`/`продолжить` вне цикла), и они закреплены
 * здесь, чтобы третье или тихое исчезновение известного краснело.
 *
 * # Это не проза
 *
 * Каждая строка **исполняется**: `compileSource` + `compileToBuildReport`. Слово
 * «собирается» в таблице означает замер, а не мнение. Где программу написать
 * нельзя, так и записано, с причиной и числом (`UNPROBED`), — вида «не пробовал»
 * здесь нет.
 *
 * Числа в текстах каталога (`debt`, `buildRefused`) взяты из этой таблицы, а сама
 * таблица проверяется исполнением: сдвинется факт — красным станет здесь, а не
 * тихо разойдётся текст с поведением.
 */
const MEASURED_AT = '2026-09-28';

const wrap = (body: string): string =>
  ['модуль ПробаВида', '', 'процедура главная()', body, 'конец', '', 'конец', ''].join('\n');

const registry = LANGUAGE_REGISTRY as unknown as {
  syscalls: readonly { name: string; argc: number }[];
  keywords: readonly { lexeme: string; kind: string }[];
};
/** Системный вызов с аргументами: без него «мало аргументов» нечем измерить. */
const SYSCALL_WITH_ARGS = registry.syscalls.find((s) => s.argc >= 1)?.name ?? 'система.лог.вывести';
/** Неблочные ключевые слова — те, что годятся в имя переменной (и не годятся в параметр). */
const NON_BLOCK_KEYWORDS = registry.keywords.filter((k) => k.kind !== 'block').map((k) => k.lexeme);
const KEYWORD_LEXEME = NON_BLOCK_KEYWORDS[0]!;

interface Measurement {
  /** Программа, у которой этот вид — ЕДИНСТВЕННАЯ диагностика. */
  readonly probe: string;
  /** Собирается ли программа с ним: замер `BuildReport.success`. */
  readonly builds: boolean;
}

const MEASURED: Record<string, Measurement> = {
  unknown_syscall: { probe: wrap('  система.такого_нет_вообще()'), builds: false },
  undeclared_var: { probe: wrap('  вернуть сумма_без_объявления'), builds: false },
  unknown_procedure: { probe: wrap('  несуществующая_процедура()'), builds: false },
  syscall_argc: { probe: wrap(`  ${SYSCALL_WITH_ARGS}()`), builds: false },
  redeclare_var: { probe: wrap('  пусть икс = 1\n  пусть икс = 2\n  вернуть икс'), builds: false },
  invented_syntax: { probe: wrap('  пусть с = структура(1)'), builds: false },
  // Проба намеренно берёт ЛОЖНОЕ срабатывание: настоящая цепочка `1 < 2 < 3` вид не
  // будит вовсе (см. отдельную проверку ниже). Вид при этом порождён — и это
  // свойство проверки, закреплённое каноном §12.1.
  chained_compare: {
    probe: wrap('  если (1 < 2) = истина тогда\n    вернуть 1\n  конец\n  вернуть 0'),
    builds: true,
  },
  keyword_as_identifier: { probe: wrap(`  пусть ${KEYWORD_LEXEME} = 1\n  вернуть 1`), builds: true },
  sentinel_pattern: { probe: wrap('  пусть с = пусто\n  вернуть 1'), builds: true },
  unknown_module: { probe: wrap('  вернуть НетТакогоМодуля.функция()'), builds: true },
  arg_count_mismatch: {
    probe: [
      'модуль ПробаВида',
      '',
      'процедура вспом(а, б)',
      '  вернуть а',
      'конец',
      '',
      'процедура главная()',
      '  вернуть вспом(1)',
      'конец',
      '',
      'конец',
      '',
    ].join('\n'),
    builds: true,
  },
  // Расхождение с ожиданием «blocking: false — значит собирается»: см. buildRefused.
  break_outside_loop: { probe: wrap('  прервать'), builds: false },
  continue_outside_loop: { probe: wrap('  продолжить'), builds: false },
};

/**
 * Виды, для которых пробы из исходного текста нет. Причина названа — с числом.
 * «Не пробовал» здесь не проходит: см. проверки ниже, они меряют обе причины.
 */
const UNPROBED: Record<string, string> = {
  keyword_param:
    'недостижим из исходного текста: парсер отвергает ключевое слово в позиции параметра — ' +
    '33 из 33 неблочных (замер перемеряется ниже), до семантики дело не доходит',
  export_collision:
    'из исходного текста не построить: загрузчик сводит провайдеров к одному — два файловых ' +
    'варианта собираются молча (перемеряется ниже); достижим только через API: `analyzeProgram` ' +
    'с собранным вручную `Program` из двух модулей с одним именем',
};

/** Исходник процедуры для ручного `Program` — путь к `export_collision` через API. */
function manualProcedure(name: string, value: number): Procedure {
  return {
    name,
    params: [],
    exported: true,
    body: [{ kind: 'вернуть', value: { kind: 'число', value } } as unknown as Stmt],
    origin: 'ручной.osnova',
  };
}

describe(`таблица замеров (${MEASURED_AT}): достижимость вида и судьба сборки`, () => {
  it('у каждого вида каталога есть либо проба, либо названная причина её отсутствия', () => {
    const covered = [...Object.keys(MEASURED), ...Object.keys(UNPROBED)].sort();
    expect(covered).toEqual(DIAGNOSTIC_KINDS.map((entry) => entry.kind).sort());
  });

  it('каждая проба порождает ровно СВОЙ вид — единственную диагностику', () => {
    const noisy: string[] = [];
    for (const [kind, m] of Object.entries(MEASURED)) {
      const kinds = [...new Set(compileSource(m.probe, { filename: 'проба-вида.osnova' }).semanticErrors.map((e) => e.kind))];
      if (kinds.length !== 1 || kinds[0] !== kind) {
        noisy.push(`${kind}: порождены [${kinds.join(', ')}] — сравнение было бы пустым`);
      }
    }
    expect(noisy, `пробы, породившие не то:\n  ${noisy.join('\n  ')}`).toEqual([]);
  });

  it('судьба сборки закреплена замером: `builds` совпадает с фактом', () => {
    const wrong: string[] = [];
    for (const [kind, m] of Object.entries(MEASURED)) {
      const report = compileToBuildReport(compileSource(m.probe, { filename: 'проба-вида.osnova' }));
      if (report.success !== m.builds) {
        wrong.push(`${kind}: таблица говорит builds=${m.builds}, факт success=${report.success}`);
      }
    }
    expect(wrong, `таблица разошлась с фактом:\n  ${wrong.join('\n  ')}`).toEqual([]);
  });

  it('расхождения «список против факта сборки» — ровно известные два', () => {
    // Две стороны одного вопроса, и обе закреплены: расхождение в любую сторону —
    // повод перемерить каталог, а не «поправить число».
    const notListedButRefused: string[] = []; // не в блокирующем списке, а программа не собирается
    const listedButBuilds: string[] = []; // в блокирующем списке, а программа собирается
    for (const [kind, m] of Object.entries(MEASURED)) {
      const entry = DIAGNOSTIC_KINDS.find((e) => e.kind === kind)!;
      if (!entry.blocking && !m.builds) notListedButRefused.push(kind);
      if (entry.blocking && m.builds) listedButBuilds.push(kind);
    }
    expect(notListedButRefused.sort()).toEqual(['break_outside_loop', 'continue_outside_loop']);
    expect(listedButBuilds, 'вид в блокирующем списке, а сборка проходит — это новый факт').toEqual([]);
  });

  it('поле buildRefused заполнено ровно там, где замер расходится с блокировкой', () => {
    // Поле — замер, а не украшение: заполнено ⟺ «в блокирующем списке вида нет,
    // а программа с ним не собирается». Где не мерено — молчит.
    const wrong: string[] = [];
    for (const entry of DIAGNOSTIC_KINDS) {
      const measured = MEASURED[entry.kind];
      const diverges = measured !== undefined && !entry.blocking && !measured.builds;
      const filled = entry.buildRefused !== undefined;
      if (diverges !== filled) {
        wrong.push(
          `${entry.kind}: buildRefused ${filled ? 'заполнен' : 'пуст'}, а замер ` +
            `${measured === undefined ? 'не делался' : `blocking=${entry.blocking}, builds=${measured.builds}`}`,
        );
      }
    }
    expect(wrong, `buildRefused не там, где нужно:\n  ${wrong.join('\n  ')}`).toEqual([]);
  });

  it('keyword_param недостижим: парсер отвергает все 33 неблочных ключевых слова', () => {
    expect(NON_BLOCK_KEYWORDS.length, 'неблочных ключевых слов в реестре').toBe(33);
    const reached: string[] = [];
    let parserRejected = 0;
    for (const kw of NON_BLOCK_KEYWORDS) {
      const source = [
        'модуль ПробаВида',
        '',
        `процедура вспом(${kw})`,
        '  вернуть 1',
        'конец',
        '',
        'процедура главная()',
        '  вернуть 1',
        'конец',
        '',
        'конец',
        '',
      ].join('\n');
      const r = compileSource(source, { filename: 'параметр.osnova' });
      if (r.semanticErrors.some((e) => e.kind === 'keyword_param')) reached.push(kw);
      else if (r.parserErrors.length > 0) parserRejected += 1;
    }
    expect(reached, `keyword_param достижим на [${reached.join(', ')}] — запись в UNPROBED устарела`).toEqual([]);
    expect(parserRejected, 'все пробы обязаны упереться в парсер').toBe(NON_BLOCK_KEYWORDS.length);
  });

  it('export_collision: из исходного текста не построить, через analyzeProgram — достижим', () => {
    // (1) два файловых варианта: загрузчик сводит провайдеров к одному.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osnova-collision-'));
    const silence: string[] = [];
    try {
      const variants: { name: string; files: Record<string, string>; entry: string }[] = [
        {
          name: 'два файла с одним именем модуля',
          files: {
            'а.osnova': ['модуль Дубль', 'процедура экспорт общая()', '  вернуть 1', 'конец', 'конец', ''].join('\n'),
            'б.osnova': ['модуль Дубль', 'процедура экспорт общая()', '  вернуть 2', 'конец', 'конец', ''].join('\n'),
            'главный.osnova': [
              'использовать модуль Дубль из "а.osnova"',
              'использовать модуль Дубль из "б.osnova"',
              '',
              'процедура главная()',
              '  вернуть Дубль.общая()',
              'конец',
              '',
              'конец',
              '',
            ].join('\n'),
          },
          entry: 'главный.osnova',
        },
        {
          name: 'два модуля с разными именами, импорт под одним',
          files: {
            'в.osnova': ['модуль Первый', 'процедура экспорт общая()', '  вернуть 1', 'конец', 'конец', ''].join('\n'),
            'г.osnova': ['модуль Второй', 'процедура экспорт общая()', '  вернуть 2', 'конец', 'конец', ''].join('\n'),
            'главный.osnova': [
              'использовать модуль Первый из "в.osnova"',
              'использовать модуль Второй из "г.osnova"',
              '',
              'процедура главная()',
              '  вернуть Первый.общая()',
              'конец',
              '',
              'конец',
              '',
            ].join('\n'),
          },
          entry: 'главный.osnova',
        },
      ];

      for (const variant of variants) {
        const sub = fs.mkdtempSync(path.join(dir, 'v-'));
        for (const [file, text] of Object.entries(variant.files)) {
          fs.writeFileSync(path.join(sub, file), text, 'utf-8');
        }
        const entry = fs.readFileSync(path.join(sub, variant.entry), 'utf-8');
        const r = compileSource(entry, { baseDir: sub, filename: variant.entry });
        const report = compileToBuildReport(r);
        const kinds = new Set(r.semanticErrors.map((e) => e.kind));
        if (kinds.has('export_collision') || report.success !== true) {
          silence.push(`${variant.name}: виды [${[...kinds].join(', ')}], success=${report.success}`);
        }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(silence, `файловые пробы перестали собираться молча:\n  ${silence.join('\n  ')}`).toEqual([]);

    // (2) ручной `Program`: тот же вид через API — доказательство, что ветка жива,
    //     а не что её забыли.
    const manual: Program = {
      modules: [
        { name: 'Дубль', imports: [], typeDeclarations: [], procedures: [manualProcedure('общая', 1)] },
        { name: 'Дубль', imports: [], typeDeclarations: [], procedures: [manualProcedure('общая', 2)] },
        { name: 'Главный', imports: [], typeDeclarations: [], procedures: [manualProcedure('главная', 3)] },
      ],
    };
    const viaApi = [...new Set(analyzeProgram(manual, { filename: 'ручной.osnova' }).errors.map((e) => e.kind))];
    expect(viaApi, 'ветка export_collision перестала отвечать даже на ручной Program').toEqual([
      'export_collision',
    ]);
  });

  it('chained_compare: настоящая цепочка молчит и собирается, ложное срабатывание — названо', () => {
    const real = compileSource(wrap('  пусть б = 1 < 2 < 3\n  вернуть б'), { filename: 'цепочка.osnova' });
    const realReport = compileToBuildReport(real);
    // Канон §12.1 держит это же: `1 < 2 < 3` собирается молча, вид не порождён.
    expect(new Set(real.semanticErrors.map((e) => e.kind)).has('chained_compare'), 'настоящая цепочка названа').toBe(false);
    expect(realReport.success, 'настоящая цепочка обязана собираться').toBe(true);
    // А проба в таблице держится на ложном срабатывании — и это закреплено явно.
    const falsePositive = compileSource(MEASURED.chained_compare!.probe, { filename: 'скобки.osnova' });
    expect(
      falsePositive.semanticErrors.some((e) => e.kind === 'chained_compare'),
      '`(1 < 2) = истина` названо цепочкой — иначе проба таблицы мертва',
    ).toBe(true);
  });
});

describe('коды каталога: одна личность на отказ', () => {
  const allCodes: { code: string; where: string }[] = [
    ...DIAGNOSTIC_KINDS.map((entry) => ({ code: entry.code, where: `вид ${entry.kind}` })),
    ...Object.entries(PHASE_CODES).map(([phase, code]) => ({ code, where: `фаза ${phase}` })),
    ...Object.entries(INTERNAL_CODES).map(([name, code]) => ({ code, where: `событие ${name}` })),
    ...Object.entries(CLI_CODES).map(([name, code]) => ({ code, where: `отказ CLI ${name}` })),
    ...Object.entries(UNCATALOGUED_CODES).map(([name, code]) => ({ code, where: `маркер ${name}` })),
  ];

  it('коды не переиспользованы между видами, фазами, событиями и CLI', () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const { code, where } of allCodes) {
      const prev = seen.get(code);
      if (prev !== undefined) clashes.push(`${code}: «${prev}» и «${where}»`);
      else seen.set(code, where);
    }
    expect(clashes, 'код выдан дважды — журнал не различит причины').toEqual([]);
  });

  it('каждый код формы OSN-<ФАЗА>-NNN', () => {
    const bad = allCodes.filter(({ code }) => !/^OSN-[A-Z]{2,4}-\d{3}$/.test(code));
    expect(bad.map((c) => `${c.where}: ${c.code}`)).toEqual([]);
  });

  it('коды CLI на месте: ровно те, на которые смотрит машинный вывод', () => {
    expect(CLI_CODES).toEqual({ inputMissing: 'OSN-CLI-001', inputNotFound: 'OSN-CLI-002' });
    expect(Object.values(CLI_CODES).filter((c) => c.startsWith('OSN-CLI-')), 'пространство CLI').toHaveLength(2);
  });

  it('маркер «вид не каталогизирован» — один на всех читателей и он НЕ подставляется молча', () => {
    expect(UNCATALOGUED_CODES).toEqual({ kindNotCatalogued: 'OSN-SEM-000' });
    // Граница, ради которой маркер отдельный: каталог по-прежнему НЕ выдумывает
    // код для неизвестного вида. Читатель, встретивший такой вид, обязан взять
    // маркер сам — и это видно в записи, а не спрятано за «похожим» кодом.
    expect(diagnosticCodeOf('вида_такого_нет'), 'код для неизвестного вида').toBeUndefined();
    expect(diagnosticKindInfo('вида_такого_нет'), 'запись для неизвестного вида').toBeUndefined();
    expect(isBlockingKind('вида_такого_нет'), 'неизвестный вид не в блокирующем списке').toBe(false);
    // И тот же вопрос про `undefined`: вида нет — кода нет, а не пустая строка.
    expect(diagnosticCodeOf(undefined)).toBeUndefined();
    expect(diagnosticCodeOf('unknown_syscall'), 'известный вид отдаёт свой код').toBe('OSN-SEM-001');
  });
});
