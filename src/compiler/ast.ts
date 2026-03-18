/**
 * AST Основа MVP — минимальный набор для bloknot, storage_demo, todo.
 */

export type Expr =
  | { kind: "число"; value: number }
  | { kind: "строка"; value: string }
  | { kind: "булево"; value: boolean }
  | { kind: "пусто" }
  | { kind: "переменная"; name: string }
  | { kind: "бинарное"; op: string; left: Expr; right: Expr }
  | { kind: "унарное"; op: "не"; arg: Expr }
  | { kind: "вызов"; name: string; args: Expr[] };

export type Stmt =
  | { kind: "пусть"; name: string; init: Expr }
  | { kind: "присвоить"; name: string; value: Expr }
  | { kind: "выражение"; expr: Expr }
  | { kind: "если"; condition: Expr; body: Stmt[]; elseIfClauses?: Array<{ condition: Expr; body: Stmt[] }>; elseBody?: Stmt[] }
  | { kind: "пока"; condition: Expr; body: Stmt[] }
  | { kind: "для_каждого"; variable: string; collection: Expr; body: Stmt[] }
  | { kind: "цикл"; body: Stmt[] }
  | { kind: "вернуть"; value?: Expr };

export interface Procedure {
  name: string;
  params: string[];
  body: Stmt[];
}

export interface Module {
  name: string;
  procedures: Procedure[];
}
