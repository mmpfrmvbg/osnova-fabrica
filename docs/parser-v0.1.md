# Парсер языка «Основа» v0.1

Спецификация парсера для языка Основа. Вход — поток токенов от лексера (`lexer-v0.1`), выход — **AST (Abstract Syntax Tree)**. Парсер не проверяет типы и семантику; это отдельный проход (типчекер).

---

## 1. Цели и стратегия

- **Стратегия:** рекурсивный спуск (recursive descent), предсказуемый и удобный для ручной реализации и хороших сообщений об ошибках.
- **Выражения:** приоритеты операторов и ассоциативность задаются таблицей; разбор выражений — через precedence climbing или цепочку правил (term → factor → primary).
- **Восстановление после ошибки:** на уровне v0.1 достаточно синхронного восстановления (synchronization points): при ошибке пропускать токены до следующего `;`, `}`, или начала объявления (`модуль`, `тип`, `процедура`, `функция`, `актор` и т.д.), затем продолжать разбор.
- **Позиции:** каждый узел AST хранит диапазон в исходном тексте (start/end line, column или offset) для диагностики и подсветки.

---

## 2. EBNF-грамматика (ядро)

Ниже — упрощённая EBNF. Терминалы в кавычках или в виде имён токенов из лексера. `[ x ]` — опционально, `{ x }` — ноль или больше, `( a | b )` — выбор.

### 2.1. Модуль и верхний уровень

```ebnf
Module        = "модуль" Identifier ";" { TopLevelDecl } .
TopLevelDecl  = UseDecl | TypeDecl | ProcedureDecl | FunctionDecl | ActorDecl .

UseDecl       = "использовать" QualifiedId ";" .
QualifiedId   = Identifier { "." Identifier } .
```

### 2.2. Типы и структуры

```ebnf
TypeDecl      = "тип" Identifier [ "открытый" | "закрытый" ] "{" { FieldDecl } "}" .
FieldDecl     = Identifier ":" TypeAnn ";" .
TypeAnn       = [ "?" ] [ "ссылка" ] ( BuiltinType | Identifier [ TypeArgs ] ) .
TypeArgs      = "<" TypeAnn { "," TypeAnn } ">" .
BuiltinType   = "Целое8" | "Целое16" | "Целое32" | "Целое64"
              | "Вещественное32" | "Вещественное64"
              | "Логический" | "Строка" | "Байт" | "Ничто" .
```

### 2.3. Процедуры и функции

```ebnf
ProcedureDecl = "процедура" Identifier "(" [ ParamList ] ")" Block .
FunctionDecl  = "функция" Identifier "(" [ ParamList ] ")" ":" TypeAnn Block .
ParamList     = ParamDecl { "," ParamDecl } .
ParamDecl     = Identifier ":" TypeAnn .
Block         = "{" { Statement } "}" .
```

### 2.4. Операторы (Statement)

```ebnf
Statement     = LetStmt | AssignOrCallStmt | IfStmt | WhileStmt | ForEachStmt
               | MatchStmt | ParallelStmt | PredSelectStmt | PacketStmt
               | UnrollLoopStmt | RegionStmt | UnsafeStmt | ReturnStmt
               | Block .

LetStmt       = "пусть" Identifier [ ":" TypeAnn ] "=" Expression ";" .
AssignOrCallStmt = ( LeftHandSide ( "=" | "+=" | "-=" | "*=" | "/=" ) Expression
                   | "вызвать" CallExpr ) ";" .
(* В v0.1 вызов процедуры/функции как оператор допускается только с префиксом "вызвать". *)
(* Составные присваивания +=, -=, *=, /= входят в v0.1; лексер их выдаёт. *)

IfStmt        = "если" Expression Block
                { "иначе_если" Expression Block }
                [ "иначе" Block ] .

WhileStmt     = "пока" Expression Block .

ForEachStmt   = "для" "каждого" Identifier "в" Expression Block .
(* В MVP: одно ключевое слово "для_каждого", тело до "конец": для_каждого Identifier "в" Expression { Statement } "конец" *)

MatchStmt     = "совпадает" Expression Block .
                (* Внутри блока только ветки "когда" — см. WhenClause *)

WhenClause    = "когда" ( Pattern ":" Statement
                         | Identifier "(" Identifier ")" Block ) .
Pattern       = Identifier "(" Identifier ")"  (* Успех(данные), Неудача(ошибка) *)
              | "иначе" .

ParallelStmt  = "параллельно" Block .
PredSelectStmt = "предвыбор" "{" { PredSelectArm } "}" .
PredSelectArm = "когда" Expression ":" Statement .
                (* или "когда" "иначе" ":" Statement *)

PacketStmt    = "пакет" "{" { SlotStmt } "}" .
SlotStmt      = "слот" ( DigitSequence | Identifier ) ":" Statement .
DigitSequence = (* целое число без знака *) .

UnrollLoopStmt = "цикл" "(" "по" Identifier "в" Expression ")" "разворачивать" IntLiteral Block .
RegionStmt   = "регион" Identifier Block .
UnsafeStmt   = "небезопасно" Block .
ReturnStmt   = "вернуть" [ Expression ] ";" .
```

