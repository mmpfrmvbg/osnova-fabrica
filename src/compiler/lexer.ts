/**
 * Лексер языка Основа: перевод строки — разделитель инструкций (Python-style).
 * Ключевые слова и операторы согласованы с `language-registry` и `OPERATORS_V01`.
 * Комментарии: `//` до конца строки и блочные slash-star.
 */

import { getImplementedKeywords, LLM_KEYWORD_ALIASES } from "./language-registry";

/**
 * Единый перечень видов токенов для `tokenize()` (ключевые слова из реестра + литералы, операторы, пунктуация, служебные).
 * Тип `TokenKind` выводится отсюда — дублирования union/массива нет.
 */
const TOKEN_KINDS = [
  "модуль",
  "процедура",
  "тип",
  "использовать",
  "экспорт",
  "чистый",
  "из",
  "пусть",
  "если",
  "иначе",
  "иначе_если",
  "попробовать",
  "иначе_попытка",
  "пока",
  "тогда",
  "когда",
  "есть",
  "выбросить",
  "для_каждого",
  "в",
  "цикл",
  "прервать",
  "продолжить",
  "конец",
  "конец_если",
  "конец_пока",
  "конец_для",
  "конец_для_каждого",
  "конец_цикла",
  "конец_когда",
  "конец_попробовать",
  "конец_процедуры",
  "конец_модуля",
  "вернуть",
  "и",
  "или",
  "не",
  "истина",
  "ложь",
  "пусто",
  "число",
  "строка",
  "идентификатор",
  "=",
  "==",
  "!=",
  "+=",
  "-=",
  "*=",
  "/=",
  "<",
  "<=",
  ">",
  ">=",
  "+",
  "-",
  "*",
  "/",
  "%",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  ":",
  ",",
  ".",
  "|",
  "новая_строка",
  "конец_файла",
  "?",
] as const;

export type TokenKind = (typeof TOKEN_KINDS)[number];

/** Полный перечень `TokenKind` для тестов покрытия и диагностики. */
export const ALL_TOKEN_KINDS: readonly TokenKind[] = TOKEN_KINDS;

export interface Token {
  kind: TokenKind;
  value?: number | string;
  lexeme: string;
  line: number;
  column: number;
}

/**
 * Закрывающие лексемы: `конец` (legacy, контекстный) и `конец_X` (канон).
 *
 * Проверяются **до** карты ключевых слов и потому в неё не попадают: у каждой
 * свой `TokenKind`, а контекст («это закрытие или имя?») решает парсер, не лексер.
 * `конец_файла` сюда НЕ входит — это служебный вид токена, а не ключевое слово.
 * `конец` остаётся в реестре как implemented: иначе реестр перестанет описывать
 * синтаксис, который лексер принимает.
 */
export const BLOCK_CLOSING_LEXEMES: readonly string[] = [
  "конец",
  "конец_если",
  "конец_пока",
  "конец_для",
  "конец_для_каждого",
  "конец_цикла",
  "конец_когда",
  "конец_попробовать",
  "конец_процедуры",
  "конец_модуля",
];

