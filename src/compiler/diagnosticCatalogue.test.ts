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
 * (г) каждый вид каталога либо порождается, либо назван **недостижимым** — иначе
 * в каталоге заводится вид, которого язык не знает;
 * (д) `BLOCKING_SEMANTIC_KINDS` в точности равен множеству видов в состоянии
 * «блокирующий», неблокирующий список — множеству «неблокирующий», а
 * `ALL_SEMANTIC_KINDS` — их сумме;
 * (е) **класс: состояние обязано совпадать с поведением компилятора** — для
 * каждого вида с пробой «блокирующий» ⟺ сборка не проходит, а `buildRefused`
 * заполнен ⟺ замер показывает отказ. Перечня «известных расхождений» и исключений
 * здесь нет: расхождение — это красное, а не запись. Замер 2026-09-28: расхождений
 * ноль (`break_outside_loop`/`continue_outside_loop` — блокирующие, программа с
 * ними не собирается);
 * (ж) **класс: у вида ровно одно состояние, и оно совпадает с замером**
 * (задача T12, решение владельца: состояние `debt` снято). Живой вид обязан
 * порождаться исходным текстом, мёртвый — не порождаться ни одной площадкой и
 * иметь названный замер недостижимости. Состояния складываются в 15 без остатка:
 * **8 блокирующих + 1 неблокирующий + 3 неблокирующих вне списка + 3 недостижимых**.
 *
 * # Негативный контроль
 *
 * Мутации **копии** каталога: файл на диске не трогается — вердикты
 * (`catalogueFindings`, `behaviourFindings`, `stateFindings`) принимают каталог
 * параметром. Каждая мутация обязана покраснеть, и проверка называет, ЧТО
 * покраснело: без этого «контроль прошёл» неотличимо от «сторож слеп». Среди
 * мутаций несущие: живой вид, названный мёртвым; мёртвый, названный живым;
 * подмена состояния у вида с пробой и снятый `buildRefused` — это и есть контроль
 * на «вид из каталога перестал соответствовать компилятору».
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

/** Замер 2026-09-28: 24 площадки `kind: "..."` в семантике, 14 уникальных видов. */
const SITES_MEASURED = 24;
const PRODUCED_KINDS_MEASURED = 14;
/** Видов в каталоге — пятнадцатый (`chained_compare`) живёт ради кода: порождать его нечем. */
const KINDS_MEASURED = 15;

// ─────────────────── вердикт: чистая функция от каталога ───────────────────

/** Имя проверки. Негативный контроль называет по нему, что именно покраснело. */
type CheckId =
  | 'уникальность вида'
  | 'уникальность кода'
  | 'формат кода'
  | 'порождённый вид вне каталога'
  | 'вид каталога без порождения и без состояния'
  | 'блокирующий список'
  | 'неблокирующий список'
  | 'признак против сборки'
  | 'замер buildRefused'
  | 'состояние вида'
  | 'состояние против факта'
  | 'замер недостижимости';

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
  state: string;
  description: string;
  unreachable?: string;
  buildRefused?: string;
}

/** Состояния, какие бывают. Всё прочее — дефект каталога, а не пятое состояние. */
const STATES = ['блокирующий', 'неблокирующий', 'неблокирующий-вне-списка', 'недостижимый'] as const;

/** Вид назван живым: он обязан порождаться исходным текстом. */
function isAlive(entry: EntryLike): boolean {
  return entry.state !== 'недостижимый';
}

/** Названный замер недостижимости — непустой текст, а не отписка. */
function hasUnreachableMeasure(entry: EntryLike): boolean {
  return typeof entry.unreachable === 'string' && entry.unreachable.trim().length > 20;
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

  // (г) вид каталога обязан быть порождён — или назван недостижимым с замером.
  for (const entry of entries) {
    if (!producedSet.has(entry.kind) && entry.state !== 'недостижимый') {
      findings.push({
        check: 'вид каталога без порождения и без состояния',
        detail:
          `«${entry.kind}» не порождается ни одной площадкой, а состояние у него ` +
          `«${entry.state}» — живой вид обязан порождаться`,
      });
    }
  }

  // (д) блокирующий список — в точности множество видов в состоянии «блокирующий».
  findings.push(
    ...listFindings(
      'блокирующий список',
      BLOCKING_SEMANTIC_KINDS,
      entries.filter((entry) => entry.state === 'блокирующий').map((entry) => entry.kind),
    ),
  );

  // (д) неблокирующий — в точности состояние «неблокирующий»: мёртвый вид сюда
  // попасть не может (маршрутизировать нечего), а живой обязан.
  findings.push(
    ...listFindings(
      'неблокирующий список',
      NON_BLOCKING_SEMANTIC_KINDS,
      entries.filter((entry) => entry.state === 'неблокирующий').map((entry) => entry.kind),
    ),
  );

  return findings;
}