### 2.5. Выражения (Expression)

Приоритет (от низкого к высокому): **логические** (`или` → `и` → `не`) → сравнения → сложение/вычитание → умножение/деление → унарный минус → вызов/доступ к полю/литералы/скобки. В **реализованном MVP** логические операторы `и`, `или`, `не` разбираются с short-circuit семантикой.

```ebnf
Expression    = LogicalOrExpr .
LogicalOrExpr = LogicalAndExpr { "или" LogicalAndExpr } .
LogicalAndExpr = LogicalNotExpr { "и" LogicalNotExpr } .
LogicalNotExpr = [ "не" ] CompareExpr .
CompareExpr   = AddExpr [ ( "==" | "!=" | "<" | "<=" | ">" | ">=" ) AddExpr ] .
AddExpr       = MulExpr { ( "+" | "-" ) MulExpr } .
MulExpr       = UnaryExpr { ( "*" | "/" | "%" ) UnaryExpr } .
UnaryExpr     = [ "-" ] PostfixExpr .
(* В MVP унарное "не" разбирается в LogicalNotExpr выше; в полной спеке "не" может быть и здесь. *)
PostfixExpr   = PrimaryExpr { ( "." Identifier | "(" [ ArgList ] ")" | "[" Expression "]" ) } .
PrimaryExpr   = IntLiteral | FloatLiteral | StringLiteral
              | "истина" | "ложь" | "пусто"
              | Identifier
              | "Успех" "(" Expression ")" | "Неудача" "(" Expression ")"
              | Identifier "{" [ FieldInitList ] "}"   (* конструктор структуры *)
              | "(" Expression ")" .
ArgList       = Expression { "," Expression } .
FieldInitList = Identifier ":" Expression { "," Identifier ":" Expression } .
LeftHandSide  = (* то же что PostfixExpr: идентификатор, доступ к полю, индекс *) .
CallExpr      = PostfixExpr .
```

### 2.6. Акторы

```ebnf
ActorDecl     = "актор" Identifier "{" { ActorMember } "}" .
ActorMember   = Identifier ":" "канал" "<" TypeAnn ">" ";"
              | TaskDecl .
TaskDecl      = "задача" Identifier "(" [ ParamList ] ")" Block .
```

Внутри блока задачи допустимы те же операторы плюс `ожидать`:

```ebnf
AwaitExpr     = "ожидать" PostfixExpr .   (* выражение, возвращающее значение из канала *)
```

---

## 3. Структура AST (узлы)

Каждый узел имеет опциональные поля `loc: { start, end }` (строка/столбец или offset). Ниже — логическая структура, не привязка к языку реализации.

### 3.1. Модуль и объявления верхнего уровня

| Узел | Поля |
|------|------|
| `Module` | `name: string`, `declarations: TopLevelDecl[]` |
| `UseDecl` | `path: string[]` (сегменты квалифицированного имени) |
| `TypeDecl` | `name: string`, `visibility?: 'открытый' \| 'закрытый'`, `fields: FieldDecl[]` |
| `FieldDecl` | `name: string`, `type: TypeAnn` |
| `ProcedureDecl` | `name: string`, `params: ParamDecl[]`, `body: Block` |
| `FunctionDecl` | `name: string`, `params: ParamDecl[]`, `returnType: TypeAnn`, `body: Block` |
| `ActorDecl` | `name: string`, `members: (ChannelMember \| TaskDecl)[]` |
| `ChannelMember` | `name: string`, `elementType: TypeAnn` |
| `TaskDecl` | `name: string`, `params: ParamDecl[]`, `body: Block` |

### 3.2. Типы

| Узел | Поля |
|------|------|
| `TypeAnn` | `optional: boolean`, `ref: boolean`, `name: string`, `typeArgs?: TypeAnn[]` |

