/**
 * Парсер Основа MVP: newline как разделитель инструкций, блоки через конец.
 */

import { KEYWORDS, type Token, type TokenKind } from "./lexer";
import type { Program, Module, Procedure, Stmt, Expr, ImportDeclaration, TypeDeclaration, TypeRef, TypeField } from "./ast";

export type ParseErrorContext = "module" | "procedure" | "stmt" | "expr";

export interface ParseError {
  message: string;
  line: number;
  column: number;
  expected?: string[];
  actualKind?: TokenKind;
  actualLexeme?: string;
  context?: ParseErrorContext;
}

export interface ParseResult {
  ast: Program | null;
  errors: ParseError[];
}

export function parse(tokens: Token[]): ParseResult {
  const errors: ParseError[] = [];
  let pos = 0;

  function peek(): Token {
    return tokens[pos] ?? tokens[tokens.length - 1];
  }

  /**
   * Следующий токен.
   *
   * ВАЖНО: `pos` обязан двигаться и на `конец_файла` — иначе на нём можно
   * застрять. Раньше здесь стоял запрет двигаться с `конец_файла`, и любой цикл
   * восстановления после ошибки (`while (peek() !== "конец_файла")`) навсегда
   * зацикливался на последнем токене: `peek()` возвращал тот же `конец_файла`,
   * `pos` не менялся. Это и был вечный цикл/OOM на `попробовать` + неизвестное
   * слово. Циклы проверяют `pos < tokens.length`, поэтому выход есть.
   */
  function advance(): Token {
    const t = peek();
    if (pos < tokens.length) pos++;
    return t;
  }

  function isAt(kind: TokenKind): boolean {
    return peek().kind === kind;
  }

  function consume(kind: TokenKind, msg: string): boolean {
    if (peek().kind === kind) {
      advance();
      return true;
    }
    const t = peek();
    errors.push({
      message: `${msg}, получено: ${t.kind}`,
      line: t.line,
      column: t.column,
      expected: [kind],
      actualKind: t.kind,
      actualLexeme: t.lexeme,
    });
    return false;
  }

  function skipNewlines(): void {
    while (peek().kind === "новая_строка") advance();
  }

  /**
   * ─── БЛОК 1 (v2): закрывающее слово называет свой блок ───
   *
   * `конец_X` — канон: закрывает X и ничего другого. `конец` — контекстный
   * токен: закрывает ближайший блок по контексту, а вне позиции закрытия
   * работает как имя (`пусть конец = 5`, `о.конец`). Контекст закрытия
   * определяет `isCloserToken`.
   */
  const KIND_КОНЕЦ_ПРОЦЕДУРЫ: TokenKind = "конец_процедуры";
  const KIND_КОНЕЦ_ЕСЛИ: TokenKind = "конец_если";
  const KIND_КОНЕЦ_ПОКА: TokenKind = "конец_пока";
  const KIND_КОНЕЦ_ДЛЯ: TokenKind = "конец_для";
  const KIND_КОНЕЦ_ЦИКЛА: TokenKind = "конец_цикла";
  const KIND_КОНЕЦ_КОГДА: TokenKind = "конец_когда";
  const KIND_КОНЕЦ_ПОПРОБОВАТЬ: TokenKind = "конец_попробовать";
  const KIND_КОНЕЦ_МОДУЛЯ: TokenKind = "конец_модуля";

  const ANY_BLOCK_CLOSER_KINDS: readonly TokenKind[] = [
    KIND_КОНЕЦ_ЕСЛИ,
    KIND_КОНЕЦ_ПОКА,
    KIND_КОНЕЦ_ДЛЯ,
    KIND_КОНЕЦ_ЦИКЛА,
    KIND_КОНЕЦ_КОГДА,
    KIND_КОНЕЦ_ПОПРОБОВАТЬ,
    KIND_КОНЕЦ_ПРОЦЕДУРЫ,
    KIND_КОНЕЦ_МОДУЛЯ,
  ];

  /** Лексемы, принимаемые как имена: `конец` больше не зарезервирован. */
  const CONTEXTUAL_NAME_LEXEMES: readonly string[] = ["конец"];

  /**
   * Продолжение инструкции сразу после токена — значит, это имя, а не закрытие.
   * `пусть конец = 5`, `вернуть конец - начало`, `о.конец`.
   */
  const EXPR_CONTINUATION_KINDS: readonly TokenKind[] = [
    "=", "+=", "-=", "*=", "/=",
    "+", "-", "*", "/", "%",
    "==", "!=", "<", "<=", ">", ">=",
    "и", "или", "?", ".",
    "[", "]", "(", ")",
    ",", ":", "}",
  ];

  function peekNext(): Token {
    return tokens[pos + 1] ?? tokens[tokens.length - 1];
  }

  /**
   * Глубина разбора условия. В условии одиночный `=` читается как `==`
   * (пункт 1.1 требований: 52 случая в трейсах — модель тянет `=` из Pascal/SQL).
   * Вне условия `=` остаётся оператором инструкции, и в выражении он — ошибка.
   */
  let conditionDepth = 0;

  /** Разобрать выражение в позиции условия (`если`, `иначе_если`, `пока`). */
  function parseCondition(): Expr | null {
    conditionDepth++;
    try {
      return parseExpr();
    } finally {
      conditionDepth--;
    }
  }
  /**
   * Токен — закрывающее слово для блока. `конец_X` однозначны (ключевые слова).
   * `конец` закрывает только тогда, когда за ним НЕТ продолжения инструкции.
   */
  function isCloserToken(t: Token): boolean {
    if (t.kind === "конец") {
      if (!CONTEXTUAL_NAME_LEXEMES.includes(t.lexeme)) return false;
      const n = peekNext();
      if (n.kind === "новая_строка" || n.kind === "конец_файла") return true;
      if (ANY_BLOCK_CLOSER_KINDS.includes(n.kind)) return true;
      return !EXPR_CONTINUATION_KINDS.includes(n.kind);
    }
    return ANY_BLOCK_CLOSER_KINDS.includes(t.kind) && t.lexeme === t.kind;
  }

  function isContextualNameToken(): boolean {
    const t = peek();
    return t.kind === "конец" && CONTEXTUAL_NAME_LEXEMES.includes(t.lexeme);
  }


  /** Принимаемое закрытие конкретного блока: канон (`конец_X`) и legacy (`конец`). */
  interface CloserSpec {
    kinds: readonly TokenKind[];
    /** Человекочитаемое имя закрываемого блока — для диагностики. */
    block: string;
  }

  const PROCEDURE_CLOSER: CloserSpec = { kinds: [KIND_КОНЕЦ_ПРОЦЕДУРЫ, "конец"], block: "процедура" };
  const MODULE_CLOSER: CloserSpec = { kinds: [KIND_КОНЕЦ_МОДУЛЯ, "конец"], block: "модуль" };
  const IF_CLOSER: CloserSpec = { kinds: [KIND_КОНЕЦ_ЕСЛИ, "конец"], block: "если" };
  const WHEN_CLOSER: CloserSpec = { kinds: [KIND_КОНЕЦ_КОГДА, "конец"], block: "когда" };
  const TRY_CLOSER: CloserSpec = { kinds: [KIND_КОНЕЦ_ПОПРОБОВАТЬ, "конец"], block: "попробовать" };
  const WHILE_CLOSER: CloserSpec = { kinds: [KIND_КОНЕЦ_ПОКА, "конец"], block: "пока" };
  // `конец_для_каждого` — полная форма имени конструкции; реестр знает короткую
  // `конец_для`. Обе принимаются: отказ на полной форме был бы непонятен.
  const FOR_EACH_CLOSER: CloserSpec = { kinds: [KIND_КОНЕЦ_ДЛЯ, "конец_для_каждого", "конец"], block: "для" };
  const LOOP_CLOSER: CloserSpec = { kinds: [KIND_КОНЕЦ_ЦИКЛА, "конец"], block: "цикл" };

  /** Закрывает ли текущий токен блок по спецификации `spec`. */
  function isAtCloser(spec: CloserSpec): boolean {
    const t = peek();
    return spec.kinds.includes(t.kind) && isCloserToken(t);
  }

  /** Явное закрытие не тем словом — ошибка с указанием ожидаемого. */
  function isMismatchedCloser(spec: CloserSpec): boolean {
    const t = peek();
    return ANY_BLOCK_CLOSER_KINDS.includes(t.kind) && isCloserToken(t) && !spec.kinds.includes(t.kind);
  }

  /**
   * Закрыть блок. Отказ называет блок и ожидаемое слово: «Закрытие ... не
   * совпадает» при явно не том слове и «Ожидается закрытие ...» при отсутствии.
   */
  function expectCloser(spec: CloserSpec): boolean {
    if (isAtCloser(spec)) {
      advance();
      return true;
    }
    const expectedWords = spec.kinds.map((k) => `'${k}'`).join(" или ");
    if (isMismatchedCloser(spec)) {
      const t = peek();
      errors.push({
        message: `Закрытие не совпадает: блок «${spec.block}» закрывается ${expectedWords}, получено: '${t.lexeme}'`,
        line: t.line,
        column: t.column,
        context: "stmt",
        expected: [...spec.kinds],
        actualKind: t.kind,
        actualLexeme: t.lexeme,
      });
      advance();
      return false;
    }
    const t = peek();
    errors.push({
      message: `Ожидается закрытие блока «${spec.block}»: ${expectedWords}, получено: ${t.kind}`,
      line: t.line,
      column: t.column,
      context: "stmt",
      expected: [...spec.kinds],
      actualKind: t.kind,
      actualLexeme: t.lexeme,
    });
    return false;
  }

  function isFieldNameToken(): boolean {
    const t = peek();
    return t.kind === "идентификатор" || KEYWORDS[t.lexeme] !== undefined || isContextualNameToken();
  }

  function takeFieldName(): string {
    const tok = advance();
    return String(tok.value ?? tok.lexeme);
  }

  function atElseIf(): boolean {
    if (peek().kind === "иначе_если") return true;
    if (peek().kind !== "иначе") return false;
    return tokens[pos + 1]?.kind === "если";
  }

  function consumeElseIf(): void {
    if (peek().kind === "иначе_если") {
      advance();
      return;
    }
    advance();
    advance();
  }

  /** Восстановление после ошибки: до новой строки, конец/конец_файла или начала следующей инструкции. */
  function syncToStmtBoundary(): void {
    const stmtHead: TokenKind[] = [
      "пусть",
      "если",
      "когда",
      "пока",
      "вернуть",
      "для",
      "попробовать",
      "выбросить",
      "прервать",
      "продолжить",
      "цикл",
    ];
    const start = pos;
    while (pos < tokens.length) {
      const k = peek().kind;
      if (k === "новая_строка" || k === "конец" || k === "конец_файла") break;
      if (stmtHead.includes(k)) break;
      advance();
    }
    // Гарантия прогресса: восстановление обязано сдвинуть разбор хотя бы на
    // токен. Иначе «текущий токен — начало инструкции, которую не удалось
    // разобрать» превращается в вечный цикл у вызывающего.
    if (pos === start) advance();
  }

  /** Восстановление на уровне модуля: до следующей процедура или конец_файла. */
  function syncToTopLevel(): void {
    while (pos < tokens.length) {
      const k = peek().kind;
      if (k === "процедура" || k === "модуль" || k === "конец_файла") return;
      advance();
    }
  }

  function parseModule(): Module | null {
    if (!isAt("модуль")) {
      const t = peek();
      errors.push({
        message: "Ожидается 'модуль'",
        line: t.line,
        column: t.column,
        context: "module",
        expected: ["модуль"],
        actualKind: t.kind,
        actualLexeme: t.lexeme,
      });
      return null;
    }
    advance();
    if (!isAt("идентификатор")) {
      const t = peek();
      errors.push({
        message: "Ожидается имя модуля",
        line: t.line,
        column: t.column,
        context: "module",
        expected: ["идентификатор"],
        actualKind: t.kind,
        actualLexeme: t.lexeme,
      });
      return null;
    }
    const tokMod = advance();
    const name = String(tokMod.value ?? tokMod.lexeme);
    skipNewlines();
    const imports: ImportDeclaration[] = [];
    // Импорт разрешён только в самом начале модуля.
    while (peek().kind === "использовать") {
      const imp = parseImportDeclaration();
      if (imp) imports.push(imp);
      else syncToTopLevel();
      skipNewlines();
    }

    const typeDeclarations: TypeDeclaration[] = [];
    // TypeDeclaration разрешён только до объявления процедур.
    while (peek().kind === "тип") {
      const t = parseTypeDeclaration();
      if (t) typeDeclarations.push(t);
      else syncToTopLevel();
      skipNewlines();
    }

    const procedures: Procedure[] = [];
    while (peek().kind === "процедура" || peek().kind === "экспорт" || peek().kind === "чистый" || peek().kind === "использовать" || peek().kind === "тип") {
      if (peek().kind === "использовать") {
        const t = peek();
        errors.push({
          message: "Импорт разрешён только в начале модуля",
          line: t.line,
          column: t.column,
          context: "module",
        });
        advance();
        skipNewlines();
        continue;
      }
      if (peek().kind === "тип") {
        const t = peek();
        errors.push({
          message: "TypeDeclaration разрешён только до процедур",
          line: t.line,
          column: t.column,
          context: "module",
        });
        // Съедим TypeDeclaration, чтобы синхронизироваться.
        const parsed = parseTypeDeclaration();
        if (parsed) skipNewlines();
        continue;
      }
      const p = parseProcedure();
      if (p) procedures.push(p);
      else syncToTopLevel();
      skipNewlines();
    }
    // Опциональный закрывающий "конец"/"конец_модуля" для модуля (БЛОК 1 v2).
    if (isAtCloser(MODULE_CLOSER)) {
      advance();
      skipNewlines();
    }
    return { name, imports, typeDeclarations, procedures };
  }

  function parseImportDeclaration(): ImportDeclaration | null {
    advance(); // использовать
    if (!consume("модуль", "Ожидается 'модуль' после 'использовать'")) return null;

    if (!isAt("идентификатор")) {
      const t = peek();
      errors.push({
        message: "Ожидается имя namespace после 'модуль'",
        line: t.line,
        column: t.column,
        context: "module",
        expected: ["идентификатор"],
        actualKind: t.kind,
        actualLexeme: t.lexeme,
      });
      return null;
    }
    const tokAlias = advance();
    const alias = String(tokAlias.value ?? tokAlias.lexeme);

    if (!consume("из", "Ожидается 'из' после имени namespace")) return null;

    if (!isAt("строка")) {
      const t = peek();
      errors.push({
        message: "Ожидается строка с путём после 'из'",
        line: t.line,
        column: t.column,
        context: "module",
        expected: ["строка"],
        actualKind: t.kind,
        actualLexeme: t.lexeme,
      });
      return null;
    }
    const tokPath = advance();
    const path = String(tokPath.value ?? tokPath.lexeme);
    return { module: alias, path };
  }

  function parseTypeRef(): TypeRef | null {
    let nullable = false;
    if (peek().kind === "?") {
      advance();
      nullable = true;
      skipNewlines();
    }
    if (isAt("[")) {
      advance();
      skipNewlines();
      if (!isAt("идентификатор")) {
        const t = peek();
        errors.push({
          message: "Ожидается имя типа элемента массива",
          line: t.line,
          column: t.column,
          context: "module",
          expected: ["идентификатор"],
          actualKind: t.kind,
          actualLexeme: t.lexeme,
        });
        return null;
      }
      const tok = advance();
      const name = String(tok.value ?? tok.lexeme);
      skipNewlines();
      if (!consume("]", "Ожидается ']' после типа элемента массива")) return null;
      return { name, nullable, array: true };
    }
    if (!isAt("идентификатор")) {
      const t = peek();
      errors.push({
        message: "Ожидается имя типа",
        line: t.line,
        column: t.column,
        context: "module",
        expected: ["идентификатор"],
        actualKind: t.kind,
        actualLexeme: t.lexeme,
      });
      return null;
    }
    const tok = advance();
    const name = String(tok.value ?? tok.lexeme);
    return { name, nullable };
  }

  function parseTypeDeclaration(): TypeDeclaration | null {
    advance(); // тип
    if (!isAt("идентификатор")) {
      const t = peek();
      errors.push({
        message: "Ожидается имя типа после 'тип'",
        line: t.line,
        column: t.column,
        context: "module",
        expected: ["идентификатор"],
        actualKind: t.kind,
        actualLexeme: t.lexeme,
      });
      return null;
    }
    const tokName = advance();
    const name = String(tokName.value ?? tokName.lexeme);
    skipNewlines();

    // Перечень: `тип Имя = a | b | c`.
    // Запись: `тип Имя = { поле: Тип, … }` — знак `=` допустим и в этой форме
    // (модель пишет запись через `=`, это частая LLM-ошибка; принимаем оба
    // написания вместо отказа).
    if (peek().kind === "=" && tokens[pos + 1]?.kind !== "{") {
      advance();
      skipNewlines();
      const variants: string[] = [];
      while (true) {
        if (!isFieldNameToken()) {
          const t = peek();
          errors.push({
            message: "Ожидается имя варианта перечня",
            line: t.line,
            column: t.column,
            context: "module",
            expected: ["идентификатор"],
            actualKind: t.kind,
            actualLexeme: t.lexeme,
          });
          return null;
        }
        variants.push(takeFieldName());
        skipNewlines();
        if (peek().kind === "|") {
          advance();
          skipNewlines();
          continue;
        }
        break;
      }
      if (variants.length === 0) {
        const t = peek();
        errors.push({
          message: "Перечень должен содержать хотя бы один вариант",
          line: t.line,
          column: t.column,
          context: "module",
        });
        return null;
      }
      return { kind: "TypeDeclaration", name, fields: [], variants };
    }

    // Форма записи со знаком равенства: `тип Имя = { … }` — `=` пропускаем,
    // дальше разбор тела общий.
    if (peek().kind === "=") advance();
    if (!consume("{", "Ожидается '{' или '=' после имени типа")) return null;
    skipNewlines();

    const fields: TypeField[] = [];
    while (peek().kind !== "}" && peek().kind !== "конец_файла") {
      skipNewlines();
      if (!isFieldNameToken()) {
        const t = peek();
        errors.push({
          message: "Ожидается имя поля типа",
          line: t.line,
          column: t.column,
          context: "module",
          expected: ["идентификатор"],
          actualKind: t.kind,
          actualLexeme: t.lexeme,
        });
        return null;
      }
      const fieldName = takeFieldName();
      if (!consume(":", "Ожидается ':' после имени поля")) return null;
      skipNewlines();

      const fieldType = parseTypeRef();
      if (!fieldType) return null;
      fields.push({ name: fieldName, type: fieldType });

      skipNewlines();
      if (peek().kind === ",") {
        advance();
        skipNewlines();
      }
    }

    if (!consume("}", "Ожидается '}' после тела типа")) return null;
    return { kind: "TypeDeclaration", name, fields };
  }

  function parseProcedure(): Procedure | null {
    let exported = false;
    let pure = false;
    if (peek().kind === "экспорт") {
      advance();
      exported = true;
      skipNewlines();
    }
    if (peek().kind === "чистый") {
      advance();
      pure = true;
      skipNewlines();
    }

    if (!consume("процедура", "Ожидается 'процедура'")) return null;

    // Поддержка формы: "процедура экспорт имя(...)" (экспорт после процедуры)
    if (peek().kind === "экспорт") {
      advance();
      exported = true;
      skipNewlines();
    }
    if (peek().kind === "чистый") {
      advance();
      pure = true;
      skipNewlines();
    }

    if (!isAt("идентификатор")) {
      const t = peek();
      errors.push({
        message: "Ожидается имя процедуры",
        line: t.line,
        column: t.column,
        context: "procedure",
        expected: ["идентификатор"],
        actualKind: t.kind,
        actualLexeme: t.lexeme,
      });
      return null;
    }
    const tokProc = advance();
    const name = String(tokProc.value ?? tokProc.lexeme);
    if (!consume("(", "Ожидается '(' после имени процедуры")) return null;
    const params: string[] = [];
    const paramTypes: Array<TypeRef | undefined> = [];
    skipNewlines();
    while (isAt("идентификатор") || isContextualNameToken()) {
      const tokParam = advance();
      params.push(String(tokParam.value ?? tokParam.lexeme));
      skipNewlines();
      if (peek().kind === ":") {
        advance();
        skipNewlines();
        const pt = parseTypeRef();
        paramTypes.push(pt ?? undefined);
        skipNewlines();
      } else {
        paramTypes.push(undefined);
      }
      if (peek().kind === ",") {
        advance();
        skipNewlines();
      } else break;
    }
    if (!consume(")", "Ожидается ')'")) return null;
    skipNewlines();
    let returnType: TypeRef | undefined;
    if (peek().kind === ":") {
      advance();
      skipNewlines();
      returnType = parseTypeRef() ?? undefined;
      skipNewlines();
    }
    const body: Stmt[] = [];
    while (!isAtCloser(PROCEDURE_CLOSER) && !isMismatchedCloser(PROCEDURE_CLOSER) && peek().kind !== "конец_файла") {
      const before = pos;
      const s = parseStmt();
      if (s) body.push(s);
      else syncToStmtBoundary();
      // Гарантия прогресса: разбор, не сдвинувший позицию, — вечный цикл.
      // НЕ ПОКРЫТА оракулом (замер 2026-09-23): 875 входов, 0 срабатываний —
      // защита в глубину. Реестр: docs/verification-debt.md, п. 5.
      if (pos === before) break;
      skipNewlines();
    }
    if (!expectCloser(PROCEDURE_CLOSER)) return null;
    const hasParamTypes = paramTypes.some((t) => t !== undefined);
    return {
      name,
      params,
      body,
      exported,
      pure,
      paramTypes: hasParamTypes ? paramTypes : undefined,
      returnType,
    };
  }

  /**
   * `пока_не` в позиции КОНСТРУКЦИИ: слово, за которым идёт выражение
   * (`пока_не x > 5`). Решение владельца — конструкцию не добавлять; здесь только
   * точная диагностика вместо каскада ошибок.
   *
   * Как имя переменной слово законно (`пусть пока_не = 5`, `пока_не = 1`,
   * `пока_не(...)`, `пока_не.поле`), поэтому за присваиванием/вызовом/полем/
   * индексом и в конце строки диагностика молчит.
   */
  function atMissingWhileNot(): boolean {
    const t = peek();
    if (t.kind !== "идентификатор" || t.lexeme !== "пока_не") return false;
    const varLike: TokenKind[] = [
      "=", "+=", "-=", "*=", "/=", "(", ".", "[", ",",
      "новая_строка", "конец_файла",
    ];
    return !varLike.includes(peekNext().kind);
  }
  function parseStmt(): Stmt | null {
    if (atMissingWhileNot()) {
      const t = peek();
      errors.push({
        message: "нет конструкции 'пока_не'; используйте 'пока не x'",
        line: t.line,
        column: t.column,
        context: "stmt",
        expected: ["пока"],
        actualKind: t.kind,
        actualLexeme: t.lexeme,
      });
      advance();
      return null;
    }
    const compoundToBinaryOp: Record<"+=" | "-=" | "*=" | "/=", "+" | "-" | "*" | "/"> = {
      "+=": "+",
      "-=": "-",
      "*=": "*",
      "/=": "/",
    };
    const isAssignOp = (k: TokenKind): boolean =>
      k === "=" || k === "+=" || k === "-=" || k === "*=" || k === "/=";

    function indexAssignStmt(arr: Expr, idx: Expr, opKind: TokenKind, rhs: Expr): Stmt {
      if (opKind === "=") {
        return {
          kind: "выражение",
          expr: { kind: "вызов", name: "система.массив.установить", args: [arr, idx, rhs] },
        };
      }
      const binOp = compoundToBinaryOp[opKind as "+=" | "-=" | "*=" | "/="];
      const current: Expr = { kind: "вызов", name: "система.массив.получить", args: [arr, idx] };
      const value: Expr = { kind: "бинарное", op: binOp, left: current, right: rhs };
      return {
        kind: "выражение",
        expr: { kind: "вызов", name: "система.массив.установить", args: [arr, idx, value] },
      };
    }

    function fieldAssignStmt(object: Expr, field: string, opKind: TokenKind, rhs: Expr): Stmt {
      if (opKind === "=") {
        return { kind: "поле_присвоить", object, field, value: rhs };
      }
      const value: Expr = {
        kind: "бинарное",
        op: compoundToBinaryOp[opKind as "+=" | "-=" | "*=" | "/="],
        left: { kind: "поле", object, field },
        right: rhs,
      };
      return { kind: "поле_присвоить", object, field, value };
    }

    /** `x =`, `arr[i] =`, `мир.поле[i] =`, `мир.доска[i].вид =`. `"нет"` — не присваивание, откат. */
    function tryParsePostfixAssign(baseName: string): Stmt | null | "нет" {
      let target: Expr = { kind: "переменная", name: baseName };
      for (;;) {
        if (peek().kind === "[") {
          advance();
          skipNewlines();
          const idx = parseExpr();
          if (!idx) return null;
          if (!consume("]", "Ожидается ']'")) return null;
          if (isAssignOp(peek().kind)) {
            const opKind = advance().kind;
            skipNewlines();
            const rhs = parseExpr();
            if (!rhs) return null;
            return indexAssignStmt(target, idx, opKind, rhs);
          }
          target = { kind: "вызов", name: "система.массив.получить", args: [target, idx] };
          continue;
        }
        if (peek().kind === ".") {
          const dotPos = pos;
          advance();
          skipNewlines();
          if (!isFieldNameToken()) {
            pos = dotPos;
            return "нет";
          }
          const fName = takeFieldName();
          if (peek().kind === "(") return "нет";
          if (isAssignOp(peek().kind)) {
            const opKind = advance().kind;
            skipNewlines();
            const rhs = parseExpr();
            if (!rhs) return null;
            return fieldAssignStmt(target, fName, opKind, rhs);
          }
          target = { kind: "поле", object: target, field: fName };
          continue;
        }
        if (isAssignOp(peek().kind) && target.kind === "переменная") {
          const opKind = advance().kind;
          skipNewlines();
          const rhs = parseExpr();
          if (!rhs) return null;
          if (opKind === "=") return { kind: "присвоить", name: baseName, value: rhs };
          const value: Expr = {
            kind: "бинарное",
            op: compoundToBinaryOp[opKind as "+=" | "-=" | "*=" | "/="],
            left: { kind: "переменная", name: baseName },
            right: rhs,
          };
          return { kind: "присвоить", name: baseName, value };
        }
        return "нет";
      }
    }

    if (peek().kind === "пусть") {
      advance();
      let name: string;
      if (isAt("идентификатор")) {
        const tokLet = advance();
        name = String(tokLet.value ?? tokLet.lexeme);
      } else if (isContextualNameToken()) {
        // `конец` — контекстный токен; вне позиции закрытия это обычное имя.
        name = advance().lexeme;
      } else if (KEYWORDS[peek().lexeme] !== undefined) {
        // ключевое слово на месте имени — парсим как имя, семантика выдаст keyword_as_identifier
        const tokLet = advance();
        name = tokLet.lexeme;
      } else {
        const t = peek();
        errors.push({
          message: "Ожидается имя переменной после 'пусть'",
          line: t.line,
          column: t.column,
          context: "stmt",
          expected: ["идентификатор"],
          actualKind: t.kind,
          actualLexeme: t.lexeme,
        });
        return null;
      }
      let typeAnnotation: TypeRef | undefined;
      if (peek().kind === ":") {
        advance(); // consume ':'
        skipNewlines();
        const t = parseTypeRef();
        if (!t) return null;
        typeAnnotation = t;
      }
      if (peek().kind === ",") {
        const имена: string[] = [name];
        while (peek().kind === ",") {
          advance();
          skipNewlines();
          if (peek().kind !== "идентификатор") {
            const et = peek();
            errors.push({ message: "Ожидается имя переменной после ','", line: et.line, column: et.column, context: "stmt" });
            return null;
          }
          имена.push(String(peek().value ?? peek().lexeme));
          advance();
          skipNewlines();
        }
        if (!consume("=", "Ожидается '='")) return null;
        skipNewlines();
        const init = parseExpr();
        if (!init) return null;
        return { kind: "распаковать", имена, значение: init };
      }
      if (!consume("=", "Ожидается '='")) return null;
      skipNewlines();
      const init = parseExpr();
      if (!init) return null;
      return { kind: "пусть", name, init, typeAnnotation };
    }
    if (peek().kind === "вернуть") {
      advance();
      // Два сигнала вместе, порознь их не хватает:
      //  - значение может быть и на следующей строке (`вернуть` + перевод + `0`):
      //    это зафиксировано тестом parser.test.ts и должно остаться;
      //  - `конец` на ТОЙ ЖЕ строке, что `вернуть`, — имя переменной (§1.4):
      //    закрытие блока на строке с `вернуть` не пишут;
      //  - `конец` на СЛЕДУЮЩЕЙ строке — закрытие блока, а не значение: иначе
      //    пустой возврат съедал бы закрытие.
      const sameLine = peek().kind !== "новая_строка";
      skipNewlines();
      const atEof = peek().kind === "конец_файла";
      const closerOnNextLine = !sameLine && isCloserToken(peek());
      let value: Expr | undefined;
      if (!atEof && !closerOnNextLine) {
        const v = parseExpr();
        if (v) {
          if (peek().kind === ",") {
            const элементы: Expr[] = [v];
            while (peek().kind === ",") {
              advance();
              skipNewlines();
              const el = parseExpr();
              if (el) элементы.push(el);
            }
            value = { kind: "кортеж", элементы };
          } else {
            value = v;
          }
        }
      }
      return { kind: "вернуть", value };
    }
    if (peek().kind === "если") {
      advance();
      skipNewlines();
      const condition = parseCondition();
      if (!condition) return null;
      if (peek().kind === "тогда") advance();
      skipNewlines();
      const body: Stmt[] = [];
      while (peek().kind !== "иначе_если" && peek().kind !== "иначе" && !isAtCloser(IF_CLOSER) && !isMismatchedCloser(IF_CLOSER) && peek().kind !== "конец_файла") {
        const before = pos;
        const s = parseStmt();
        if (s) body.push(s);
        else syncToStmtBoundary();
        // Гарантия прогресса: разбор, не сдвинувший позицию, — вечный цикл.
        // НЕ ПОКРЫТА оракулом (замер 2026-09-23): 875 входов, 0 срабатываний —
        // защита в глубину. Реестр: docs/verification-debt.md, п. 5.
        if (pos === before) break;
        skipNewlines();
      }
      const elseIfClauses: Array<{ condition: Expr; body: Stmt[] }> = [];
      while (atElseIf()) {
        consumeElseIf();
        skipNewlines();
        const cond = parseCondition();
        if (!cond) return null;
        if (peek().kind === "тогда") advance();
        skipNewlines();
        const clauseBody: Stmt[] = [];
        while (peek().kind !== "иначе_если" && peek().kind !== "иначе" && !isAtCloser(IF_CLOSER) && !isMismatchedCloser(IF_CLOSER) && peek().kind !== "конец_файла") {
          const before = pos;
          const s = parseStmt();
          if (s) clauseBody.push(s);
          else syncToStmtBoundary();
          // Гарантия прогресса: разбор, не сдвинувший позицию, — вечный цикл.
          // НЕ ПОКРЫТА оракулом (замер 2026-09-23): 875 входов, 0 срабатываний —
          // защита в глубину. Реестр: docs/verification-debt.md, п. 5.
          if (pos === before) break;
          skipNewlines();
        }
        elseIfClauses.push({ condition: cond, body: clauseBody });
      }
      let elseBody: Stmt[] | undefined;
      if (peek().kind === "иначе") {
        advance();
        skipNewlines();
        elseBody = [];
        while (!isAtCloser(WHEN_CLOSER) && !isMismatchedCloser(WHEN_CLOSER) && peek().kind !== "конец_файла") {
          const before = pos;
          const s = parseStmt();
          if (s) elseBody.push(s);
          else syncToStmtBoundary();
          // Гарантия прогресса: разбор, не сдвинувший позицию, — вечный цикл.
          // НЕ ПОКРЫТА оракулом (замер 2026-09-23): 875 входов, 0 срабатываний —
          // защита в глубину. Реестр: docs/verification-debt.md, п. 5.
          if (pos === before) break;
          skipNewlines();
        }
      }
      if (!expectCloser(IF_CLOSER)) return null;
      return { kind: "если", condition, body, elseIfClauses: elseIfClauses.length > 0 ? elseIfClauses : undefined, elseBody };
    }
    if (peek().kind === "когда") {
      advance();
      skipNewlines();
      const scrutinee = parseExpr();
      if (!scrutinee) return null;
      skipNewlines();
      const arms: Array<{ variant: Expr; body: Stmt[] }> = [];
      while (peek().kind === "есть") {
        advance();
        skipNewlines();
        const variant = parseExpr();
        if (!variant) return null;
        skipNewlines();
        const armBody: Stmt[] = [];
        while (
          peek().kind !== "есть" &&
          peek().kind !== "иначе" &&
          !isAtCloser(WHEN_CLOSER)  &&
          peek().kind !== "конец_файла"
        ) {
          const before = pos;
          const s = parseStmt();
          if (s) armBody.push(s);
          else syncToStmtBoundary();
          // Гарантия прогресса: разбор, не сдвинувший позицию, — вечный цикл.
          // НЕ ПОКРЫТА оракулом (замер 2026-09-23): 875 входов, 0 срабатываний —
          // защита в глубину. Реестр: docs/verification-debt.md, п. 5.
          if (pos === before) break;
          skipNewlines();
        }
        arms.push({ variant, body: armBody });
      }
      if (arms.length === 0) {
        const t = peek();
        errors.push({
          message: "после когда нужна хотя бы одна ветка есть Имя.вариант",
          line: t.line,
          column: t.column,
          context: "stmt",
        });
        return null;
      }
      let elseBody: Stmt[] | undefined;
      if (peek().kind === "иначе") {
        advance();
        skipNewlines();
        elseBody = [];
        while (!isAtCloser(WHEN_CLOSER) && !isMismatchedCloser(WHEN_CLOSER) && peek().kind !== "конец_файла") {
          const before = pos;
          const s = parseStmt();
          if (s) elseBody.push(s);
          else syncToStmtBoundary();
          // Гарантия прогресса: разбор, не сдвинувший позицию, — вечный цикл.
          // НЕ ПОКРЫТА оракулом (замер 2026-09-23): 875 входов, 0 срабатываний —
          // защита в глубину. Реестр: docs/verification-debt.md, п. 5.
          if (pos === before) break;
          skipNewlines();
        }
      }
      if (!expectCloser(WHEN_CLOSER)) return null;
      return { kind: "когда", scrutinee, arms, elseBody };
    }
    if (peek().kind === "попробовать") {
      advance();
      skipNewlines();
      const body: Stmt[] = [];
      while (peek().kind !== "поймать" && !isAtCloser(TRY_CLOSER) && !isMismatchedCloser(TRY_CLOSER) && peek().kind !== "конец_файла") {
        const before = pos;
        const s = parseStmt();
        if (s) body.push(s);
        else syncToStmtBoundary();
        // Гарантия прогресса: разбор, не сдвинувший позицию, — вечный цикл.
        // НЕ ПОКРЫТА оракулом (замер 2026-09-23): 875 входов, 0 срабатываний —
        // защита в глубину. Реестр: docs/verification-debt.md, п. 5.
        if (pos === before) break;
        skipNewlines();
      }
      if (!consume("поймать", "Ожидается 'поймать' (алиас: 'иначе_попытка')")) return null;
      skipNewlines();
      if (!isAt("идентификатор")) {
        const t = peek();
        errors.push({
          message: "Ожидается имя переменной ошибки после 'поймать'",
          line: t.line,
          column: t.column,
          context: "stmt",
          expected: ["идентификатор"],
          actualKind: t.kind,
          actualLexeme: t.lexeme,
        });
        return null;
      }
      const catchTok = advance();
      const catchVar = String(catchTok.value ?? catchTok.lexeme);
      skipNewlines();
      const catchBody: Stmt[] = [];
      while (!isAtCloser(TRY_CLOSER) && !isMismatchedCloser(TRY_CLOSER) && peek().kind !== "конец_файла") {
        const before = pos;
        const s = parseStmt();
        if (s) catchBody.push(s);
        else syncToStmtBoundary();
        // Гарантия прогресса: разбор, не сдвинувший позицию, — вечный цикл.
        // НЕ ПОКРЫТА оракулом (замер 2026-09-23): 875 входов, 0 срабатываний —
        // защита в глубину. Реестр: docs/verification-debt.md, п. 5.
        if (pos === before) break;
        skipNewlines();
      }
      if (!expectCloser(TRY_CLOSER)) return null;
      return { kind: "попробовать", body, catchVar, catchBody };
    }
    if (peek().kind === "выбросить") {
      advance();
      skipNewlines();
      const value = parseExpr();
      if (!value) return null;
      return { kind: "выбросить", value };
    }
    if (peek().kind === "пока") {
      advance();
      skipNewlines();
      const condition = parseCondition();
      if (!condition) return null;
      if (peek().kind === "тогда") advance();
      skipNewlines();
      const body: Stmt[] = [];
      while (!isAtCloser(WHILE_CLOSER) && !isMismatchedCloser(WHILE_CLOSER) && peek().kind !== "конец_файла") {
        const before = pos;
        const s = parseStmt();
        if (s) body.push(s);
        else syncToStmtBoundary();
        // Гарантия прогресса: разбор, не сдвинувший позицию, — вечный цикл.
        // НЕ ПОКРЫТА оракулом (замер 2026-09-23): 875 входов, 0 срабатываний —
        // защита в глубину. Реестр: docs/verification-debt.md, п. 5.
        if (pos === before) break;
        skipNewlines();
      }
      if (!expectCloser(WHILE_CLOSER)) return null;
      return { kind: "пока", condition, body };
    }
    if (peek().kind === "для") {
      advance();
      if (!isAt("идентификатор")) {
        const t = peek();
        errors.push({
          message: "Ожидается имя переменной после 'для'",
          line: t.line,
          column: t.column,
          context: "stmt",
          expected: ["идентификатор"],
          actualKind: t.kind,
          actualLexeme: t.lexeme,
        });
        return null;
      }
      const tokItem = advance();
      const item = String(tokItem.value ?? tokItem.lexeme);
      let index: string | undefined;
      if (peek().kind === ",") {
        advance();
        if (!isAt("идентификатор")) {
          const t = peek();
          errors.push({
            message: "Ожидается имя индексной переменной после ','",
            line: t.line,
            column: t.column,
            context: "stmt",
            expected: ["идентификатор"],
            actualKind: t.kind,
            actualLexeme: t.lexeme,
          });
          return null;
        }
        const tokIndex = advance();
        index = String(tokIndex.value ?? tokIndex.lexeme);
      }
      if (!consume("в", "Ожидается 'в' после переменной для")) return null;
      skipNewlines();
      const source = parseExpr();
      if (!source) return null;
      if (peek().kind === "тогда") advance();
      skipNewlines();
      const body: Stmt[] = [];
      while (!isAtCloser(FOR_EACH_CLOSER) && !isMismatchedCloser(FOR_EACH_CLOSER) && peek().kind !== "конец_файла") {
        const before = pos;
        const s = parseStmt();
        if (s) body.push(s);
        else syncToStmtBoundary();
        // Гарантия прогресса: разбор, не сдвинувший позицию, — вечный цикл.
        // НЕ ПОКРЫТА оракулом (замер 2026-09-23): 875 входов, 0 срабатываний —
        // защита в глубину. Реестр: docs/verification-debt.md, п. 5.
        if (pos === before) break;
        skipNewlines();
      }
      if (!expectCloser(FOR_EACH_CLOSER)) return null;
      return {
        kind: "для_каждого",
        item,
        index,
        source,
        body,
        // Обратная совместимость для текущего семантического анализатора.
        variable: item,
        collection: source,
      };
    }
    if (peek().kind === "прервать") {
      advance();
      return { kind: "прервать" };
    }
    if (peek().kind === "продолжить") {
      advance();
      return { kind: "продолжить" };
    }
    if (peek().kind === "цикл") {
      advance();
      skipNewlines();
      const body: Stmt[] = [];
      while (!isAtCloser(LOOP_CLOSER) && !isMismatchedCloser(LOOP_CLOSER) && peek().kind !== "конец_файла") {
        const before = pos;
        const s = parseStmt();
        if (s) body.push(s);
        else syncToStmtBoundary();
        // Гарантия прогресса: разбор, не сдвинувший позицию, — вечный цикл.
        // НЕ ПОКРЫТА оракулом (замер 2026-09-23): 875 входов, 0 срабатываний —
        // защита в глубину. Реестр: docs/verification-debt.md, п. 5.
        if (pos === before) break;
        skipNewlines();
      }
      if (!expectCloser(LOOP_CLOSER)) return null;
      return { kind: "цикл", body };
    }
    if (isAt("идентификатор")) {
      const startPos = pos;
      const tokAssign = advance();
      const name = String(tokAssign.value ?? tokAssign.lexeme);
      const assigned = tryParsePostfixAssign(name);
      if (assigned !== "нет") return assigned;
      pos = startPos;
    }
    const expr = parseExpr();
    if (!expr) return null;
    return { kind: "выражение", expr };
  }

  function parseExpr(): Expr | null {
    return parseLogicalOr();
  }

  /** или (низший приоритет логики) */
  function parseLogicalOr(): Expr | null {
    let left = parseLogicalAnd();
    if (!left) return null;
    while (peek().kind === "или") {
      advance();
      skipNewlines();
      const right = parseLogicalAnd();
      if (!right) return null;
      left = { kind: "бинарное", op: "или", left, right };
    }
    return left;
  }

  /** и (выше чем или) */
  function parseLogicalAnd(): Expr | null {
    let left = parseLogicalNot();
    if (!left) return null;
    while (peek().kind === "и") {
      advance();
      skipNewlines();
      const right = parseLogicalNot();
      if (!right) return null;
      left = { kind: "бинарное", op: "и", left, right };
    }
    return left;
  }

  /** не (выше чем и) */
  function parseLogicalNot(): Expr | null {
    if (peek().kind === "не") {
      advance();
      skipNewlines();
      const arg = parseLogicalNot();
      if (!arg) return null;
      return { kind: "унарное", op: "не", arg };
    }
    return parseCompare();
  }

  /** Оператор сравнения; в позиции условия одиночный `=` читается как `==` (пункт 1.1). */
  function isCompareOp(k: TokenKind): boolean {
    if (k === "=") return conditionDepth > 0;
    return k === "==" || k === "!=" || k === "<" || k === "<=" || k === ">" || k === ">=";
  }

  function parseCompare(): Expr | null {
    const left = parseAdd();
    if (!left) return null;
    if (!isCompareOp(peek().kind)) return left;
    // a < b < c → (a < b) и (b < c) — как пишут нейросети и Python
    let acc: Expr | null = null;
    let prevRight: Expr = left;
    while (isCompareOp(peek().kind)) {
      const raw = advance().kind;
      // В условии `=` — сравнение, а не присваивание: в AST идёт `==`.
      const op = raw === "=" ? "==" : raw;
      skipNewlines();
      const right = parseAdd();
      if (!right) return null;
      const cmp: Expr = { kind: "бинарное", op, left: prevRight, right };
      acc = acc ? { kind: "бинарное", op: "и", left: acc, right: cmp } : cmp;
      prevRight = right;
    }
    return acc;
  }

  function parseAdd(): Expr | null {
    let left = parseMul();
    if (!left) return null;
    while (peek().kind === "+" || peek().kind === "-") {
      const op = advance().kind;
      skipNewlines();
      const right = parseMul();
      if (!right) return null;
      left = { kind: "бинарное", op, left, right };
    }
    return left;
  }

  function parseMul(): Expr | null {
    let left = parseUnary();
    if (!left) return null;
    while (peek().kind === "*" || peek().kind === "/" || peek().kind === "%") {
      const op = advance().kind;
      skipNewlines();
      const right = parseUnary();
      if (!right) return null;
      left = { kind: "бинарное", op, left, right };
    }
    return left;
  }

  function parseUnary(): Expr | null {
    if (peek().kind === "-") {
      advance();
      skipNewlines();
      const inner = parseUnary();
      if (!inner) return null;
      return { kind: "бинарное", op: "-", left: { kind: "число", value: 0 }, right: inner };
    }
    return parsePrimary();
  }

  function getExprInvokeName(expr: Expr): string {
    if (expr.kind === "переменная") return expr.name;
    if (expr.kind === "поле") return getExprInvokeName(expr.object) + "." + expr.field;
    return "";
  }

  function parsePrimary(): Expr | null {
    const t = peek();
    if (t.kind === "число") {
      advance();
      return { kind: "число", value: Number(t.value) };
    }
    if (t.kind === "строка") {
      advance();
      return { kind: "строка", value: String(t.value ?? "") };
    }
    if (t.kind === "истина") {
      advance();
      return { kind: "булево", value: true };
    }
    if (t.kind === "ложь") {
      advance();
      return { kind: "булево", value: false };
    }
    if (t.kind === "пусто") {
      advance();
      return { kind: "пусто" };
    }
    if (t.kind === "(") {
      advance();
      skipNewlines();
      const first = parseExpr();
      if (first && peek().kind === ",") {
        const элементы: Expr[] = [first];
        while (peek().kind === ",") {
          advance();
          skipNewlines();
          const el = parseExpr();
          if (el) элементы.push(el);
        }
        consume(")", "Ожидается ')'");
        return { kind: "кортеж", элементы };
      }
      consume(")", "Ожидается ')'");
      return first;
    }
    if (t.kind === "{") {
      advance();
      skipNewlines();
      const entries: Array<{ key: string; value: Expr }> = [];
      while (peek().kind !== "}" && peek().kind !== "конец_файла") {
        skipNewlines();
        if (!isFieldNameToken()) break;
        const key = takeFieldName();
        if (!consume(":", "Ожидается ':' после ключа объекта")) return null;
        skipNewlines();
        const val = parseExpr();
        if (!val) return null;
        entries.push({ key, value: val });
        skipNewlines();
        if (peek().kind === ",") {
          advance();
          skipNewlines();
        }
      }
      if (!consume("}", "Ожидается '}' после тела объекта")) return null;
      return { kind: "объект", entries };
    }
    if (t.kind === "[") {
      advance();
      skipNewlines();
      const elements: Expr[] = [];
      while (peek().kind !== "]" && peek().kind !== "конец_файла") {
        skipNewlines();
        if (peek().kind === "]" || peek().kind === "конец_файла") break;
        const el = parseExpr();
        if (!el) return null;
        elements.push(el);
        skipNewlines();
        if (peek().kind === ",") {
          advance();
          skipNewlines();
        }
      }
      if (!consume("]", "Ожидается ']'")) return null;
      return { kind: "массив", elements };
    }
    if (t.kind === "идентификатор" || isContextualNameToken()) {
      advance();
      const name = String(t.value ?? t.lexeme);
      let expr: Expr = { kind: "переменная", name };
      // Именованный конструктор записи: Имя { поле: значение, ... }
      // Компилируется как обычный объектный литерал — никаких новых AST-узлов.
      if (peek().kind === "{") {
        advance(); // consume "{"
        skipNewlines();
        const entries: Array<{ key: string; value: Expr }> = [];
        while (peek().kind !== "}" && peek().kind !== "конец_файла") {
          skipNewlines();
          if (!isFieldNameToken()) break;
          const key = takeFieldName();
          if (!consume(":", "Ожидается ':' после ключа записи")) return null;
          skipNewlines();
          const val = parseExpr();
          if (!val) return null;
          entries.push({ key, value: val });
          skipNewlines();
          if (peek().kind === ",") {
            advance();
            skipNewlines();
          }
        }
        if (!consume("}", "Ожидается '}' после тела записи")) return null;
        return { kind: "объект", entries };
      }
      // Чередование суффиксов `.поле` и `[i]`: `arr[0].x` → получить(arr,0) затем поле.
      for (;;) {
        const posBeforeSuffix = pos;
        while (peek().kind === ".") {
          advance();
          skipNewlines();
          if (!isFieldNameToken()) break;
          const field = takeFieldName();
          if (peek().kind === "(") {
            const fullName = getExprInvokeName(expr) + (getExprInvokeName(expr) ? "." : "") + field;
            advance();
            skipNewlines();
            const args: Expr[] = [];
            while (peek().kind !== ")" && peek().kind !== "конец_файла") {
              const arg = parseExpr();
              if (arg) args.push(arg);
              skipNewlines();
              if (peek().kind === ",") {
                advance();
                skipNewlines();
              } else break;
            }
            if (!consume(")", "Ожидается ')'")) return null;
            return { kind: "вызов", name: fullName, args };
          }
          expr = { kind: "поле", object: expr, field };
        }
        while (peek().kind === "[") {
          advance(); // "["
          skipNewlines();
          const idx = parseExpr();
          if (!idx) return null;
          if (!consume("]", "Ожидается ']'")) return null;
          expr = {
            kind: "вызов",
            name: "система.массив.получить",
            args: [expr, idx],
          };
        }
        if (pos === posBeforeSuffix) break;
      }
      if (peek().kind === "(") {
        advance();
        skipNewlines();
        const args: Expr[] = [];
        while (peek().kind !== ")" && peek().kind !== "конец_файла") {
          const arg = parseExpr();
          if (arg) args.push(arg);
          skipNewlines();
          if (peek().kind === ",") {
            advance();
            skipNewlines();
          } else break;
        }
        consume(")", "Ожидается ')'");
        return { kind: "вызов", name, args };
      }
      return expr;
    }
    errors.push({
      message: `Ожидается выражение, получено: ${t.kind}`,
      line: t.line,
      column: t.column,
      context: "expr",
      expected: ["число", "строка", "истина", "ложь", "пусто", "идентификатор", "(", "["],
      actualKind: t.kind,
      actualLexeme: t.lexeme,
    });
    return null;
  }

  skipNewlines();
  const modules: Module[] = [];
  while (peek().kind !== "конец_файла") {
    if (!isAt("модуль")) {
      const t = peek();
      errors.push({
        message: "Ожидается 'модуль'",
        line: t.line,
        column: t.column,
        context: "module",
        expected: ["модуль"],
        actualKind: t.kind,
        actualLexeme: t.lexeme,
      });
      advance();
      syncToTopLevel();
      skipNewlines();
      continue;
    }
    const mod = parseModule();
    if (mod) {
      modules.push(mod);
      if (peek().kind !== "модуль" && peek().kind !== "конец_файла") {
        const t = peek();
        errors.push({
          message: "Ожидается начало следующего модуля или конец файла",
          line: t.line,
          column: t.column,
          context: "module",
          expected: ["модуль", "конец_файла"],
          actualKind: t.kind,
          actualLexeme: t.lexeme,
        });
        advance();
        syncToTopLevel();
      }
    } else {
      syncToTopLevel();
    }
    skipNewlines();
  }
  const ast = modules.length > 0
    ? ({
        modules,
        // Обратная совместимость: старый код обращается к ast.procedures напрямую.
        ...modules[0],
      } as Program)
    : null;
  return { ast, errors };
}

/** Форматированный вывод ошибки парсера для CLI (строка + указатель + ожидалось/получено). */
export function printParseError(e: ParseError, source: string): void {
  const lines = source.split(/\r?\n/);
  const line = lines[e.line - 1] ?? "";
  const pointer = " ".repeat(Math.max(0, e.column - 1)) + "^";
  const expected =
    e.expected?.length ? ` ожидалось: ${e.expected.join(" | ")}` : "";
  const actual = e.actualKind ? `, получено: ${e.actualKind}` : "";
  const where = e.context ? `[${e.context}] ` : "";

  console.error(
    `Парсер ${e.line}:${e.column}: ${where}${e.message}${expected}${actual}\n${line}\n${pointer}`,
  );
}

