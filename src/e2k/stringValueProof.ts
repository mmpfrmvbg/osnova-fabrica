/**
 * ДОКАЗАТЕЛЬСТВО ЗНАЧЕНИЙ НА СБОРКЕ — строк, чисел и ИСХОДА ПАРЫ `Результат<Т, Е>`.
 *
 * # Задача
 *
 * Строковость берётся из ТИПА, а числа (длина в кодпоинтах и таблица кодов) — только из ДОКАЗАННОГО
 * ЗНАЧЕНИЯ: у строкового параметра на сборке есть адрес, а не содержимое. Значит единственный честный
 * путь — рассмотреть ВСЕ сайты вызова процедуры и доказать, что в этот параметр ВСЕГДА приходит одно и
 * то же значение. Это МЕЖПРОЦЕДУРНАЯ задача о неподвижной точке: значение параметра одной процедуры
 * может быть значением параметра другой.
 *
 * # Зачем ЦЕЛЫЕ и зачем исход пары ПО САЙТУ
 *
 * Нагрузка пары может быть строкой ИЛИ числом в ОДНОЙ И ТОЙ ЖЕ клетке канала вызова. Замер verifier'а
 * (проба П12): `добыть("абв", 0)` отдаёт `Неудача(7)` там, где на пути успеха лежит Строка. Пометка
 * «по успешному возврату процедуры» напечатала бы 1072 вместо отказа — то есть НОВУЮ тихую ложь.
 * Поэтому тег доказывается НА КАЖДОМ САЙТЕ: для этого нужно знать значение аргумента (`ч = 0`),
 * вычислить предикат (`ч > 0` — ложно) и ПРОЙТИ ТЕЛО вызываемой по взятой ветви до `IR.ret_result`.
 *
 * Отсюда форма выхода: {@link StringValueProof.pairs} — «носитель `IR.result_pick` → доказанный тег и
 * (если доказана) нагрузка». Записи в `pairs` НЕТ, когда тег не доказан: пометка нагрузки без тега
 * была бы догадкой, а не доказательством.
 *
 * # Правила (каждое обязательно)
 *
 * 1. **Факт заводится литералом и едет только вычислением**: `IR.const` (строка или число),
 *    `IR.zero`, `IR.move`, `IR.add`/`IR.sub`/`IR.mul` над известными числами, `IR.not` и сравнения
 *    `IR.eq`/`IR.ne`/`IR.lt`/`IR.le`/`IR.gt`/`IR.ge` над известными числами. ЛЮБАЯ запись в регистр
 *    факт ГАСИТ (как `kill` в `stringPlan.ts`); незнакомый носитель гасит ВСЁ — лучше отказ, чем
 *    тихая ложь.
 * 2. **Параметр доказывается САЙТАМИ, а не большинством.** Хоть один сайт с неизвестным значением —
 *    параметр не доказан. Сайты передают разное — не доказан. Процедуру никто не зовёт — не доказан.
 * 3. **Неподвижная точка** — итерации до отсутствия изменений; предел НАЗВАН
 *    ({@link STRING_VALUE_PROOF_ROUNDS}). Раунд ссылается на ПРЕДЫДУЩИЙ, а «неизвестно» фактом не
 *    является, поэтому каждый раунд даёт только правду (возможно, неполную): предел обрезает
 *    полноту, но не правду. Цикл вызовов зацикливания не даёт.
 * 4. **Исход пары — исполнением тела вызываемой** по доказанным значениям этого сайта: сравнение с
 *    известными операндами даёт известный предикат, переход идёт по ВЗЯТОЙ ветви, исход берётся у
 *    достигнутого `IR.ret_result`. Предикат НЕИЗВЕСТЕН — «не доказано», а не «наверное, успех»;
 *    достижимы разные теги — «не доказано». Число шагов разбора ограничено
 *    ({@link STRING_CALL_WALK_STEPS}), за пределом — НАЗВАННЫЙ отказ.
 * 5. **Сравниваются БАЙТЫ, а не индексы записей** (два литерала «абв» в пуле — одно значение);
 *    канонической записью считается МЕНЬШАЯ с теми же байтами.
 * 6. **Причины НАЗВАНЫ и с индексом носителя:** какой сайт чего не передал, какие сайты разошлись,
 *    где предикат не доказан. Отказ без причины — тоже ложь, только другого рода.
 *
 * # Раскладка операндов — из дерева, а не из головы
 *
 * | носитель | операнды | источник |
 * |---|---|---|
 * | `IR.const` | `[приёмник, индекс пула, тип]` | `emitterShell.ts`, `CONST_TYPES` = `["i32","f64","str","bool","null"]` |
 * | `IR.move` | `[приёмник, источник]` | `emitterShell.ts` |
 * | `IR.zero` | `[приёмник]` | `programImage.ts` (пролог значений вызываемой) |
 * | `IR.add/sub/mul` | `[приёмник, a, b]` → `d = a ±/· b` | `e2kRealRun.ts#LOWERING`, `fromIr [1,2,0]` |
 * | `IR.eq/ne/lt/le/gt/ge` | `[ключ, a, b]` → `a <оп> b` | `predicatePairing.ts`, `collectionsRuntime.ts` |
 * | `IR.call` | `[флаги, arg0, arg1, payload = индекс процедуры, приёмник]` | `emitterShell.ts` |
 * | `IR.result_pick` | `[приёмник нагрузки, якорь = приёмник тега того же вызова]` | `resultLowering.test.ts` |
 * | `IR.ret_result` | `[тег, нагрузка]` — оба РЕГИСТРЫ, тег Успеха = 0 | `emitterShell.ts`, `liveness.ts` |
 *
 * Аргументы вызова берутся ОДНИМ источником с раскладкой (`src/e2k/shell.ts#callArgumentOperands`),
 * запись/чтение — из `defUseOf` (`src/e2k/liveness.ts`): второго списка носителей в дереве нет.
 * Входной тип объявлен ЗДЕСЬ ({@link ProveStringValuesInput}) — модуль самостоятелен, потребитель
 * приводит данные к нему.
 *
 * # Границы, названные замером
 *
 * Маршрут «считать длину и код символа РАНТАЙМОВЫМ блоком скана» ЗАКРЫТ замером 2026-11-05: раскладка
 * размещает только носители, голых команд (`ldb`, `shrs`, `movts`) в потоке не бывает, а внутренний
 * переход в составном носителе невыразим. Стена осталась в дереве: шапка `src/e2k/stringPlan.ts`
 * (раздел «МАРШРУТ РАНТАЙМ-СКАН ЗАКРЫТ ЗАМЕРОМ») и ИСПОЛНЯЕМЫЕ проверки — `src/e2k/stringTypeParam.test.ts`
 * (24 проверки, в том числе отказ на недоказанном значении и на нагрузке пары без доказанного Успеха) и
 * `src/e2k/resultStringDepth.test.ts` (глубина 2, ответы пары). Отдельного файла
 * `stringValueProof.test.ts` в дереве НЕТ — здесь стояла ссылка на него, и она была ложной.
 * Черновик механизма — `.tmp/a230-runtime-scan-cancelled/`.
 */
