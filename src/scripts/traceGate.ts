/**
 * ГЕЙТ «ТРАССА ДО ПРАВКИ»: PR БЕЗ §2 «ТРАССА» НЕ ПРИНИМАЕТСЯ.
 *
 * # Дефект, ради которого это написано
 *
 * Правило «сначала трасса, потом правка» в проекте **было записано** и **не имело гейта**.
 * Измерено по реестру проверяемости, три случая одного класса:
 *
 * | случай | что произошло без трассы | цена |
 * |---|---|---|
 * | **98** | на **одно** сравнение (`<` → `<=`) ушло **две** сессии: первая искала дефект в вызываемой, дефект был в пересылках сайта вызова | двое суток поиска не там |
 * | **103** | код **136** приписали упаковке, а причина была в **раскладке** | ложный диагноз в реестре |
 * | круги **10–22** | **три** круга искали **несуществующее** зацикливание | три круга |
 *
 * Это не три случайности, а **структурный** срыв: пока трасса — соглашение, её пропускают
 * ровно там, где она дороже всего, то есть на трудном дефекте. Гейт делает её **условием
 * приёмки**, а не пожеланием.
 *
 * # Почему это гейт, а не «ещё одна форма»
 *
 * Сторож без красной стороны — украшение (правило из случая 8). Поэтому здесь две стороны,
 * и обе проверяются оракулом `traceGate.audit.test.ts`:
 *
 * | сторона | что обязано быть |
 * |---|---|
 * | **тело PR** | раздел `## Трасса`, в нём **заполненные** `diff эталон vs факт` и класс `A/B/C/D` |
 * | **шаблон** | тот же раздел, иначе тело рождается без него и гейт ловит всех, кроме причины |
 *
 * # Ловушка, ради которой проверяется ЗАПОЛНЕННОСТЬ, а не наличие
 *
 * Шаблон, взятый целиком и не заполненный, содержит `## Трасса` — и «проверка наличия» пропустила
 * бы его как пройденный. Это ровно случай 30 реестра: наблюдатель не различает вход, и «проходит»
 * читается как проверка. Поэтому значение после `diff эталон vs факт:` сверяется с **заглушкой
 * шаблона** побайтово: не заполнил — красное, а не зелёное.
 *
 * # Откуда берётся тело PR (и почему не всегда)
 *
 * | источник | когда есть | что это |
 * |---|---|---|
 * | `GITHUB_EVENT_PATH` → `pull_request.body` | прогон на событии `pull_request` | **настоящий гейт**: тело PR у CI уже в руках |
 * | `TRACE_PR` → `gh pr view <N> --json body` | локальная проверка перед пушем | то же тело, но по сети |
 * | нет ничего | `push` в `feat/**`, локальный прогон без PR | тела нет — и это **названо**, а не выдано за «прошло» |
 *
 * Третий случай не даёт зелёного «гейт пройден»: он даёт вердикт `не применимо`, и шаблон при этом
 * всё равно проверяется — потому что шаблон и есть то, из чего рождается тело.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Шапка раздела. Хвост в скобках допускается: шаблон пишет пояснение. */
export const TRACE_HEADING = '## Трасса';

/** Шаблон, из которого рождается тело PR. */
export const TEMPLATE_PATH = path.join('.github', 'pull_request_template.md');

/** Что значит «трассы нет» — текст отказа, он же код поиска. */
export const TRACE_GATE_CODE = 'OSN-GATE-TRACE';

/** Классы трассы. `D` — «не применимо», и он допускается только для docs/infra. */
export const TRACE_CLASSES = ['A', 'B', 'C', 'D'] as const;

export type TraceClass = (typeof TRACE_CLASSES)[number];

/** Что именно нашлось в теле — для отчёта, а не для гадания. */
export interface TraceAudit {
  /** Раздел `## Трасса` найден. */
  readonly present: boolean;
  /** Выбранный класс, если назван и распознан. */
  readonly klass: TraceClass | null;
  /** Значение `diff эталон vs факт` как оно записано (для цитаты в отказе). */
  readonly diff: string | null;
  /** Нарушения. Пусто — трасса есть и заполнена. */
  readonly problems: readonly string[];
}

/** Поля раздела, которые обязаны быть заполнены. */
const DIFF_LABEL = 'diff эталон vs факт';
const CLASS_LABEL = 'Класс';

/**
 * Тело раздела `## Трасса` — от заголовка до следующего заголовка того же уровня или выше.
 *
 * Возвращает `null`, если раздела нет вовсе. Уровень сравнивается: `###` внутри раздела
 * разделом не обрывается, а `##` — обрывает.
 */
export function traceSectionOf(body: string): string | null {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => headingLevel(line) === 2 && isTraceHeading(line));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const level = headingLevel(lines[i]!);
    if (level !== null && level <= 2) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n');
}

function isTraceHeading(line: string): boolean {
  return line.trim().toLowerCase().startsWith(TRACE_HEADING.toLowerCase());
}

