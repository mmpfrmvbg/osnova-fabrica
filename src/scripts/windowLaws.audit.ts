/**
 * ЗАКОНЫ ОКНА — OSN-GATE-WINDOW. Сторож, применяющий законы §3.111/§3.113 К КОНСТАНТАМ ДЕРЕВА.
 *
 * # Зачем, если законы уже где-то проверяются
 *
 * Проверяются — но врозь и в РАЗНЫХ ПЛОСКОСТЯХ, и это ровно тот способ, которым закон окна уже
 * один раз применили не туда:
 *
 * * `src/e2k/windowLimits.test.ts` гоняет модель и меряет предел клеток — плоскость ТОЧКИ ВХОДА.
 * * `src/e2k/syscallLocalWindow.test.ts` смотрит ФОРМУ команд `setwd`/`setbn` вокруг `call` —
 *   плоскость ЛОКАЛЬНОГО ОКНА сайта.
 * * `src/e2k/windowGeometry.ts` сводит три источника одного числа — плоскость ВЫЗЫВАЕМОЙ.
 *
 * Ни один из них не держит САМИ ЗАКОНЫ как формулы, применимые к любому набору констант. Отсюда
 * дефект, который этот модуль закрывает: константу двигают, форма остаётся согласованной, модель
 * зелена — а закон нарушен, и нарушен молча, потому что проверять его нечем.
 *
 * # Ошибка, которую я сделал сам и которую модуль делает невозможной
 *
 * При первом прогоне я проверил закон 3 (`wsz − wbs = 4`) на окне ФУНКЦИИ: `ARRAY_WINDOW_WSZ = 16`
 * минус `CALL_WBS = 4` даёт **12**, и я записал «закон нарушен». Это ЛОЖНОЕ красное: закон 3 живёт в
 * плоскости ЛОКАЛЬНОГО окна, которое сайт вызова открывает ПЕРЕД `sdisp` (`syscallCallOpen`:
 * `setwd wsz = frame.wbs + 4`), то есть `8 − 4 = 4`. Тот же класс ошибки, что §3.166 поймал в
 * реестре: вывод, верный в одной плоскости, перенесли в другую.
 *
 * Поэтому каждый закон здесь несёт ЯВНОЕ имя плоскости, а не только формулу: без этого «нарушено»
 * и «применено не туда» неразличимы.
 *
 * # Что сторож НЕ делает
 *
 * Не заменяет замер. §3.113 снят на ЖЕЛЕЗЕ, а его пробы (`.tmp`, папка на машине) **удалены и в git
 * не входят** — воспроизвести замер из этого дерева нельзя, и сторож этого не изображает. Он
 * проверяет СОГЛАСОВАННОСТЬ объявленных чисел с законами, а не то, что железо ведёт себя так.
 */

import {
  ARRAY_WINDOW_RSZ,
  ARRAY_WINDOW_WSZ,
  ARRAY_REGISTERS,
} from '../e2k/arrayRuntime';
import { CALL_WBS } from '../e2k/twoPassLayout';
import { WINDOW_GROW_WSZ, INNER_CALL_WBS } from '../e2k/procedureCall';
import {
  ENTRY_SYSCALL_FRAME,
  GROWN_SYSCALL_FRAME,
  SYSCALL_ENTRY_WSZ,
  SYSCALL_GROWN_WSZ,
} from '../e2k/syscallRuntime';

/** Код отказа — он же строка поиска в логах. */
export const WINDOW_GATE_CODE = 'OSN-GATE-WINDOW';

/**
 * Плоскости окна. Имя плоскости — не украшение: закон, применённый не в своей плоскости, даёт
 * ложное красное или ложное зелёное, и различить их без имени нельзя (§3.166).
 */
export type WindowPlane =
  /** Окно, объявленное прологом образа; `rsz` и клетки `%b[N]` — здесь. */
  | 'вход'
  /** Локальное окно, которое сайт вызова открывает ПЕРЕД `sdisp`; закон «ровно 4» — здесь. */
  | 'сайт вызова'
  /** Окно вызываемой: `call wbs = W` уменьшает его, клетки даёт `wsz`, а не `rsz`. */
  | 'вызываемая';