import type { AsmInstruction } from './backend';
import { defUseOf } from './liveness';
import { callArgumentOperands } from './shell';
import type { ProcedureOffset } from './procedureCall';

/**
 * ТЕГ УСПЕХА пары `Результат<Т, Е>` (`docs/abi-v3-draft.md` §10.2): ноль.
 *
 * Назван числом: возврат с тегом 0 несёт НАГРУЗКУ, возврат с другим тегом — ошибку, и поле у неё
 * другого типа. Перепутать их значит доказать строку там, где лежит число.
 */
export const STRING_SUCCESS_TAG = 0;

/**
 * ФЛАГ ТИПА «строка» у носителя `IR.const` — индекс в `CONST_TYPES` (`src/e2k/emitterShell.ts`):
 * `["i32", "f64", "str", "bool", "null"]`, значит строка — 2. Если конвейер предъявил пул значений
 * (`constantValues`), строковость берётся ПО НЕМУ — тем же правилом, что в `planStrings`
 * (`typeof raw === 'string'`), чтобы второго правила распознавания строки не завелось.
 */
export const STRING_CONST_TYPE_FLAG = 2;

/**
 * ПРЕДЕЛ ИТЕРАЦИЙ НЕПОДВИЖНОЙ ТОЧКИ.
 *
 * Цепочка «параметр → копия → аргумент следующего вызова» удлиняет доказательство на шаг за вызов,
 * поэтому предел больше глубины реальных цепочек; за ним — НАЗВАННЫЙ отказ. Цикл вызовов зациклить
 * доказательство не может (см. правило 3): предел стоит страховкой от расхождения.
 */
export const STRING_VALUE_PROOF_ROUNDS = 32;

/**
 * ПРЕДЕЛ РАЗБОРА ТЕЛА вызываемой процедуры — в носителях, на один сайт.
 *
 * Тело исполняется по носителям: цикл с известным предикатом разбирается по шагам, и без предела
 * `пока истина` зациклило бы сборку. За пределом — НАЗВАННЫЙ отказ.
 */
export const STRING_CALL_WALK_STEPS = 4096;

/** Имя типа-строки в объявлении параметров. */
export const STRING_TYPE_NAME = 'Строка';

/** Имя числового типа: такие клетки доказываются ради ПРЕДИКАТОВ, а не ради подстановки. */
export const NUMBER_TYPE_NAME = 'Число';

/** Доказанное значение: строка (номер записи пула) или целое. */
export type ProvenValue =
  | { readonly kind: 'строка'; readonly pool: number }
  | { readonly kind: 'целое'; readonly value: number };

/** Исход пары: тег Успеха — 0, всё прочее — Неудача. */
export type OutcomeTag = 'успех' | 'неудача';

/** Доказанный исход пары на сайте: тег и (если доказана) нагрузка. */
export interface PairOutcome {
  readonly tag: OutcomeTag;
  readonly payload?: ProvenValue;
}

/** Причина «не доказано»: НАЗВАННАЯ, с процедурой, клеткой и (где есть) индексом носителя. */
export interface StringValueProblem {
  readonly procedure: number;
  /** Клетка (номер параметра); нет — если недоказанность не про клетку. */
  readonly register?: number;
  /** Индекс носителя, о котором речь (сайт вызова, `IR.result_pick`, возврат). */
  readonly site?: number;
  readonly reason: string;
}

/** ДОКАЗАННОЕ. Чего здесь нет — не доказано, и причина названа в {@link StringValueProof.problems}. */
export interface StringValueProof {
  /** процедура → номер КЛЕТКИ-параметра → каноническая запись пула (СТРОКИ). */
  readonly parameters: ReadonlyMap<number, ReadonlyMap<number, number>>;
  /**
   * Носитель `IR.result_pick` → доказанный исход пары.
   *
   * ЗАПИСЬ ЕСТЬ ТОЛЬКО ПРИ ДОКАЗАННОМ ТЕГЕ. Пометку нагрузки можно ставить лишь при `tag === 'успех'`:
   * у пути неудачи в той же клетке канала лежит поле ДРУГОГО типа (замер П12).
   */
  readonly pairs: ReadonlyMap<number, PairOutcome>;
  /** Названные причины «почему не доказано». */
  readonly problems: readonly StringValueProblem[];
  /**
   * ЗНАЧЕНИЯ ВСЕХ САЙТОВ ПАРАМЕТРА — когда известны ВСЕ сайты (TD-0001).
   *
   * Это НЕ второе доказательство, а ЗНАНИЕ МНОЖЕСТВА: `parameters` отвечает «значение одно, вот оно»,
   * а здесь лежит «вот все, что могут прийти» — в порядке сайтов. Разница нужна там, где одного
   * значения не хватает, а множества ДОСТАТОЧНО: параметр, которому разные сайты передают разные
   * ЛИТЕРАЛЫ, понижается выборкой из дескриптора перед блобом (`src/e2k/stringRuntime.ts`,
   * `STRING_DESCRIPTOR_MARK`), и сборке знать «какая именно строка» не требуется.
   *
   * Чего здесь НЕ бывает: клетки, у которой хоть один сайт неизвестен (тогда значения не «множество»,
   * а «множество плюс неизвестность», и такой параметр обязан отказывать — `problems`), и значений не
   * из пула: в множестве лежат только записи пула (`{kind: 'строка'}`), то есть ЛИТЕРАЛЫ. Значение,
   * собранное в рантайме (склейка), в пул не попадает и в это множество не входит — поэтому
   * потребитель, разрешивший выборку по множеству, не разрешит её для склейки.
   */
  readonly siteValues: ReadonlyMap<number, ReadonlyMap<number, readonly ProvenValue[]>>;
}

