/**
 * Лексер Основа MVP: разделитель инструкций — перевод строки (Python-style).
 * Спека: минимальный набор для todo/bloknot/storage_demo.
 * Ключевые слова — из language-registry (единый источник правды).
 */

import { getImplementedKeywords } from "./language-registry";

export type TokenKind =
  | "модуль"
  | "процедура"
  | "тип"
  | "использовать"
  | "экспорт"
  | "из"
  | "пусть"
  | "если"
  | "иначе"
  | "иначе_если"
  | "попробовать"
  | "иначе_попытка"
  | "пока"
  | "тогда"
  | "выбросить"
  | "для_каждого"
  | "в"
  | "цикл"
  | "прервать"
  | "продолжить"
  | "конец"
  | "вернуть"
  | "и"
  | "или"
  | "не"
  | "истина"
  | "ложь"
  | "пусто"
  | "число"
  | "строка"
  | "идентификатор"
  | "="
  | "=="
  | "!="
  | "+="
  | "-="
  | "*="
  | "/="
  | "<"
  | "<="
  | ">"
  | ">="
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "("
  | ")"
  | "["
  | "]"
  | "{"
  | "}"
  | ":"
  | ","
  | "."
  | "новая_строка"
  | "конец_файла"
  | "?";

export interface Token {
  kind: TokenKind;
  value?: number | string;
  lexeme: string;
  line: number;
  column: number;
}

/** Ключевые слова лексера — из реестра языка (implemented: true). */
export const KEYWORDS: Record<string, TokenKind> = Object.fromEntries(
  getImplementedKeywords().map((k) => [k.lexeme, k.lexeme as TokenKind]),
) as Record<string, TokenKind>;

function isLetter(c: string): boolean {
  if (!c) return false;
  const code = c.charCodeAt(0);
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x410 && code <= 0x44f) ||
    code === 0x401 ||
    code === 0x451
  );
}

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

function isIdContinue(c: string): boolean {
  return isLetter(c) || isDigit(c) || c === "_";
}

export interface LexerError {
  message: string;
  line: number;
  column: number;
}

export interface LexerResult {
  tokens: Token[];
  errors: LexerError[];
}

export function tokenize(source: string): LexerResult {
  const tokens: Token[] = [];
  const errors: LexerError[] = [];
  let i = 0;
  let line = 1;
  let column = 1;

  function peek(): string {
    return source[i] ?? "";
  }

  function advance(): string {
    if (i >= source.length) return "";
    const c = source[i++];
    if (c === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
    return c;
  }

  function makeToken(kind: TokenKind, lexeme: string, value?: number | string): Token {
    const startCol = column - lexeme.length;
    return { kind, lexeme, value, line, column: startCol };
  }

  while (i < source.length) {
    const startCol = column;
    const c = peek();

    if (c === " " || c === "\t" || c === "\r") {
      advance();
      continue;
    }

    if (c === "\n") {
      advance();
      tokens.push(makeToken("новая_строка", "\n"));
      continue;
    }

    if (c === "/" && source[i + 1] === "/") {
      advance();
      advance();
      while (peek() && peek() !== "\n") advance();
      continue;
    }

    if (c === '"') {
      advance();
      let value = "";
      while (peek() && peek() !== '"') {
        if (peek() === "\\") {
          advance();
          const esc = advance();
          if (esc === "n") value += "\n";
          else if (esc === "r") value += "\r";
          else if (esc === "t") value += "\t";
          else if (esc === '"') value += '"';
          else if (esc === "\\") value += "\\";
          else {
            value += esc;
            errors.push({ message: `Неизвестный escape: \\${esc}`, line, column });
          }
        } else {
          value += advance();
        }
      }
      if (peek() === '"') advance();
      else errors.push({ message: "Незакрытая строка", line, column: startCol });
      tokens.push(makeToken("строка", '"' + value + '"', value));
      continue;
    }

    if (isDigit(c) || (c === "." && isDigit(source[i + 1]))) {
      let numStr = "";
      if (c === ".") {
        numStr = advance();
        while (isDigit(peek())) numStr += advance();
        const val = parseFloat(numStr);
        tokens.push(makeToken("число", numStr, val));
      } else {
        while (isDigit(peek())) numStr += advance();
        if (peek() === "." && isDigit(source[i + 1])) {
          numStr += advance();
          while (isDigit(peek())) numStr += advance();
          tokens.push(makeToken("число", numStr, parseFloat(numStr)));
        } else {
          tokens.push(makeToken("число", numStr, parseInt(numStr, 10)));
        }
      }
      continue;
    }

    if (isLetter(c) || c === "_") {
      let lex = "";
      while (isIdContinue(peek())) lex += advance();
      const kw = KEYWORDS[lex];
      if (kw) tokens.push(makeToken(kw, lex));
      else tokens.push(makeToken("идентификатор", lex, lex));
      continue;
    }

    if (c === "=" && source[i + 1] === "=") {
      advance();
      advance();
      tokens.push(makeToken("==", "=="));
      continue;
    }
    if (c === "!" && source[i + 1] === "=") {
      advance();
      advance();
      tokens.push(makeToken("!=", "!="));
      continue;
    }
    if (c === "<" && source[i + 1] === "=") {
      advance();
      advance();
      tokens.push(makeToken("<=", "<="));
      continue;
    }
    if (c === ">" && source[i + 1] === "=") {
      advance();
      advance();
      tokens.push(makeToken(">=", ">="));
      continue;
    }
    if (c === "+" && source[i + 1] === "=") {
      advance();
      advance();
      tokens.push(makeToken("+=", "+="));
      continue;
    }
    if (c === "-" && source[i + 1] === "=") {
      advance();
      advance();
      tokens.push(makeToken("-=", "-="));
      continue;
    }
    if (c === "*" && source[i + 1] === "=") {
      advance();
      advance();
      tokens.push(makeToken("*=", "*="));
      continue;
    }
    if (c === "/" && source[i + 1] === "=") {
      advance();
      advance();
      tokens.push(makeToken("/=", "/="));
      continue;
    }

    const single: Record<string, TokenKind> = {
      "=": "=",
      "<": "<",
      ">": ">",
      "+": "+",
      "-": "-",
      "*": "*",
      "/": "/",
      "%": "%",
      "(": "(",
      ")": ")",
      "[": "[",
      "]": "]",
      "{": "{",
      "}": "}",
      ":": ":",
      ",": ",",
      ".": ".",
      "?": "?",
    };
    if (single[c]) {
      advance();
      tokens.push(makeToken(single[c], c));
      continue;
    }

    errors.push({ message: `Неизвестный символ: ${JSON.stringify(c)}`, line, column });
    advance();
  }

  tokens.push(makeToken("конец_файла", ""));
  return { tokens, errors };
}
