/**
 * ЗАПИСЬ НА ЦЕЛИ: БЛОК ЭЛЕМЕНТОВ, А НЕ ОБЪЕКТ — И ПОЧЕМУ ИМЕННО ТАК.
 *
 * # Отказ, из которого вырос модуль
 *
 * `src/e2k/emitterShell.ts`, функция `lowerInstruction`, строка 230: у операций `obj.new`, `obj.get`,
 * `obj.set` **нет носителя** (таблица `NO_CARRIER`, строки 137–139), и оболочка ОСТАНАВЛИВАЕТСЯ
 * исключением. Замер: программа `тип Точка { х, у }` + `т.х` умирает на **`obj.new`** — то есть
 * `obj.get` даже не достигается: сначала нечем создать запись.
 *
 * # Что здесь вместо носителя
 *
 * Запись разворачивается в **блок элементов** — ту самую форму, которой на цели уже живут коллекции
 * (§3.103.2: «элемент коллекции — одно 8-байтовое слово, а записи-структуры в языке ещё нет»). Поля
 * ложатся в блок по порядку ОБЪЯВЛЕНИЯ типа, поле читается по СТАТИЧЕСКОМУ индексу:
 *
 * | в языке | в плане | на цели |
 * |---|---|---|
 * | `тип Точка { х: Число, у: Число }` | порядок полей `х → 0`, `у → 1` | — |
 * | `пусть т: Точка = { х: 3, у: 4 }` | `[3, 4]` | блок элементов (куча рантайма массивов) |
 * | `т.х` | `система.массив.получить(т, 0)` | чтение элемента по индексу — **работает** |
 * | `т.х = 5` | `система.массив.установить(т, 0, 5)` | запись элемента — **работает** |
 *
 * Носителя `obj.get` при этом НЕ появляется, и это не обход, а выбор представления: блок элементов —
 * единственная форма, у которой на цели УЖЕ есть рантайм (замер контрольного опыта: `[3, 4]` +
 * `т[0] + т[1]` → код **7**, отказов **0**). Изобретать второй рантайм ради записи значило бы
 * завести вторые границы, вторую арену и второй отказ.
 *
 * # Почему индекс берётся из ОБЪЯВЛЕНИЯ, а не из литерала
 *
 * `{ у: 4, х: 3 }` — законный литерал: порядок ключей в нём не обязан совпадать с порядком полей
 * типа. Если бы индекс шёл по порядку ЛИТЕРАЛА, `т.х` читало бы `у`. Поэтому разворот идёт по типу,
 * а ключи литерала только СОПОСТАВЛЯЮТСЯ полям. Это и есть предмет негативного контроля: сломай
 * порядок — и `т.х` вернёт 4 вместо 3.
 *
 * # Чего здесь НЕТ — и это названо, а не замолчано
 *
 * | случай | что происходит |
 * |---|---|
 * | запись без выведенного типа (`пусть т = { х: 3 }`) | остаётся объектом → отказ оболочки `obj.new` (названный) |
 * | поле, которого нет в типе | отказ ЗДЕСЬ, с именем поля и типа (до разворота это ловит семантика, но её отказ относится к переменной, а не к литералу) |
 * | литерал без части полей | отказ ЗДЕСЬ: недостающее поле — не ноль, а «не задано» |
 * | вложенная запись полем | РАЗВЁРНУТА (тип поля берётся из объявления), но в блок ляжет АДРЕС вложенного блока — проверено оракулом только для одного уровня |
 * | запись в списке/коллекции | не разворачивается: элемент списка — слово, и признака «это запись» у него нет |
 */
import type { Expr, Module, Procedure, Stmt, TypeRef } from '../compiler/ast';
import { compileSource, type CompileOptions, type CompileResult } from '../compiler/compiler';
import { compileToReg } from '../compiler/regcodegen';
import type { RegModule } from '../runtime/vm/regcode';
import { LOWERING_CODES } from './loweringRefusal';

const GET = 'система.массив.получить';
const SET = 'система.массив.установить';

/** Отказ плана записи: причина называется, а не замалчивается. */
export class RecordPlanRefusal extends Error {
  /** Код контракта отказа понижения: «у носителя нет формы понижения» — тот же класс, что у оболочки. */
  readonly code = LOWERING_CODES.noForm;
  constructor(message: string) {
    super(message);
    this.name = 'RecordPlanRefusal';
  }
}

/** Раскладка записей: имя типа → имена полей в порядке ОБЪЯВЛЕНИЯ (он же порядок в блоке). */
export type RecordLayout = ReadonlyMap<string, readonly string[]>;

