/**
 * Кодоген регистрового бэкенда: AST → {@link RegModule}.
 *
 * Стоит **рядом** с `src/compiler/codegen.ts` и повторяет его семантику операция
 * за операцией — так оракул (`src/oracle/parity.ts`) сравнивает две реализации
 * одной семантики, а не две разные семантики. Стековый кодоген при этом не
 * меняется: он остаётся эталоном и bootstrap для self-host.
 *
 * ## Раскладка значений
 *
 * - Переменная (параметр или `пусть`) занимает **фиксированный** vreg
 *   `0..localsCount-1`: `localToVreg`. `local.get`/`local.set` исчезают.
 * - Временные значения выражений берут vreg'и **выше** `localsCount` по принципу
 *   «отметка → выделение → освобождение» ({@link RegAllocator}); порядок обхода
 *   AST детерминирован, поэтому высокий уровень воды — это `vregs` процедуры.
 * - Переменная как выражение (`вернуть x`) отдаёт свой регистр **без копии**:
 *   регистры переменных в этом срезе не переиспользуются под временные.
 *
 * ## Срез
 *
 * Поддержано: числа/строки/булево/пусто, переменные, арифметика и сравнения,
 * `и`/`или` с коротким замыканием, `не`, вызовы процедур и `invoke`, `пусть`,
 * `присвоить`, `выражение`, `вернуть`, `если`/`иначе если`/`иначе`, `пока`,
 * `цикл`, `прервать`, `продолжить`, `для_каждого` (элемент, индекс,
 * вложенность), литералы массивов и объектов, `объект.поле`, `поле_присвоить`,
 * кортежи (`вернуть a, b`), `распаковать` (`пусть x, y = вызов()`),
 * `попробовать` / `иначе_попытка` (алиас `поймать`) / `выбросить`.
 *
 * Полный паритет со стековой VM проверяется оракулом на корпусе
 * `src/runtime/fixtures/reg-parity/` и на всех фикстурах проекта:
 * `src/oracle/parity.test.ts` + `npx tsx src/cli.ts parity <файл>`.
 *
 * ## Два прохода и служебные ячейки
 *
 * Адреса меток `прервать`/`продолжить` известны только после тела цикла, но
 * холостой замер и настоящая генерация обязаны получить **одни и те же** номера
 * регистров. Отсюда два инварианта:
 *
 * 1. Замер (`measuring`) не эмитит инструкции и не патчит адреса.
 * 2. Нумерация служебных ячеек `для_каждого` (`__forEach_src/len/i_N`) — это
 *    вложенность по AST, и счётчик увеличивает **только** сам `для_каждого`
 *    (ровно как в `buildLocals`): сиблинги в разных ветках получают одну тройку,
 *    вложенные — разные. Замер тела не увеличивает счётчик, поэтому вложенный
 *    цикл внутри чужого замера получает тот же номер, что и на своём проходе.
 */

import type { Module, Procedure, Program, Stmt, Expr } from "./ast";
import { compileProgram as compileProgramToStack } from "./codegen";
import {
  REGCODE_IR,
  REGCODE_VERSION,
  type RegConstType,
  type RegInstruction,
  type RegModule,
  type RegOp,
  type RegProcedure,
} from "../runtime/vm/regcode";

/** Ошибка регистрового кодогена: конструкция вне поддержанного среза. */
export class RegCodegenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegCodegenError";
  }
}

/**
 * Порядок разворота литерала массива.
 *
 * `create-first` — массив раньше значений (исторический, умолчание: на нём стоит эталонная
 * плоскость и её пошаговый паритет со стековой VM).
 * `values-first` — значения раньше массива (требование ПЛОСКОСТИ ЦЕЛИ: куча массивов там — один
 * растущий указатель, и блок, созданный между `создать` и `добавить`, затирается первым же
 * элементом родителя). Разбор и замер — у `ProcedureCodegen#emitArrayLiteral`.
 */
export type ArrayLiteralOrder = 'create-first' | 'values-first';

/** Соответствие «оператор языка → регистровый опкод» (совпадает со стековым набором). */
const REG_BINARY_OP: Record<string, RegOp> = {
  "+": "add",
  "-": "sub",
  "*": "mul",
  "/": "div",
  "%": "rem",
  // БЛОК 2: целочисленное деление — свой регистровый опкод (см. `regcode.ts`).
  "div": "idiv",
  "==": "eq",
  "!=": "ne",
  "<": "lt",
  "<=": "le",
  ">": "gt",
  ">=": "ge",
};

/** Операции с эффектом: их результат не наблюдается. */
const EFFECT_ONLY_INVOKES = new Set(["система.массив.добавить", "система.хранилище.записать"]);

/**
 * Распределение временных регистров: отметка → выделение → освобождение.
 * `highWater` — сколько ячеек реально понадобилось процедуре.
 */
export class RegAllocator {
  private next: number;
  private highWater: number;

  constructor(private readonly base: number) {
    this.next = base;
    this.highWater = base;
  }

  /** Отметка для отката (значение `next` до серии выделений). */
  mark(): number {
    return this.next;
  }

  /** Выделить регистр. */
  alloc(): number {
    const reg = this.next++;
    if (this.next > this.highWater) this.highWater = this.next;
    return reg;
  }

  /** Освободить всё, выделенное после отметки. */
  freeTo(mark: number): void {
    if (mark < this.base) {
      throw new RegCodegenError(`Отметка аллокатора ниже базы: ${mark} < ${this.base}`);
    }
    this.next = mark;
  }

  /** Текущая вершина выделения: столько же, что вернёт следующий `mark()`. */
  allocated(): number {
    return this.next;
  }

  /** Сколько ячеек нужно процедуре (не меньше базы: переменные занимают 0..base-1). */
  vregs(): number {
    return Math.max(this.highWater, this.base);
  }
}

function assertNever(x: never, ctx: string): never {
  throw new RegCodegenError(`regcodegen: непокрытый узел (${ctx})`);
}

/**
 * Литеральные значения, которые кодоген умеет писать **прямо** в произвольный
 * регистр, не занимая временный: тогда `пусть x = 7` даёт один `const` в регистр
 * `x` вместо «временный + `move`». Для остальных выражений значение вычисляется
 * во временном регистре и переносится в переменную одной копией.
 */