/** Вход доказательства. Тип объявлен ЗДЕСЬ: модуль самостоятелен, потребитель приводит данные к нему. */
export interface ProveStringValuesInput {
  /** Поток носителей оболочки (после `emitShell`). */
  readonly code: readonly AsmInstruction[];
  /** Границы процедур (`codeOffset`) — те же, что у `planStrings`. */
  readonly procedures: readonly ProcedureOffset[];
  /** Имена вызовов образа: ими называется процедура в причине (индекс — `payload` у `IR.invoke`). */
  readonly invokeNames?: readonly string[];
  /** Пул строк: индекс записи → БАЙТЫ (по ним значения и сравниваются). */
  readonly stringPool: readonly (readonly number[])[];
  /** Пул значений модуля: строки — текстом, числа — числом (как `RegModule.constants`). */
  readonly constantValues?: readonly unknown[];
  /** Имена типов параметров: `paramTypes[процедура][номер параметра]`. Право вообще искать. */
  readonly paramTypes?: readonly (readonly (string | undefined)[])[];
}

/** Вид факта о клетке: доказано или РАЗОШЛОСЬ (два разных значения на сайтах). */
type Fact =
  | { readonly kind: 'value'; readonly value: ProvenValue }
  | { readonly kind: 'conflict'; readonly first: ProvenValue; readonly second: ProvenValue };

/** Исход сайта, как его видит ПРЕДЫДУЩИЙ раунд (для нагрузки `IR.result_pick` внутри тела). */
interface CallFact {
  readonly tag?: OutcomeTag;
  readonly payload?: ProvenValue;
}

/** Возврат, достигнутый при разборе тела. */
interface ReturnFact {
  readonly index: number;
  readonly pair: boolean;
  readonly tag?: OutcomeTag;
  readonly payload?: ProvenValue;
}

/** Состояние доказательства между раундами. */
interface ProofState {
  readonly params: Map<string, Fact>;
  readonly outcomes: Map<number, CallFact>;
}

/** Разбор одного сайта: тег, нагрузка и причина, если чего-то нет. */
interface SiteOutcome {
  readonly tag?: OutcomeTag;
  readonly payload?: ProvenValue;
  readonly reason?: string;
  /** Индекс носителя, о котором говорит причина (предикат, возврат, предел). */
  readonly at?: number;
}

const keyOf = (procedure: number, cell: number): string => `${String(procedure)}:${String(cell)}`;

/** Ключ значения: по нему видно «то же самое или другое». */
function sameValue(a: ProvenValue | undefined, b: ProvenValue | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.kind !== b.kind) return false;
  return a.kind === 'строка' ? a.pool === (b as { pool: number }).pool : a.value === (b as { value: number }).value;
}

/** Описание значения для причины — числами, а не словом «значение». */
function describeValue(value: ProvenValue): string {
  return value.kind === 'строка' ? `запись пула ${String(value.pool)}` : `число ${String(value.value)}`;
}

/**
 * Носители, чья раскладка операндов ИЗВЕСТНА (сверено с `defUseOf`, `src/e2k/liveness.ts`).
 *
 * Всё, чего здесь нет, гасит ВСЕ факты: неизвестная запись в регистр, оставленная без внимания,
 * доказала бы мёртвое значение — это тихая ложь, а не неполнота.
 */
const KNOWN_CARRIERS: ReadonlySet<string> = new Set([
  'IR.const',
  'IR.move',
  'IR.zero',
  'IR.not',
  'IR.add',
  'IR.sub',
  'IR.mul',
  'IR.idiv',
  'IR.rem',
  'IR.eq',
  'IR.ne',
  'IR.lt',
  'IR.le',
  'IR.gt',
  'IR.ge',
  'IR.and',
  'IR.or',
  'IR.jmp',
  'IR.jmp_if',
  'IR.jmp_if_not',
  'IR.call',
  'IR.invoke',
  'IR.ret',
  'IR.ret_result',
  'IR.result_pick',
  'IR.exit',
  'IR.spill_ld',
  'IR.spill_st',
  'IR.load',
  'IR.store',
  'IR.arena_init',
  'IR.arena_alloc',
  'IR.arena_pointer',
  'IR.arena_limit',
  'IR.refusal',
  'IR.string_arena_copy',
  'IR.arena_concat',
  'IR.array_values',
  'IR.array_slot',
  'IR.callee_zero',
]);

/** Сравнения: их результат — известное 0/1, и он же — предикат перехода. */
const COMPARISONS: ReadonlySet<string> = new Set(['IR.eq', 'IR.ne', 'IR.lt', 'IR.le', 'IR.gt', 'IR.ge']);

/** Клетка-приёмник носителя, если она вообще есть. */
function writtenCells(carrier: AsmInstruction): { readonly known: boolean; readonly cells: readonly number[] } {
  if (!KNOWN_CARRIERS.has(carrier.mnemonic)) return { known: false, cells: [] };
  return { known: true, cells: defUseOf(carrier).def };
}

/** Сколько аргументов несёт носитель вызова. */
function callArity(carrier: AsmInstruction): number {
  const flags = carrier.operands[0];
  return flags === undefined || flags.kind !== 'imm' ? 0 : flags.value >> 1;
}

/** Цель перехода носителя, если она выражена числом. */
function jumpTarget(carrier: AsmInstruction): number | undefined {
  const operand = carrier.mnemonic === 'IR.jmp' ? carrier.operands[0] : carrier.operands[1];
  return operand !== undefined && operand.kind === 'imm' ? operand.value : undefined;
}

/** Функции значения носителя `IR.const`: объявлены ТИПОМ, а не прокинуты приведением. */
interface ValueSources {
  /** Запись пула носителя `IR.const`, если он несёт СТРОКУ. */
  readonly constRecord: (carrier: AsmInstruction) => number | undefined;
  /** Значение числа носителя `IR.const`, если оно известно сборке. */
  readonly constNumber: (carrier: AsmInstruction) => number | undefined;
}

/** Вход разбора тела. */
interface WalkOptions extends ValueSources {
  readonly code: readonly AsmInstruction[];
  readonly from: number;
  readonly to: number;
  readonly entry: ReadonlyMap<number, ProvenValue>;
  /** Исходы ПРОШЛОГО раунда: по ним доказывается нагрузка `IR.result_pick` внутри тела. */
  readonly outcomes: ReadonlyMap<number, CallFact>;
  /** Идти ли по переходам (разбор ветви) или линейно (сбор фактов по процедуре). */
  readonly followJumps: boolean;
  readonly limit: number;
}

/** Что дал разбор тела. */
interface WalkResult {
  readonly returns: readonly ReturnFact[];
  /** Аргументы сайтов вызова: индекс носителя → клетка → значение на входе носителя. */
  readonly callStates: ReadonlyMap<number, ReadonlyMap<number, ProvenValue>>;
  readonly stopped: 'end' | 'limit' | 'unknown-predicate' | 'outside';
  readonly stoppedAt: number;
}