/** Что именно покраснело — без дублей, в порядке появления. */
function checksOf(findings: readonly Finding[]): CheckId[] {
  return [...new Set(findings.map((finding) => finding.check))];
}

/**
 * КЛАСС (е): каталог против **поведения компилятора**, выведенный из замера.
 *
 * Отличие от `catalogueFindings` принципиальное. Тот сверяет каталог с каталогом
 * же и с текстом семантики; этот берёт **исполняемую** таблицу замеров (проба
 * компилируется ниже, в том же файле) и требует, чтобы признак и замер совпали:
 * вид, при котором сборка не проходит, обязан быть в блокирующем списке, а
 * `buildRefused` — стоять там, где замер показывает отказ. Перечня известных
 * расхождений здесь нет намеренно: он превращал бы дефект в запись.
 *
 * Принимает замеры параметром — поэтому негативный контроль подсовывает сюда и
 * мутированный каталог, и сдвинутый замер, не трогая файл на диске.
 */
function behaviourFindings(
  entries: readonly EntryLike[],
  measured: Record<string, { builds: boolean }>,
): Finding[] {
  const findings: Finding[] = [];
  for (const entry of entries) {
    const m = measured[entry.kind];
    // Вид без пробы классом не судится: его достижимость держит отдельная
    // проверка с названной причиной (`UNPROBED`).
    if (m === undefined) continue;
    const refused = !m.builds;
    if ((entry.state === 'блокирующий') !== refused) {
      findings.push({
        check: 'признак против сборки',
        detail:
          `«${entry.kind}»: в каталоге состояние «${entry.state}», а замер ` +
          (refused ? 'показывает отказ сборки (success=false)' : 'показывает успешную сборку'),
      });
    }
    const filled = typeof entry.buildRefused === 'string' && entry.buildRefused.trim() !== '';
    // `buildRefused` — имя расхождения, а не общий замер: заполнено ⟺ «сборка не
    // проходит, а вид не блокирующий». Сегодня таких нет ни одного.
    const diverges = refused && entry.state !== 'блокирующий';
    if (filled !== diverges) {
      findings.push({
        check: 'замер buildRefused',
        detail:
          `«${entry.kind}»: buildRefused ${filled ? 'заполнен' : 'пуст'}, а расхождение ` +
          (diverges
            ? 'есть: сборка не проходит, а состояние не «блокирующий»'
            : 'отсутствует: состояние и судьба сборки согласованы'),
      });
    }
  }
  return findings;
}

/**
 * КЛАСС (ж): **у вида ровно одно состояние, и оно совпадает с замером.**
 *
 * Решение владельца (задача T12, 2026-09-28): состояние `debt` снято; у каждого
 * из пятнадцати видов состояние названо, и безымянного «не отнесён ни к одному»
 * больше нет. Состояний четыре, и они складываются в 15 без остатка:
 * **8 блокирующих + 1 неблокирующий + 3 неблокирующих вне списка + 3 недостижимых**.
 *
 * Факт, с которым сверяется состояние, — **достижимость по замеру**: вид с пробой
 * (`MEASURED`) порождается исходным текстом, вид без пробы — нет. Именно «по
 * замеру», а не «по скану площадок»: у `keyword_param` и `export_collision`
 * площадка в `semantic.ts` **есть**, но мёртвая (парсер отвергает ключевое слово
 * в позиции параметра; загрузчик не даёт двух провайдеров), поэтому скан говорит
 * «порождается», а замер — «нет». Скан держит проверка (г) выше.
 *
 * Поэтому здесь:
 * - состояние обязано быть одним из четырёх (`STATES`) — пятого не бывает;
 * - живой вид обязан иметь пробу, мёртвый — не иметь;
 * - мёртвый обязан нести названный замер недостижимости (`unreachable`, длиннее
 *   отписки), живой его нести не может — иначе «мёртвость» приписывалась бы
 *   живому виду текстом.
 */