function isLiteral(expr: Expr): boolean {
  switch (expr.kind) {
    case "число":
    case "строка":
    case "булево":
    case "пусто":
    case "вариант":
      return true;
    default:
      return false;
  }
}

function regConstType(value: unknown): RegConstType {
  if (typeof value === "number") return Number.isInteger(value) ? "i32" : "f64";
  if (typeof value === "string") return "str";
  if (typeof value === "boolean") return "bool";
  return "null";
}

/**
 * Таблица переменных процедуры: имя → фиксированный vreg.
 *
 * Нумерация служебных ячеек `для_каждого` (`__forEach_src/len/i_N`) — та же, что
 * в стековом кодогене: счётчик вложенности идёт по AST слева-направо, включая
 * циклы в условиях `пока`/`если` (там порядок обхода — условие, затем тело).
 * Кодоген обязан повторить ровно этот порядок — см. `enterLoop`/`exitLoop`.
 */
function buildLocals(proc: Procedure): Map<string, number> {
  const locals = new Map<string, number>();
  let next = 0;
  let forCounter = 0;
  const declare = (name: string): void => {
    if (!locals.has(name)) locals.set(name, next++);
  };

  proc.params.forEach(declare);

  function scanExpr(_expr: Expr): void {
    // Значения выражений живут во временных регистрах, объявлять нечего:
    // выражения не заводят новых переменных.
    return;
  }

  function scan(stmts: Stmt[]): void {
    for (const s of stmts) {
      switch (s.kind) {
        case "пусть":
          scanExpr(s.init);
          declare(s.name);
          break;
        case "присвоить":
          scanExpr(s.value);
          break;
        case "поле_присвоить":
          scanExpr(s.object);
          scanExpr(s.value);
          break;
        case "выражение":
          scanExpr(s.expr);
          break;
        case "если":
          scanExpr(s.condition);
          scan(s.body);
          if (s.elseIfClauses) {
            for (const c of s.elseIfClauses) {
              scanExpr(c.condition);
              scan(c.body);
            }
          }
          if (s.elseBody) scan(s.elseBody);
          break;
        case "пока":
          scanExpr(s.condition);
          scan(s.body);
          break;
        case "цикл":
          scan(s.body);
          break;
        case "для_каждого": {
          const depth = forCounter++;
          declare(s.item);
          if (s.index !== undefined) declare(s.index);
          declare(`__forEach_src_${depth}`);
          declare(`__forEach_len_${depth}`);
          declare(`__forEach_i_${depth}`);
          scanExpr(s.source);
          scan(s.body);
          break;
        }
        case "распаковать":
          scanExpr(s.значение);
          for (const имя of s.имена) declare(имя);
          break;
        case "попробовать":
          declare(s.catchVar);
          scan(s.body);
          scan(s.catchBody);
          break;
        case "выбросить":
          scanExpr(s.value);
          break;
        case "вернуть":
          if (s.value) scanExpr(s.value);
          break;
        default:
          break;
      }
    }
  }

  scan(proc.body);
  return locals;
}

/** Всё, что регистровый кодоген этого среза не берёт — с явной причиной. */
function unsupported(kind: string, hint: string): never {
  throw new RegCodegenError(
    `Регистровый бэкенд (срез 1) не поддерживает ${kind}. ${hint}`,
  );
}

/**
 * ИМЯ ТИПА-ПАРЫ. Одно место на весь кодоген: `Результат<Т, Е>` — это не «просто тип», а признак
 * того, что возврат несёт ДВА значения (тег и нагрузка, `docs/abi-v3-draft.md` §10.2).
 */
const ИМЯ_ПАРЫ = "Результат";

/**
 * Процедуры, возвращающие пару `Результат<Т, Е>`.
 *
 * Нужен вызывающему ПО ИМЕНИ процедуры: узел `вызов` в AST имени типа не несёт, а без этого признака
 * пара читалась бы как обычное значение — то есть нагрузка терялась бы молча, и программа считала бы
 * по тегу как по значению (класс «тихая ложь»).
 */
function pairReturningNames(ast: Module): Set<string> {
  const имена = new Set<string>();
  for (const proc of ast.procedures) {
    if (proc.returnType?.name === ИМЯ_ПАРЫ) имена.add(proc.name);
  }
  return имена;
}

class ProcedureCodegen {
  private readonly constants: unknown[];
  private readonly code: RegInstruction[];
  private readonly allocator: RegAllocator;
  private readonly locals: Map<string, number>;
  private readonly procedureIndex: ReadonlyMap<string, number>;
  private returnsValue = false;
  /** Цели `прервать` (патчатся на конец цикла), вложенность — стек. */
  private readonly breakTargets: Array<{ patches: number[] }> = [];
  /** Цели `продолжить`: у `для_каждого` — на инкремент, у остальных — на условие. */
  private readonly continueTargets: Array<{ loopStart: number; forEachPatches?: number[] }> = [];

  constructor(
    private readonly proc: Procedure,
    code: RegInstruction[],
    constants: unknown[],
    procedureIndex: ReadonlyMap<string, number>,
    /** Процедуры, возвращающие пару `Результат<Т, Е>`: без этого признака пара неотличима от значения. */
    private readonly pairReturning: ReadonlySet<string> = new Set<string>(),
    /**
     * ПАРА ПРИХОДИТ КАНАЛОМ ВЫЗОВА (плоскость ЦЕЛИ, `docs/abi-v3-draft.md` §10.2).
     *
     * `false` (умолчание) — эталонная плоскость: нагрузку отдаёт сам вызов, интерпретатор кладёт её
     * прямым приёмником. `true` — цель: тег читает носитель вызова, а нагрузку переносит из оконной
     * клетки `2·wbs + 1` инструкция `result_pick`. Довод отдельный, потому что окон у VM нет, а
     * угадывать плоскость по имени процедуры — тот же класс ошибки, что «форма зависит от плоскости».
     */
    private readonly pairInWindow: boolean = false,
    /** Порядок разворота литерала массива — см. {@link ArrayLiteralOrder}. */
    private readonly arrayLiteralOrder: ArrayLiteralOrder = 'create-first',
  ) {
    this.code = code;
    this.constants = constants;
    this.locals = buildLocals(proc);
    this.procedureIndex = procedureIndex;
    const localsCount = Math.max(this.locals.size, proc.params.length);
    this.allocator = new RegAllocator(localsCount);
  }