export const KEYWORDS: Record<string, TokenKind> = Object.fromEntries(
  getImplementedKeywords()
    .filter((k) => !BLOCK_CLOSING_LEXEMES.includes(k.lexeme))
    .map((k) => [k.lexeme, k.lexeme as TokenKind]),
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

  function makeToken(kind: TokenKind, lexeme: string, value?: number | string, loc?: { line: number; column: number }): Token {
    const line0 = loc?.line ?? line;
    const col0 = loc?.column ?? column - lexeme.length;
    return { kind, lexeme, value, line: line0, column: col0 };
  }

  while (i < source.length) {
    const startCol = column;
    const c = peek();

    if (c === " " || c === "\t" || c === "\r") {
      advance();
      continue;
    }

    if (c === "\n") {
      const nlLine = line;
      const nlCol = column;
      advance();
      tokens.push(makeToken("новая_строка", "\n", undefined, { line: nlLine, column: nlCol }));
      continue;
    }

    if (c === "/" && source[i + 1] === "/") {
      advance();
      advance();
      while (peek() && peek() !== "\n") advance();
      continue;
    }

    if (c === "/" && source[i + 1] === "*") {
      const commentLine = line;
      const commentCol = column;
      advance();
      advance();
      let closed = false;
      while (peek()) {
        if (peek() === "*" && source[i + 1] === "/") {
          advance();
          advance();
          closed = true;
          break;
        }
        advance();
      }
      if (!closed) {
        errors.push({ message: "Незакрытый комментарий /*", line: commentLine, column: commentCol });
      }
      continue;
    }

    if (c === '"') {
      const strLine = line;
      const strCol = column;
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
      const lexeme = '"' + value + '"';
      tokens.push(makeToken("строка", lexeme, value, { line: strLine, column: strCol }));
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
      // Служебный токен конца файла — не ключевое слово и не `конец_` + `файла`:
      // проверяется раньше всего остального, иначе слово `конец_файла` в исходнике
      // закрывало бы блок.
      if (lex === "конец_файла") {
        tokens.push(makeToken("конец_файла", lex));
        continue;
      }
      // `конец` и `конец_X` — отдельные виды токенов; контекст решает парсер.
      if (BLOCK_CLOSING_LEXEMES.includes(lex)) {
        tokens.push(makeToken(lex as TokenKind, lex));
        continue;
      }
      const kw = KEYWORDS[lex] ?? (LLM_KEYWORD_ALIASES[lex] as TokenKind | undefined);
      // Английский алиас `end` ведёт к тому же виду токена, что `конец`:
      // лексема у него своя, поэтому контекст закрытия надо сохранить.
      if (kw === "конец") {
        tokens.push(makeToken("конец", "конец"));
        continue;
      }
      // `else if` пишется с пробелом: посимвольный алиас его не ловит. Собираем
      // в один токен `иначе_если`, иначе `else` уходил в ветку `иначе`, а `if`
      // начинал новую инструкцию внутри неё.
      if (lex === "else") {
        const save = i;
        while (peek() === " " || peek() === "\t") advance();
        if (source.startsWith("if", i) && !isIdContinue(source[i + 2] ?? "")) {
          advance();
          advance();
          tokens.push(makeToken("иначе_если", "else if"));
          continue;
        }
        i = save;
      }
      if (kw) tokens.push(makeToken(kw, lex));
      else tokens.push(makeToken("идентификатор", lex, lex));
      continue;
    }

    if (c === "=" && source[i + 1] === "=") {
      advance();
      advance();
      if (peek() === "=") advance();
      tokens.push(makeToken("==", "=="));
      continue;
    }
    if (c === "!" && source[i + 1] === "=") {
      advance();
      advance();
      if (peek() === "=") advance();
      tokens.push(makeToken("!=", "!="));
      continue;
    }
    if (c === "&" && source[i + 1] === "&") {
      advance();
      advance();
      tokens.push(makeToken("и", "&&"));
      continue;
    }
    if (c === "|" && source[i + 1] === "|") {
      advance();
      advance();
      tokens.push(makeToken("или", "||"));
      continue;
    }
    if (c === "|") {
      advance();
      tokens.push(makeToken("|", "|"));
      continue;
    }
    if (c === "!") {
      advance();
      tokens.push(makeToken("не", "!"));
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
    // `:=` — алиас `=` (пункт 1.3 требований: 20 случаев в трейсах, модель тянет
    // `:=` из Паскаля). Двоеточие в языке только в аннотации типа и в литералах
    // объектов, где за ним идёт имя типа, а не `=`, поэтому разбор однозначен.
    if (c === ":" && source[i + 1] === "=") {
      advance();
      advance();
      tokens.push(makeToken("=", ":="));
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