/**
 * Собрать раскладку из объявлений типа. Перечни (`variants`) записью не считаются.
 *
 * Порядок полей берётся из объявления как есть: это ЕДИНСТВЕННЫЙ источник индекса, и он же —
 * предмет сторожа (`src/e2k/recordPlan.test.ts`: подмена порядка обязана покраснеть).
 */
export function recordLayoutOf(ast: Module): RecordLayout {
  const layout = new Map<string, readonly string[]>();
  for (const td of ast.typeDeclarations) {
    if (td.fields.length > 0) layout.set(td.name, td.fields.map((f) => f.name));
  }
  return layout;
}

/** Тип поля записи — для вложенных записей и для ожидаемого типа литерала. */
function fieldTypeOf(ast: Module, typeName: string, field: string): TypeRef | undefined {
  const td = ast.typeDeclarations.find((t) => t.name === typeName);
  return td?.fields.find((f) => f.name === field)?.type;
}

/**
 * Вывести тип выражения — ровно настолько, насколько нужно развороту.
 *
 * Это НЕ второй вывод типов компилятора: он умеет четыре случая (переменная, поле, литерал с
 * ожидаемым типом, вызов своей процедуры с аннотацией возврата) и на остальном честно возвращает
 * `undefined` — тогда узел остаётся как есть, и оболочка отказывает СВОИМ отказом. Догадка здесь
 * была бы хуже: неверный тип развернул бы запись в блок молча.
 */
function typeOf(expr: Expr, env: ReadonlyMap<string, TypeRef>, ast: Module): TypeRef | undefined {
  switch (expr.kind) {
    case 'переменная':
      return env.get(expr.name);
    case 'поле': {
      const объект = typeOf(expr.object, env, ast);
      if (объект === undefined || объект.array === true) return undefined;
      return fieldTypeOf(ast, объект.name, expr.field);
    }
    case 'вызов': {
      const proc = ast.procedures.find((p) => p.name === expr.name);
      return proc?.returnType;
    }
    default:
      return undefined;
  }
}

/** Запись ли это (тип с полями), а не перечень и не примитив. */
function isRecord(layout: RecordLayout, type: TypeRef | undefined): boolean {
  return type !== undefined && type.array !== true && layout.has(type.name);
}

/**
 * РАЗВЕРНУТЬ ЗАПИСИ В БЛОКИ ЭЛЕМЕНТОВ — правка AST на месте.
 *
 * Вызывается ТОЛЬКО на пути цели (`src/e2k/programImage.ts`): эталонная VM обязана видеть ту же
 * программу, что и раньше, — иначе сверка «VM против цели» перестала бы быть сверкой. Записи на VM
 * работают объектами, и трогать это незачем.
 */
export function planRecords(ast: Module): void {
  const layout = recordLayoutOf(ast);
  if (layout.size === 0) return;
  for (const proc of ast.procedures) {
    const env = new Map<string, TypeRef>();
    for (let i = 0; i < proc.params.length; i++) {
      const pt = proc.paramTypes?.[i];
      if (pt !== undefined) env.set(proc.params[i]!, pt);
    }
    stmts(proc.body, env, ast, layout);
  }
}

