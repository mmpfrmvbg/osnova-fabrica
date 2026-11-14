/**
 * СТОРОЖ ЗОНДА D12: проба блока рантайма массивов против системного вызова — В РЕПОЗИТОРИИ.
 *
 * # Дефект, из-за которого это написано
 *
 * §3.187 реестра железа: полный лексер на живой E8C2 дал код 0, sha256 совпал, stderr пуст — и
 * **число неверное**. Вывод начинался `342, 342, 6, 1, …` вместо `342, 6, 1, 1087, …`: второй
 * элемент подменялся длиной списка, последний терялся. Ни отказа, ни следа — тихая ложь (класс
 * случая 23 реестра проверяемости).
 *
 * Механизм установил ПРЯМОЙ ЗОНД (§3.187.1): рантайм массивов держал `0`/`1`/`8`/адрес кучи в
 * клетках `%b[12..15]` плоскости точки входа, а сайт печати делает `call %ctpr1, wbs = 0x4` —
 * сдвиг окна на `2·4 = 8` регистров, поэтому это `%b[4..7]` ВЫЗЫВАЕМОГО. Ядро их занимает.
 *
 * **Модель этого закона не воспроизводит.** Поэтому 228 файлов прогона были зелёными, а цель
 * падала (случай 52). Знание об этом живёт ровно в одном месте — этом зонде. Если зонд не в
 * репозитории, а в `.tmp` (а `.tmp` в git не входит), то единственный прибор, РАЗЛИЧАЮЩИЙ модель и
 * цель, существует до первой уборки временных файлов.
 *
 * # Что проверяет сторож — три вещи, и каждая может покраснеть
 *
 * | что | как | что значит красное |
 * |---|---|---|
 * | **проба на месте** | пять `.s` и отчёт лежат в `tools/e2k-hardware/probes/d12-window/` | прибор потерян, дефект снова невидим |
 * | **проба непротиворечива** | в каждом файле записаны ВСЕ четыре клетки и читается ровно одна — та, что в имени | файл переименован/скопирован с чужой клеткой: код возврата читался бы не оттуда |
 * | **контроль назван** | есть проба БЕЗ системного вызова, и её значение ≠ 0 | без контроля `0` неотличим от «зонд не работает» |
 *
 * # Границы (названы, а не сглажены)
 *
 * * Сторож НЕ утверждает, что железо по-прежнему даёт 0/0/0/0: замер от 2026-11-08 снят на E8C2 с
 *   ядром `6.1.0-0.8-e8c2`, и повторить его отсюда нельзя (нет ни e2k-toolchain на хосте, ни
 *   доступа по ssh). Он держит ЗАПИСЬ замера и его форму, а не живую машину.
 * * Сторож НЕ проверяет, что правка сайта печати на месте — это предмет
 *   `src/e2k/arrayBlockRestore.test.ts` (структура команд) и `arrayBlockRestore.test.ts` же держит
 *   негативный контроль N=1. Здесь другой предмет: **сам прибор**, которым дефект был найден.
 * * Колонка «контроль без вызова» в §3.187.1 заполнена ТОЛЬКО для `%b[14]`: в отчёте прогона
 *   2026-11-08 стоит `exit(b14-nowrite) = 8`, и других контрольных прогонов в нём нет. Таблица в
 *   доке показывает 0/1/8/17 в этой колонке — это НЕ записанный замер. Расхождение названо здесь
 *   и в шапке отчёта, а не сглажено: сторож требуе�� ровно один названный контроль, потому что
 *   ровно один был снят.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Код отказа — он же строка поиска в логах. */
export const D12_GATE_CODE = 'OSN-GATE-D12';

/** Каталог зонда: `.s`-файлы, стенд и отчёт замера. */
export const D12_DIR = path.join('tools', 'e2k-hardware', 'probes', 'd12-window');

/** Отчёт живого прогона — единственная запись ответа машины. */
export const D12_REPORT = 'report-hardware.txt';