/**
 * РАЗОБРАТЬ ТЕЛО ПО НОСИТЕЛЯМ.
 *
 * Линейно (`followJumps: false`) — чтобы собрать факты по процедуре. По переходам
 * (`followJumps: true`) — чтобы получить ИСХОД ветви: тогда предикат обязан быть известен, и
 * неизвестный предикат — остановка с названной причиной, а не «пойдём по обеим ветвям».
 */
function walkBody(options: WalkOptions): WalkResult {
  const values = new Map<number, ProvenValue>(options.entry);
  const returns: ReturnFact[] = [];
  const callStates = new Map<number, ReadonlyMap<number, ProvenValue>>();
  /** Пик вызова, чей приёмник — якорь порядка: связывает нагрузку с вызываемой. */
  const calleeByTag = new Map<number, number>();
  let at = options.from;
  let steps = 0;

  for (;;) {
    if (steps >= options.limit) return { returns, callStates, stopped: 'limit', stoppedAt: at };
    steps += 1;
    if (at < options.from || at >= options.to) return { returns, callStates, stopped: 'outside', stoppedAt: at };
    const carrier = options.code[at];
    if (carrier === undefined) return { returns, callStates, stopped: 'end', stoppedAt: at };

    // ── ВОЗВРАТ: состояние читается ДО записи (её у возврата нет) ─────────────
    if (carrier.mnemonic === 'IR.ret') {
      const flag = carrier.operands[0];
      const hasValue = flag !== undefined && flag.kind === 'imm' && flag.value === 1;
      const value = hasValue ? carrier.operands[1] : undefined;
      returns.push({
        index: at,
        pair: false,
        tag: 'успех',
        payload: value !== undefined && value.kind === 'reg' ? values.get(value.index) : undefined,
      });
      if (options.followJumps) return { returns, callStates, stopped: 'end', stoppedAt: at };
      at += 1;
      continue;
    }
    if (carrier.mnemonic === 'IR.ret_result') {
      const tag = carrier.operands[0];
      const payload = carrier.operands[1];
      const tagValue = tag !== undefined && tag.kind === 'reg' ? values.get(tag.index) : undefined;
      const tagFact = tagValue !== undefined && tagValue.kind === 'целое' ? tagValue.value : undefined;
      returns.push({
        index: at,
        pair: true,
        tag: tagFact === undefined ? undefined : tagFact === STRING_SUCCESS_TAG ? 'успех' : 'неудача',
        payload: payload !== undefined && payload.kind === 'reg' ? values.get(payload.index) : undefined,
      });
      if (options.followJumps) return { returns, callStates, stopped: 'end', stoppedAt: at };
      at += 1;
      continue;
    }

    // ── САЙТ ВЫЗОВА: аргументы читаются ДО записи приёмника ──────────────────
    if (carrier.mnemonic === 'IR.call' || carrier.mnemonic === 'IR.invoke') {
      const state = new Map<number, ProvenValue>();
      // КЛЮЧ — НОМЕР АРГУМЕНТА, А НЕ НОМЕР РЕГИСТРА (найдено замером 2026-11-05, шаг 2.3).
      //
      // Параметры вызываемой лежат в её клетках 0…n-1, и «параметр k» — это АРГУМЕНТ k. Регистр же, из
      // которого аргумент уезжает, выбирает оболочка (`src/e2k/shell.ts`), и у потока ДО раскладки он
      // произвольный: в пробе `с_токеном("", "имя", "сумма")` аргументы стояли в `%b[2]`, `%b[3]`,
      // `%b[4]`, а параметры — в клетках 0, 1, 2. Ключ по регистру связывал «клетку 2» с `%b[2]`, то
      // есть приписывал второму параметру ПЕРВЫЙ аргумент (`""` вместо `"сумма"`), и доказанным
      // оказывался не тот параметр. После раскладки оболочка пересылает аргументы в клетки 0…n-1, и
      // ключи совпадали СЛУЧАЙНО — поэтому дефект виделся только на потоке до раскладки (им же
      // пользуется разведка нужды в клетках строкового рантайма, `stringNeedProcedures`).
      //
      // Для чтения состояния ТЕЛА вызываемой такая ключёвка тоже верна: там ключ — клетка её кадра, а
      // параметр k лежит именно в клетке k (`src/e2k/shell.ts#ARGUMENT_SLOTS`).
      callArgumentOperands(carrier).forEach((argument, position) => {
        if (argument.kind !== 'reg') return;
        const value = values.get(argument.index);
        if (value !== undefined) state.set(position, value);
      });
      callStates.set(at, state);
      const payload = carrier.operands[3];
      const flags = carrier.operands[0];
      if (
        carrier.mnemonic === 'IR.call' &&
        payload !== undefined &&
        payload.kind === 'imm' &&
        flags !== undefined &&
        flags.kind === 'imm' &&
        (flags.value & 1) === 1
      ) {
        const destination = carrier.operands[4];
        if (destination !== undefined && destination.kind === 'reg') calleeByTag.set(destination.index, at);
      }
    }

    // ── НАГРУЗКА ПАРЫ: приёмник берёт значение исхода того вызова, чей якорь совпал ──
    if (carrier.mnemonic === 'IR.result_pick') {
      const destination = carrier.operands[0];
      const anchor = carrier.operands[1];
      if (destination !== undefined && destination.kind === 'reg') {
        values.delete(destination.index);
        const callIndex = anchor !== undefined && anchor.kind === 'reg' ? calleeByTag.get(anchor.index) : undefined;
        const fact = callIndex === undefined ? undefined : options.outcomes.get(callIndex);
        if (fact !== undefined && fact.payload !== undefined) values.set(destination.index, fact.payload);
      }
      at += 1;
      continue;
    }

    // ── ПЕРЕХОДЫ ────────────────────────────────────────────────────────────
    if (carrier.mnemonic === 'IR.jmp') {
      if (!options.followJumps) {
        at += 1;
        continue;
      }
      const target = jumpTarget(carrier);
      if (target === undefined || target < options.from || target >= options.to) {
        return { returns, callStates, stopped: 'outside', stoppedAt: at };
      }
      at = target;
      continue;
    }
    if (carrier.mnemonic === 'IR.jmp_if' || carrier.mnemonic === 'IR.jmp_if_not') {
      if (!options.followJumps) {
        at += 1;
        continue;
      }
      const condition = carrier.operands[0];
      const value = condition !== undefined && condition.kind === 'reg' ? values.get(condition.index) : undefined;
      if (value === undefined || value.kind !== 'целое') {
        return { returns, callStates, stopped: 'unknown-predicate', stoppedAt: at };
      }
      const truthy = value.value !== 0;
      const taken = (carrier.mnemonic === 'IR.jmp_if') === truthy;
      const next = taken ? jumpTarget(carrier) : at + 1;
      if (next === undefined || next < options.from || next >= options.to) {
        return { returns, callStates, stopped: 'outside', stoppedAt: at };
      }
      at = next;
      continue;
    }

    // ── ЗАПИСЬ НОСИТЕЛЯ ─────────────────────────────────────────────────────
    if (carrier.mnemonic === 'IR.const') {
      const destination = carrier.operands[0];
      if (destination === undefined || destination.kind !== 'reg') {
        at += 1;
        continue;
      }
      const record = options.constRecord(carrier);
      const number = options.constNumber(carrier);
      values.delete(destination.index);
      if (record !== undefined) values.set(destination.index, { kind: 'строка', pool: record });
      else if (number !== undefined) values.set(destination.index, { kind: 'целое', value: number });
      at += 1;
      continue;
    }
    if (carrier.mnemonic === 'IR.zero') {
      const destination = carrier.operands[0];
      if (destination !== undefined && destination.kind === 'reg') {
        values.set(destination.index, { kind: 'целое', value: 0 });
      }
      at += 1;
      continue;
    }
    if (carrier.mnemonic === 'IR.move') {
      const destination = carrier.operands[0];
      const source = carrier.operands[1];
      if (destination !== undefined && destination.kind === 'reg') {
        const value = source !== undefined && source.kind === 'reg' ? values.get(source.index) : undefined;
        // Правило 1: пересылка ПЕРЕНОСИТ факт и не создаёт нового.
        if (value === undefined) values.delete(destination.index);
        else values.set(destination.index, value);
      }
      at += 1;
      continue;
    }
    if (carrier.mnemonic === 'IR.not') {
      const destination = carrier.operands[0];
      const source = carrier.operands[1];
      if (destination !== undefined && destination.kind === 'reg') {
        const value = source !== undefined && source.kind === 'reg' ? values.get(source.index) : undefined;
        if (value !== undefined && value.kind === 'целое') {
          values.set(destination.index, { kind: 'целое', value: value.value === 0 ? 1 : 0 });
        } else {
          values.delete(destination.index);
        }
      }
      at += 1;
      continue;
    }
    if (COMPARISONS.has(carrier.mnemonic)) {
      const destination = carrier.operands[0];
      const first = carrier.operands[1];
      const second = carrier.operands[2];
      if (destination !== undefined && destination.kind === 'reg') {
        const left = first !== undefined && first.kind === 'reg' ? values.get(first.index) : undefined;
        const right = second !== undefined && second.kind === 'reg' ? values.get(second.index) : undefined;
        const result =
          left === undefined || right === undefined || left.kind !== 'целое' || right.kind !== 'целое'
            ? undefined
            : compareValues(carrier.mnemonic, left.value, right.value);
        if (result === undefined) values.delete(destination.index);
        else values.set(destination.index, { kind: 'целое', value: result });
      }
      at += 1;
      continue;
    }
    if (carrier.mnemonic === 'IR.add' || carrier.mnemonic === 'IR.sub' || carrier.mnemonic === 'IR.mul') {
      const destination = carrier.operands[0];
      const first = carrier.operands[1];
      const second = carrier.operands[2];
      if (destination !== undefined && destination.kind === 'reg') {
        const left = first !== undefined && first.kind === 'reg' ? values.get(first.index) : undefined;
        const right = second !== undefined && second.kind === 'reg' ? values.get(second.index) : undefined;
        values.delete(destination.index);
        if (left !== undefined && right !== undefined && left.kind === 'целое' && right.kind === 'целое') {
          // Семантика — из `LOWERING` (`src/e2k/e2kRealRun.ts`): `d = a + b`, `a − b`, `a · b`.
          const value =
            carrier.mnemonic === 'IR.add'
              ? left.value + right.value
              : carrier.mnemonic === 'IR.sub'
                ? left.value - right.value
                : left.value * right.value;
          values.set(destination.index, { kind: 'целое', value });
        }
      }
      at += 1;
      continue;
    }

    const written = writtenCells(carrier);
    if (!written.known) {
      values.clear();
      at += 1;
      continue;
    }
    for (const cell of written.cells) values.delete(cell);
    at += 1;
  }
}