/** Набор чисел, к которым применяются законы. */
export interface WindowFacts {
  /** Окно пролога образа, квадрослов. */
  readonly entryWsz: number;
  /** Область вращения пролога. */
  readonly entryRsz: number;
  /** База области вращения пролога. */
  readonly entryRbs: number;
  /** Старшая клетка, которую рантайм точки входа реально трогает. */
  readonly entryTopCell: number;
  /** Ширина кадра сайта вызова. */
  readonly localWbs: number;
  /** Окно, открытое сайтом вызова перед `sdisp`. */
  readonly localWsz: number;
  /** Окно выращенной процедуры. */
  readonly grownWsz: number;
  /** Ширина вложенного вызова. */
  readonly grownWbs: number;
}

/** Закон с именем плоскости и с формулой, названной словами. */
export interface WindowLaw {
  readonly id: string;
  readonly plane: WindowPlane;
  readonly statement: string;
  readonly holds: boolean;
  readonly detail: string;
}

/** Предел клеток в плоскости входа: `%b[N]` законна при `N < 2·(rsz + 1)` (§3.163/§3.166). */
export function entryCellLimit(rsz: number): number {
  return 2 * (rsz + 1);
}

/** Клеток вызываемой: `2·(wsz − wbs)` (§3.166, замер 1: первая недоступная равна ровно этому). */
export function calleeCellLimit(wsz: number, wbs: number): number {
  return 2 * (wsz - wbs);
}

/** Все законы, применённые к набору чисел, — с именем плоскости у каждого. */
export function windowLaws(facts: WindowFacts): WindowLaw[] {
  const laws: WindowLaw[] = [];

  // ЗАКОН 1 — годность окна. Плоскость: ВХОД. `rbs + rsz + 1 ≤ wsz`, иначе негодно ВСЁ окно
  // (SEGV_BNDERR на первом же обращении), а не «регистр вне области».
  const fit = facts.entryRbs + facts.entryRsz + 1;
  laws.push({
    id: 'З1 годность',
    plane: 'вход',
    statement: 'rbs + rsz + 1 ≤ wsz — иначе негодно всё окно',
    holds: fit <= facts.entryWsz,
    detail: `${String(facts.entryRbs)}+${String(facts.entryRsz)}+1 = ${String(fit)} ≤ ${String(facts.entryWsz)}`,
  });

  // ЗАКОН 2 — адрес клетки. Плоскость: ВХОД. Клетки кончаются на 2·(rsz+1); обращение за предел —
  // авария, а не «регистр вне области».
  const limit = entryCellLimit(facts.entryRsz);
  laws.push({
    id: 'З2 предел клеток входа',
    plane: 'вход',
    statement: 'старшая трогаемая клетка < 2·(rsz + 1)',
    holds: facts.entryTopCell < limit,
    detail: `старшая клетка ${String(facts.entryTopCell)} < ${String(limit)} = 2·(${String(facts.entryRsz)}+1)`,
  });

  // ЗАКОН 3 — условие вызова. Плоскость: САЙТ ВЫЗОВА (локальное окно!), а не окно функции.
  // Шире — SIGKILL, уже — трап не берётся (петля); обе стороны молчаливы.
  const localDelta = facts.localWsz - facts.localWbs;
  laws.push({
    id: 'З3 ровно четыре у вызова',
    plane: 'сайт вызова',
    statement: 'локальное_wsz − wbs = 4 — ровно, не «не меньше»',
    holds: localDelta === 4,
    detail: `${String(facts.localWsz)} − ${String(facts.localWbs)} = ${String(localDelta)}`,
  });

  // ЗАКОН 4 — бюджет вызываемой. Плоскость: ВЫЗЫВАЕМАЯ. Клетки даёт `wsz`, а не `rsz`; `rsz`
  // пролога образа у листовой вызываемой не двигает ни одной клетки (§3.166, замер 2).
  const callee = calleeCellLimit(facts.grownWsz, facts.grownWbs);
  laws.push({
    id: 'З4 бюджет вызываемой',
    plane: 'вызываемая',
    statement: 'клеток вызываемой = 2·(wsz − wbs), и это положительное число',
    holds: callee > 0 && facts.grownWsz > facts.grownWbs,
    detail: `2·(${String(facts.grownWsz)} − ${String(facts.grownWbs)}) = ${String(callee)}`,
  });

  return laws;
}