function stmts(list: Stmt[], env: Map<string, TypeRef>, ast: Module, layout: RecordLayout): void {
  for (const s of list) {
    switch (s.kind) {
      case 'пусть': {
        const ожидаемый = s.typeAnnotation;
        s.init = выражение(s.init, env, ast, layout, ожидаемый);
        if (s.typeAnnotation !== undefined) env.set(s.name, s.typeAnnotation);
        break;
      }
      case 'присвоить':
        s.value = выражение(s.value, env, ast, layout, undefined);
        break;
      case 'поле_присвоить': {
        // `т.х = 5` → `система.массив.установить(т, 0, 5)`. Замена СТАТЕМЕНТА на выражение —
        // потому что запись элемента у языка уже есть вызовом, и второго пути заводить не надо.
        //
        // ТИП БЕРЁТСЯ У ИСХОДНОГО УЗЛА, А НЕ У ПЕРЕПИСАННОГО (правка 2026-10-09, вложенная запись).
        // После разворота внутреннего поля выражение становится ВЫЗОВОМ `система.массив.получить`,
        // а `typeOf` типа вызова знает только у СВОИХ процедур (`returnType`), у системной — нет.
        // Поэтому тип, снятый с результата разворота, терялся, и второй уровень вложенности оставался
        // `obj.set` → отказ оболочки. Замер до правки — `.tmp/probe-nested-record.ts`.
        const тип = typeOf(s.object, env, ast);
        const объект = выражение(s.object, env, ast, layout, undefined);
        if (isRecord(layout, тип)) {
          const индекс = индексПоля(layout.get(тип!.name)!, s.field, тип!.name, 'запись поля');
          const значение = выражение(s.value, env, ast, layout, fieldTypeOf(ast, тип!.name, s.field));
          const вызов: Stmt = {
            kind: 'выражение',
            expr: { kind: 'вызов', name: SET, args: [объект, { kind: 'число', value: индекс }, значение] },
          };
          Object.assign(s, вызов);
          break;
        }
        s.object = объект;
        s.value = выражение(s.value, env, ast, layout, undefined);
        break;
      }
      case 'выражение':
        s.expr = выражение(s.expr, env, ast, layout, undefined);
        break;
      case 'вернуть':
        if (s.value) s.value = выражение(s.value, env, ast, layout, undefined);
        break;
      case 'выбросить':
        s.value = выражение(s.value, env, ast, layout, undefined);
        break;
      case 'если':
        s.condition = выражение(s.condition, env, ast, layout, undefined);
        stmts(s.body, new Map(env), ast, layout);
        for (const ветвь of s.elseIfClauses ?? []) {
          ветвь.condition = выражение(ветвь.condition, env, ast, layout, undefined);
          stmts(ветвь.body, new Map(env), ast, layout);
        }
        if (s.elseBody) stmts(s.elseBody, new Map(env), ast, layout);
        break;
      case 'пока':
        s.condition = выражение(s.condition, env, ast, layout, undefined);
        stmts(s.body, new Map(env), ast, layout);
        break;
      case 'цикл':
        stmts(s.body, new Map(env), ast, layout);
        break;
      case 'для_каждого':
        s.source = выражение(s.source, env, ast, layout, undefined);
        stmts(s.body, new Map(env), ast, layout);
        break;
      case 'попробовать':
        stmts(s.body, new Map(env), ast, layout);
        stmts(s.catchBody, new Map(env), ast, layout);
        break;
      case 'распаковать':
        s.значение = выражение(s.значение, env, ast, layout, undefined);
        break;
      default:
        break;
    }
  }
}

/** Индекс поля в блоке — по ОБЪЯВЛЕНИЮ. Не найдено → отказ с именем поля и типа. */
function индексПоля(поля: readonly string[], поле: string, тип: string, где: string): number {
  const индекс = поля.indexOf(поле);
  if (индекс < 0) {
    throw new RecordPlanRefusal(
      `запись.${где}: у типа «${тип}» нет поля «${поле}» — известны: ${поля.join(', ')}`,
    );
  }
  return индекс;
}

function выражение(
  expr: Expr,
  env: ReadonlyMap<string, TypeRef>,
  ast: Module,
  layout: RecordLayout,
  ожидаемый: TypeRef | undefined,
): Expr {
  switch (expr.kind) {
    case 'поле': {
      // ВЛОЖЕННАЯ ЗАПИСЬ: тип поля снимается с ИСХОДНОГО узла (`expr.object`), а не с результата
      // разворота. Причина та же, что у `поле_присвоить`: `т.начало` после разворота — вызов
      // `система.массив.получить`, типа которого `typeOf` не знает, поэтому `т.начало.х` оставался
      // `obj.get`. Замер: до правки — «операция obj.get не выражается оболочкой», после — код 1
      // (`.tmp/probe-nested-record.ts`).
      const тип = typeOf(expr.object, env, ast);
      const объект = выражение(expr.object, env, ast, layout, undefined);
      if (isRecord(layout, тип)) {
        const индекс = индексПоля(layout.get(тип!.name)!, expr.field, тип!.name, 'чтение поля');
        return { kind: 'вызов', name: GET, args: [объект, { kind: 'число', value: индекс }] };
      }
      return { ...expr, object: объект };
    }
    case 'объект': {
      // Литерал разворачивается ТОЛЬКО когда тип ожидается: без типа это словарь, и трогать его
      // нельзя (словарь — не запись).
      if (!isRecord(layout, ожидаемый)) {
        return { ...expr, entries: expr.entries.map((п) => ({ ...п, value: выражение(п.value, env, ast, layout, undefined) })) };
      }
      const поля = layout.get(ожидаемый!.name)!;
      const значByИмя = new Map(expr.entries.map((п) => [п.key, п.value] as const));
      for (const ключ of значByИмя.keys()) {
        if (!поля.includes(ключ)) {
          throw new RecordPlanRefusal(
            `запись: в литерале типа «${ожидаемый!.name}» нет поля «${ключ}» — известны: ${поля.join(', ')}`,
          );
        }
      }
      const элементы: Expr[] = [];
      for (const имя of поля) {
        const значение = значByИмя.get(имя);
        if (значение === undefined) {
          throw new RecordPlanRefusal(
            `запись: в литерале типа «${ожидаемый!.name}» не задано поле «${имя}» — ` +
              'недостающее поле не ноль, а «не задано», и молчаливая подстановка нуля была бы тихой ложью',
          );
        }
        элементы.push(выражение(значение, env, ast, layout, fieldTypeOf(ast, ожидаемый!.name, имя)));
      }
      return { kind: 'массив', elements: элементы };
    }
    case 'вызов':
      return { ...expr, args: expr.args.map((а) => выражение(а, env, ast, layout, undefined)) };
    case 'бинарное':
      return { ...expr, left: выражение(expr.left, env, ast, layout, undefined), right: выражение(expr.right, env, ast, layout, undefined) };
    case 'унарное':
      return { ...expr, arg: выражение(expr.arg, env, ast, layout, undefined) };
    case 'массив':
      return { ...expr, elements: expr.elements.map((э) => выражение(э, env, ast, layout, undefined)) };
    case 'кортеж':
      return { ...expr, элементы: expr.элементы.map((э) => выражение(э, env, ast, layout, undefined)) };
    default:
      // Отдельного узла «индекс» в AST нет: `а[i]` парсер ставит ВЫЗОВОМ `система.массив.получить`
      // (и он же приходит сюда случаем `вызов` выше). Это не мелочь: будь узел отдельным, разворот
      // записи пришлось бы учить и ему.
      return expr;
  }
}

