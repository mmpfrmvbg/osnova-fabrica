/**
 * Реестр языка Основа — единый источник правды о ключевых словах и конструкциях.
 * Используется для: генератора (LLM, подсказки), компилятора (валидация), документации, golden-тестов.
 * Версия языка согласована с meta.osnova_version в trace-format и minOsnovaVersion в реестре приложений.
 */

export const LANGUAGE_VERSION = "0.1.0";

/** Категория ключевого слова. */
export type KeywordKind = "module" | "stmt" | "expr" | "block" | "type" | "vliw";

export interface KeywordSpec {
  /** Лексема (как в исходнике). */
  lexeme: string;
  /** Категория: модуль, оператор, выражение, блок, тип, vliw. */
  kind: KeywordKind;
  /** Реализовано в текущем компиляторе (src/tools/osnova-compiler). */
  implemented: boolean;
  /** Версия языка, с которой доступно (семантическое версионирование). */
  since: string;
  /** Краткое пояснение (опционально). */
  description?: string;
}

/** Идентификатор конструкции. */
export type ConstructId =
  | "module"
  | "procedure"
  | "let"
  | "assign"
  | "if"
  | "while"
  | "for_each"
  | "loop"
  | "return"
  | "and"
  | "or"
  | "not";

export interface AstFieldSpec {
  name: string;
  type: string;
  optional?: boolean;
}

export interface ConstructSpec {
  id: ConstructId;
  /** Человекочитаемый шаблон синтаксиса для документации и LLM. */
  syntax: string;
  /** Узел AST: kind и поля (соответствует ast.ts). */
  astNode: {
    kind: string;
    fields: AstFieldSpec[];
  };
  /** Версия языка. */
  since: string;
  /** Как реализуется в байткоде (для документации / LLM; кодоген не обязан читать). */
  bytecodePattern?: string;
  /** Реализовано в текущем компиляторе. */
  implemented: boolean;
  description?: string;
}

export interface LanguageRegistry {
  version: string;
  keywords: KeywordSpec[];
  constructs: ConstructSpec[];
}

/** Ключевые слова v0.1: реализованные в MVP + зарезервированные на будущее. */
const KEYWORDS_V01: KeywordSpec[] = [
  { lexeme: "модуль", kind: "module", implemented: true, since: "0.1.0" },
  { lexeme: "процедура", kind: "stmt", implemented: true, since: "0.1.0" },
  { lexeme: "пусть", kind: "stmt", implemented: true, since: "0.1.0" },
  { lexeme: "если", kind: "stmt", implemented: true, since: "0.1.0" },
  { lexeme: "иначе", kind: "stmt", implemented: true, since: "0.1.0", description: "ветка else после если" },
  { lexeme: "иначе_если", kind: "stmt", implemented: true, since: "0.1.0", description: "цепочка else-if между если и иначе" },
  { lexeme: "пока", kind: "stmt", implemented: true, since: "0.1.0" },
  { lexeme: "для_каждого", kind: "stmt", implemented: true, since: "0.1.0", description: "цикл по коллекции" },
  { lexeme: "в", kind: "stmt", implemented: true, since: "0.1.0", description: "в конструкции для_каждого x в expr" },
  { lexeme: "цикл", kind: "stmt", implemented: true, since: "0.1.0" },
  { lexeme: "конец", kind: "block", implemented: true, since: "0.1.0", description: "конец блока если/пока/для_каждого/цикл/процедура" },
  { lexeme: "вернуть", kind: "stmt", implemented: true, since: "0.1.0" },
  { lexeme: "истина", kind: "expr", implemented: true, since: "0.1.0" },
  { lexeme: "ложь", kind: "expr", implemented: true, since: "0.1.0" },
  { lexeme: "пусто", kind: "expr", implemented: true, since: "0.1.0" },
  { lexeme: "и", kind: "expr", implemented: true, since: "0.1.0", description: "логическое И, short-circuit" },
  { lexeme: "или", kind: "expr", implemented: true, since: "0.1.0", description: "логическое ИЛИ, short-circuit" },
  { lexeme: "не", kind: "expr", implemented: true, since: "0.1.0", description: "логическое НЕ" },
];

