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

  function advance(): Token {
    const t = peek();
    if (pos < tokens.length && tokens[pos].kind !== "конец_файла") pos++;
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

  function isFieldNameToken(): boolean {
    const t = peek();
    return t.kind === "идентификатор" || KEYWORDS[t.lexeme] !== undefined;
  }

  function takeFieldName(): string {
    const tok = advance();
    return String(tok.value ?? tok.lexeme);
  }

  function peekKindSkippingNewlinesFrom(from: number): TokenKind {
    let i = from;
    while (tokens[i]?.kind === "новая_строка") i++;
    return tokens[i]?.kind ?? "конец_файла";
  }

  function atElseIf(): boolean {
    if (peek().kind === "иначе_если") return true;
    return peek().kind === "иначе" && peekKindSkippingNewlinesFrom(pos + 1) === "если";
  }

  function consumeElseIf(): void {
    if (peek().kind === "иначе_если") {
      advance();
      return;
    }
    advance();
    skipNewlines();
    advance();
  }

  /** Восстановление после ошибки: до новой строки, конец/конец_файла или начала следующей инструкции. */
  function syncToStmtBoundary(): void {
    const stmtHead: TokenKind[] = [
      "пусть",
      "если",
      "пока",
      "вернуть",
      "для_каждого",
      "попробовать",
      "выбросить",
      "прервать",
      "продолжить",
      "цикл",
    ];
    while (pos < tokens.length) {
      const k = peek().kind;
      if (k === "новая_строка" || k === "конец" || k === "конец_файла") return;
      if (stmtHead.includes(k)) return;
      advance();
    }
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
    while (peek().kind === "процедура" || peek().kind === "экспорт" || peek().kind === "использовать" || peek().kind === "тип") {
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
    // Опциональный закрывающий "конец" для модуля
    if (peek().kind === "конец") {
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

    // Перечень: тип Имя = a | b | c
    if (peek().kind === "=") {
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
    if (peek().kind === "экспорт") {
      advance();
      exported = true;
      skipNewlines();
    }

    if (!consume("процедура", "Ожидается 'процедура'")) return null;

    // Поддержка формы: "процедура экспорт имя(...)" (экспорт после процедуры)
    if (peek().kind === "экспорт") {
      advance();
      exported = true;
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
    while (peek().kind === "идентификатор") {
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
    const body: Stmt[] = [];
    while (peek().kind !== "конец" && peek().kind !== "конец_файла") {
      const s = parseStmt();
      if (s) body.push(s);
      else syncToStmtBoundary();
      skipNewlines();
    }
    if (!consume("конец", "Ожидается 'конец'")) return null;
    const hasParamTypes = paramTypes.some((t) => t !== undefined);
    return {
      name,
      params,
      body,
      exported,
      paramTypes: hasParamTypes ? paramTypes : undefined,
    };
  }

  function parseStmt(): Stmt | null {
    const compoundToBinaryOp: Record<"+=" | "-=" | "*=" | "/=", "+" | "-" | "*" | "/"> = {
      "+=": "+",
      "-=": "-",
      "*=": "*",
      "/=": "/",
    };

    if (peek().kind === "пусть") {
      advance();
      let name: string;
      if (isAt("идентификатор")) {
        const tokLet = advance();
        name = String(tokLet.value ?? tokLet.lexeme);
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
      if (!consume("=", "Ожидается '='")) return null;
      skipNewlines();
      const init = parseExpr();
      if (!init) return null;
      return { kind: "пусть", name, init, typeAnnotation };
    }
    if (peek().kind === "вернуть") {
      advance();
      skipNewlines();
      let value: Expr | undefined;
      if (peek().kind !== "новая_строка" && peek().kind !== "конец" && peek().kind !== "конец_файла") {
        const v = parseExpr();
        if (v) value = v;
      }
      return { kind: "вернуть", value };
    }
    if (peek().kind === "если") {
      advance();
      skipNewlines();
      const condition = parseExpr();
      if (!condition) return null;
      if (peek().kind === "тогда") advance();
      skipNewlines();
      const body: Stmt[] = [];
      while (peek().kind !== "конец" && peek().kind !== "иначе_если" && peek().kind !== "иначе" && peek().kind !== "конец_файла") {
        const s = parseStmt();
        if (s) body.push(s);
        else syncToStmtBoundary();
        skipNewlines();
      }
      const elseIfClauses: Array<{ condition: Expr; body: Stmt[] }> = [];
      while (atElseIf()) {
        consumeElseIf();
        skipNewlines();
        const cond = parseExpr();
        if (!cond) return null;
        if (peek().kind === "тогда") advance();
        skipNewlines();
        const clauseBody: Stmt[] = [];
        while (peek().kind !== "конец" && peek().kind !== "иначе_если" && peek().kind !== "иначе" && peek().kind !== "конец_файла") {
          const s = parseStmt();
          if (s) clauseBody.push(s);
          else syncToStmtBoundary();
          skipNewlines();
        }
        elseIfClauses.push({ condition: cond, body: clauseBody });
      }
      let elseBody: Stmt[] | undefined;
      if (peek().kind === "иначе") {
        advance();
        skipNewlines();
        elseBody = [];
        while (peek().kind !== "конец" && peek().kind !== "конец_файла") {
          const s = parseStmt();
          if (s) elseBody.push(s);
          else syncToStmtBoundary();
          skipNewlines();
        }
      }
      if (!consume("конец", "Ожидается 'конец' после тела если")) return null;
      return { kind: "если", condition, body, elseIfClauses: elseIfClauses.length > 0 ? elseIfClauses : undefined, elseBody };
    }
    if (peek().kind === "попробовать") {
      advance();
      skipNewlines();
      const body: Stmt[] = [];
      while (peek().kind !== "иначе_попытка" && peek().kind !== "конец_файла") {
        const s = parseStmt();
        if (s) body.push(s);
        else syncToStmtBoundary();
        skipNewlines();
      }
      if (!consume("иначе_попытка", "Ожидается 'иначе_попытка'")) return null;
      skipNewlines();
      if (!isAt("идентификатор")) {
        const t = peek();
        errors.push({
          message: "Ожидается имя переменной ошибки после 'иначе_попытка'",
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
      while (peek().kind !== "конец" && peek().kind !== "конец_файла") {
        const s = parseStmt();
        if (s) catchBody.push(s);
        else syncToStmtBoundary();
        skipNewlines();
      }
      if (!consume("конец", "Ожидается 'конец' после иначе_попытка")) return null;
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
      const condition = parseExpr();
      if (!condition) return null;
      if (peek().kind === "тогда") advance();
      skipNewlines();
      const body: Stmt[] = [];
      while (peek().kind !== "конец" && peek().kind !== "конец_файла") {
        const s = parseStmt();
        if (s) body.push(s);
        else syncToStmtBoundary();
        skipNewlines();
      }
      if (!consume("конец", "Ожидается 'конец' после тела пока")) return null;
      return { kind: "пока", condition, body };
    }
    if (peek().kind === "для_каждого") {
      advance();
      if (!isAt("идентификатор")) {
        const t = peek();
        errors.push({
          message: "Ожидается имя переменной после 'для_каждого'",
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
      if (!consume("в", "Ожидается 'в' после переменной для_каждого")) return null;
      skipNewlines();
      const source = parseExpr();
      if (!source) return null;
      if (peek().kind === "тогда") advance();
      skipNewlines();
      const body: Stmt[] = [];
      while (peek().kind !== "конец" && peek().kind !== "конец_файла") {
        const s = parseStmt();
        if (s) body.push(s);
        else syncToStmtBoundary();
        skipNewlines();
      }
      if (!consume("конец", "Ожидается 'конец' после тела для_каждого")) return null;
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
      while (peek().kind !== "конец" && peek().kind !== "конец_файла") {
        const s = parseStmt();
        if (s) body.push(s);
        else syncToStmtBoundary();
        skipNewlines();
      }
      if (!consume("конец", "Ожидается 'конец' после тела цикл")) return null;
      return { kind: "цикл", body };
    }
    if (isAt("идентификатор")) {
      const startPos = pos;
      const tokAssign = advance();
      const name = String(tokAssign.value ?? tokAssign.lexeme);
      const baseVarExpr: Expr = { kind: "переменная", name };
      // Проверить: имя.поле (=|+=|-=|*=|/=) значение
      let rewinded = false;
      // Сахар: arr[i] = val и arr[i] op= val
      if (peek().kind === "[") {
        advance(); // consume "["
        skipNewlines();
        const idx = parseExpr();
        if (!idx) return null;
        if (!consume("]", "Ожидается ']'")) return null;
        const opKind = peek().kind;
        if (opKind === "=" || opKind === "+=" || opKind === "-=" || opKind === "*=" || opKind === "/=") {
          advance();
          skipNewlines();
          const rhs = parseExpr();
          if (!rhs) return null;

          if (opKind === "=") {
            const callExpr: Expr = {
              kind: "вызов",
              name: "система.массив.установить",
              args: [baseVarExpr, idx, rhs],
            };
            return { kind: "выражение", expr: callExpr };
          }

          const binOp = compoundToBinaryOp[opKind as "+=" | "-=" | "*=" | "/="];
          const current: Expr = {
            kind: "вызов",
            name: "система.массив.получить",
            args: [baseVarExpr, idx],
          };
          const value: Expr = {
            kind: "бинарное",
            op: binOp,
            left: current,
            right: rhs,
          };
          const callExpr: Expr = {
            kind: "вызов",
            name: "система.массив.установить",
            args: [baseVarExpr, idx, value],
          };
          return { kind: "выражение", expr: callExpr };
        }
        // не присваивание — откат и разбор как выражения arr[i]
        pos = startPos;
        rewinded = true;
      }
      if (peek().kind === ".") {
        // Смотрим вперёд: есть ли в конце цепочки присваивание?
        // Стратегия: строим цепочку полей, на каждом шаге проверяем оператор.
        // Откат через savePos если не присваивание.
        const savePos = pos;
        // Строим left-hand side как цепочку expr.field.field...
        let lhsObject: Expr = baseVarExpr;
        let lastField: string | null = null;
        let chainOk = true;

        while (peek().kind === "." && chainOk) {
          const dotPos = pos;
          advance(); // consume "."
          skipNewlines();
          if (!isFieldNameToken()) {
            pos = dotPos;
            chainOk = false;
            break;
          }
          const fName = takeFieldName();
          const opKind = peek().kind;
          if (opKind === "=" || opKind === "+=" || opKind === "-=" || opKind === "*=" || opKind === "/=") {
            // Нашли присваивание — lhsObject уже накоплен, lastField = fName
            lastField = fName;
            advance(); // consume op
            skipNewlines();
            const rhs = parseExpr();
            if (!rhs) return null;
            if (opKind === "=") {
              return { kind: "поле_присвоить", object: lhsObject, field: lastField, value: rhs };
            }
            const value: Expr = {
              kind: "бинарное",
              op: compoundToBinaryOp[opKind as "+=" | "-=" | "*=" | "/="],
              left: { kind: "поле", object: lhsObject, field: lastField },
              right: rhs,
            };
            return { kind: "поле_присвоить", object: lhsObject, field: lastField, value };
          }
          // Не присваивание — накапливаем поле как промежуточный объект
          lhsObject = { kind: "поле", object: lhsObject, field: fName };
        }

        // Нет присваивания в цепочке — откатываемся
        pos = savePos - 1; // rewind to identifier
        rewinded = true;
      }
      if (
        !rewinded &&
        (peek().kind === "=" || peek().kind === "+=" || peek().kind === "-=" || peek().kind === "*=" || peek().kind === "/=")
      ) {
        const opKind = advance().kind;
        skipNewlines();
        const rhs = parseExpr();
        if (!rhs) return null;
        if (opKind === "=") {
          return { kind: "присвоить", name, value: rhs };
        }
        const value: Expr = {
          kind: "бинарное",
          op: compoundToBinaryOp[opKind as "+=" | "-=" | "*=" | "/="],
          left: { kind: "переменная", name },
          right: rhs,
        };
        return { kind: "присвоить", name, value };
      }
      if (!rewinded) pos--; // put back identifier, parse as expression statement
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

  function parseCompare(): Expr | null {
    let left = parseAdd();
    if (!left) return null;
    const compareOps = new Set<TokenKind>(["==", "!=", "<", "<=", ">", ">="]);
    if (!compareOps.has(peek().kind)) return left;
    // a < b < c → (a < b) и (b < c) — как пишут нейросети и Python
    let acc: Expr | null = null;
    let prevRight: Expr = left;
    while (compareOps.has(peek().kind)) {
      const op = advance().kind;
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
      const inner = parseExpr();
      consume(")", "Ожидается ')'");
      return inner;
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
    if (t.kind === "идентификатор") {
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
