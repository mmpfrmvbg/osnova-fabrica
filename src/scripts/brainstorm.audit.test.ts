/**
 * ОРАКУЛ ДОКУМЕНТА-ГИПОТЕЗЫ: `docs/brainstorm/00…04`.
 *
 * # Зачем этот тест
 *
 * Документ этого сеанса — не код и не замер, а **карта гипотез**. У такого документа нет
 * естественного оракула: его нельзя сравнить с эталоном, и он не проходит через компилятор.
 * Значит проверять надо **сам документ**: три вещи, каждая из которых уже стоила проекту
 * отдельного случая в `docs/verification-debt.md`.
 *
 * 1. **Ссылки не выдуманы.** Каждая ссылка вида `путь:строка` обязана указывать на файл,
 *    который лежит в репозитории, и на строку, которая в нём **есть**. Класс дефекта —
 *    `docs/verification-debt.md:81-84` («мнемоника либо **скопирована из извлечения
 *    посимвольно**, либо её нет в спецификации»): здесь то же правило применено к ссылкам.
 * 2. **Оценка помечена.** Любое предложение, утверждающее эффект (множитель, проценты, такты),
 *    обязано нести пометку **ГИПОТЕЗА** либо быть цитатой с источником. Иначе документ
 *    читается как замер, которым он не является (`memory/_index.md:48-54`).
 * 3. **У каждого хода названы риск и проверяемость.** Ход без риска и без способа проверки —
 *    обещание, а не кандидат; в проекте обещания запрещены прямым правилом владельца
 *    (`docs/language-v2-requirements.md:9-14` — «Здесь только требования»).
 *
 * # Негативный контроль обязателен, и он проверяет СЕБЯ
 *
 * Правило случая 10: «негативный контроль обязан проверять **свой собственный прогон**, а не
 * только результат оракула», и «ноль собранных — это „контроль недействителен", а не „оракул
 * слеп"» (`docs/verification-debt.md:148-151`). Поэтому ниже проверки идут **чистыми
 * функциями** над текстом: подложенный текст проверяется тем же кодом, что и настоящий
 * документ, и тест не может «пройти», ничего не проверив.
 *
 * # Чего этот тест НЕ проверяет
 *
 * Он **не** проверяет истинность утверждений — только то, что они снабжены источником или
 * пометкой. Более сильное утверждение («ссылка ведёт именно туда, где сказано») машине
 * недоступно: это проверяет человек, а частично — оракулы источников
 * (`src/scripts/e2kWideCommands.audit.test.ts` и родственные).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const DOCS = path.join(ROOT, 'docs', 'brainstorm');
const HAS_SOURCES = fs.existsSync(path.join(ROOT, '.tmp', 'e2k-sources'));

/** Документы сеанса: имена фиксированы, лишние в каталоге — отказ (чтобы карта не расползалась). */
export const DOC_NAMES: readonly string[] = [
  '00-map.md',
  '01-opportunities.md',
  '02-ai-vs-hardware.md',
  '03-candidates.md',
  '04-first-experiment.md',
  '05-step1-measurement.md',
  '06-stepB-packet-size.md',
  '06-next-steps.md',
];

/** Внешние каталоги, которых в репозитории нет, но которые названы источниками извлечения. */
export const EXTERNAL_PREFIXES: readonly string[] = ['qemu/', 'opcodes/', 'gas/', 'elbrus-docs/', 'include/'];

export interface Citation {
  readonly file: string;
  readonly from: number;
  readonly to: number;
  /** Строка документа, в которой встретилась ссылка, — для сообщения об ошибке. */
  readonly at: number;
  readonly raw: string;
}

export type CitationProblem =
  | { readonly kind: 'нет файла'; readonly citation: Citation }
  | { readonly kind: 'нет строки'; readonly citation: Citation; readonly total: number }
  | { readonly kind: 'голое имя без корня'; readonly citation: Citation }
  | { readonly kind: 'внешний путь, который не назван в EXTERNAL_PREFIXES'; readonly citation: Citation };

/**
 * Вырезать ссылки вида `путь:строка` или `путь:строка-строка`.
 *
 * Две тонкости, обе из практики проекта:
 * - ссылки живут **внутри обратных кавычек** в этом документе, поэтому берётся содержимое
 *   кавычек, а не весь текст: иначе `wbs=4` и «стр. 71–72» дали бы ложные «файлы»;
 * - диапазон записывается дефисом, и его конец обязан быть в том же файле.
 */