/**
 * Четыре клетки блока рантайма и значения, которыми они помечены в пробе.
 *
 * `role` — не подпись для читателя, а ПРЕДМЕТ СВЕРКИ: значения обязаны совпадать с ролями в коде
 * (`ENTRY_ARRAY_CELLS` в `src/e2k/arrayRuntime.ts`). Иначе возможен тихий дрейф: код переселил
 * `eight` в другую клетку, а проба продолжает мерить старую, и оба файла при этом «согласованы».
 *
 * `value` — что проба ВКЛАДЫВАЕТ в клетку, то есть величину, которую рантайм в ней держит:
 * ноль в `zero`, единица в `one`, восемь в `eight`, `0x11` в адрес кучи (подставной адрес: вопрос
 * про клетку, а не про память по этому адресу).
 */
export const D12_CELLS = [
  { cell: 12, value: 0x00, role: 'zero' },
  { cell: 13, value: 0x01, role: 'one' },
  { cell: 14, value: 0x08, role: 'eight' },
  { cell: 15, value: 0x11, role: 'heapSlot' },
] as const;

/**
 * Пробы, которые обязаны лежать в каталоге.
 *
 * `reads` — какую клетку проба читает в `exit`; `calls` — сколько `call %ctpr1, wbs = 0x4` в ней.
 * Имя файла обязано СОВПАДАТЬ с читаемой клеткой: проба `probe-b14.s`, читающая `%b[15]`, — это
 * подмена, при которой ответ 0 был бы приписан не той клетке.
 *
 * # Почему `calls` считаются, а не проверяются на наличие
 *
 * Первая редакция сторожа спрашивала «есть ли вызов», и контроль `probe-b14-nowrite.s` покраснел:
 * в нём вызов ЕСТЬ — сам `exit`. Отличить контроль от вопроса наличием вызова нельзя, потому что
 * без `exit` значение вообще не вернуть (канал наблюдения — код возврата). Отличие — в ЧИСЛЕ:
 * у вопроса два вызова (`write(1,NULL,0)` и `exit`), у контроля один (`exit`). Это и записано
 * числом, чтобы сторож не мог «пройти» на пробе, где забыли холостой вызов.
 */
export interface D12Probe {
  readonly file: string;
  readonly reads: number;
  /** Сколько `call %ctpr1, wbs = 0x4` обязано быть в пробе: 2 — вопрос, 1 — контроль. */
  readonly calls: number;
}

export const D12_PROBES: readonly D12Probe[] = [
  { file: 'probe-b12.s', reads: 12, calls: 2 },
  { file: 'probe-b13.s', reads: 13, calls: 2 },
  { file: 'probe-b14.s', reads: 14, calls: 2 },
  { file: 'probe-b15.s', reads: 15, calls: 2 },
  { file: 'probe-b14-nowrite.s', reads: 14, calls: 1 },
];

/** Разбор одного `.s`-файла зонда. */
export interface ProbeAudit {
  readonly file: string;
  /** Клетки, которым проба присвоила значение (все четыре обязательны). */
  readonly written: readonly number[];
  /** Клетка, читаемая в `exit` (`adds %b[N], …`). */
  readonly read: number | null;
  /** Сколько `call %ctpr1, wbs = 0x4` в пробе: 2 — вопрос, 1 — контроль. */
  readonly calls: number;
  /** Нарушения по этому файлу. */
  readonly problems: readonly string[];
}

/** Разбор прогона: код возврата по каждой пробе, как он записан в отчёте. */
export interface ReportAudit {
  /** Значения из отчёта: имя пробы → код возврата. */
  readonly codes: ReadonlyMap<string, number>;
  /** Сколько замеров без вызова (контроль) записано. */
  readonly controls: readonly string[];
  readonly problems: readonly string[];
}