/** Результат сравнения по известным числам. */
function compareValues(mnemonic: string, left: number, right: number): number | undefined {
  switch (mnemonic) {
    case 'IR.eq':
      return left === right ? 1 : 0;
    case 'IR.ne':
      return left !== right ? 1 : 0;
    case 'IR.lt':
      return left < right ? 1 : 0;
    case 'IR.le':
      return left <= right ? 1 : 0;
    case 'IR.gt':
      return left > right ? 1 : 0;
    case 'IR.ge':
      return left >= right ? 1 : 0;
    default:
      return undefined;
  }
}

/**
 * ИСХОД ПАРЫ по достигнутым возвратам.
 *
 * Тег не доказан, если разбор не дошёл до возврата, если в возврате тег не число, если ветви сошлись
 * на разных тегах или если хоть одна ветвь вернула значение БЕЗ пары (`IR.ret`): у пары поле нагрузки
 * лежит в клетке канала вызова, и «просто возврат» его туда не кладёт.
 */
function outcomeOf(walk: WalkResult): SiteOutcome {
  if (walk.stopped === 'limit') {
    return {
      at: walk.stoppedAt,
      reason: `тело вызываемой не разобрано: предел разбора (${String(STRING_CALL_WALK_STEPS)} носителей) исчерпан на #${String(walk.stoppedAt)}`,
    };
  }
  if (walk.stopped === 'unknown-predicate') {
    return { at: walk.stoppedAt, reason: `предикат перехода #${String(walk.stoppedAt)} не доказан — ветвь взять нечем, а угадывать запрещено` };
  }
  if (walk.stopped === 'outside') {
    return { at: walk.stoppedAt, reason: `переход #${String(walk.stoppedAt)} уводит за процедуру — разбор ветви невозможен` };
  }
  if (walk.returns.length === 0) {
    return { at: walk.stoppedAt, reason: `тело не дошло до возврата — исхода пары нет` };
  }
  const plain = walk.returns.find((item) => !item.pair);
  if (plain !== undefined) {
    return { at: plain.index, reason: `возврат #${String(plain.index)} отдаёт значение БЕЗ пары («IR.ret») — тега у него нет` };
  }
  const withoutTag = walk.returns.find((item) => item.tag === undefined);
  if (withoutTag !== undefined) {
    return { at: withoutTag.index, reason: `тег возврата #${String(withoutTag.index)} не доказан числом — «наверное, успех» запрещено` };
  }
  const first = walk.returns[0]!;
  const otherTag = walk.returns.find((item) => item.tag !== first.tag);
  if (otherTag !== undefined) {
    return {
      at: otherTag.index,
      reason:
        `ветви расходятся по тегу: #${String(first.index)} — «${String(first.tag)}», ` +
        `#${String(otherTag.index)} — «${String(otherTag.tag)}»`,
    };
  }
  if (walk.returns.length === 1) {
    return {
      tag: first.tag,
      ...(first.payload === undefined ? {} : { payload: first.payload }),
    };
  }
  const withoutPayload = walk.returns.find((item) => item.payload === undefined);
  if (withoutPayload !== undefined) {
    return {
      tag: first.tag,
      at: withoutPayload.index,
      reason: `нагрузка не доказана: ветвь #${String(withoutPayload.index)} отдаёт значение, которого сборка не знает`,
    };
  }
  const otherPayload = walk.returns.find((item) => !sameValue(item.payload, first.payload));
  if (otherPayload !== undefined) {
    return {
      tag: first.tag,
      at: otherPayload.index,
      reason:
        `нагрузка не доказана: ветви #${String(first.index)} и #${String(otherPayload.index)} отдают разные значения ` +
        `(${describeValue(first.payload!)} и ${describeValue(otherPayload.payload!)})`,
    };
  }
  return { tag: first.tag, payload: first.payload };
}

