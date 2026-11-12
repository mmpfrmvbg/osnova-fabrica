/**
 * AST языка Основа: выражения и инструкции для пайплайна компилятора.
 *
 * Expr: число, строка, булево, пусто, переменная, бинарное/унарное, вызов,
 * массив, объект, поле.
 * Stmt: пусть, присвоить, поле_присвоить, выражение, если, попробовать,
 * выбросить, пока, для_каждого, цикл, прервать, продолжить, вернуть.
 * Модуль: импорты, объявления типов, процедуры.
 */

export type Expr =
  | { kind: "число"; value: number }
  | { kind: "строка"; value: string }
  | { kind: "булево"; value: boolean }
  | { kind: "пусто" }
  | { kind: "переменная"; name: string }
  | { kind: "бинарное"; op: string; left: Expr; right: Expr }
  | { kind: "унарное"; op: "не"; arg: Expr }
  | { kind: "вызов"; name: string; args: Expr[] }
  | { kind: "массив"; elements: Expr[] }
  | { kind: "кортеж"; элементы: Expr[] }
  | { kind: "объект"; entries: Array<{ key: string; value: Expr }> }
  | { kind: "поле"; object: Expr; field: string }
  /**
   * КОНСТРУКТОРЫ ПАРЫ `Результат<Т, Е>`: `Успех(значение)` и `Неудача(ошибка)`.
   *
   * Отдельные узлы, а не обычные вызовы, — потому что это НЕ вызов процедуры: значения
   * `Успех`/`Неудача` в модуле нет, его строит понижение (тег + нагрузка, `docs/abi-v3-draft.md`
   * §10.2). Ровно эти два узла названы каноном: golden-тест `микро_результат`
   * (`docs/golden-tests.md`, `SuccessExpr`/`FailureExpr`) — то есть форма не выдумана здесь.
   */
  | { kind: "успех"; значение: Expr }
  | { kind: "неудача"; значение: Expr }
  /** Литерал перечня: `Масть.пики` → в VM строка `"Масть.пики"`. */
  | { kind: "вариант"; typeName: string; variant: string };

export type Stmt =
  | { kind: "пусть"; name: string; init: Expr; typeAnnotation?: TypeRef }
  | { kind: "распаковать"; имена: string[]; значение: Expr }
  | { kind: "присвоить"; name: string; value: Expr }
  | { kind: "поле_присвоить"; object: Expr; field: string; value: Expr }
  | { kind: "выражение"; expr: Expr }
  | { kind: "если"; condition: Expr; body: Stmt[]; elseIfClauses?: Array<{ condition: Expr; body: Stmt[] }>; elseBody?: Stmt[] }
  | {
      kind: "когда";
      scrutinee: Expr;
      arms: Array<{ variant: Expr; body: Stmt[] }>;
      elseBody?: Stmt[];
    }
  | { kind: "попробовать"; body: Stmt[]; catchVar: string; catchBody: Stmt[] }
  | { kind: "выбросить"; value: Expr }
  | { kind: "пока"; condition: Expr; body: Stmt[] }
  | {
      kind: "для_каждого";
      item: string;
      index?: string;
      source: Expr;
      body: Stmt[];
      /** @deprecated старое имя поля для обратной совместимости */
      variable: string;
      /** @deprecated старое имя поля для обратной совместимости */
      collection: Expr;
    }
  | { kind: "цикл"; body: Stmt[] }
  | { kind: "прервать" }
  | { kind: "продолжить" }
  | { kind: "вернуть"; value?: Expr };

export interface Procedure {
  name: string;
  params: string[];
  /** Типы параметров (тот же порядок, что `params`); нет — неаннотирован. */
  paramTypes?: Array<TypeRef | undefined>;
  /** Аннотация типа возврата: `процедура f(...): Тип`. Нет — выводится или процедура без значения. */
  returnType?: TypeRef;
  body: Stmt[];
  /** Модификатор `экспорт` в объявлении процедуры. */
  exported?: boolean;
  /** Модификатор `чистый`: процедура без побочных эффектов. */
  pure?: boolean;
  /**
   * Файл, из которого пришла процедура, — для диагностики.
   *
   * Нужен потому, что импорты РАЗВОРАЧИВАЮТСЯ: процедуры импортируемого модуля
   * встраиваются в AST главного, и без этого поля ошибка внутри чужого модуля
   * называлась бы сборкой главного. Так и было: `модуль 'X' не найден`,
   * возникшая в `tasks_core.osnova`, приписывалась `main.osnova`.
   *
   * Ставится при разворачивании импортов (`expandModuleImports`): своим
   * процедурам — имя входного файла, встроенным — файл, откуда они пришли.
   */
  origin?: string;
}

export interface ImportDeclaration {
  /** Имя namespace в импортирующем модуле (например: `Утил` в `Утил.процедура(...)`). */
  module: string;
  /** Путь к импортируемому файлу. */
  path: string;
}

export interface TypeRef {
  /** Идентификатор типа (для nullable — без префикса '?'). */
  name: string;
  /** Префикс '?' перед именем типа. */
  nullable: boolean;
  /** Поле-массив: синтаксис `[Имя]`. */
  array?: boolean;
  /**
   * Параметры типа: `Результат<Строка, Ошибка>` → `name: "Результат"`, `typeArgs: [Строка, Ошибка]`.
   *
   * Форма взята у канона, а не заведена здесь: golden-тест `микро_результат`
   * (`docs/golden-tests.md`) требует `TypeAnn(name: "Результат", typeArgs: [...])`, и
   * `docs/decisions.md` (D19) называет `typeArgs` уже существующим в языке. Без этого поля
   * `Результат<…>` не разбирался бы вовсе, а имя типа теряло бы свои два довода, и понижение
   * не смогло бы отличить пару от обычного значения.
   */
  typeArgs?: TypeRef[];
}

export interface TypeField {
  name: string;
  type: TypeRef;
}

export interface TypeDeclaration {
  kind: "TypeDeclaration";
  name: string;
  /** Поля записи; пусто, если это перечень вариантов. */
  fields: TypeField[];
  /** Перечень: `тип Масть = пики | черви`. */
  variants?: string[];
  /** Файл объявления после разворачивания импортов (не в байткод). */
  origin?: string;
}

export interface Module {
  name: string;
  imports: ImportDeclaration[];
  typeDeclarations: TypeDeclaration[];
  procedures: Procedure[];
  /**
   * Строка закрывающего слова модуля (`конец` или `конец_модуля`), если модуль
   * был закрыт явно. Нужна диагностике «лишний `конец`» (БЛОК 1 v2): сообщение
   * называет строку лишнего слова и строку, где модуль уже закрыт.
   */
  moduleClosedAt?: number;
}

export interface Program {
  modules: Module[];
}