/** Процедуры модуля — для оракула и для наблюдателей: сколько тел обошёл план. */
export function proceduresOf(ast: Module): readonly Procedure[] {
  return ast.procedures;
}

/**
 * КОНВЕЙЕР ЦЕЛИ С ПЛАНОМ ЗАПИСЕЙ — замена `regModuleOf` ТОЛЬКО на пути e2k.
 *
 * Порядок ровно такой, и он важен: **сначала компиляция с проверками, потом план**. Семантика
 * обязана увидеть исходную программу — на ней держатся её отказы (неизвестное поле, несовпадение
 * типа). Разверни план раньше — семантика проверяла бы уже развёрнутое дерево, и «опечатка в поле
 * через переменную» перестала бы отвергаться (случай 26 реестра проверяемости,
 * `src/compiler/recordsGap.audit.test.ts`).
 *
 * Эталонная VM при этом видит ту же программу, что и раньше: план живёт в плоскости цели и на
 * `compileSource` не влияет.
 */
export function regModuleWithRecordPlan(
  source: string,
  options: CompileOptions = {},
): { module: RegModule; compiled: CompileResult } | null {
  const compiled = compileSource(source, options);
  if (compiled.module === null || compiled.moduleAst === undefined) return null;
  planRecords(compiled.moduleAst);
  // `values-first` — ПОЧЕМУ ЗДЕСЬ, А НЕ В ОБЩЕМ КОДОГЕНЕРАТОРЕ (замер 2026-10-09, вложенные записи):
  // куча массивов на цели — один растущий вверх указатель, и адрес элемента считается
  // `массив + 8 + индекс*8`. Если массив создан раньше значений, вложенный литерал
  // (`{ начало: { х: 1, у: 2 } }`) выделяет свой блок ровно там, куда затем пишет `добавить`
  // родителя, и первый элемент вложенного блока затирается (`о.начало.х` → 40 — адрес соседа).
  // Эталонная плоскость остаётся на `create-first`: её пошаговый паритет со стековой VM наблюдаем
  // и без этого, а на VM литерал массива — объект языка. Разбор — `src/compiler/regcodegen.ts`
  // (`emitArrayLiteral`) и `docs/hardware-debt.md` §3.122.
  // `pairInWindow` — ПОЧЕМУ ЗДЕСЬ: пара `Результат<Т, Е>` приходит на цель КАНАЛОМ ВЫЗОВА (тег
  // `2·wbs`, нагрузка `2·wbs + 1`, `docs/abi-v3-draft.md` §10.2), и нагрузку из оконной клетки
  // переносит отдельный носитель (`IR.result_pick`). У эталонной VM окон нет — там нагрузку отдаёт
  // сам вызов прямым приёмником (`call.d2`), и лишняя инструкция ей не нужна.
  return {
    module: compileToReg(compiled.moduleAst, { arrayLiteralOrder: 'values-first', pairInWindow: true }),
    compiled,
  };
}