Для встроенных типов `name` — `"Целое32"`, `"Строка"` и т.д.; для пользовательских — идентификатор; для дженериков — `typeArgs` заполнен.

### 3.3. Операторы

| Узел | Поля |
|------|------|
| `Block` | `statements: Statement[]` |
| `LetStmt` | `name: string`, `type?: TypeAnn`, `init: Expression` |
| `AssignStmt` | `lhs: LeftHandSide`, `op: '=' \| '+=' \| '-=' \| ...`, `rhs: Expression` |
| `CallStmt` | `call: CallExpr` |
| `IfStmt` | `condition: Expression`, `thenBlock: Block`, `elseIf: { condition, block }[]`, `elseBlock?: Block` |
| `WhileStmt` | `condition: Expression`, `body: Block` |
| `ForEachStmt` | `variable: string`, `collection: Expression`, `body: Block` |
| `MatchStmt` | `subject: Expression`, `clauses: WhenClause[]` |
| `WhenClause` | `pattern: Pattern` (конструктор + имя переменной или `иначе`), `body: Statement \| Block` |
| `ParallelStmt` | `body: Block` |
| `PredSelectStmt` | `arms: { condition: Expression, body: Statement }[]`, `elseArm?: Statement` |
| `PacketStmt` | `slots: { slotId: string \| number, body: Statement }[]` |
| `UnrollLoopStmt` | `variable: string`, `collection: Expression`, `factor: number`, `body: Block` |
| `RegionStmt` | `name: string`, `body: Block` |
| `UnsafeStmt` | `body: Block` |
| `ReturnStmt` | `value?: Expression` |

### 3.4. Выражения

| Узел | Поля |
|------|------|
| `IntLiteral` | `value: number \| bigint`, `raw: string` |
| `FloatLiteral` | `value: number`, `raw: string` |
| `StringLiteral` | `value: string`, `raw: string` |
| `BoolLiteral` | `value: boolean` |
| `NullLiteral` | (пусто — ключевое слово `пусто`) |
| `Identifier` | `name: string` |
| `BinaryExpr` | `left: Expression`, `op: string`, `right: Expression` |
| `UnaryExpr` | `op: string`, `operand: Expression` |
| `CallExpr` | `callee: Expression` (после разбора цепочки вызовов), `args: Expression[]` |
| `MemberExpr` | `object: Expression`, `member: string` |
| `IndexExpr` | `object: Expression`, `index: Expression` |
| `ConstructorExpr` | `typeName: string`, `fields: { name: string, value: Expression }[]` |
| `SuccessExpr` | `value: Expression` |
| `FailureExpr` | `value: Expression` |
| `AwaitExpr` | `expression: Expression` |

`LeftHandSide` в AST можно представить как `MemberExpr` / `IndexExpr` / `Identifier` (то же, что выражение, но только допускающее присваивание).

---

## 4. Неоднозначности и соглашения

- **Вызов vs. скобки вокруг выражения:**  
  `имя(аргумент)` — вызов функции. Скобки вокруг одного выражения — `PrimaryExpr`: `"(" Expression ")"`.

- **`когда` в `совпадает` и в `предвыбор`:**  
  - В `совпадает`: `когда Успех(данные) { ... }` или `когда Неудача(ошибка) { ... }` — конструктор + имя переменной + тело.  
  - В `предвыбор`: `когда условие: оператор` — условие + одно выражение/оператор (без блока с `{ }` в минимальном варианте; при необходимости можно разрешить блок).

- **`слот0` vs `слот 0`:**  
  В грамматике допускается и идентификатор `слот0`, и ключевое слово `слот` с числом. Лексер должен выдавать отдельный токен для `слот` и число/идентификатор; парсер тогда: `"слот" ( IntLiteral | Identifier ) ":" Statement`.

- **Дженерики и сравнения:**  
  В `Список<Юнит>` угловые скобки — часть типа. В `a < b` — оператор. Разрешение: при разборе выражений после `Identifier` смотреть следующий токен: если `"<"` и дальше идёт тип (например, идентификатор), трактовать как начало типа-аргумента; иначе — как оператор сравнения. Для v0.1 можно упростить: в контексте типа парсер ожидает `TypeAnn` (в т.ч. `Identifier "<" ... ">"`), в контексте выражения — бинарный оператор.

---

## 5. Интерфейс парсера (эскиз TypeScript)