/** Доказать значения на сборке. Ни одного «наверное»: недоказанное называется отказом. */
export function proveStringValues(input: ProveStringValuesInput): StringValueProof {
  const { code, procedures, stringPool } = input;
  const constantValues = input.constantValues;
  const problems: StringValueProblem[] = [];

  if (procedures.length === 0) {
    return {
      parameters: new Map(),
      pairs: new Map(),
      problems: [{ procedure: 0, reason: 'в потоке нет ни одной процедуры: доказывать нечего' }],
      siteValues: new Map(),
    };
  }

  const nameOf = (procedure: number): string => procedures[procedure]?.name ?? `#${String(procedure)}`;
  const bounds = procedures.map((procedure, at) => ({
    from: procedure.codeOffset,
    to: procedures[at + 1]?.codeOffset ?? code.length,
  }));

  /** Индексы пула, про которые ИЗВЕСТНО, что они строки. */
  const stringRecords = new Set<number>();
  if (constantValues !== undefined) {
    constantValues.forEach((raw, index) => {
      if (typeof raw === 'string') stringRecords.add(index);
    });
  } else {
    for (const carrier of code) {
      if (carrier.mnemonic !== 'IR.const') continue;
      const flag = carrier.operands[2];
      const pool = carrier.operands[1];
      if (pool === undefined || pool.kind !== 'imm') continue;
      if (flag !== undefined && flag.kind === 'imm' && flag.value === STRING_CONST_TYPE_FLAG) stringRecords.add(pool.value);
    }
  }
  /** Каноническая запись: МЕНЬШАЯ из записей с теми же БАЙТАМИ (правило 5). */
  const canonical = new Map<string, number>();
  for (const index of [...stringRecords].sort((a, b) => a - b)) {
    const bytes = stringPool[index];
    if (bytes === undefined) continue;
    const digest = bytes.join(',');
    if (!canonical.has(digest)) canonical.set(digest, index);
  }
  const constRecord = (carrier: AsmInstruction): number | undefined => {
    const pool = carrier.operands[1];
    if (pool === undefined || pool.kind !== 'imm' || !stringRecords.has(pool.value)) return undefined;
    const bytes = stringPool[pool.value];
    return bytes === undefined ? undefined : canonical.get(bytes.join(','));
  };
  const constNumber = (carrier: AsmInstruction): number | undefined => {
    if (constantValues === undefined) return undefined;
    const pool = carrier.operands[1];
    if (pool === undefined || pool.kind !== 'imm') return undefined;
    const raw = constantValues[pool.value];
    return typeof raw === 'number' ? raw : undefined;
  };
  const sources: ValueSources = { constRecord, constNumber };

  // ── САЙТЫ ВЫЗОВА ──────────────────────────────────────────────────────────
  const callSites = new Map<number, number[]>();
  code.forEach((carrier, index) => {
    if (carrier.mnemonic !== 'IR.call') return;
    const payload = carrier.operands[3];
    if (payload === undefined || payload.kind !== 'imm') return;
    if (payload.value < 0 || payload.value >= procedures.length) {
      problems.push({
        procedure: procedureOfIndex(procedures, index),
        site: index,
        reason: `«IR.call»: индекс процедуры ${String(payload.value)} вне модуля (процедур ${String(procedures.length)})`,
      });
      return;
    }
    const sites = callSites.get(payload.value) ?? [];
    sites.push(index);
    callSites.set(payload.value, sites);
  });
  /** Носитель `IR.result_pick`, читающий пару сайта: якорь = приёмник тега того же вызова. */
  const pickOfCall = (callIndex: number): number | undefined => {
    const call = code[callIndex];
    if (call === undefined) return undefined;
    const flags = call.operands[0];
    const destination = call.operands[4];
    if (flags === undefined || flags.kind !== 'imm' || (flags.value & 1) !== 1) return undefined;
    if (destination === undefined || destination.kind !== 'reg') return undefined;
    for (let at = callIndex + 1; at < code.length; at += 1) {
      const carrier = code[at];
      if (carrier === undefined) break;
      if (carrier.mnemonic !== 'IR.result_pick') break; // пары стоят ПОДРЯД (`resultLowering.test.ts`)
      const anchor = carrier.operands[1];
      if (anchor !== undefined && anchor.kind === 'reg' && anchor.index === destination.index) return at;
    }
    return undefined;
  };

  // ── ПРАВО ИСКАТЬ ──────────────────────────────────────────────────────────
  const paramCandidates = (procedure: number): number[] => {
    const declared = input.paramTypes?.[procedure];
    if (declared !== undefined) {
      const cells: number[] = [];
      declared.forEach((type, cell) => {
        if (type === STRING_TYPE_NAME || type === NUMBER_TYPE_NAME) cells.push(cell);
      });
      return cells;
    }
    let arity = 0;
    for (const site of callSites.get(procedure) ?? []) {
      const carrier = code[site];
      if (carrier !== undefined) arity = Math.max(arity, callArity(carrier));
    }
    return Array.from({ length: arity }, (_, cell) => cell);
  };
  /** Отказ сопровождает только СТРОКОВЫЕ клетки: значение числа план не подставляет. */
  const stringCandidates = (procedure: number): number[] => {
    const declared = input.paramTypes?.[procedure];
    if (declared === undefined) return paramCandidates(procedure);
    const cells: number[] = [];
    declared.forEach((type, cell) => {
      if (type === STRING_TYPE_NAME) cells.push(cell);
    });
    return cells;
  };

  /** Прочитать тело вызываемой с ЗАДАННЫМ входом и получить исход пары. */
  const interpret = (
    procedure: number,
    entry: ReadonlyMap<number, ProvenValue>,
    outcomes: ReadonlyMap<number, CallFact>,
  ): SiteOutcome =>
    outcomeOf(
      walkBody({
        ...sources,
        code,
        from: bounds[procedure]!.from,
        to: bounds[procedure]!.to,
        entry,
        outcomes,
        followJumps: true,
        limit: STRING_CALL_WALK_STEPS,
      }),
    );

  // ── НЕПОДВИЖНАЯ ТОЧКА ─────────────────────────────────────────────────────
  let state: ProofState = { params: new Map(), outcomes: new Map() };
  let limitHit = false;
  let walks: WalkResult[] = [];
  let callStates: ReadonlyMap<number, ReadonlyMap<number, ProvenValue>> = new Map();
  let siteOutcomes = new Map<number, SiteOutcome>();
  /** Значения всех сайтов по клеткам: заполняется КАЖДЫЙ раунд, наружу идёт последний (TD-0001). */
  const collectedSiteValues = new Map<string, readonly ProvenValue[]>();
  for (let round = 0; round < STRING_VALUE_PROOF_ROUNDS; round += 1) {
    const entryOf = (procedure: number): Map<number, ProvenValue> => {
      const entry = new Map<number, ProvenValue>();
      for (const cell of paramCandidates(procedure)) {
        const fact = state.params.get(keyOf(procedure, cell));
        if (fact !== undefined && fact.kind === 'value') entry.set(cell, fact.value);
      }
      return entry;
    };
    // ЛИНЕЙНЫЙ проход: факты по процедуре и состояние на её сайтах вызова.
    walks = procedures.map((_, procedure) =>
      walkBody({
        ...sources,
        code,
        from: bounds[procedure]!.from,
        to: bounds[procedure]!.to,
        entry: entryOf(procedure),
        outcomes: state.outcomes,
        followJumps: false,
        limit: code.length + 1,
      }),
    );
    const collectedCallStates = new Map<number, ReadonlyMap<number, ProvenValue>>();
    for (const walk of walks) for (const [at, cells] of walk.callStates) collectedCallStates.set(at, cells);
    callStates = collectedCallStates;

    // ИСХОД КАЖДОГО САЙТА: тело вызываемой исполняется по значениям ЭТОГО сайта.
    const outcomes = new Map<number, CallFact>();
    siteOutcomes = new Map<number, SiteOutcome>();
    const cache = new Map<string, SiteOutcome>();
    for (const [callee, sites] of callSites) {
      for (const site of sites) {
        const entry = new Map<number, ProvenValue>(callStates.get(site) ?? []);
        const digest = `${String(callee)}|${[...entry.entries()]
          .map(([cell, value]) => `${String(cell)}=${describeValue(value)}`)
          .sort()
          .join(';')}`;
        let outcome = cache.get(digest);
        if (outcome === undefined) {
          outcome = interpret(callee, entry, state.outcomes);
          cache.set(digest, outcome);
        }
        siteOutcomes.set(site, outcome);
        if (outcome.tag !== undefined) outcomes.set(site, { tag: outcome.tag, ...(outcome.payload === undefined ? {} : { payload: outcome.payload }) });
      }
    }

    const next: ProofState = {
      params: deriveParams({ callSites, paramCandidates, callStates, siteValues: collectedSiteValues }),
      outcomes,
    };
    const stable = sameState(next, state);
    state = next;
    if (stable) break;
    if (round === STRING_VALUE_PROOF_ROUNDS - 1) limitHit = true;
  }

  // ── ВЫХОД ─────────────────────────────────────────────────────────────────
  const parameters = new Map<number, ReadonlyMap<number, number>>();
  for (const [pair, fact] of state.params) {
    if (fact.kind !== 'value' || fact.value.kind !== 'строка') continue;
    const [procedure, cell] = pair.split(':').map(Number) as [number, number];
    const cells = new Map(parameters.get(procedure) ?? []);
    cells.set(cell, fact.value.pool);
    parameters.set(procedure, cells);
  }

  // МНОЖЕСТВА ЗНАЧЕНИЙ ПО САЙТАМ — НАРУЖУ (TD-0001): свёртка уже сделана, знание множества осталось.
  const siteValues = new Map<number, ReadonlyMap<number, readonly ProvenValue[]>>();
  for (const [pair, values] of collectedSiteValues) {
    const [procedure, cell] = pair.split(':').map(Number) as [number, number];
    const cells = new Map(siteValues.get(procedure) ?? []);
    cells.set(cell, values);
    siteValues.set(procedure, cells);
  }

  // Пары — по ПОСЛЕДНЕМУ (правдивому) состоянию, с причинами по каждому сайту.
  const pairs = new Map<number, PairOutcome>();
  for (const [callee, sites] of [...callSites.entries()].sort((a, b) => a[1][0]! - b[1][0]!)) {
    for (const site of sites) {
      const entry = new Map<number, ProvenValue>(callStates.get(site) ?? []);
      const outcome = interpret(callee, entry, state.outcomes);
      const pickIndex = pickOfCall(site);
      if (pickIndex === undefined) continue;
      if (outcome.tag === undefined) {
        problems.push({
          procedure: procedureOfIndex(procedures, site),
          site: pickIndex,
          reason:
            `пара на сайте #${String(site)} (вызываемая «${String(nameOf(callee))}»): ` +
            (outcome.reason ?? 'нагрузка не доказана'),
        });
        continue;
      }
      pairs.set(pickIndex, { tag: outcome.tag, ...(outcome.payload === undefined ? {} : { payload: outcome.payload }) });
      if (outcome.payload === undefined && outcome.reason !== undefined) {
        problems.push({
          procedure: procedureOfIndex(procedures, site),
          site: pickIndex,
          reason:
            `тег пары на сайте #${String(site)} доказан («${outcome.tag}»), а нагрузка — нет: ${outcome.reason}`,
        });
      }
    }
  }

  procedures.forEach((_, procedure) => {
    for (const cell of stringCandidates(procedure)) {
      const fact = state.params.get(keyOf(procedure, cell));
      if (fact !== undefined && fact.kind === 'value' && fact.value.kind === 'строка') continue;
      problems.push({
        procedure,
        register: cell,
        reason: parameterReason({
          procedure,
          cell,
          fact: fact !== undefined && fact.kind === 'value' ? undefined : fact,
          sites: callSites.get(procedure) ?? [],
          callStates,
          nameOf,
        }),
      });
    }
  });
  if (limitHit) {
    problems.push({
      procedure: 0,
      reason:
        `предел итераций (${String(STRING_VALUE_PROOF_ROUNDS)}) исчерпан: доказательство не сошлось — ` +
        'цепочка «параметр → копия → аргумент» длиннее предела, значения не доказаны',
    });
  }
  return { parameters, pairs, problems, siteValues };
}