  /** Имя переменной → vreg (для отладочной карты артефакта). */
  localToVreg(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [name, reg] of this.locals) out[name] = reg;
    return out;
  }

  /** Сгенерировать тело процедуры; возвращает её метаданные. */
  generate(): { codeOffset: number; vregs: number; returnsValue: boolean } {
    const codeOffset = this.code.length;
    for (const s of this.proc.body) this.emitStmt(s);
    // Падение с конца: как в стековом кодогене — процедура отдаёт «пусто».
    this.emit({ op: "ret" });
    return {
      codeOffset,
      vregs: this.allocator.vregs(),
      returnsValue: this.returnsValue,
    };
  }

  // ─── низкий уровень ────────────────────────────────────────────────────

  /** Добавить инструкцию в общий поток кода модуля. */
  private emit(ins: RegInstruction): void {
    // Холостой проход (`measuring`) считает только регистры: инструкции в код
    // не попадают, иначе тело цикла оказалось бы в артефакте дважды.
    if (this.measuring) return;
    this.code.push(ins);
  }

  /** Текущая позиция в коде. */
  private here(): number {
    return this.code.length;
  }

  private constIndex(value: unknown): number {
    let i = this.constants.indexOf(value);
    if (i < 0) {
      i = this.constants.length;
      this.constants.push(value);
    }
    return i;
  }

  private vregOf(name: string): number {
    const reg = this.locals.get(name);
    if (reg === undefined) {
      throw new RegCodegenError(`Неизвестная переменная: ${name}`);
    }
    return reg;
  }

  private alloc(): number {
    return this.allocator.alloc();
  }

  // ─── выражения ─────────────────────────────────────────────────────────

  /** Выражение в свежий временный регистр. */
  private emitExpr(expr: Expr): number {
    const d = this.alloc();
    this.emitInto(expr, d);
    return d;
  }

  /**
   * Выражение прямо в целевой регистр там, где он уже известен (`пусть x = …`,
   * `присвоить x = …`). Для простых узлов это убирает лишний `move`; для
   * остальных поведение то же, что {@link emitExpr} + копия.
   */
  /**
   * Значение выражения в переменную: литерал пишется прямо в её регистр,
   * остальное вычисляется во временном регистре и переносится одной копией.
   */
  private emitIntoVariable(expr: Expr, target: number): void {
    if (isLiteral(expr)) {
      this.emitInto(expr, target);
      return;
    }
    const value = this.emitExpr(expr);
    if (value !== target) this.emit({ op: "move", d: target, a: value });
  }

  /**
   * Выражение в конкретный регистр `d`.
   * Для `и`/`или` это то, что нужно: обе ветки короткого замыкания сходятся в `d`.
   */
  private emitInto(expr: Expr, d: number): void {
    switch (expr.kind) {
      case "число": {
        this.emit({ op: "const", d, type: regConstType(expr.value), k: this.constIndex(expr.value) });
        return;
      }
      case "строка": {
        this.emit({ op: "const", d, type: "str", k: this.constIndex(expr.value) });
        return;
      }
      // ЛОГИЧЕСКИЕ И ПУСТОЙ ЛИТЕРАЛЫ ИДУТ ЧЕРЕЗ ПУЛ, как числа и строки, а не своими операциями
      // `const.true`/`const.false`/`const.null`. Причина измерена 2026-10-10: у этих трёх операций
      // НЕТ НОСИТЕЛЯ ни в одной оболочке — так и записано в `src/e2k/emitterShell.ts` («литеральные
      // константы языка отражаются через пул (`const`), отдельного носителя нет»), — и потому любая
      // программа с `и`/`или`/`нет` (короткое замыкание заводит временную булеву) не собиралась на
      // цель вовсе: останов `const.false` вместо понижения. Пул умеет `bool` и `null` с самого
      // начала (`CONST_TYPES`), виртуальные машины читают значение по индексу (`constants[k]`).
      case "булево":
        this.emit({ op: "const", d, type: "bool", k: this.constIndex(expr.value) });
        return;
      case "пусто":
        this.emit({ op: "const", d, type: "null", k: this.constIndex(null) });
        return;
      case "вариант": {
        const lit = `${expr.typeName}.${expr.variant}`;
        this.emit({ op: "const", d, type: regConstType(lit), k: this.constIndex(lit) });
        return;
      }
      case "переменная": {
        const src = this.vregOf(expr.name);
        if (src !== d) this.emit({ op: "move", d, a: src });
        return;
      }
      case "бинарное":
        this.emitBinaryInto(expr, d);
        return;
      case "унарное": {
        // В AST унарный оператор только один — `не` (см. `Expr` в ast.ts).
        // Новый оператор сюда не попадёт молча: TypeScript заставит дополнить
        // этот `switch` (case исчерпывающий по типу).
        const mark = this.allocator.mark();
        const arg = this.emitExpr(expr.arg);
        // Семантика стековой VM: `не x` → `x == false`.
        const same = this.emitExpr({ kind: "булево", value: false });
        this.emit({ op: "eq", d, a: arg, b: same });
        this.allocator.freeTo(mark);
        return;
      }
      case "вызов": {
        // ПАРА КАК ЗНАЧЕНИЕ — НАЗВАННЫЙ ОТКАЗ, а не половина ответа. У вызова, возвращающего
        // `Результат<Т, Е>`, два места: тег и нагрузка. Взятое «как значение» оно отдало бы ОДНО
        // место, и потерянным оказалось бы ровно то, ради чего пара заведена (§10.2, D4).
        if (!expr.name.includes(".") && this.pairReturning.has(expr.name)) {
          throw new RegCodegenError(
            `«${expr.name}» возвращает пару Результат<>: её разбирают ДВУМЯ именами — ` +
              `«пусть тег, нагрузка = ${expr.name}(…)», — а как одно значение она не берётся: ` +
              "второе место пары потерялось бы молча",
          );
        }
        this.emitCallInto(expr, d);
        return;
      }
      // КОНСТРУКТОР ПАРЫ вне возврата. Канон строит пару возвратом (`вернуть Успех(…)`), и это не
      // узость ради узости: место пары — канал вызова, а не значение процедуры. Отказ по имени
      // честнее подстановки: «пусть р = Успех(5)» некуда положить второе место.
      case "успех":
      case "неудача":
        throw new RegCodegenError(
          `«${expr.kind === "успех" ? "Успех" : "Неудача"}» строится только возвратом: ` +
            "«вернуть Успех(значение)» в процедуре, объявленной «→ Результат<Т, Е>»",
        );
      case "массив": {
        this.emitArrayLiteral(expr.elements, d);
        return;
      }
      case "объект": {
        this.emitObjectLiteral(expr.entries, d);
        return;
      }
      case "поле": {
        const mark = this.allocator.mark();
        const obj = this.emitExpr(expr.object);
        const key = this.emitExpr({ kind: "строка", value: expr.field });
        this.emit({ op: "obj.get", d, a: obj, key });
        this.allocator.freeTo(mark);
        return;
      }
      case "кортеж": {
        // Кортеж — тот же массив (как в стековом кодогене): `вернуть a, b`.
        this.emitArrayLiteral(expr.элементы, d);
        return;
      }
      default:
        assertNever(expr, "RegProcedure.emitInto");
    }
  }

  private emitBinaryInto(expr: Expr & { kind: "бинарное" }, d: number): void {
    // Короткое замыкание: сохраняем семантику стековой VM (левое значение как
    // результат), но без стека — результат сходится в `d`.
    if (expr.op === "и") {
      this.emitInto(expr.left, d);
      const patch = this.here();
      this.emit({ op: "jmp_if_not", off: 0, cond: d });
      this.emitInto(expr.right, d);
      const end = this.here();
      this.patch(patch, end);
      return;
    }
    if (expr.op === "или") {
      this.emitInto(expr.left, d);
      const patch = this.here();
      this.emit({ op: "jmp_if", off: 0, cond: d });
      this.emitInto(expr.right, d);
      const end = this.here();
      this.patch(patch, end);
      return;
    }
    const op = REG_BINARY_OP[expr.op];
    if (op === undefined) {
      throw new RegCodegenError(`Неподдерживаемый бинарный оператор: ${expr.op}`);
    }
    const mark = this.allocator.mark();
    const a = this.emitExpr(expr.left);
    const b = this.emitExpr(expr.right);
    this.emit({ op, d, a, b } as RegInstruction);
    this.allocator.freeTo(mark);
  }

  /**
   * Вызов процедуры. `d2` — ВТОРОЕ место результата: нагрузка пары `Результат<Т, Е>`.
   *
   * У эталонной плоскости это второе место регистра, у цели — соседняя клетка канала вызова
   * (`docs/abi-v3-draft.md` §10.2: тег `2·wbs`, нагрузка `2·wbs + 1`). Отдельным доводом, а не
   * вторым вызовом: аргументы обязаны вычисляться ОДИН раз.
   */
  private emitCallInto(expr: Expr & { kind: "вызов" }, d: number, d2?: number): void {
    const mark = this.allocator.mark();
    const args: number[] = [];
    for (const arg of expr.args) args.push(this.emitExpr(arg));
    if (expr.name.includes(".")) {
      if (d2 !== undefined) {
        throw new RegCodegenError(
          `«${expr.name}» — системный вызов, а пару Результат<> отдаёт только процедура модуля`,
        );
      }
      // Системный вызов: результат в `d`. Пометка «операция с эффектом» в этом
      // срезе не влияет на семантику (регистр-приёмник всё равно нужен для
      // `pop`-семантики стековой VM) — набор оставлен как место для оптимизаций.
      void EFFECT_ONLY_INVOKES;
      this.emit({ op: "invoke", d, name: expr.name, args, argc: args.length });
      this.allocator.freeTo(mark);
      return;
    }
    const fi = this.procedureIndex.get(expr.name);
    if (fi === undefined) {
      throw new RegCodegenError(`Неизвестная процедура: ${expr.name}`);
    }
    this.emit({ op: "call", d, d2, fi, args, argc: args.length });
    this.allocator.freeTo(mark);
  }

  /**
   * Литерал массива. Порядок «значения или массив первым» — не стиль, а РАЗНЫЕ ТРЕБОВАНИЯ ПЛОСКОСТЕЙ.
   *
   * `create-first` (умолчание) — массив создаётся до вычисления элементов. Так разворот устроен с
   * самого начала, и на нём стоит ЭТАЛОННАЯ плоскость: оракул паритета (`src/oracle/parity.ts`)
   * сверяет трассу регистровой VM со стековой ПОШАГОВО, а стековая создаёт массив первым. Смена
   * порядка на этой плоскости покраснила бы паритет, а за ним — закреплённые позиции читателей
   * (`src/vliw/regGraphWar.test.ts`, `docs/e2k-array-literals.md`). На VM литерал массива — объект
   * языка, и порядок там наблюдаем только трассой.
   *
   * `values-first` — элементы вычисляются до создания массива. Этого требует ЦЕЛЬ и только она:
   * куча массивов там — ОДИН растущий вверх указатель, а адрес элемента считается как
   * `массив + 8 + индекс*8`, то есть элементы обязаны лежать вплотную за заголовком. Если массив
   * создать первым, любой элемент, который сам создаёт массив (вложенная запись
   * `{ начало: { х: 1, у: 2 } }`), выделит свой блок В ПРОМЕЖУТКЕ — и первый же `добавить` родителя
   * запишет в него. Замер до правки (`.tmp/probe-nested-record.ts`): `о.начало.х` давало **40** —
   * адрес второго вложенного блока, затёрший первый элемент первого, при верных `о.начало.у` (2) и
   * `о.финиш.*` (3 и 4); литерал, собранный ОТДЕЛЬНЫМ оператором, читался верно и до правки.
   *
   * `values-first` зовёт ровно один: `src/e2k/recordPlan.ts#regModuleWithRecordPlan` — плоскость цели.
   */
  private emitArrayLiteral(elements: Expr[], d: number): void {
    const mark = this.allocator.mark();
    if (this.arrayLiteralOrder === 'values-first') {
      // Значения — ДО массива: элемент вправе сам создать массив (вложенный литерал).
      const значения = elements.map((element) => this.emitExpr(element));
      this.emit({ op: "invoke", d, name: "система.массив.создать", args: [], argc: 0 });
      for (const value of значения) {
        this.emit({ op: "invoke", d: undefined, name: "система.массив.добавить", args: [d, value], argc: 2 });
      }
      this.allocator.freeTo(mark);
      return;
    }
    // `d` держит массив: он не должен попасть в пул временных, иначе следующее
    // выделение вернёт тот же регистр. Поэтому вызовы идут через свежие регистры.
    this.emit({ op: "invoke", d, name: "система.массив.создать", args: [], argc: 0 });
    for (const element of elements) {
      const value = this.emitExpr(element);
      this.emit({ op: "invoke", d: undefined, name: "система.массив.добавить", args: [d, value], argc: 2 });
    }
    this.allocator.freeTo(mark);
  }

  private emitObjectLiteral(entries: Array<{ key: string; value: Expr }>, d: number): void {
    const mark = this.allocator.mark();
    this.emit({ op: "obj.new", d });
    for (const entry of entries) {
      const key = this.emitExpr({ kind: "строка", value: entry.key });
      const value = this.emitExpr(entry.value);
      this.emit({ op: "obj.set", a: d, key, b: value });
    }
    this.allocator.freeTo(mark);
  }

  // ─── инструкции ────────────────────────────────────────────────────────

  private emitStmt(s: Stmt): void {
    // Отметка на инструкцию: временные регистры выражения не переживают её.
    const mark = this.allocator.mark();
    switch (s.kind) {
      case "пусть": {
        this.emitIntoVariable(s.init, this.vregOf(s.name));
        break;
      }
      case "присвоить": {
        this.emitIntoVariable(s.value, this.vregOf(s.name));
        break;
      }
      case "поле_присвоить": {
        const obj = this.emitExpr(s.object);
        const key = this.emitExpr({ kind: "строка", value: s.field });
        const value = this.emitExpr(s.value);
        this.emit({ op: "obj.set", a: obj, key, b: value });
        break;
      }
      case "выражение": {
        // Результат выражения-инструкции не наблюдается — регистр не нужен.
        const d = this.emitExpr(s.expr);
        void d;
        break;
      }
      case "вернуть": {
        // ВОЗВРАТ ПАРЫ `Результат<Т, Е>`: тег (0 = Успех, 1 = Неудача) и нагрузка.
        //
        // Тег — ЧИСЛО из пула, а не булев литерал: на цели булева литерала нет, `literalOf`
        // отражает булево числом 0/1 (`src/e2k/e2kRealRun.ts`), и `если тег == 1` обязано
        // сравнивать числа на обеих плоскостях. Нагрузка вычисляется ДО тега — порядок в коде не
        // наблюдаем, но так выражение нагрузки не затирает уже положенный тег.
        if (s.value && (s.value.kind === "успех" || s.value.kind === "неудача")) {
          if (this.proc.returnType?.name !== ИМЯ_ПАРЫ) {
            throw new RegCodegenError(
              `«${s.value.kind === "успех" ? "Успех" : "Неудача"}» в процедуре «${this.proc.name}», ` +
                "объявленной БЕЗ пары: объявите возврат как «→ Результат<Т, Е>» — иначе паре некуда деться",
            );
          }
          const mark = this.allocator.mark();
          const нагрузка = this.emitExpr(s.value.значение);
          const тег = this.alloc();
          this.emit({
            op: "const",
            d: тег,
            type: "i32",
            k: this.constIndex(s.value.kind === "успех" ? 0 : 1),
          });
          this.returnsValue = true;
          this.emit({ op: "ret", v: тег, v2: нагрузка });
          this.allocator.freeTo(mark);
          break;
        }
        if (s.value) {
          const value = this.emitExpr(s.value);
          this.returnsValue = true;
          this.emit({ op: "ret", v: value });
        } else {
          // Как в стековой VM: `вернуть` без значения отдаёт «пусто».
          this.returnsValue = true;
          this.emit({ op: "ret", v: this.emitExpr({ kind: "пусто" }) });
        }
        break;
      }
      case "если": {
        this.emitIf(s);
        break;
      }
      case "пока": {
        this.emitWhile(s);
        break;
      }
      case "для_каждого": {
        this.emitForEach(s);
        break;
      }
      case "цикл": {
        this.emitLoop(s);
        break;
      }
      case "прервать": {
        const target = this.breakTargets[this.breakTargets.length - 1];
        if (!target) {
          throw new RegCodegenError("оператор 'прервать' допустим только внутри цикла");
        }
        target.patches.push(this.here());
        this.emit({ op: "jmp", off: 0 });
        break;
      }
      case "продолжить": {
        // ХОЛОСТОЙ ЗАМЕР НИЧЕГО НЕ ВЫПУСКАЕТ И НИЧЕГО НЕ ТРЕБУЕТ. Замер тела
        // `для_каждого` идёт ДО пролога цикла (иначе вложенный цикл выпустил бы свой
        // пролог во время замера внешнего), поэтому цель `продолжить` в замере ещё
        // не заведена — и прежде это давало отказ «допустим только внутри цикла» на
        // ВЕРНОЙ программе. Причём не только в v3: та же v2-программа отвергалась
        // (замерено, `regcodegen` — общий слой). Проверка стоит ПЕРВОЙ: замер не
        // разрешает цели переходов, ему нечего патчить.
        if (this.measuring) break;
        // `продолжить` ведёт на проверку условия цикла (у `для_каждого` — на
        // инкремент), как в стековом кодогене.
        const target = this.continueTargets[this.continueTargets.length - 1];
        if (!target) {
          throw new RegCodegenError("оператор 'продолжить' допустим только внутри цикла");
        }
        if (target.forEachPatches) {
          target.forEachPatches.push(this.here());
          this.emit({ op: "jmp", off: 0 });
        } else {
          this.emit({ op: "jmp", off: target.loopStart });
        }
        break;
      }
      case "распаковать": {
        this.emitUnpack(s);
        break;
      }
      case "попробовать": {
        this.emitTry(s);
        break;
      }
      case "выбросить": {
        const value = this.emitExpr(s.value);
        this.emit({ op: "throw", a: value });
        break;
      }
      case "когда":
        unsupported(
          "инструкцию «когда»",
          "«когда» разворачивается в «если» до кодогена; до этой точки доходить не должно.",
        );
        break;
      default:
        assertNever(s, "RegProcedure.emitStmt");
    }
    this.allocator.freeTo(mark);
  }

  /**
   * Записать адрес перехода в уже выпущенную инструкцию. На холостом проходе
   * инструкций нет — патчить нечего, поэтому вызов молча пропускается.
   */
  private patch(at: number, off: number): void {
    if (this.measuring) return;
    (this.code[at] as { off: number }).off = off;
  }

  /**
   * `если` в регистровой форме: ветки — обычные блоки инструкций, переменные
   * живут в фиксированных регистрах, поэтому сходиться веткам не нужно
   * (ни `phi`, ни `move` в конце ветки).
   */
  private emitIf(s: Stmt & { kind: "если" }): void {
    const condMark = this.allocator.mark();
    const cond = this.emitExpr(s.condition);
    const patchToElse = this.here();
    this.emit({ op: "jmp_if_not", off: 0, cond });
    this.allocator.freeTo(condMark);

    this.emitNested(s.body);

    const hasElse =
      (s.elseIfClauses && s.elseIfClauses.length > 0) ||
      (s.elseBody && s.elseBody.length > 0);
    const patchSkipElse = hasElse ? this.here() : null;
    if (hasElse) this.emit({ op: "jmp", off: 0 });

    if (s.elseIfClauses && s.elseIfClauses.length > 0) {
      let elseLabel = this.here();
      this.patch(patchToElse, elseLabel);
      const toEnd: number[] = [];
      for (const clause of s.elseIfClauses) {
        const cMark = this.allocator.mark();
        const c = this.emitExpr(clause.condition);
        const patchNext = this.here();
        this.emit({ op: "jmp_if_not", off: 0, cond: c });
        this.allocator.freeTo(cMark);
        this.emitNested(clause.body);
        toEnd.push(this.here());
        this.emit({ op: "jmp", off: 0 });
        elseLabel = this.here();
        this.patch(patchNext, elseLabel);
      }
      if (s.elseBody && s.elseBody.length > 0) {
        this.emitNested(s.elseBody);
      }
      const end = this.here();
      if (patchSkipElse !== null) this.patch(patchSkipElse, end);
      for (const p of toEnd) this.patch(p, end);
    } else if (s.elseBody && s.elseBody.length > 0) {
      this.patch(patchToElse, this.here());
      this.emitNested(s.elseBody);
      const end = this.here();
      if (patchSkipElse !== null) this.patch(patchSkipElse, end);
    } else {
      this.patch(patchToElse, this.here());
    }
  }

  /**
   * `пока`: условие → тело → безусловный возврат на условие.
   *
   * Регистры тела распределяются дважды — сначала холостой проход (узнать
   * глубину файла и куда встанут метки), затем настоящая генерация. Иначе
   * времена `прервать`/`продолжить` (их адреса известны только после тела)
   * сдвинули бы номера регистров на втором проходе.
   */
  private emitWhile(s: Stmt & { kind: "пока" }): void {
    const mark = this.allocator.mark();
    // Цели `прервать`/`продолжить` нужны уже на холостом проходе: тело может
    // содержать `прервать`, и он обязан найти свой цикл.
    this.breakTargets.push({ patches: [] });
    const loopStart = this.here();
    this.continueTargets.push({ loopStart });

    // Холостой проход: узнать, куда встанут метки и сколько нужно регистров.
    // Порядок обхода — условие, затем тело: так же его обходит `buildLocals`,
    // иначе циклы внутри условия получили бы другие номера служебных ячеек.
    this.measureCondition(s.condition);
    this.emitStmtMeasure(s.body);
    this.allocator.freeTo(mark);

    const cond = this.emitExpr(s.condition);
    const patchExit = this.here();
    this.emit({ op: "jmp_if_not", off: 0, cond });

    this.emitNested(s.body);
    this.emit({ op: "jmp", off: loopStart });

    const end = this.here();
    this.patch(patchExit, end);
    const target = this.breakTargets.pop()!;
    for (const p of target.patches) this.patch(p, end);
    this.continueTargets.pop();
  }

  /** `цикл` (бесконечный): выход только через `прервать`. */
  private emitLoop(s: Stmt & { kind: "цикл" }): void {
    const mark = this.allocator.mark();
    this.breakTargets.push({ patches: [] });
    const loopStart = this.here();
    this.continueTargets.push({ loopStart });

    // Холостой проход нужен только ради ячеек вложенных `для_каждого`; он идёт
    // до метки тела, чтобы не сдвигать адреса.
    this.emitStmtMeasure(s.body);
    this.allocator.freeTo(mark);

    this.emitNested(s.body);
    this.emit({ op: "jmp", off: loopStart });

    const end = this.here();
    const target = this.breakTargets.pop()!;
    for (const p of target.patches) this.patch(p, end);
    this.continueTargets.pop();
  }

  /** Счётчик вложенности `для_каждого`: обязан совпадать с `buildLocals`. */
  private forEachCounter = 0;
  /** Холостой проход: инструкции не эмитятся, считаются только регистры. */
  private measuring = false;
  /** Адрес `jmp_if_not` выхода из текущего `для_каждого` (заполняет пролог). */
  private patchExit: number | null = null;

  /**
   * Войти во вложенную конструкцию и получить её глубину для `для_каждого`.
   * Семантика — **пост-инкремент** (`forCounter++` в `buildLocals`): первый
   * уровень даёт 0. Глубина растёт на любой вложенности — так же, как в
   * `buildLocals`, иначе цикл внутри `цикл`/`если` искал бы чужую тройку ячеек.
   */
  private enterLoop(): number {
    return this.forEachCounter++;
  }

  private exitLoop(): void {
    this.forEachCounter--;
  }

  private emitForEach(s: Stmt & { kind: "для_каждого" }): void {
    const mark = this.allocator.mark();
    // Глубина цикла берётся по месту в AST: `enterLoop` держится на время обоих
    // обходов тела, поэтому служебные ячейки совпадают с `buildLocals`.
    const depth = this.enterLoop();
    try {
      const srcSlot = this.vregOf(`__forEach_src_${depth}`);
      const lenSlot = this.vregOf(`__forEach_len_${depth}`);
      const idxSlot = this.vregOf(`__forEach_i_${depth}`);
      const itemSlot = this.vregOf(s.item);
      const indexSlot = s.index !== undefined ? this.vregOf(s.index) : undefined;

      this.breakTargets.push({ patches: [] });

      // Холостой проход по телу — ДО пролога. Пролог пишет в регистры: если
      // мерить тело после него, вложенный цикл успеет выпустить собственный
      // пролог прямо во время замера внешнего, и код перемешается.
      this.emitStmtMeasure(s.body);
      this.allocator.freeTo(mark);

      const loopStart = this.emitForEachPrologue(s, srcSlot, lenSlot, idxSlot);
      const patchExit = this.patchExit;
      const forEachContinue = { loopStart, forEachPatches: [] as number[] };
      this.continueTargets.push(forEachContinue);

      // Элемент итерации: `система.массив.получить(источник, индекс)` — оба
      // аргумента уже лежат в известных регистрах.
      const item = this.alloc();
      this.emitInvokeFromRegs(item, "система.массив.получить", [srcSlot, idxSlot]);
      this.emit({ op: "move", d: itemSlot, a: item });
      if (indexSlot !== undefined) {
        // `индекс` цикла — текущее значение счётчика.
        this.emit({ op: "move", d: indexSlot, a: idxSlot });
      }

      this.emitNested(s.body);

      const incStart = this.here();
      for (const p of forEachContinue.forEachPatches) this.patch(p, incStart);
      const next = this.emitExpr({
        kind: "бинарное",
        op: "+",
        left: { kind: "переменная", name: `__forEach_i_${depth}` },
        right: { kind: "число", value: 1 },
      });
      this.emit({ op: "move", d: idxSlot, a: next });
      this.emit({ op: "jmp", off: loopStart });

      const end = this.here();
      if (patchExit !== null) this.patch(patchExit, end);
      const target = this.breakTargets.pop()!;
      for (const p of target.patches) this.patch(p, end);
      this.continueTargets.pop();
    } finally {
      this.exitLoop();
    }
  }

  /**
   * Пролог `для_каждого`: `итератор.из(источник)` → длина → индекс 0, затем
   * проверка `индекс < длина`. Возвращает адрес проверки (цель `продолжить`),
   * а адрес выхода кладёт в {@link patchExit} — патчить его нужно уже после
   * тела, когда адрес известен.
   */
  private emitForEachPrologue(
    s: Stmt & { kind: "для_каждого" },
    srcSlot: number,
    lenSlot: number,
    idxSlot: number,
  ): number {
    const source = this.emitExpr({
      kind: "вызов",
      name: "система.итератор.из",
      args: [s.source],
    });
    this.emit({ op: "move", d: srcSlot, a: source });

    const len = this.emitExpr({
      kind: "вызов",
      name: "система.массив.длина",
      args: [{ kind: "переменная", name: this.nameOfSlot(srcSlot) }],
    });
    this.emit({ op: "move", d: lenSlot, a: len });

    const zero = this.emitExpr({ kind: "число", value: 0 });
    this.emit({ op: "move", d: idxSlot, a: zero });

    const loopStart = this.here();
    const cond = this.emitExpr({
      kind: "бинарное",
      op: "<",
      left: { kind: "переменная", name: this.nameOfSlot(idxSlot) },
      right: { kind: "переменная", name: this.nameOfSlot(lenSlot) },
    });
    this.patchExit = this.here();
    this.emit({ op: "jmp_if_not", off: 0, cond });
    return loopStart;
  }

  /** Обратный поиск имени переменной по её регистру (для служебных ячеек). */
  private nameOfSlot(reg: number): string {
    for (const [name, slot] of this.locals) {
      if (slot === reg) return name;
    }
    throw new RegCodegenError(`Нет переменной в регистре r${reg}`);
  }

  /**
   * Холостой проход по телу цикла: инструкции не пишутся, считаются регистры.
   *
   * Нужен там, где адреса меток известны только после тела (`пока`, `цикл`,
   * `для_каждого`): патчи `прервать`/`продолжить` задаются после тела и на
   * втором проходе нумерация регистров должна повториться.
   *
   * Глубину цикла считает вызывающий (`enterLoop`/`exitLoop` вокруг обоих
   * обходов), иначе вложенный `для_каждого` получил бы лишний уровень.
   */
  private emitStmtMeasure(body: Stmt[]): void {
    // Флаг сохраняется и восстанавливается: замер бывает вложенным (тело
    // внешнего цикла содержит внутренний, который тоже себя замеряет), и
    // безусловный `measuring = false` в `finally` выпустил бы код внутреннего
    // пролога прямо в поток внешнего.
    const previous = this.measuring;
    this.measuring = true;
    try {
      for (const b of body) this.emitStmt(b);
    } finally {
      this.measuring = previous;
    }
  }

  /**
   * Настоящий проход по вложенному телу (`если`, `пока`, `цикл`, `для_каждого`,
   * `попробовать`). Глубину `для_каждого` здесь **не** увеличиваем: её владеет
   * сам `для_каждого` — единственная конструкция, которая вводит тройку ячеек,
   * и ровно так же считает `buildLocals`.
   */
  private emitNested(body: Stmt[]): void {
    for (const b of body) this.emitStmt(b);
  }

  /**
   * Холостой замер выражения (условие цикла/ветки): регистры считаются,
   * инструкции не пишутся. Нужен, чтобы порядок обхода совпадал с `buildLocals`.
   */
  private measureCondition(expr: Expr): void {
    const previous = this.measuring;
    this.measuring = true;
    try {
      this.emitExpr(expr);
    } finally {
      this.measuring = previous;
    }
  }

  /**
   * `распаковать` (`пусть x, y = кортеж`): кортеж — тот же массив, значения
   * достаются `система.массив.получить` по индексу (контракт стекового кодогена).
   * Аргументы `invoke` — регистры, поэтому сам массив и индекс живут в
   * выделенных регистрах (`alloc`), а не в литералах.
   *
   * ОСОБЫЙ СЛУЧАЙ — ПАРА `Результат<Т, Е>`: она приходит из вызова ДВУМЯ местами (тег и нагрузка,
   * §10.2), а не блоком в куче. Поэтому имена берутся прямо из приёмников вызова: `arr`-путь здесь
   * дал бы адрес канала вызова вместо значения — тихую ложь, а не отказ.
   */
  private emitUnpack(s: Stmt & { kind: "распаковать" }): void {
    const значение = s.значение;
    if (
      значение.kind === "вызов" &&
      !значение.name.includes(".") &&
      this.pairReturning.has(значение.name)
    ) {
      if (s.имена.length !== 2) {
        throw new RegCodegenError(
          `пара Результат<> разбирается ровно ДВУМЯ именами (тег и нагрузка), ` +
            `а здесь их ${String(s.имена.length)}: «пусть тег, нагрузка = ${значение.name}(…)»`,
        );
      }
      const mark = this.allocator.mark();
      const тег = this.alloc();
      const нагрузка = this.alloc();
      // ДВА ВИДА ОДНОЙ ПАРЫ — по плоскости, и это не украшение:
      //  * эталонная (регистровая) VM не знает окон, поэтому нагрузку ей отдаёт сам вызов
      //    (`call.d2`), и интерпретатор кладёт её прямо в приёмник;
      //  * у ЦЕЛИ пара приходит каналом вызова (тег `2·wbs`, нагрузка `2·wbs+1`, §10.2), и нагрузку
      //    из окна переносит отдельная инструкция `result_pick` — её и понижает оболочка.
      // Признак плоскости приходит доводом (`pairInWindow`), а не угадывается по имени процедуры.
      this.emitCallInto(значение, тег, this.pairInWindow ? undefined : нагрузка);
      if (this.pairInWindow) this.emit({ op: "result_pick", a: тег, d: нагрузка });
      this.emit({ op: "move", d: this.vregOf(s.имена[0]!), a: тег });
      this.emit({ op: "move", d: this.vregOf(s.имена[1]!), a: нагрузка });
      this.allocator.freeTo(mark);
      return;
    }
    const tuple = this.emitExpr(s.значение);
    const mark = this.allocator.mark();
    const arrReg = this.alloc();
    this.emit({ op: "move", d: arrReg, a: tuple });
    const idxReg = this.alloc();
    for (let i = 0; i < s.имена.length; i++) {
      const slot = this.vregOf(s.имена[i]!);
      const k = this.emitExpr({ kind: "число", value: i });
      this.emit({ op: "move", d: idxReg, a: k });
      const item = this.alloc();
      this.emitInvokeFromRegs(item, "система.массив.получить", [arrReg, idxReg]);
      this.emit({ op: "move", d: slot, a: item });
    }
    this.allocator.freeTo(mark);
  }

  /**
   * `invoke` с готовыми регистрами аргументов. Нужен там, где аргумент — уже
   * вычисленный регистр (массив кортежа, счётчик `для_каждого`), а не выражение.
   */
  private emitInvokeFromRegs(d: number, name: string, args: number[]): void {
    this.emit({ op: "invoke", d, name, args, argc: args.length });
  }

  /**
   * `попробовать` / `иначе_попытка` — та же форма, что в стековом кодогене:
   * `try_begin обработчик` → тело → `try_end` → `jmp конец` → метка обработчика:
   * Пойманное значение интерпретатор кладёт **прямо в регистр переменной**
   * (`catchReg` записан в `try_begin`), поэтому обработчик начинается с тела
   * как есть — ни переноса значения, ни отдельного регистра.
   */
  private emitTry(s: Stmt & { kind: "попробовать" }): void {
    const catchSlot = this.vregOf(s.catchVar);
    const outerMark = this.allocator.mark();

    const patchTryBegin = this.here();
    this.emit({ op: "try_begin", off: 0, catchReg: catchSlot });
    this.emitNested(s.body);
    this.emit({ op: "try_end" });
    const patchJmpEnd = this.here();
    this.emit({ op: "jmp", off: 0 });

    const catchLabel = this.here();
    this.patch(patchTryBegin, catchLabel);
    // Сюда управление приходит только от `throw`, а значение уже в `catchSlot`.
    this.emitNested(s.catchBody);

    const end = this.here();
    this.patch(patchJmpEnd, end);
    this.allocator.freeTo(outerMark);
  }
}

