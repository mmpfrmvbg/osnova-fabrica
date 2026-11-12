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
import { collectCompileDiagnostics } from '../compiler/compileDiagnostics';
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
 * ТИПЫ ПРОЦЕДУР ДЛЯ ПУТИ ЦЕЛИ (шаг 2.3, ATOM-06-02-02а): строковость берётся ИЗ ТИПА, а не из происхождения.
 *
 * # Зачем это отдельным слоем, а не «пусть планирование строк догадается»
 *
 * Планирование строк (`src/e2k/stringPlan.ts`) видит ПОТОК НОСИТЕЛЕЙ, а в носителе типа нет вовсе —
 * есть регистры. Поэтому литерал оно узнаёт по пулу констант, а параметр `Строка` — не узнаёт ничем:
 * замер (`.tmp/a230-planner.ts`, HEAD 63bf36cd) — `процедура символ_по_с(с: Строка) / вернуть с[0]`
 * даёт 2 отказа «аргумент не строка» (строки 396/413 плана) и 2 отказа формы раскладки. Содержимое
 * такой строки на сборке НЕИЗВЕСТНО, поэтому операция над ней обязана идти РАНТАЙМОВОЙ развёрткой, а
 * не подстановкой длины/таблицы кодов.
 *
 * # Почему типы берутся из `CompileResult`, а не из `RegModule`
 *
 * `RegProcedure` (`src/runtime/vm/regcode.ts:286`) типов не несёт — это плоскость VM, где тип не нужен.
 * Типы остаются в AST (`compiled.moduleAst`), и оттуда их читает конвейер цели
 * (`src/e2k/guards/loweredUnchecked.ts`), а не парсер: парсер не трогается вовсе.
 *
 * # Что здесь СОГЛАШЕНИЕ, а не вывод
 *
 * Параметр `i` — это vreg `i`, он ЗАКРЕПЛЁН (`argumentCountsOf`, `src/e2k/regAlloc.ts`) и после
 * раскладки живёт в `%b[i]`. Замер (`.tmp/a230-dump.ts`): у `два(а: Число, с: Строка)` поток после
 * раскладки читает `%b1` там, где в исходнике `с` — то есть параметр 1 действительно в клетке 1.
 */
export interface ProcedureTypeInfo {
  readonly name: string;
  /**
   * Типы параметров по порядку; индекс = номер vreg параметра = клетка после раскладки.
   *
   * Элемент БЫВАЕТ `undefined` — это параметр БЕЗ объявленного типа, и он обязан остаться на своём
   * месте: фильтрация массива молча СДВИНУЛА бы соответствие «параметр i ↔ paramTypes[i]», и параметр
   * без типа получил бы тип соседа — ровно тот класс «тихой лжи», который закрывает шаг 2.3. Потребитель
   * обязан различать «тип не объявлен» (ни строковости, ни «это число») и конкретный тип.
   */
  readonly paramTypes: readonly (TypeRef | undefined)[] | undefined;
  /** Объявленный тип возврата: у пары `Результат<Т, Е>` нагрузка лежит в `typeArgs[0]`. */
  readonly returnType: TypeRef | undefined;
}

/** Типы процедур компиляции по имени — единственный источник «Строка/Число из типа» на пути цели. */
export function procedureTypesOf(compiled: CompileResult): readonly ProcedureTypeInfo[] {
  return (compiled.moduleAst?.procedures ?? []).map((procedure) => ({
    name: procedure.name,
    paramTypes: procedure.paramTypes,
    returnType: procedure.returnType,
  }));
}

/** Тип объявлен как `Строка` (и это не массив строк): ТОЛЬКО такой параметр даёт строковость. */
export function isStringType(type: TypeRef | undefined): boolean {
  return type !== undefined && type.array !== true && type.name === 'Строка';
}

/** Тип объявлен как `Число` (и это не массив чисел): ДОКАЗАННОЕ число, массивом быть не может. */
export function isNumberType(type: TypeRef | undefined): boolean {
  return type !== undefined && type.array !== true && type.name === 'Число';
}

/**
 * НАГРУЗКА ПАРЫ `Результат<Т, Е>` — `typeArgs[0]`.
 *
 * Имя берётся у объявленного типа возврата ВЫЗЫВАЕМОЙ процедуры, а не угадывается по носителю: в
 * `IR.result_pick` типа нет, а `пусть тег, нагрузка = добыть(...)` в потоке — это пара носителей
 * «вызов → выбор нагрузки» без единой пометки. Замер (`.tmp/a230-dump.ts`): `IR.call [5, …, 0, %b2]`
 * (payload 0 = процедура `добыть`), сразу за ним `IR.result_pick [%b3, %b2]` — нагрузка `%b3` обязана
 * быть строкой ровно потому, что у `добыть` объявлен `Результат<Строка, Ошибка>`.
 */