function headingLevel(line: string): number | null {
  const match = /^(#{1,6})\s/.exec(line);
  return match ? match[1]!.length : null;
}

/**
 * Значение поля раздела: текст после `label`, включая ли `:` и `**`.
 *
 * Метка ищется по вхождению (она может стоять в списке, в жирном, в чекбоксе), а не по позиции:
 * форматирование шаблона — не предмет проверки, а её содержимое — предмет. Обратные кавычки
 * снимаются с обеих сторон сравнения: шаблон пишет `` `diff` эталон vs факт ``, и строгий поиск
 * метки без них не нашёл бы её вовсе — то есть сторож ловил бы **все** PR, включая правильные.
 */
export function fieldValue(section: string, label: string): string | null {
  const needle = label.toLowerCase().replace(/`/g, '');
  for (const line of section.split(/\r?\n/)) {
    const flat = line.replace(/`/g, '');
    const at = flat.toLowerCase().indexOf(needle);
    if (at < 0) continue;
    let rest = flat.slice(at + needle.length);
    // Снять разделители метки: `**`, `:`, `—`, `→`.
    rest = rest.replace(/^[\s*:—–-]+/, '');
    rest = rest.replace(/\*\*/g, '').trim();
    return rest;
  }
  return null;
}

/**
 * Класс из значения поля: первая буква `A`–`D` вне скобок и списков.
 *
 * Принимается и `B`, и `(B) продвижение`, и `выбран: D — docs/infra`: класс — это одна буква,
 * остальное пояснение к ней. Принимается только буква из списка: иначе `A/B/C/D` из пояснения
 * шаблона читалось бы как выбор.
 */
export function classOf(value: string | null): TraceClass | null {
  if (value === null) return null;
  // Заглушка шаблона перечисляет все классы — это не выбор.
  if (looksLikePlaceholder(value)) return null;
  const match = /(?:^|[\s(])?([ABCD])(?:[)\s.,;:—-]|$)/.exec(value);
  if (!match) return null;
  const letter = match[1] as TraceClass;
  return TRACE_CLASSES.includes(letter) ? letter : null;
}

/**
 * Заглушка ли это — то есть шаблон, взятый как есть.
 *
 * Признаки названы, а не угаданы: пустое значение, `<…>` из шаблона, `___`, `[цитата]`, и
 * перечисление классов через `/` (в шаблоне стоит `(A) запись / (B) продвижение / …`).
 */
export function looksLikePlaceholder(value: string): boolean {
  const text = value.trim();
  if (text.length === 0) return true;
  if (/^_+$/.test(text)) return true;
  if (/^<.*>$/.test(text)) return true;
  if (/^\[[^\]]*\]$/.test(text)) return true;
  // Перечисление всех четырёх классов подряд — это текст шаблона, а не выбор.
  const letters = text.match(/\b[ABCD]\b/g) ?? [];
  if (letters.length >= 3 && /\//.test(text)) return true;
  return false;
}

/** Минимальная длина цитаты трассы: `diff` в одну букву трассой не является. */
export const MIN_DIFF_LENGTH = 15;

/**
 * Проверка одного тела PR. Чистая: ни файлов, ни сети — поэтому её и проверяет оракул.
 */
export function auditTraceBody(body: string): TraceAudit {
  const section = traceSectionOf(body);
  if (section === null) {
    return {
      present: false,
      klass: null,
      diff: null,
      problems: [`${TRACE_GATE_CODE}: PR без §2 «Трасса» не принимается (случай 98).`],
    };
  }

  const problems: string[] = [];
  const rawDiff = fieldValue(section, DIFF_LABEL);
  const klass = classOf(fieldValue(section, CLASS_LABEL));

  if (rawDiff === null) {
    problems.push(
      `${TRACE_GATE_CODE}: в §2 «Трасса» нет строки «${DIFF_LABEL}» — без неё трасса не трасса ` +
        `(случай 103: код 136 приписали упаковке, причина была в раскладке).`,
    );
  } else if (looksLikePlaceholder(rawDiff)) {
    problems.push(
      `${TRACE_GATE_CODE}: «${DIFF_LABEL}» оставлен заглушкой «${rawDiff}» — шаблон взят как есть, ` +
        `трассы нет (случай 30: наличие раздела ≠ заполненный раздел).`,
    );
  } else if (rawDiff.length < MIN_DIFF_LENGTH) {
    problems.push(
      `${TRACE_GATE_CODE}: «${DIFF_LABEL}» короче ${MIN_DIFF_LENGTH} символов («${rawDiff}») — ` +
        `цитаты эталона и факта здесь нет.`,
    );
  }

  if (klass === null) {
    const raw = fieldValue(section, CLASS_LABEL);
    problems.push(
      `${TRACE_GATE_CODE}: класс трассы не назван (нужен A — запись, B — продвижение, ` +
        `C — пропуск, D — не применимо для docs/infra). Записано: ${raw === null ? 'ничего' : `«${raw}»`}.`,
    );
  }

  return { present: true, klass, diff: rawDiff, problems };
}

/** Чем кончилась проверка шаблона. */
export interface TemplateAudit {
  /** Шаблон прочитан. */
  readonly present: boolean;
  /** Тот же разбор, что и у тела PR: шаблон обязан быть валиден по той же функции. */
  readonly audit: TraceAudit | null;
  readonly problems: readonly string[];
}