function stateFindings(
  entries: readonly EntryLike[],
  measured: Record<string, { builds: boolean }>,
): Finding[] {
  const findings: Finding[] = [];
  const counts: Record<string, number> = {};

  for (const entry of entries) {
    counts[entry.state] = (counts[entry.state] ?? 0) + 1;

    // Ровно одно состояние — и оно из трёх названных.
    if (!(STATES as readonly string[]).includes(entry.state)) {
      findings.push({
        check: 'состояние вида',
        detail: `«${entry.kind}»: состояние «${entry.state}» не из трёх названных`,
      });
      continue;
    }

    const probed = measured[entry.kind] !== undefined;
    const alive = isAlive(entry);

    if (alive && !probed) {
      findings.push({
        check: 'состояние против факта',
        detail: `«${entry.kind}»: назван живым (${entry.state}), а пробы нет — достижимость не показана`,
      });
    }
    if (!alive && probed) {
      findings.push({
        check: 'состояние против факта',
        detail: `«${entry.kind}»: назван мёртвым, а проба его порождает — вид жив`,
      });
    }

    // Замер недостижимости — только у мёртвого и обязателен у него.
    const measuredUnreachable = hasUnreachableMeasure(entry);
    if (!alive && !measuredUnreachable) {
      findings.push({
        check: 'замер недостижимости',
        detail: `«${entry.kind}»: назван мёртвым без названного замера недостижимости`,
      });
    }
    if (alive && entry.unreachable !== undefined) {
      findings.push({
        check: 'замер недостижимости',
        detail: `«${entry.kind}»: живой вид несёт замер недостижимости — состояния спорят`,
      });
    }
  }

  // Сумма состояний — 15 без остатка, и каждое состояние непусто.
  const sum = STATES.reduce((acc, state) => acc + (counts[state] ?? 0), 0);
  if (sum !== entries.length) {
    findings.push({
      check: 'состояние вида',
      detail: `состояния покрывают ${sum} видов из ${entries.length} — есть вид без состояния`,
    });
  }
  for (const state of STATES) {
    if ((counts[state] ?? 0) === 0) {
      findings.push({ check: 'состояние вида', detail: `состояние «${state}» не занято ни одним видом` });
    }
  }
  return findings;
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

  it('(г) каждый вид каталога либо порождается, либо назван недостижимым', () => {
    const producedSet = new Set(PRODUCED);
    const silent = DIAGNOSTIC_KINDS.filter(
      (entry) => !producedSet.has(entry.kind) && entry.state !== 'недостижимый',
    ).map((entry) => entry.kind);
    expect(silent, 'виды каталога без порождения и без состояния «недостижимый»').toEqual([]);
  });

  it('скан исходника не слеп: 24 площадки порождения, 14 видов', () => {
    // Число площадок — замер, а не украшение: если сканер ослепнет (переписали
    // кавычки, сломали регулярку), проверка (г) покраснеет вслед за этой, и
    // причина будет названа, а не выдана за находку в каталоге.
    expect(PRODUCED).toHaveLength(SITES_MEASURED);
    expect(new Set(PRODUCED).size).toBe(PRODUCED_KINDS_MEASURED);
    expect(new Set(PRODUCED).size).toBeLessThan(KINDS_MEASURED);
  });
});

// ─────────────────── (д): списки выводятся из каталога ───────────────────