/** Чистый разбор `.s`: ни файлов, ни сети — поэтому его и проверяет оракул. */
export function auditProbeSource(file: string, source: string): ProbeAudit {
  const problems: string[] = [];
  const written: number[] = [];
  let read: number | null = null;
  let calls = 0;

  for (const raw of source.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/u, '');
    // Запись клетки: `movts,0 0x8, %b[14]`. Используется как объявление значения, не как чтение.
    const write = /^\s*movts,\d+\s+(0x[0-9a-f]+|\d+)\s*,\s*%b\[(\d+)\]/iu.exec(line);
    if (write !== null) {
      const cell = Number(write[2]);
      if (!written.includes(cell)) written.push(cell);
      continue;
    }
    // Чтение клетки в exit: `adds,0 %b[14], %b[11], %r9`.
    const readMatch = /adds,\d+\s+%b\[(\d+)\]/iu.exec(line);
    if (readMatch !== null) read = Number(readMatch[1]);
    if (/call\s+%ctpr1\s*,\s*wbs\s*=/iu.test(line)) calls += 1;
  }

  // Все четыре клетки обязаны быть помечены: иначе проба не воспроизводит блок рантайма целиком,
  // и вопрос «что пережило вызов» задан не про тот блок.
  for (const { cell } of D12_CELLS) {
    if (!written.includes(cell)) {
      problems.push(`${D12_GATE_CODE}: ${file} — клетка %b[${String(cell)}] не помечена; блок рантайма задан не полностью (нужны 12,13,14,15).`);
    }
  }
  if (read === null) {
    problems.push(`${D12_GATE_CODE}: ${file} — не найдено чтение клетки в exit (adds %b[N]); проба ничего не возвращает.`);
  }
  return { file, written, read, calls, problems };
}

/**
 * Чистый разбор отчёта.
 *
 * Формат отчёта — вывод `run.sh`: строки `exit(bNN) = K`. Строка `exit(b14-nowrite) = K` — контроль.
 * Всё остальное в отчёте (хост, дата) не разбирается: это шапка, а не замер.
 */
export function auditProbeReport(text: string): ReportAudit {
  const problems: string[] = [];
  const codes = new Map<string, number>();
  const controls: string[] = [];

  for (const raw of text.split(/\r?\n/)) {
    const m = /^exit\((b\d+(?:-nowrite)?)\)\s*=\s*(-?\d+)\s*$/u.exec(raw.trim());
    if (m === null) continue;
    const name = m[1]!;
    codes.set(name, Number(m[2]));
    if (name.includes('nowrite')) controls.push(name);
  }

  if (codes.size === 0) {
    problems.push(`${D12_GATE_CODE}: отчёт не содержит ни одной строки «exit(bNN) = K» — это не замер.`);
  }
  // Контроль обязателен: без него `0` неотличим от «зонд не работает вовсе».
  if (controls.length === 0) {
    problems.push(
      `${D12_GATE_CODE}: в отчёте нет КОНТРОЛЯ без системного вызова — тогда «0» неотличим от ` +
        `неработающего зонда (клетка не та, регистр стёрт, промах по адресу).`,
    );
  }
  for (const name of controls) {
    const value = codes.get(name);
    if (value === 0) {
      problems.push(
        `${D12_GATE_CODE}: контроль ${name} вернул 0 — значит проба читает НЕ ту клетку, которую ` +
          `записала, и весь опыт ничего не доказывает.`,
      );
    }
  }
  return { codes, controls, problems };
}

/** Разбор каталога зонда: файлы, исходники, отчёт. */
export interface D12Audit {
  readonly probes: readonly ProbeAudit[];
  readonly report: ReportAudit | null;
  readonly problems: readonly string[];
}

