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
  | { kind: "объект"; entries: Array<{ key: string; value: Expr }> }
  | { kind: "поле"; object: Expr; field: string }
  /** Литерал перечня: `Масть.пики` → в VM строка `"Масть.пики"`. */
  | { kind: "вариант"; typeName: string; variant: string };

export type Stmt =
  | { kind: "пусть"; name: string; init: Expr; typeAnnotation?: TypeRef }
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
  body: Stmt[];
  /** Модификатор `экспорт` в объявлении процедуры. */
  exported?: boolean;
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
}

export interface Module {
  name: string;
  imports: ImportDeclaration[];
  typeDeclarations: TypeDeclaration[];
  procedures: Procedure[];
}

export interface Program {
  modules: Module[];
}