/** Числа ИЗ ДЕРЕВА: ни одного закреплённого в этом файле. */
export function windowFactsFromTree(): WindowFacts {
  const topCell = Math.max(...Object.values(ARRAY_REGISTERS));
  return {
    entryWsz: ARRAY_WINDOW_WSZ,
    entryRsz: ARRAY_WINDOW_RSZ,
    entryRbs: 0,
    entryTopCell: topCell,
    localWbs: ENTRY_SYSCALL_FRAME.wbs,
    localWsz: ENTRY_SYSCALL_FRAME.wbs + 4,
    grownWsz: WINDOW_GROW_WSZ,
    grownWbs: INNER_CALL_WBS,
  };
}

/** Расхождения объявленных чисел с законами. Пустой список — согласованы. */
export function windowLawProblems(facts: WindowFacts = windowFactsFromTree()): string[] {
  return windowLaws(facts)
    .filter((law) => !law.holds)
    .map(
      (law) =>
        `${WINDOW_GATE_CODE}: ${law.id} (плоскость «${law.plane}») нарушен: ${law.detail}; ` +
        `закон — ${law.statement}`,
    );
}

/**
 * Дублированные константы совпадают со своими источниками.
 *
 * `SYSCALL_ENTRY_WSZ` и `SYSCALL_GROWN_WSZ` продублированы намеренно (импорт дал бы цикл
 * `procedureCall` → `syscallRuntime`). Дублирование без сверки — это две записи одного числа,
 * которые расходятся молча; `syscallLocalWindow.test.ts` стережёт их в плоскости ФОРМЫ команд, а
 * здесь — в плоскости ЗНАЧЕНИЙ.
 */
export function windowDuplicateProblems(): string[] {
  const problems: string[] = [];
  if (SYSCALL_ENTRY_WSZ !== ARRAY_WINDOW_WSZ) {
    problems.push(
      `${WINDOW_GATE_CODE}: SYSCALL_ENTRY_WSZ = ${String(SYSCALL_ENTRY_WSZ)}, а пролог образа ` +
        `(ARRAY_WINDOW_WSZ) = ${String(ARRAY_WINDOW_WSZ)}: закрытие вернёт не то окно, которое открыл пролог`,
    );
  }
  if (SYSCALL_GROWN_WSZ !== WINDOW_GROW_WSZ) {
    problems.push(
      `${WINDOW_GATE_CODE}: SYSCALL_GROWN_WSZ = ${String(SYSCALL_GROWN_WSZ)}, а ` +
        `WINDOW_GROW_WSZ = ${String(WINDOW_GROW_WSZ)}: кадр роста разойдётся с его восстановлением`,
    );
  }
  if (GROWN_SYSCALL_FRAME.wbs !== INNER_CALL_WBS) {
    problems.push(
      `${WINDOW_GATE_CODE}: GROWN_SYSCALL_FRAME.wbs = ${String(GROWN_SYSCALL_FRAME.wbs)}, а ` +
        `INNER_CALL_WBS = ${String(INNER_CALL_WBS)}: ширина вложенного вызова объявлена дважды`,
    );
  }
  if (ENTRY_SYSCALL_FRAME.base !== 2 * CALL_WBS) {
    problems.push(
      `${WINDOW_GATE_CODE}: ENTRY_SYSCALL_FRAME.base = ${String(ENTRY_SYSCALL_FRAME.base)}, а ` +
        `2·CALL_WBS = ${String(2 * CALL_WBS)}: клетка вызываемой считается не от той базы`,
    );
  }
  return problems;
}