/** Конструкции v0.1 с привязкой к AST и синтаксису. */
const CONSTRUCTS_V01: ConstructSpec[] = [
  {
    id: "module",
    syntax: "модуль <имя>",
    astNode: { kind: "Module", fields: [{ name: "name", type: "string" }, { name: "procedures", type: "Procedure[]" }] },
    since: "0.1.0",
    implemented: true,
  },
  {
    id: "procedure",
    syntax: "процедура <имя>(<параметры>) ... конец",
    astNode: { kind: "Procedure", fields: [{ name: "name", type: "string" }, { name: "params", type: "string[]" }, { name: "body", type: "Stmt[]" }] },
    since: "0.1.0",
    implemented: true,
  },
  {
    id: "let",
    syntax: "пусть <имя> = <выражение>",
    astNode: { kind: "пусть", fields: [{ name: "name", type: "string" }, { name: "init", type: "Expr" }] },
    since: "0.1.0",
    implemented: true,
  },
  {
    id: "assign",
    syntax: "<имя> = <выражение>",
    astNode: { kind: "присвоить", fields: [{ name: "name", type: "string" }, { name: "value", type: "Expr" }] },
    since: "0.1.0",
    implemented: true,
  },
  {
    id: "if",
    syntax: "если <условие> ... иначе ... конец",
    astNode: {
      kind: "если",
      fields: [
        { name: "condition", type: "Expr" },
        { name: "body", type: "Stmt[]" },
        { name: "elseBody", type: "Stmt[]", optional: true },
      ],
    },
    since: "0.1.0",
    bytecodePattern: "condition → jmp_if_not else; then-body; jmp end; else-body; end:",
    implemented: true,
  },
  {
    id: "while",
    syntax: "пока <условие> ... конец",
    astNode: { kind: "пока", fields: [{ name: "condition", type: "Expr" }, { name: "body", type: "Stmt[]" }] },
    since: "0.1.0",
    bytecodePattern: "loopStart: condition → jmp_if_not exit; body; jmp loopStart; exit:",
    implemented: true,
  },
  {
    id: "for_each",
    syntax: "для_каждого <переменная> в <выражение> ... конец",
    astNode: {
      kind: "для_каждого",
      fields: [
        { name: "variable", type: "string" },
        { name: "collection", type: "Expr" },
        { name: "body", type: "Stmt[]" },
      ],
    },
    since: "0.1.0",
    bytecodePattern: "collection → __for_arr; 0 → __for_idx; loop: idx<length? jmp_if_not exit; получить(arr,idx)→var; body; idx+1→__for_idx; jmp loop; exit:",
    implemented: true,
    description: "Цикл по массиву через система.массив.длина / система.массив.получить",
  },
  {
    id: "loop",
    syntax: "цикл ... конец",
    astNode: { kind: "цикл", fields: [{ name: "body", type: "Stmt[]" }] },
    since: "0.1.0",
    bytecodePattern: "loop: body; jmp loop",
    implemented: true,
  },
  {
    id: "return",
    syntax: "вернуть <выражение> | вернуть",
    astNode: { kind: "вернуть", fields: [{ name: "value", type: "Expr", optional: true }] },
    since: "0.1.0",
    implemented: true,
  },
  {
    id: "and",
    syntax: "<левый> и <правый>",
    astNode: { kind: "бинарное", fields: [{ name: "op", type: "string" }, { name: "left", type: "Expr" }, { name: "right", type: "Expr" }] },
    since: "0.1.0",
    bytecodePattern: "left; jmp_if_not skip_right; right; skip_right:",
    implemented: true,
    description: "Short-circuit: правый операнд не вычисляется, если левый ложь",
  },
  {
    id: "or",
    syntax: "<левый> или <правый>",
    astNode: { kind: "бинарное", fields: [{ name: "op", type: "string" }, { name: "left", type: "Expr" }, { name: "right", type: "Expr" }] },
    since: "0.1.0",
    bytecodePattern: "left; jmp_if skip_to_true; right; jmp end; skip_to_true: const.true; end:",
    implemented: true,
    description: "Short-circuit: правый операнд не вычисляется, если левый истина",
  },
  {
    id: "not",
    syntax: "не <выражение>",
    astNode: { kind: "унарное", fields: [{ name: "op", type: "не" }, { name: "arg", type: "Expr" }] },
    since: "0.1.0",
    bytecodePattern: "arg; const.false; eq",
    implemented: true,
  },
];

/** Реестр языка Основа v0.1 (текущая реализованная версия). */
export const LANGUAGE_V01: LanguageRegistry = {
  version: LANGUAGE_VERSION,
  keywords: KEYWORDS_V01,
  constructs: CONSTRUCTS_V01,
};

/** Реестр по умолчанию для компилятора и генератора. */
export const LANGUAGE_REGISTRY = LANGUAGE_V01;

/** Ключевые слова, реализованные в лексере (для валидации/подсказок). */
export function getImplementedKeywords(reg: LanguageRegistry = LANGUAGE_REGISTRY): KeywordSpec[] {
  return reg.keywords.filter((k) => k.implemented);
}

/** Конструкции, реализованные в компиляторе. */
export function getImplementedConstructs(reg: LanguageRegistry = LANGUAGE_REGISTRY): ConstructSpec[] {
  return reg.constructs.filter((c) => c.implemented);
}

/** Сериализация реестра в JSON для документации и LLM (без комментариев). */
export function languageRegistryToJson(reg: LanguageRegistry = LANGUAGE_REGISTRY): string {
  return JSON.stringify(reg, null, 2);
}