export function resultPayloadType(returnType: TypeRef | undefined): TypeRef | undefined {
  if (returnType === undefined || returnType.name !== 'Результат') return undefined;
  return returnType.typeArgs?.[0];
}

/**
 * НАЗВАННЫЙ ОТКАЗ ПОВЕРХНОСТИ: ПОЧЕМУ программа не скомпилировалась (D5, случай 73).
 *
 * # Что здесь чинится
 *
 * Прежняя редакция двери теряла причину: `compileSource` отдавал `module = null` вместе с НАЗВАННЫМИ
 * диагностиками (у каждой свой код каталога, фаза и текст), а наружу уходило одно и то же
 * `Error('программа не компилируется')` — то есть читатель не мог отличить «у `длина` не выведен тип»
 * от «ожидается выражение» и от «процедура не объявлена». ЗАМЕР (`.tmp/a622-codes.ts`):
 * `длина нагрузка` и `длина а` дают `OSN-CG-001` (««длина» требует известного типа операнда: у
 * «нагрузка» тип не выведен — добавьте аннотацию»), синтаксис — `OSN-PAR-001`, неизвестная процедура —
 * `OSN-SEM-003`: три разных кода, которые бросок выбрасывал все три.
 *
 * # Почему это по-прежнему БРОСОК, а не отказ понижения
 *
 * Класс этого отказа в дереве назван — **«язык»**, и он ВНЕ контракта понижения: у языка свой канал
 * кодов (`OSN-CG-*`/`OSN-PAR-*`/`OSN-SEM-*`), а `OSN-LOW-*` описывает отказ ПОНИЖЕНИЯ
 * (`src/e2k/loweringRefusal.ts`, `src/scripts/e2kLoweringDiagnostics.ts#classOfCode`). Назвать это
 * `OSN-LOW-*` значило бы соврать о слое: понижение до программы даже не дошло. Поэтому чинится
 * АНОНИМНОСТЬ: текст броска называет код, фазу и причину, а прежняя фраза-класс остаётся НАЧАЛОМ
 * сообщения — по ней классификатор (`classOfThrown`) и его оракул узнают класс «язык», как и раньше.
 */
export type RegModuleOrNamedFailure =
  | { readonly ok: true; readonly module: RegModule; readonly compiled: CompileResult }
  | { readonly ok: false; readonly причины: readonly string[] };

/**
 * Причины отказа поверхности по одной строке на причину: `КОД фаза: текст`.
 *
 * Берётся КАНОНИЧЕСКИЙ сборщик диагностик (`src/compiler/compileDiagnostics.ts#collectCompileDiagnostics`)
 * — тот же, что у прибора `src/scripts/e2kLoweringDiagnostics.ts`: второй сборщик разошёлся бы с первым,
 * и один и тот же отказ назывался бы по-разному в двух местах. Список НЕ ПУСТ по контракту сборщика:
 * если модуля нет и ни одна фаза причину не назвала, он добавляет запись-признак `OSN-CG-002`
 * («отказ без диагностики: ни одна фаза не назвала причину — это дефект компилятора»). Своего запасного
 * текста здесь поэтому нет: он был бы вторым ответом на один вопрос и к тому же недостижимым.
 */
export function frontendFailureReasons(compiled: CompileResult): readonly string[] {
  const записи = collectCompileDiagnostics(compiled);
  const ошибки = записи.filter((запись) => запись.severity === 'ошибка');
  const значимые = ошибки.length > 0 ? ошибки : записи;
  return значимые.map((запись) => `${запись.code} ${запись.phase}: ${запись.message}`);
}

/** Текст броска: класс «язык» остаётся НАЧАЛОМ сообщения, причины — за ним. */
export function frontendRefusalMessage(причины: readonly string[]): string {
  return `программа не компилируется: ${причины.join(' | ')}`;
}

/**
 * КОНВЕЙЕР ЦЕЛИ — тот же, что {@link regModuleWithRecordPlan}, но отказ ПОВЕРХНОСТИ отдаётся
 * названным (`frontendFailureReasons`), а не теряется в `null`.
 */
export function regModuleOrNamedFailure(
  source: string,
  options: CompileOptions = {},
): RegModuleOrNamedFailure {
  const compiled = compileSource(source, options);
  if (compiled.module === null || compiled.moduleAst === undefined) {
    return { ok: false, причины: frontendFailureReasons(compiled) };
  }
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
    ok: true,
    module: compileToReg(compiled.moduleAst, { arrayLiteralOrder: 'values-first', pairInWindow: true }),
    compiled,
  };
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
  const итог = regModuleOrNamedFailure(source, options);
  return итог.ok ? { module: итог.module, compiled: итог.compiled } : null;
}