/** Разбор настоящего каталога зонда. */
export function auditD12Dir(root = path.resolve(__dirname, '..', '..')): D12Audit {
  const problems: string[] = [];
  const dir = path.join(root, D12_DIR);
  if (!fs.existsSync(dir)) {
    return {
      probes: [],
      report: null,
      problems: [
        `${D12_GATE_CODE}: каталог зонда ${D12_DIR} не найден — прибор, различивший модель и цель, ` +
          `отсутствует в репозитории (дефект снова невидим; случай 52).`,
      ],
    };
  }

  const probes: ProbeAudit[] = [];
  for (const probe of D12_PROBES) {
    const file = path.join(dir, probe.file);
    if (!fs.existsSync(file)) {
      problems.push(`${D12_GATE_CODE}: проба ${probe.file} отсутствует — вопрос ${String(probe.reads)} не задаётся.`);
      continue;
    }
    const audit = auditProbeSource(probe.file, fs.readFileSync(file, 'utf8'));
    probes.push(audit);
    problems.push(...audit.problems);

    // Имя файла обязано совпадать с читаемой клеткой: иначе ответ припишут не той клетке.
    if (audit.read !== null && audit.read !== probe.reads) {
      problems.push(
        `${D12_GATE_CODE}: ${probe.file} читает %b[${String(audit.read)}], а в реестре проб за ней ` +
          `закреплена %b[${String(probe.reads)}] — ответ будет приписан не той клетке.`,
      );
    }
    // Число вызовов — предмет проверки: контроль отличается от вопроса ОДНИМ холостым вызовом.
    if (audit.calls !== probe.calls) {
      problems.push(
        `${D12_GATE_CODE}: ${probe.file} — вызовов ${String(audit.calls)}, а по реестру проб должно ` +
          `быть ${String(probe.calls)} (2 = write + exit у вопроса, 1 = только exit у контроля).`,
      );
    }
  }

  // Блок рантайма целиком (все четыре клетки) обязан быть задан в КАЖДОЙ пробе с вызовом: вопрос
  // «что пережило вызов» имеет смысл только про тот блок, который правка восстанавливает.
  const callProbes = probes.filter((p) => p.calls >= 2);
  if (callProbes.length > 0) {
    const full = callProbes.filter((p) => D12_CELLS.every(({ cell }) => p.written.includes(cell)));
    if (full.length !== callProbes.length) {
      problems.push(
        `${D12_GATE_CODE}: не все пробы с вызовом задают блок целиком — ${String(callProbes.length - full.length)} ` +
          `из ${String(callProbes.length)} (нужны клетки 12, 13, 14, 15).`,
      );
    }
  }

  const reportPath = path.join(dir, D12_REPORT);
  let report: ReportAudit | null = null;
  if (!fs.existsSync(reportPath)) {
    problems.push(
      `${D12_GATE_CODE}: отчёт прогона ${D12_REPORT} отсутствует — пробы есть, а ЗАМЕРА нет; ` +
        `ожидание в доке тогда ничем не подкреплено.`,
    );
  } else {
    report = auditProbeReport(fs.readFileSync(reportPath, 'utf8'));
    problems.push(...report.problems);

    // Каждая проба обязана быть в отчёте: незаписанный ответ = не заданный вопрос.
    for (const probe of D12_PROBES) {
      const name = probe.file.replace(/^probe-/u, '').replace(/\.s$/u, '');
      if (!report.codes.has(name)) {
        problems.push(`${D12_GATE_CODE}: проба ${probe.file} не имеет строки в отчёте — её ответ не записан.`);
      }
    }
  }

  return { probes, report, problems };
}

/**
 * Сверка клеток пробы с РОЛЯМИ в коде.
 *
 * # Зачем отдельная функция, а не проверка внутри разбора каталога
 *
 * Разбор каталога читает ФАЙЛЫ; сверка с кодом читает МОДУЛЬ. Смешать их значило бы, что оракул
 * пробы тянет за собой рантайм массивов, а сторож падает от чужой правки. Здесь же предмет узкий и
 * названный: клетка 12 в пробе — это `zero`, 13 — `one`, 14 — `eight`, 15 — адрес кучи.
 *
 * # Что это ловит
 *
 * Класс случая 27 реестра проверяемости («запись есть в коде и отсутствует в реестре»): код
 * переселил роль в другую клетку, проба продолжает мерить старую, и **оба файла согласованы между
 * собой**. Без этой сверки дрейф не виден ниоткуда: проба отвечает на свой вопрос, код работает
 * по-своему, а расхождение обнаружится только на машине — то есть дороже всего.
 */
export interface CellRoleAudit {
  readonly problems: readonly string[];
}

export function auditCellRoles(
  cells: readonly { readonly cell: number; readonly role: string }[],
  entryCells: Readonly<Record<string, number>>,
): CellRoleAudit {
  const problems: string[] = [];
  for (const { cell, role } of cells) {
    const inCode = entryCells[role];
    if (inCode === undefined) {
      problems.push(
        `${D12_GATE_CODE}: роль «${role}» зонда не найдена в ENTRY_ARRAY_CELLS — код и зонд ` +
          `разошлись в именах; сверка невозможна, и это красное, а не «пропущено».`,
      );
      continue;
    }
    if (inCode !== cell) {
      problems.push(
        `${D12_GATE_CODE}: роль «${role}» в коде живёт в %b[${String(inCode)}], а зонд её помечает ` +
          `в %b[${String(cell)}] — зонд меряет НЕ ТУ клетку (класс случая 27: запись разошлась с ` +
          `источником, и оба файла при этом согласованы).`,
      );
    }
  }
  return { problems };
}