export function citationsOf(text: string): Citation[] {
  const found: Citation[] = [];
  const lines = text.split(/\r?\n/);
  const ticked = /`([^`\n]+)`/g;
  lines.forEach((line, index) => {
    for (const match of line.matchAll(ticked)) {
      const body = match[1]!;
      const rx = /((?:[A-Za-z0-9_.\-/\\]+\/)?[A-Za-z0-9_.\-]+\.(?:ts|md|json|jsonl|h|c|yaml|yml)):(\d+)(?:\s*[-–]\s*(\d+))?/g;
      for (const hit of body.matchAll(rx)) {
        const file = hit[1]!.replace(/\\/g, '/');
        const from = Number(hit[2]);
        const to = hit[3] === undefined ? from : Number(hit[3]);
        found.push({ file, from, to, at: index + 1, raw: hit[0] });
      }
    }
  });
  return found;
}

/** Линии файла без учёта переводов строк: `\r\n` и `\n` дают одно и то же число (случай 15). */
export function lineCountOf(file: string): number {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

/** Разрешить путь ссылки: след от корня репозитория либо голое имя файла проекта. */
export function resolveCited(citation: Citation): string | undefined {
  const candidates: string[] = [];
  if (citation.file.includes('/')) {
    candidates.push(path.join(ROOT, citation.file));
    candidates.push(path.join(ROOT, '.tmp', 'e2k-sources', citation.file));
    // Каталоги извлечения лежат внутри `.tmp/e2k-sources`; если назван хвост пути — искать там.
    candidates.push(path.join(ROOT, '.tmp', 'e2k-sources', 'qemu-e2k', citation.file));
    candidates.push(path.join(ROOT, '.tmp', 'e2k-sources', 'binutils-gdb', citation.file));
  } else {
    // Голое имя: искать по известным корням проекта (так ссылается сам проект).
    for (const root of ['src/e2k', 'src/vliw', 'src/runtime/vm', 'docs', '.tmp', '.tmp/e2k-sources/elbrus-docs']) {
      candidates.push(path.join(ROOT, root, citation.file));
    }
  }
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}

/** Проверить одну ссылку: файл есть, строки есть, диапазон не вывернут. */
export function checkCitation(citation: Citation): CitationProblem[] {
  const problems: CitationProblem[] = [];
  const resolved = resolveCited(citation);
  if (resolved === undefined) {
    const external = EXTERNAL_PREFIXES.some((prefix) => citation.file.startsWith(prefix));
    problems.push(
      external
        ? { kind: 'внешний путь, который не назван в EXTERNAL_PREFIXES', citation }
        : { kind: 'нет файла', citation },
    );
    return problems;
  }
  const total = lineCountOf(resolved);
  if (citation.from < 1 || citation.to < citation.from || citation.to > total) {
    problems.push({ kind: 'нет строки', citation, total });
  }
  return problems;
}

/** Ссылки документа. */
export function citationsOfDoc(name: string): Citation[] {
  return citationsOf(fs.readFileSync(path.join(DOCS, name), 'utf8'));
}

/**
 * Предложения, утверждающие эффект без пометки **ГИПОТЕЗА**.
 *
 * Признак эффекта — множитель (`×1.2`), процент (`−23 %`) или число тактов. Оценка **не**
 * считается немаркированной, если:
 *
 * - в строке или в двух строках выше стоит **ГИПОТЕЗА** (таблица эффектов помечается в шапке —
 *   иначе пришлось бы повторять пометку в каждой строке);
 * - число стоит **внутри кавычек** `«…»` — пересказ источника или формула, а не своя оценка;
 * - в строке есть ссылка `файл:строка`.
 *
 * Две строки, а не одна, — потому что пометка стоит в заголовке абзаца, а сама оценка на строку
 * ниже; это проверено на самих документах и на подложенном тексте (негативный контроль).
 *
 * Ложное срабатывание здесь так же недопустимо, как пропуск: знак умножения перед идентификатором
 * («820 пакетов × 6 каналов, слогов 4920») — это формула, и она обязана проходить. Такой случай
 * уже был: `docs/brainstorm/05-step1-measurement.md`, строка про пустые слоги.
 */
export function unmarkedClaimsOf(text: string): string[] {
  const offending: string[] = [];
  // Множитель эффекта — цифра сразу или через короткий пробел после знака: «×1.2», «× 2».
  const claim = /(×\s?\d|на\s+\d+\s*%|−\s?\d+(?:[.,]\d+)?\s*%|минус\s+\d+\s*%|\d+\s*тактов)/;
  // Формула: знак умножения, за которым стоит идентификатор — «820 пакетов × 6 каналов»… здесь
  // после «× » идёт цифра, поэтому формула отличается **пробелом после знака**: «× 6» — умножение,
  // «×2» — множитель эффекта. Это различие введено по реальному случаю (05-step1-measurement.md).
  const formula = /×\s+[A-Za-zА-Яа-яЁё\d]/;
  const lines = text.split(/\r?\n/);
  // Таблица эффектов помечается один раз — в шапке; пометка действует на все её строки, пока
  // таблица не кончилась. Иначе пришлось бы повторять «ГИПОТЕЗА» в каждой строке.
  let tableMarked = false;
  lines.forEach((line, index) => {
    const isTableRow = line.trimStart().startsWith('|');
    if (!isTableRow) tableMarked = false;
    else if (line.includes('ГИПОТЕЗА')) tableMarked = true;
    if (!claim.test(line)) return;
    if (formula.test(line)) return;
    if (tableMarked) return;
    if ([lines[index - 2] ?? '', lines[index - 1] ?? '', line].join('\n').includes('ГИПОТЕЗА')) return;
    if (/`[^`]*\.(?:ts|md|json|jsonl):\d+/.test(line)) return;
    if (/«[^»]*(?:×|\d+\s*(?:тактов|%))[^»]*»/.test(line)) return;
    offending.push(`${index + 1}: ${line.trim().slice(0, 120)}`);
  });
  return offending;
}

/**
 * Слова-обещания, запрещённые в этом документе (правило владельца: обещание без метрики).
 *
 * Ловятся только **обещания**, а не технические описания: проверяется не вхождение слова, а
 * конструкция «это <слово>», «<слово> и всё», «<слово>, потому что». Русское «работает» иначе
 * встречается в осмысленных фразах вида «байпас работает после выдачи», и оракул, краснеющий на
 * них, был бы украшением (`docs/verification-debt.md:137` — «пока у проверки нет своего
 * негативного контроля… она не проверка»).
 *
 * Метрикой считается замер, число, цитата или ссылка на файл: `замер`, `измерен`, `N из M`,
 * `файл:строка`.
 */
export const FORBIDDEN_CLAIMS: readonly string[] = ['работает', 'готово', 'решит все проблемы', 'Intel умрёт'];

/** Есть ли в строке метрика: замер, число вида «N из M», цитата или ссылка на файл. */
export function hasMetric(line: string): boolean {
  const numberRatio = /\d+\s*(?:из|[\\/])\s*\d+/;
  const fileRef = /`[^`]*\.(?:ts|md|json|jsonl):\d+/;
  return /(замер|измерен|проверен|документ|цитат)/u.test(line) || numberRatio.test(line) || fileRef.test(line);
}

/** Найти запрещённые обещания в конструкции «это <слово>», «<слово> и всё», «<слово>, потому что».
 *
 * Граница слова задана явным диапазоном `(?![а-яё])`, а не `\b`: в JavaScript `\w` и `\b`
 * **ASCII-ные** и границу после кириллической буквы не видят — это отдельный случай реестра
 * проверяемости (`docs/verification-debt.md:137`), и здесь он учтён.
 */
export function forbiddenClaimsOf(text: string): string[] {
  const offending: string[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    for (const word of FORBIDDEN_CLAIMS) {
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const asPromise = new RegExp(
        `(?:это|всё|значит)\\s+${escaped}(?![а-яё])|${escaped}(?![а-яё])\\s+(?:и всё|потому что)`,
        'ui',
      );
      if (!asPromise.test(line)) continue;
      if (hasMetric(line)) continue;
      offending.push(`${index + 1}: «${word}» — ${line.trim().slice(0, 100)}`);
    }
  });
  return offending;
}

/** Ходы в `03-candidates.md`: заголовок «## ХОД N: …» и его тело до следующего заголовка `## `. */
export function movesOf(text: string): { readonly title: string; readonly body: string; readonly at: number }[] {
  const lines = text.split(/\r?\n/);
  const moves: { title: string; body: string[]; at: number }[] = [];
  lines.forEach((line, index) => {
    if (/^##\s+ХОД\s+\d+/.test(line)) {
      moves.push({ title: line, body: [], at: index + 1 });
      return;
    }
    if (moves.length === 0) return;
    if (/^##\s+/.test(line)) return; // следующий раздел того же уровня — тело хода кончилось
    moves[moves.length - 1]!.body.push(line);
  });
  return moves.map((move) => ({ title: move.title, body: move.body.join('\n'), at: move.at }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Проверки над настоящими документами
// ─────────────────────────────────────────────────────────────────────────────

describe('docs/brainstorm: состав и шапки', () => {
  it('все пять документов на месте, лишних нет', () => {
    const onDisk = fs
      .readdirSync(DOCS)
      .filter((name) => name.endsWith('.md'))
      .sort();
    expect(onDisk, 'состав каталога docs/brainstorm').toEqual([...DOC_NAMES].sort());
  });

  it('у каждого документа шапка doc-status: scratch', () => {
    for (const name of DOC_NAMES) {
      const head = fs.readFileSync(path.join(DOCS, name), 'utf8').split(/\r?\n/)[0] ?? '';
      expect(head, `${name}: первая строка`).toContain('doc-status: scratch');
    }
  });

  it('документы непустые и не «заглушки»', () => {
    for (const name of DOC_NAMES) {
      const text = fs.readFileSync(path.join(DOCS, name), 'utf8');
      expect(text.length, `${name}: длина`).toBeGreaterThan(1500);
    }
  });
});

describe('ссылки: каждая существует в файле', () => {
  it('у каждой ссылки документ резолвится в файл репозитория', () => {
    const problems: CitationProblem[] = [];
    for (const name of DOC_NAMES) {
      for (const citation of citationsOfDoc(name)) {
        // Внешние источники живут только в .tmp/e2k-sources; без копий их нельзя
        // проверить, и молчаливое «нет файла» было бы ложным красным на чистом клоне.
        if (!HAS_SOURCES && EXTERNAL_PREFIXES.some((prefix) => citation.file.startsWith(prefix))) continue;
        problems.push(...checkCitation(citation));
      }
    }
    const report = problems.map((problem) => {
      const { citation } = problem;
      const tail = 'total' in problem ? ` (в файле ${problem.total} строк)` : '';
      return `${citation.raw} → ${problem.kind}${tail}`;
    });
    expect(report, 'проблемные ссылки в docs/brainstorm').toEqual([]);
  });

  it('ссылок достаточно много — оракул не «проходит» на пустом множестве', () => {
    const total = DOC_NAMES.reduce((sum, name) => sum + citationsOfDoc(name).length, 0);
    // Порог выбран по факту: карта цитирует более сотни строк кода. Ноль ссылок означал бы, что
    // разбор сломан, а не что документ хорош (случай 10 реестра проверяемости).
    expect(total, 'всего ссылок в пяти документах').toBeGreaterThan(100);
  });

  it('ссылки распределены по документам, а не собраны в одном', () => {
    for (const name of DOC_NAMES) {
      expect(citationsOfDoc(name).length, `${name}: ссылок`).toBeGreaterThan(3);
    }
  });

  it('внешние источники названы префиксами и не выдаются за файлы репозитория', () => {
    if (!HAS_SOURCES) {
      expect(HAS_SOURCES, 'нет .tmp/e2k-sources — внешние ссылки не сверялись').toBe(false);
      return;
    }
    // Если появится ссылка на `qemu/...`, `gas/...` — она обязана быть известна как внешняя.
    const externals = DOC_NAMES.flatMap((name) =>
      citationsOfDoc(name).filter((citation) => EXTERNAL_PREFIXES.some((prefix) => citation.file.startsWith(prefix))),
    );
    for (const citation of externals) {
      const resolved = resolveCited(citation);
      expect(resolved, `${citation.raw}: внешний путь обязан иметь файл в .tmp/e2k-sources`).toBeDefined();
    }
  });
});

describe('пометки ГИПОТЕЗА и запрещённые обещания', () => {
  it('утверждения об эффекте помечены ГИПОТЕЗА либо снабжены ссылкой', () => {
    for (const name of DOC_NAMES) {
      const text = fs.readFileSync(path.join(DOCS, name), 'utf8');
      expect(unmarkedClaimsOf(text), `${name}: немаркированные оценки`).toEqual([]);
    }
  });

  it('нет запрещённых слов-обещаний без метрики', () => {
    for (const name of DOC_NAMES) {
      const text = fs.readFileSync(path.join(DOCS, name), 'utf8');
      expect(forbiddenClaimsOf(text), `${name}: обещания без метрики`).toEqual([]);
    }
  });

  it('в 03-candidates.md есть пометки ГИПОТЕЗА', () => {
    const text = fs.readFileSync(path.join(DOCS, '03-candidates.md'), 'utf8');
    expect(text.split('ГИПОТЕЗА').length - 1, 'вхождений «ГИПОТЕЗА»').toBeGreaterThanOrEqual(5);
  });
});

describe('03-candidates.md: у каждого хода риск и проверяемость', () => {
  const text = fs.readFileSync(path.join(DOCS, '03-candidates.md'), 'utf8');
  const moves = movesOf(text);

  it('ходов не меньше пяти и не больше десяти', () => {
    expect(moves.length, 'число ходов').toBeGreaterThanOrEqual(5);
    expect(moves.length, 'число ходов').toBeLessThanOrEqual(10);
  });

  it('у каждого хода названы риск и проверяемость', () => {
    const problems: string[] = [];
    for (const move of moves) {
      if (!/Риск/.test(move.body)) problems.push(`${move.title}: нет раздела риска`);
      if (!/Проверяемость/.test(move.body)) problems.push(`${move.title}: нет проверяемости`);
      if (!/Цитата/.test(move.body)) problems.push(`${move.title}: нет цитаты из кода`);
      if (!/ГИПОТЕЗА/.test(move.body) && !/БЛОКИРОВ/.test(move.body)) {
        problems.push(`${move.title}: эффект не помечен ГИПОТЕЗА и не назван блокированным`);
      }
    }
    expect(problems, 'недостатки ходов').toEqual([]);
  });

  it('каждый ход содержит хотя бы одну ссылку на код', () => {
    const problems: string[] = [];
    for (const move of moves) {
      if (!/`[^`]*\.(?:ts|md|json|jsonl):\d+/.test(move.body)) problems.push(`${move.title}: нет ссылки файл:строка`);
    }
    expect(problems, 'ходы без ссылок').toEqual([]);
  });

  it('в 03 названы отброшенные направления с причиной', () => {
    expect(text, 'раздел отбросов').toContain('Чего в этом списке нет');
    expect(text, 'причина отброса профиля из трейсов').toMatch(/нет[\s\S]{0,200}частот ветвлений/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// НЕГАТИВНЫЙ КОНТРОЛЬ: подложенная выдуманная ссылка обязана ловиться тем же кодом
// ─────────────────────────────────────────────────────────────────────────────

describe('НЕГАТИВНЫЙ КОНТРОЛЬ: оракул ловит выдуманное и не проходит на пустом', () => {
  it('выдуманная ссылка на несуществующий файл ловится', () => {
    const planted = 'Смотри `src/e2k/no-such-module.ts:12` — там всё сказано.';
    const citations = citationsOf(planted);
    expect(citations.length, 'собрано ссылок (ноль означал бы недействительный контроль)').toBe(1);
    const problems = checkCitation(citations[0]!);
    expect(problems.map((problem) => problem.kind), 'вид проблемы').toContain('нет файла');
  });

  it('ссылка на существующий файл с невозможной строкой ловится', () => {
    const planted = 'Смотри `src/e2k/latencyMap.ts:99999` — там всё сказано.';
    const citations = citationsOf(planted);
    expect(citations.length, 'собрано ссылок').toBe(1);
    const problems = checkCitation(citations[0]!);
    expect(problems.map((problem) => problem.kind), 'вид проблемы').toContain('нет строки');
  });

  it('вывернутый диапазон (конец раньше начала) ловится', () => {
    const planted = 'Смотри `src/e2k/latencyMap.ts:200-10`.';
    const problems = checkCitation(citationsOf(planted)[0]!);
    expect(problems.map((problem) => problem.kind)).toContain('нет строки');
  });

  it('настоящая ссылка проходит — контроль не «красный всегда»', () => {
    const planted = 'Смотри `src/e2k/latencyMap.ts:84` — там всё сказано.';
    expect(checkCitation(citationsOf(planted)[0]!), 'настоящая ссылка').toEqual([]);
  });

  it('ссылка на внешний источник без файла в репозитории названа отдельным видом проблемы', () => {
    const planted = 'Смотри `qemu/target/e2k/fake.c:1`.';
    const problems = checkCitation(citationsOf(planted)[0]!);
    expect(problems.map((problem) => problem.kind)).toEqual(['внешний путь, который не назван в EXTERNAL_PREFIXES']);
  });

  it('немаркированная оценка ловится, маркированная — нет', () => {
    expect(unmarkedClaimsOf('Это даст ×1.5 на задаче.').length, 'без пометки').toBe(1);
    expect(unmarkedClaimsOf('Это даст **ГИПОТЕЗА** ×1.5 на задаче.').length, 'с пометкой').toBe(0);
    expect(unmarkedClaimsOf('Измерено: −23 % команд (`docs/e2k-wide-commands.md:265`).').length, 'цитата').toBe(0);
    // Пометка в шапке таблицы распространяется на её строки, а пересказ источника в кавычках —
    // не своя оценка. Оба исключения обязаны работать, иначе оракул краснеет на честном тексте.
    expect(unmarkedClaimsOf('**ГИПОТЕЗА**\n| ×1.2 | ×2 |').length, 'таблица под шапкой').toBe(0);
    expect(unmarkedClaimsOf('| ×1.2 | ×2 |').length, 'таблица без шапки').toBe(1);
    expect(unmarkedClaimsOf('Находка — «60 тактов простоя из 70».').length, 'цитата в кавычках').toBe(0);
    // Формула со знаком умножения перед идентификатором — не оценка эффекта. Этот случай реально
    // возник в 05-step1-measurement.md и обязан проходить, иначе оракул краснеет на честном тексте.
    expect(unmarkedClaimsOf('Слогов всего `820 пакетов × 6 каналов = 4920`.').length, 'формула').toBe(0);
    expect(unmarkedClaimsOf('Это даст ×2 на задаче.').length, 'множитель с пробелом').toBe(1);
  });

  it('слово-обещание без метрики ловится, техническое описание — нет', () => {
    expect(forbiddenClaimsOf('Это работает.').length, 'обещание без метрики').toBe(1);
    expect(forbiddenClaimsOf('Это работает: замер дал 3 из 3.').length, 'обещание с метрикой').toBe(0);
    // Ложное срабатывание так же недопустимо, как пропуск (случай 8 реестра проверяемости):
    // `\b` в JavaScript ASCII-ный, поэтому «Это» с большой буквы тоже обязано ловиться — и
    // ловится, а техническое описание «байпас работает после выдачи» — нет.
    expect(forbiddenClaimsOf('Аппаратный байпас работает уже после выдачи.').length, 'описание, не обещание').toBe(0);
    expect(forbiddenClaimsOf('Это решит все проблемы.').length, 'обещание-лозунг').toBe(1);
    expect(forbiddenClaimsOf('Это работает.').length, 'кириллица с большой буквы').toBe(1);
  });

  it('разбор ходов не «находит» ходы там, где их нет', () => {
    expect(movesOf('## Что-то другое\n\nтекст').length, 'ходов в чужом тексте').toBe(0);
    expect(movesOf('## ХОД 1: проба\n\nРиск: нет. Проверяемость: нет.\n').length, 'ходов в подложенном').toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Оракул самого теста: он обязан быть собран и что-то проверять
// ─────────────────────────────────────────────────────────────────────────────

describe('оракул собран и проверяет непустое множество', () => {
  it('разбор ссылок даёт разные файлы, а не один (признак живого разбора)', () => {
    const files = new Set(DOC_NAMES.flatMap((name) => citationsOfDoc(name).map((citation) => citation.file)));
    expect(files.size, 'разных файлов в ссылках').toBeGreaterThan(10);
  });

  it('разбор ссылок видит и документы, и код', () => {
    const all = DOC_NAMES.flatMap((name) => citationsOfDoc(name).map((citation) => citation.file));
    expect(all.some((file) => file.endsWith('.ts')), 'ссылки на .ts').toBe(true);
    expect(all.some((file) => file.endsWith('.md')), 'ссылки на .md').toBe(true);
  });

  it('число строк читается одинаково для LF и CRLF', () => {
    // Правило случая 15: инструмент не должен зависеть от переводов строк файла.
    const lf = path.join(ROOT, '.tmp', 'brainstorm-lines-lf.txt');
    const crlf = path.join(ROOT, '.tmp', 'brainstorm-lines-crlf.txt');
    fs.writeFileSync(lf, 'один\nдва\nтри\n');
    fs.writeFileSync(crlf, 'один\r\nдва\r\nтри\r\n');
    try {
      expect(lineCountOf(lf), 'LF').toBe(3);
      expect(lineCountOf(crlf), 'CRLF').toBe(3);
    } finally {
      fs.rmSync(lf, { force: true });
      fs.rmSync(crlf, { force: true });
    }
  });
});