```ts
import type { Token } from './lexer';

export type AST = Module;

export interface Module {
  kind: 'Module';
  name: string;
  declarations: TopLevelDecl[];
  loc?: SourceRange;
}

export type TopLevelDecl =
  | UseDecl
  | TypeDecl
  | ProcedureDecl
  | FunctionDecl
  | ActorDecl;

export interface UseDecl {
  kind: 'UseDecl';
  path: string[];
  loc?: SourceRange;
}

export interface TypeDecl {
  kind: 'TypeDecl';
  name: string;
  visibility?: 'открытый' | 'закрытый';
  fields: FieldDecl[];
  loc?: SourceRange;
}

export interface FieldDecl {
  kind: 'FieldDecl';
  name: string;
  type: TypeAnn;
  loc?: SourceRange;
}

export interface TypeAnn {
  kind: 'TypeAnn';
  optional: boolean;
  ref: boolean;
  name: string;
  typeArgs?: TypeAnn[];
  loc?: SourceRange;
}

export interface ProcedureDecl {
  kind: 'ProcedureDecl';
  name: string;
  params: ParamDecl[];
  body: Block;
  loc?: SourceRange;
}

export interface FunctionDecl {
  kind: 'FunctionDecl';
  name: string;
  params: ParamDecl[];
  returnType: TypeAnn;
  body: Block;
  loc?: SourceRange;
}

export interface ParamDecl {
  kind: 'ParamDecl';
  name: string;
  type: TypeAnn;
  loc?: SourceRange;
}

export interface Block {
  kind: 'Block';
  statements: Statement[];
  loc?: SourceRange;
}

export type Statement =
  | LetStmt
  | AssignStmt
  | CallStmt
  | IfStmt
  | WhileStmt
  | ForEachStmt
  | MatchStmt
  | ParallelStmt
  | PredSelectStmt
  | PacketStmt
  | UnrollLoopStmt
  | RegionStmt
  | UnsafeStmt
  | ReturnStmt
  | Block;

export interface LetStmt {
  kind: 'LetStmt';
  name: string;
  type?: TypeAnn;
  init: Expression;
  loc?: SourceRange;
}

export interface AssignStmt {
  kind: 'AssignStmt';
  lhs: LeftHandSide;
  op: '=' | '+=' | '-=' | '*=' | '/=';
  rhs: Expression;
  loc?: SourceRange;
}

export interface CallStmt {
  kind: 'CallStmt';
  call: CallExpr;
  loc?: SourceRange;
}

export interface IfStmt {
  kind: 'IfStmt';
  condition: Expression;
  thenBlock: Block;
  elseIf: { condition: Expression; block: Block }[];
  elseBlock?: Block;
  loc?: SourceRange;
}

export interface WhileStmt {
  kind: 'WhileStmt';
  condition: Expression;
  body: Block;
  loc?: SourceRange;
}

export interface ForEachStmt {
  kind: 'ForEachStmt';
  variable: string;
  collection: Expression;
  body: Block;
  loc?: SourceRange;
}

export interface MatchStmt {
  kind: 'MatchStmt';
  subject: Expression;
  clauses: WhenClause[];
  loc?: SourceRange;
}

export interface WhenClause {
  kind: 'WhenClause';
  pattern: { tag: string; binding: string } | { else: true };
  body: Statement | Block;
  loc?: SourceRange;
}

export interface ParallelStmt {
  kind: 'ParallelStmt';
  body: Block;
  loc?: SourceRange;
}

export interface PredSelectStmt {
  kind: 'PredSelectStmt';
  arms: { condition: Expression; body: Statement }[];
  elseArm?: Statement;
  loc?: SourceRange;
}

export interface PacketStmt {
  kind: 'PacketStmt';
  slots: { slotId: string | number; body: Statement }[];
  loc?: SourceRange;
}

export interface UnrollLoopStmt {
  kind: 'UnrollLoopStmt';
  variable: string;
  collection: Expression;
  factor: number;
  body: Block;
  loc?: SourceRange;
}

export interface RegionStmt {
  kind: 'RegionStmt';
  name: string;
  body: Block;
  loc?: SourceRange;
}

export interface UnsafeStmt {
  kind: 'UnsafeStmt';
  body: Block;
  loc?: SourceRange;
}

export interface ReturnStmt {
  kind: 'ReturnStmt';
  value?: Expression;
  loc?: SourceRange;
}

export type Expression =
  | IntLiteral
  | FloatLiteral
  | StringLiteral
  | BoolLiteral
  | NullLiteral
  | Identifier
  | BinaryExpr
  | UnaryExpr
  | CallExpr
  | MemberExpr
  | IndexExpr
  | ConstructorExpr
  | SuccessExpr
  | FailureExpr
  | AwaitExpr;

export interface IntLiteral {
  kind: 'IntLiteral';
  value: number | bigint;
  raw: string;
  loc?: SourceRange;
}

export interface FloatLiteral {
  kind: 'FloatLiteral';
  value: number;
  raw: string;
  loc?: SourceRange;
}

export interface StringLiteral {
  kind: 'StringLiteral';
  value: string;
  raw: string;
  loc?: SourceRange;
}

export interface BoolLiteral {
  kind: 'BoolLiteral';
  value: boolean;
  loc?: SourceRange;
}

export interface NullLiteral {
  kind: 'NullLiteral';
  loc?: SourceRange;
}

export interface Identifier {
  kind: 'Identifier';
  name: string;
  loc?: SourceRange;
}

export interface BinaryExpr {
  kind: 'BinaryExpr';
  left: Expression;
  op: string;
  right: Expression;
  loc?: SourceRange;
}

export interface UnaryExpr {
  kind: 'UnaryExpr';
  op: string;
  operand: Expression;
  loc?: SourceRange;
}

export interface CallExpr {
  kind: 'CallExpr';
  callee: Expression;
  args: Expression[];
  loc?: SourceRange;
}

export interface MemberExpr {
  kind: 'MemberExpr';
  object: Expression;
  member: string;
  loc?: SourceRange;
}

export interface IndexExpr {
  kind: 'IndexExpr';
  object: Expression;
  index: Expression;
  loc?: SourceRange;
}

export interface ConstructorExpr {
  kind: 'ConstructorExpr';
  typeName: string;
  fields: { name: string; value: Expression }[];
  loc?: SourceRange;
}

export interface SuccessExpr {
  kind: 'SuccessExpr';
  value: Expression;
  loc?: SourceRange;
}

export interface FailureExpr {
  kind: 'FailureExpr';
  value: Expression;
  loc?: SourceRange;
}

export interface AwaitExpr {
  kind: 'AwaitExpr';
  expression: Expression;
  loc?: SourceRange;
}

export type LeftHandSide = Identifier | MemberExpr | IndexExpr;

export interface ActorDecl {
  kind: 'ActorDecl';
  name: string;
  members: (ChannelMember | TaskDecl)[];
  loc?: SourceRange;
}

export interface ChannelMember {
  kind: 'ChannelMember';
  name: string;
  elementType: TypeAnn;
  loc?: SourceRange;
}

export interface TaskDecl {
  kind: 'TaskDecl';
  name: string;
  params: ParamDecl[];
  body: Block;
  loc?: SourceRange;
}

export interface SourceRange {
  start: { line: number; column: number; offset: number };
  end: { line: number; column: number; offset: number };
}

export interface ParseError {
  message: string;
  line: number;
  column: number;
  offset: number;
}

export interface ParseResult {
  ast: Module | null;
  errors: ParseError[];
}

export function parse(tokens: Token[]): ParseResult {
  // Реализация рекурсивного спуска по EBNF выше.
  // При ошибке — добавлять в errors, по возможности синхронизироваться и продолжать.
  return { ast: null, errors: [] };
}
```

---

## 6. Границы v0.1

- **Включено в MVP-парсер:** модуль, процедуры (без типов параметров), блоки через `конец`, `пусть`, присваивание, вызов (без `вызвать`), `если`/`иначе`/`конец`, `пока`/`конец`, **`для_каждого`** `переменная` **`в`** `выражение` … `конец`, `цикл`/`конец`, `вернуть`, выражения с **`и`**/ **`или`**/ **`не`** (short-circuit).
- **Включено в спеке (полная грамматика):** модуль, `использовать`, типы и поля, процедуры/функции, блоки, `пусть`, присваивание, вызов с `вызвать`, `если`/`иначе_если`/`иначе`, `пока`, `для каждого`, `совпадает`/`когда`, `параллельно`, `предвыбор`, `пакет`/`слот`, `цикл ... разворачивать`, `регион`, `небезопасно`, `вернуть`, актор/канал/задача/`ожидать`, конструкторы `Успех`/`Неудача`, инициализация структур.
- **Не входит в парсер (оставить типчекеру/семантике):** проверка типов, проверка существования символов, правила чистоты функции, контроль прав доступа к полям.
- **Можно отложить на v0.2:** индексация `a[i]`, многострочные литералы, расширенный синтаксис `когда`.