/** Компиляция одного модуля AST в регистровый модуль. */
export function compileToReg(
  ast: Module,
  /**
   * Порядок разворота литералов массива. Умолчание — `create-first`: эталонная (регистровая) VM
   * обязана оставаться пошагово сверяемой со стековой, а `values-first` — требование ПЛОСКОСТИ ЦЕЛИ
   * (куча массивов — один растущий указатель). Причину и замер см. у `emitArrayLiteral`.
   */
  options: { readonly arrayLiteralOrder?: ArrayLiteralOrder; readonly pairInWindow?: boolean } = {},
): RegModule {
  const constants: unknown[] = [];
  const code: RegInstruction[] = [];
  const procedures: RegProcedure[] = [];
  const procedureIndex = new Map<string, number>();
  ast.procedures.forEach((p, i) => procedureIndex.set(p.name, i));
  const pairReturning = pairReturningNames(ast);

  for (const proc of ast.procedures) {
    const gen = new ProcedureCodegen(
      proc,
      code,
      constants,
      procedureIndex,
      pairReturning,
      options.pairInWindow === true,
      options.arrayLiteralOrder,
    );
    const { codeOffset, vregs, returnsValue } = gen.generate();
    procedures.push({
      name: proc.name,
      codeOffset,
      argc: proc.params.length,
      vregs: Math.max(vregs, proc.params.length),
      localToVreg: gen.localToVreg(),
      returnsValue,
      pure: proc.pure,
    });
  }

  return {
    ir: REGCODE_IR,
    version: REGCODE_VERSION,
    moduleName: ast.name,
    constants,
    procedures,
    code,
  };
}