describe('списки выводятся из каталога, а не пишутся рядом', () => {
  it('(д) BLOCKING_SEMANTIC_KINDS в точности равен множеству состояния «блокирующий»', () => {
    const derived = DIAGNOSTIC_KINDS.filter((entry) => entry.state === 'блокирующий').map(
      (entry) => entry.kind,
    );
    expect([...BLOCKING_SEMANTIC_KINDS]).toEqual(derived);
    expect(derived, 'блокирующих видов').toHaveLength(8);
  });

  it('(д) NON_BLOCKING_SEMANTIC_KINDS в точности равен множеству состояния «неблокирующий»', () => {
    const derived = DIAGNOSTIC_KINDS.filter((entry) => entry.state === 'неблокирующий').map(
      (entry) => entry.kind,
    );
    expect([...NON_BLOCKING_SEMANTIC_KINDS]).toEqual(derived);
    // Список НЕ расширен (T12: расширение отклонено владельцем) — в нём один вид,
    // а три живых неблокирующих стоят вне списка с названным состоянием.
    expect(derived, 'неблокирующих видов в списке').toHaveLength(1);
  });

  it('шесть видов вне списков, и у каждого названное состояние — не «ни к одному»', () => {
    const beyondLists = DIAGNOSTIC_KINDS.filter(
      (entry) => entry.state !== 'блокирующий' && entry.state !== 'неблокирующий',
    ).map((entry) => entry.kind);
    expect(beyondLists).toEqual([
      'arg_count_mismatch',
      'chained_compare',
      'keyword_param',
      'sentinel_pattern',
      'unknown_module',
      'export_collision',
    ]);
    for (const kind of beyondLists) {
      const entry = DIAGNOSTIC_KINDS.find((e) => e.kind === kind)!;
      expect(BLOCKING_SEMANTIC_KINDS as readonly string[]).not.toContain(kind);
      expect(NON_BLOCKING_SEMANTIC_KINDS as readonly string[]).not.toContain(kind);
      expect(ALL_SEMANTIC_KINDS as readonly string[]).not.toContain(kind);
      // Состояние названо — и оно одно из двух законных «вне списков».
      expect(
        ['недостижимый', 'неблокирующий-вне-списка'],
        `«${kind}»: состояние вне списков`,
      ).toContain(entry.state);
    }
    const dead = beyondLists.filter(
      (kind) => DIAGNOSTIC_KINDS.find((e) => e.kind === kind)!.state === 'недостижимый',
    );
    const notRouted = beyondLists.filter(
      (kind) => DIAGNOSTIC_KINDS.find((e) => e.kind === kind)!.state === 'неблокирующий-вне-списка',
    );
    expect(dead, 'мёртвых').toEqual(['chained_compare', 'keyword_param', 'export_collision']);
    expect(notRouted, 'живых, потребителям не отданных').toEqual([
      'arg_count_mismatch',
      'sentinel_pattern',
      'unknown_module',
    ]);
  });

  it('ALL_SEMANTIC_KINDS = блокирующие + неблокирующие: 9 из 15 (число не сдвинулось)', () => {
    expect([...ALL_SEMANTIC_KINDS]).toEqual([
      ...BLOCKING_SEMANTIC_KINDS,
      ...NON_BLOCKING_SEMANTIC_KINDS,
    ]);
    expect(ALL_SEMANTIC_KINDS).toHaveLength(9);
    expect(ALL_SEMANTIC_KINDS.length).toBeLessThan(DIAGNOSTIC_KINDS.length);
  });

  it('значения списков: 8 блокирующих и 1 неблокирующий (T12: без расширения)', () => {
    // Эти два перечня импортируют ~15 файлов, включая замороженный пайплайн и
    // `src/agents/**`. Сдвиг 2026-09-28 один и назван вслух:
    // `break_outside_loop`/`continue_outside_loop` перешли в блокирующие (сборка
    // не проходит). Неблокирующий список НЕ расширен — три живых вида с долгом
    // получили состояние «неблокирующий-вне-списка»; цена расширения измерена и
    // лежит в `semanticKinds.ts` и в каталоге.
    expect([...BLOCKING_SEMANTIC_KINDS]).toEqual([
      'unknown_syscall',
      'undeclared_var',
      'unknown_procedure',
      'syscall_argc',
      'redeclare_var',
      'invented_syntax',
      'break_outside_loop',
      'continue_outside_loop',
    ]);
    expect([...NON_BLOCKING_SEMANTIC_KINDS]).toEqual(['keyword_as_identifier']);
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

function setState(entries: readonly EntryLike[], kind: string, state: string): EntryLike[] {
  return entries.map((entry) => (entry.kind === kind ? { ...entry, state } : { ...entry }));
}

function clearUnreachable(entries: readonly EntryLike[], kind: string): EntryLike[] {
  return entries.map((entry) => {
    if (entry.kind !== kind) return { ...entry };
    const without: EntryLike = { ...entry };
    delete without.unreachable;
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
    // Одна находка: вид стоит вне списков (состояние «неблокирующий-вне-списка»),
    // поэтому список потребителей его потерей не двигается — двигается каталог.
    expect(catalogueFindings(mutated, PRODUCED_AS_CATALOGUED).map((f) => f.check)).toEqual([
      'порождённый вид вне каталога',
    ]);
  });

  it('выдуманный живой вид краснит проверки (г) и неблокирующий список', () => {
    const mutated = addEntry(copy(), {
      kind: 'ghost_kind',
      code: 'OSN-SEM-016',
      state: 'неблокирующий',
      description: 'вид, которого язык не знает',
    });
    // Две находки, и вторая — не шум: живой вид по состоянию попадает в
    // `NON_BLOCKING_SEMANTIC_KINDS`, то есть расширяет список, которым пользуются
    // потребители. Именно это и обязан поймать сторож.
    expect(catalogueFindings(mutated, PRODUCED_AS_CATALOGUED).map((f) => f.check)).toEqual([
      'вид каталога без порождения и без состояния',
      'неблокирующий список',
    ]);
  });

  it('выдуманный МЁРТВЫЙ вид без замера краснит класс (ж), а список не трогает', () => {
    const mutated = addEntry(copy(), {
      kind: 'ghost_kind',
      code: 'OSN-SEM-016',
      state: 'недостижимый',
      description: 'вид, названный мёртвым заранее',
    });
    // Проверка (г) молчит: мёртвый вид имеет право не порождаться. Молчит и
    // неблокирующий список. Но класс (ж) требует замер недостижимости — и краснеет.
    expect(catalogueFindings(mutated, PRODUCED_AS_CATALOGUED)).toEqual([]);
    expect(stateFindings(mutated, MEASURED).map((f) => f.check)).toEqual([
      'замер недостижимости',
    ]);
  });

  it('мёртвый вид С ЗАМЕРОМ — не находка (обратный контроль (ж))', () => {
    const mutated = addEntry(copy(), {
      kind: 'ghost_kind',
      code: 'OSN-SEM-016',
      state: 'недостижимый',
      description: 'вид, названный мёртвым с замером',
      unreachable:
        'заведён до первой площадки порождения; замер: проба не строится, площадок в semantic.ts ноль',
    });
    expect(catalogueFindings(mutated, PRODUCED_AS_CATALOGUED)).toEqual([]);
    expect(stateFindings(mutated, MEASURED)).toEqual([]);
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

  it('подмена состояния у блокирующего вида краснит обе проверки (д)', () => {
    const mutated = setState(copy(), 'unknown_syscall', 'неблокирующий');
    expect(catalogueFindings(mutated, PRODUCED_AS_CATALOGUED).map((f) => f.check)).toEqual([
      'блокирующий список',
      'неблокирующий список',
    ]);
  });

  it('тихое расширение списка краснит проверку (д): «вне списка» → «неблокирующий»', () => {
    // Тот самый контроль на отклонённое расширение: если кто-то переведёт живой
    // неотданный вид в состояние «неблокирующий», список молча вырастет с 1 до 2 —
    // и это обязано быть красным, а не тихой правкой замороженного пайплайна.
    const mutated = setState(copy(), 'arg_count_mismatch', 'неблокирующий');
    expect(catalogueFindings(mutated, PRODUCED_AS_CATALOGUED).map((f) => f.check)).toEqual([
      'неблокирующий список',
    ]);
  });

  it('обратный контроль: «неблокирующий» → «вне списка» тоже краснит (д)', () => {
    const mutated = setState(copy(), 'keyword_as_identifier', 'неблокирующий-вне-списка');
    expect(catalogueFindings(mutated, PRODUCED_AS_CATALOGUED).map((f) => f.check)).toEqual([
      'неблокирующий список',
    ]);
  });

  it('живой вид, названный мёртвым, краснит класс (ж) — обратная сторона', () => {
    const mutated = setState(copy(), 'unknown_module', 'недостижимый');
    expect(stateFindings(mutated, MEASURED).map((f) => f.check)).toEqual([
      'состояние против факта',
      'замер недостижимости',
    ]);
  });

  it('мёртвый вид, названный живым, краснит класс (ж)', () => {
    const mutated = setState(copy(), 'chained_compare', 'неблокирующий');
    expect(stateFindings(mutated, MEASURED).map((f) => f.check)).toEqual([
      'состояние против факта',
      'замер недостижимости',
    ]);
  });

  it('четвёртое состояние краснит класс (ж) — состояний ровно три', () => {
    const mutated = setState(copy(), 'unknown_module', 'долг');
    // Две стороны одной правки: состояние не из трёх названных — и сумма
    // состояний перестаёт покрывать 15 видов. Обе находки одного имени.
    const findings = stateFindings(mutated, MEASURED);
    expect(checksOf(findings)).toEqual(['состояние вида']);
    expect(findings).toHaveLength(2);
  });

  it('снятый замер недостижимости краснит класс (ж)', () => {
    const mutated = clearUnreachable(copy(), 'keyword_param');
    expect(stateFindings(mutated, MEASURED).map((f) => f.check)).toEqual([
      'замер недостижимости',
    ]);
  });

  it('каталог на диске мутациями не сдвинут', () => {
    // Сторож работает по копиям: если бы мутации правили сам каталог, «красное»
    // перетекло бы в соседние проверки — и в чужие тесты того же воркера.
    expect(JSON.stringify(DIAGNOSTIC_KINDS)).toBe(CATALOGUE_SNAPSHOT);
    expect(DIAGNOSTIC_KINDS).toHaveLength(KINDS_MEASURED);
  });
});

// ─────────── (е) класс: вид каталога против ПОВЕДЕНИЯ компилятора ───────────

/**
 * Здесь проверяется не «совпал ли каталог сам с собой», а **совпал ли он с
 * компилятором**. Замеры — те же, что в таблице ниже (проба компилируется
 * `compileSource` + `compileToBuildReport`), но проверка выведена правилом:
 * «вид, при котором сборка не проходит, обязан быть в блокирующем списке, а
 * `buildRefused` — стоять там, где замер показывает отказ». Никакого перечня
 * известных расхождений: он был бы записью о дефекте вместо красного.
 *
 * Повод — замер 2026-09-28. До него расхождений было ровно два
 * (`break_outside_loop`, `continue_outside_loop`: каталог `blocking: false`, а
 * сборка падала), и они были закреплены списком «известных». Список снят:
 * признак переведён по замеру, а проверка стала классом.
 */
describe('(е) класс: признак и замер совпадают с поведением компилятора', () => {
  it('чистый каталог против чистых замеров — находок нет', () => {
    expect(behaviourFindings(DIAGNOSTIC_KINDS, MEASURED)).toEqual([]);
  });

  it('сдвиг признака у вида с пробой краснит класс — негативный контроль', () => {
    const mutated = setState(copy(), 'break_outside_loop', 'неблокирующий');
    const findings = behaviourFindings(mutated, MEASURED);
    // Две стороны одной мутации: признак разошёлся со сборкой — и имя расхождения
    // (`buildRefused`) обязано появиться. Ровно это прежде прикрывал перечень
    // «известных двух»; теперь это красное.
    expect(checksOf(findings)).toEqual(['признак против сборки', 'замер buildRefused']);
    expect(findings).toHaveLength(2);
  });

  it('`buildRefused` на виде, который собирается, краснит класс — обратная сторона', () => {
    const mutated = copy().map((entry) =>
      entry.kind === 'sentinel_pattern'
        ? { ...entry, buildRefused: 'отписка там, где сборка проходит' }
        : { ...entry },
    );
    expect(behaviourFindings(mutated, MEASURED).map((f) => f.check)).toEqual(['замер buildRefused']);
  });

  it('сдвиг ЗАМЕРА (а не каталога) краснит класс — сторож не читает только каталог', () => {
    const shifted = { ...MEASURED, unknown_syscall: { builds: true } };
    expect(behaviourFindings(copy(), shifted).map((f) => f.check)).toEqual(['признак против сборки']);
  });

  it('вид без пробы классом не судится — за него отвечает названная причина', () => {
    // Иначе «нет пробы» молча означало бы «нет проверки»: `keyword_param` и
    // `chained_compare` (недостижимы) обязаны быть в `UNPROBED`, и это отдельная
    // проверка ниже. Здесь — что класс их не выдумывает.
    const measuredKinds = Object.keys(MEASURED);
    expect(measuredKinds).not.toContain('keyword_param');
    expect(measuredKinds).not.toContain('chained_compare');
    expect(Object.keys(UNPROBED).sort()).toEqual(['chained_compare', 'export_collision', 'keyword_param']);
  });
});

// ─────────── (ж) класс: ровно одно состояние на вид, и оно совпадает с фактом ───────────

/**
 * Задача T12, решение владельца 2026-09-28: состояние `debt` снято. Здесь
 * проверяется, что у каждого вида **ровно одно** состояние из трёх и что оно
 * совпадает с замером: живой вид порождается, мёртвый — нет и назван замером.
 *
 * Состояний ровно три, и они складываются в 15 без остатка: 8 + 4 + 3. Это
 * проверяется числом, а не абзацем: сумма состояний обязана совпасть с числом
 * видов, а каждое состояние — быть занятым.
 */
describe('(ж) класс: состояние вида совпадает с фактом, третьего состояния нет', () => {
  it('чистый каталог против замеров — находок нет', () => {
    expect(stateFindings(DIAGNOSTIC_KINDS, MEASURED)).toEqual([]);
  });

  it('состояния складываются в 15 без остатка: 8 + 1 + 3 + 3', () => {
    const counts = {
      блокирующий: 0,
      неблокирующий: 0,
      'неблокирующий-вне-списка': 0,
      недостижимый: 0,
    } as Record<string, number>;
    for (const entry of DIAGNOSTIC_KINDS) counts[entry.state] = (counts[entry.state] ?? 0) + 1;
    expect(counts).toEqual({
      блокирующий: 8,
      неблокирующий: 1,
      'неблокирующий-вне-списка': 3,
      недостижимый: 3,
    });
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(DIAGNOSTIC_KINDS.length);
    // «Долга» как состояния больше нет — это и есть решение владельца.
    expect(Object.keys(counts)).not.toContain('debt');
  });

  it('у каждого мёртвого вида назван свой замер недостижимости, и они разные', () => {
    const dead = DIAGNOSTIC_KINDS.filter((entry) => entry.state === 'недостижимый');
    expect(dead.map((entry) => entry.kind)).toEqual([
      'chained_compare',
      'keyword_param',
      'export_collision',
    ]);
    for (const entry of dead) {
      const measure = 'unreachable' in entry ? entry.unreachable : undefined;
      expect(typeof measure, `«${entry.kind}»: замер недостижимости`).toBe('string');
      expect(measure!.length, `«${entry.kind}»: замер длиннее отписки`).toBeGreaterThan(80);
      expect(measure, `«${entry.kind}»: замер называет дату`).toContain('2026-09-28');
    }
    // Замеры разные: три вида мёртвы по трём разным причинам, и одна отписка на
    // всех означала бы, что мерили не каждый.
    const measures = dead.map((entry) => ('unreachable' in entry ? entry.unreachable : ''));
    expect(new Set(measures).size).toBe(3);
  });

  it('живые виды несут замер недостижимости только если он у них есть — и ни у кого нет', () => {
    const alive = DIAGNOSTIC_KINDS.filter((entry) => entry.state !== 'недостижимый');
    expect(alive).toHaveLength(12);
    for (const entry of alive) {
      expect('unreachable' in entry ? entry.unreachable : undefined).toBeUndefined();
    }
  });
});

// ═══════════ таблица замеров: достижимость вида и судьба сборки ═══════════

/**
 * ТАБЛИЦА ЗАМЕРА (2026-09-28, перемер 2026-09-28). По каждому виду: можно ли
 * написать программу, которая порождает **его одного**, и собирается ли такая
 * программа.
 *
 * # Зачем это отдельно от состояния вида
 *
 * Состояние (`state`) отвечает за вхождение в списки потребителей, а судьбу
 * сборки решает ещё и кодоген. Раньше эти две вещи расходились (два вида), и
 * расхождение было закреплено перечнем «известных». Теперь правило обратное:
 * **состояние и замер обязаны совпадать** — разошлись, значит красное
 * (`behaviourFindings`, `stateFindings` выше). Перечень снят вместе с
 * расхождением: `break_outside_loop` и `continue_outside_loop` переведены в
 * блокирующие, потому что программы с ними не собираются.
 *
 * # Это не проза
 *
 * Каждая строка **исполняется**: `compileSource` + `compileToBuildReport`. Слово
 * «собирается» в таблице означает замер, а не мнение. Где программу написать
 * нельзя, так и записано, с причиной и числом (`UNPROBED`), — вида «не пробовал»
 * здесь нет.
 *
 * Числа в текстах каталога (`unreachable`, `buildRefused`) взяты из этой таблицы,
 * а сама таблица проверяется исполнением: сдвинется факт — красным станет здесь, а
 * не тихо разойдётся текст с поведением.
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
  // С 2026-09-28 признак переведён в `true` — замер и классификация совпали.
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
  chained_compare:
    'недостижим из исходного текста с 2026-09-28: цепочку `a < b < c` разворачивает в `(a < b) и ' +
    '(b < c)` ПАРСЕР (канон §2.1 объявляет её сахаром), поэтому площадки в семантике нет — ' +
    'прежняя проверка била только по законным программам (`(1 < 2) = истина`) и снята; замер ' +
    'перемеряется ниже',
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

  it('расхождений «состояние против факта сборки» нет ни одного — и это выведено, а не закреплено', () => {
    // Прежде здесь стоял перечень «известных двух» расхождений
    // (`break_outside_loop`, `continue_outside_loop`): каталог говорил
    // «неблокирующий», а программа не собиралась. Перечень был честной записью
    // о дефекте — и оставался бы ею, пока состояние не привели к замеру. Теперь
    // проверка выведена (класс (е)), а не сверяется со списком: любой сдвиг —
    // красное, а не строка «известное».
    expect(behaviourFindings(DIAGNOSTIC_KINDS, MEASURED)).toEqual([]);
    const blocking = DIAGNOSTIC_KINDS.filter((e) => e.state === 'блокирующий')
      .map((e) => e.kind)
      .sort();
    const refuses = Object.entries(MEASURED)
      .filter(([, m]) => !m.builds)
      .map(([kind]) => kind)
      .sort();
    expect(blocking, 'блокирующие виды обязаны совпасть с видами, где сборка не проходит').toEqual(
      refuses,
    );
  });

  it('поле buildRefused пусто у всех: расхождений «состояние против сборки» нет', () => {
    // Поле — имя расхождения, а не украшение: заполнено ⟺ «сборка не проходит, а
    // вид не блокирующий». Проверка выведена из таблицы, поэтому краснеют обе
    // стороны — расхождение без записи и запись без расхождения.
    const wrong: string[] = [];
    for (const entry of DIAGNOSTIC_KINDS) {
      const measured = MEASURED[entry.kind];
      const diverges = measured !== undefined && !measured.builds && entry.state !== 'блокирующий';
      const filled = typeof entry.buildRefused === 'string' && entry.buildRefused.trim() !== '';
      if (diverges !== filled) {
        wrong.push(
          `${entry.kind}: buildRefused ${filled ? 'заполнен' : 'пуст'}, а расхождение ` +
            (diverges ? 'есть' : 'отсутствует'),
        );
      }
    }
    expect(wrong, `buildRefused не там, где нужно:\n  ${wrong.join('\n  ')}`).toEqual([]);
    // И именно поэтому поле пусто: два прежних его носителя
    // (`break_outside_loop`, `continue_outside_loop`) переведены в блокирующие —
    // замер судьбы сборки и классификация сходятся.
    const filled = DIAGNOSTIC_KINDS.filter((e) => e.buildRefused !== undefined).map((e) => e.kind);
    expect(filled, 'виды с названным расхождением').toEqual([]);
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

  it('chained_compare недостижим: цепочка — сахар парсера, законное сравнение собирается', () => {
    // Прежде эта проверка закрепляла ИНВЕРСИЮ: «настоящая цепочка молчит, а
    // ложное срабатывание названо». Замер 2026-09-28 показал, что названное —
    // это и был весь эффект проверки: цепочку разворачивает парсер (канон §2.1),
    // а вид бил по законной программе. Проверка снята, вид объявлен недостижимым,
    // и здесь закреплено ИМЕННО ЭТО:
    //
    // (1) площадки в семантике нет — скан исходника, а не мнение;
    // (2) законная программа `(1 < 2) = истина` собирается БЕЗ диагностик
    //     (была ложная ошибка — стала тишина, и это правильная тишина);
    // (3) цепочка собирается и считается — число меряется на VM в независимом
    //     аудите (`src/scripts/errorChannel.audit.test.ts`), потому что здесь
    //     проверяется каталог, а не арифметика.
    expect(PRODUCED, 'chained_compare снова порождается семантикой').not.toContain(
      'chained_compare',
    );
    const legal = compileSource(
      wrap('  если (1 < 2) = истина тогда\n    вернуть 1\n  конец\n  вернуть 0'),
      { filename: 'скобки.osnova' },
    );
    expect(legal.semanticErrors, 'сравнение результата сравнения с `истина` — законная программа').toEqual(
      [],
    );
    expect(compileToBuildReport(legal).success, 'законная программа обязана собираться').toBe(true);
    const chain = compileSource(wrap('  пусть б = 1 < 2 < 3\n  вернуть б'), {
      filename: 'цепочка.osnova',
    });
    expect(chain.semanticErrors, 'цепочка — сахар канона §2.1, а не ошибка').toEqual([]);
    expect(compileToBuildReport(chain).success, 'цепочка обязана собираться').toBe(true);
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