/** Параметры: по ВСЕМ сайтам сразу — «первый» и «большинство» запрещены (правило 2). */
function deriveParams(options: {
  readonly callSites: ReadonlyMap<number, readonly number[]>;
  readonly paramCandidates: (procedure: number) => number[];
  readonly callStates: ReadonlyMap<number, ReadonlyMap<number, ProvenValue>>;
  /**
   * СЮДА СКЛАДЫВАЮТСЯ ЗНАЧЕНИЯ ВСЕХ САЙТОВ (TD-0001) — для клеток, у которых ИЗВЕСТНЫ ВСЕ сайты.
   *
   * Ключ тот же (`keyOf`), значение — список в порядке сайтов. Складывается КАЖДЫЙ раунд: наружу
   * уйдёт последний, то есть тот, на котором сошлась неподвижная точка (так же поступает `params`).
   */
  readonly siteValues: Map<string, readonly ProvenValue[]>;
}): Map<string, Fact> {
  const params = new Map<string, Fact>();
  for (const [callee, sites] of options.callSites) {
    for (const cell of options.paramCandidates(callee)) {
      const values: ProvenValue[] = [];
      let unknown = false;
      for (const site of sites) {
        const value = options.callStates.get(site)?.get(cell);
        if (value === undefined) unknown = true;
        else values.push(value);
      }
      if (unknown || values.length === 0) continue;
      // ЗНАНИЯ МНОЖЕСТВА ХВАТАЕТ, КОГДА САЙТЫ РАЗОШЛИСЬ: складывается ДО свёртки в один факт.
      options.siteValues.set(keyOf(callee, cell), values);
      const first = values[0]!;
      const other = values.find((value) => !sameValue(value, first));
      if (other === undefined) params.set(keyOf(callee, cell), { kind: 'value', value: first });
      else params.set(keyOf(callee, cell), { kind: 'conflict', first, second: other });
    }
  }
  return params;
}