/**
 * Проверка шаблона.
 *
 * Шаблон проверяется **той же** функцией {@link auditTraceBody}, но с послаблением: `diff` и класс
 * в шаблоне обязаны быть **заглушками** — иначе PR родится с «трассой» из шаблона, и гейт её
 * пропустит. То есть у шаблона проверяется обратное: раздел есть, а трассы в нём нет.
 */
export function auditTemplate(text: string): TemplateAudit {
  const section = traceSectionOf(text);
  if (section === null) {
    return {
      present: false,
      audit: null,
      problems: [
        `${TRACE_GATE_CODE}: в шаблоне PR нет раздела «${TRACE_HEADING}» — тело PR рождается без ` +
          `трассы, и гейт ловит всех, кроме причины.`,
      ],
    };
  }

  const problems: string[] = [];
  const rawDiff = fieldValue(section, DIFF_LABEL);
  if (rawDiff === null) {
    problems.push(`${TRACE_GATE_CODE}: в шаблоне PR нет строки «${DIFF_LABEL}».`);
  } else if (!looksLikePlaceholder(rawDiff)) {
    problems.push(
      `${TRACE_GATE_CODE}: в шаблоне «${DIFF_LABEL}» уже заполнен («${rawDiff}») — PR пройдёт гейт, ` +
        `ничего не написав. В шаблоне обязан стоять заполнитель.`,
    );
  }
  if (!section.toLowerCase().includes('класс')) {
    problems.push(`${TRACE_GATE_CODE}: в шаблоне нет строки про класс трассы (A/B/C/D).`);
  }
  // Предупреждение о цене пропуска — часть шаблона: она объясняет, зачем это заполнять.
  if (!/не принимается/i.test(section)) {
    problems.push(
      `${TRACE_GATE_CODE}: в шаблоне не сказано, что без трассы PR не принимается — правило без ` +
        `цены не читают.`,
    );
  }

  return { present: true, audit: auditTraceBody(text), problems };
}

/**
 * Тело PR из окружения — если прогон идёт на событии `pull_request`.
 *
 * Это **единственный** путь, дающий настоящий гейт без сети: GitHub кладёт тело PR в файл события,
 * и CI уже имеет к нему доступ — ни токена, ни `gh`, ни прав.
 */
export function eventBody(pathToEvent = process.env.GITHUB_EVENT_PATH): string | null {
  if (!pathToEvent || !fs.existsSync(pathToEvent)) return null;
  try {
    const event = JSON.parse(fs.readFileSync(pathToEvent, 'utf8')) as {
      pull_request?: { body?: string | null };
    };
    const body = event.pull_request?.body;
    return typeof body === 'string' ? body : null;
  } catch {
    return null;
  }
}

/**
 * Тело PR по номеру через `gh` — для локальной проверки перед пушем.
 *
 * Отсутствие `gh` или незалогиненность — **не** «трасса есть»: возвращается `null`, и вызывающий
 * обязан назвать это «не проверено», а не «прошло».
 */
export function bodyOfPullRequest(prNumber: number): string | null {
  try {
    const out = execFileSync('gh', ['pr', 'view', String(prNumber), '--json', 'body'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(out) as { body?: string | null };
    return typeof parsed.body === 'string' ? parsed.body : null;
  } catch {
    return null;
  }
}

/**
 * Гейт целиком: шаблон всегда, тело — если оно есть.
 *
 * Возвращает вердикт с **названным** источником тела. `source: 'нет'` — это не «прошло»,
 * и в отчёте так и пишется.
 */
export interface GateVerdict {
  readonly templateProblems: readonly string[];
  readonly body: {
    readonly source: 'event' | 'gh' | 'нет';
    readonly problems: readonly string[];
  };
  readonly ok: boolean;
}

export function runTraceGate(options: {
  readonly root?: string;
  readonly prNumber?: number | null;
  readonly eventPath?: string | null;
} = {}): GateVerdict {
  const root = options.root ?? path.resolve(__dirname, '..', '..');
  const templateFile = path.join(root, TEMPLATE_PATH);
  const templateText = fs.existsSync(templateFile) ? fs.readFileSync(templateFile, 'utf8') : '';
  const templateProblems = templateText
    ? auditTemplate(templateText).problems
    : [`${TRACE_GATE_CODE}: шаблон PR не найден: ${TEMPLATE_PATH}`];

  let bodyText: string | null = null;
  let source: 'event' | 'gh' | 'нет' = 'нет';
  const fromEvent = eventBody(options.eventPath ?? process.env.GITHUB_EVENT_PATH);
  if (fromEvent !== null) {
    bodyText = fromEvent;
    source = 'event';
  } else if (options.prNumber) {
    const fetched = bodyOfPullRequest(options.prNumber);
    if (fetched !== null) {
      bodyText = fetched;
      source = 'gh';
    }
  }

  const bodyProblems = bodyText === null ? [] : auditTraceBody(bodyText).problems;
  return {
    templateProblems,
    body: { source, problems: bodyProblems },
    ok: templateProblems.length === 0 && bodyProblems.length === 0,
  };
}