/**
 * Компиляция многомодульной программы.
 *
 * Префиксация имён процедур (`Модуль__процедура`) берётся из стекового
 * `compileProgram`, поэтому эмитится тот же `call.fi`: сначала строится
 * стековый артефакт (он же эталон оракула), затем по полученным именам
 * процедур — регистровый. Побочный эффект: стековый кодоген вызывается и здесь;
 * пока это дешевле, чем третья копия правил разрешения имён.
 */
export function compileProgramToReg(program: Program, moduleIndex = 0): RegModule {
  const stackModules = compileProgramToStack(program);
  const source = program.modules[moduleIndex];
  const stackModule = stackModules[moduleIndex];
  if (!source || !stackModule) {
    throw new RegCodegenError(`Нет модуля с индексом ${moduleIndex}`);
  }
  if (source.procedures.length !== stackModule.procedures.length) {
    throw new RegCodegenError(
      "Регистровый кодоген: число процедур разошлось со стековым артефактом",
    );
  }
  const renamed: Module = {
    name: stackModule.moduleName,
    imports: [],
    typeDeclarations: [...source.typeDeclarations],
    procedures: source.procedures.map((proc, i) => ({
      ...proc,
      name: stackModule.procedures[i]!.name,
    })),
  };
  return compileToReg(renamed);
}