/** Состояние не изменилось — неподвижная точка найдена. */
function sameState(a: ProofState, b: ProofState): boolean {
  if (a.params.size !== b.params.size || a.outcomes.size !== b.outcomes.size) return false;
  for (const [at, fact] of a.params) {
    const other = b.params.get(at);
    if (other === undefined || other.kind !== fact.kind) return false;
    if (fact.kind === 'value' && other.kind === 'value' && !sameValue(fact.value, other.value)) return false;
  }
  for (const [at, fact] of a.outcomes) {
    const other = b.outcomes.get(at);
    if (other === undefined || other.tag !== fact.tag || !sameValue(other.payload, fact.payload)) return false;
  }
  return true;
}

/** Процедура, которой принадлежит носитель: последняя, чьё смещение не больше индекса. */
function procedureOfIndex(procedures: readonly ProcedureOffset[], index: number): number {
  let found = 0;
  procedures.forEach((procedure, at) => {
    if (procedure.codeOffset <= index) found = at;
  });
  return found;
}

/** Причина «параметр не доказан» — НАЗВАННАЯ, с номерами сайтов. */
function parameterReason(options: {
  readonly procedure: number;
  readonly cell: number;
  readonly fact: Fact | undefined;
  readonly sites: readonly number[];
  readonly callStates: ReadonlyMap<number, ReadonlyMap<number, ProvenValue>>;
  readonly nameOf: (procedure: number) => string;
}): string {
  const name = options.nameOf(options.procedure);
  if (options.fact !== undefined && options.fact.kind === 'conflict') {
    return (
      `параметр ${String(options.cell)} процедуры «${String(name)}»: сайты вызова передают РАЗНЫЕ значения ` +
      `(${describeValue(options.fact.first)} и ${describeValue(options.fact.second)}) — «взять первое» запрещено`
    );
  }
  if (options.sites.length === 0) {
    return `параметр ${String(options.cell)} процедуры «${String(name)}»: процедуру никто не зовёт — значения параметра взять неоткуда`;
  }
  const unknown = options.sites.find((site) => options.callStates.get(site)?.get(options.cell) === undefined);
  if (unknown !== undefined) {
    return (
      `параметр ${String(options.cell)} процедуры «${String(name)}»: сайт #${String(unknown)} передаёт значение, ` +
      'которого сборка не знает — содержимое строки известно не для всех вызовов, развёртка рантайма не сделана'
    );
  }
  return (
    `параметр ${String(options.cell)} процедуры «${String(name)}»: значение не доказано — ` +
    'ни один сайт не передал запись пула, известную сборке'
  );
}

/**
 * ТЕКСТЫ ДОКАЗАННЫХ СТРОК — мост к `StringTypeFacts` (`src/e2k/stringPlan.ts`).
 *
 * План берёт значения текстом, доказательство — записями пула: перевод делает эта функция, а не каждый
 * читатель по-своему (иначе два перевода однажды разойдутся).
 */
export function proofTexts(
  proof: StringValueProof,
  stringPool: readonly (readonly number[])[],
): { readonly parameters: ReadonlyMap<number, ReadonlyMap<number, string>> } {
  const text = (record: number): string => Buffer.from(stringPool[record] ?? []).toString('utf-8');
  const parameters = new Map<number, ReadonlyMap<number, string>>();
  for (const [procedure, cells] of proof.parameters) {
    const texts = new Map<number, string>();
    for (const [cell, record] of cells) texts.set(cell, text(record));
    parameters.set(procedure, texts);
  }
  return { parameters };
}
