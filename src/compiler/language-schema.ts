import { INVOKE_ARG_COUNT } from "../runtime/vm/invokeRegistry";
import { LANGUAGE_REGISTRY, LANGUAGE_VERSION } from "./language-registry";
import { KEYWORDS, type TokenKind } from "./lexer";

type Status = "stable" | "experimental" | "deprecated" | "planned";

interface SchemaField {
  name: string;
  type: string;
  constraints?: string[];
  optional: boolean;
}

interface LanguageSchema {
  languageName: string;
  languageVersion: string;
  schemaVersion: string;
  constructions: Array<{
    id: string;
    kind: "statement" | "expression" | "type" | "helper";
    humanName: string;
    description: string;
    astNodeType: string;
    fields: SchemaField[];
    notes: string[];
    status: Status;
  }>;
  keywords: Array<{
    spelling: string;
    tokenKind: TokenKind | string;
    relatedConstructions: string[];
    status: Status;
  }>;
  operators: Array<{
    symbol: string;
    category: string;
    precedence: number;
    associativity: "left" | "right";
    relatedTokens: string[];
    relatedAstNodes: string[];
    status: Status;
  }>;
  types: Array<{
    id: string;
    category: "primitive" | "composite" | "function" | "alias" | "type_declaration";
    status: Status;
  }>;
  syscalls: Array<{
    id: string;
    signature: {
      args: Array<{ name: string; type: string }>;
      returns: string;
    };
    description: string;
    status: Status;
  }>;
  opcodes: Array<{
    id: string;
    description: string;
    relatedNodeTypes: string[];
  }>;
}

const KEYWORD_TO_CONSTRUCTION: Record<string, string[]> = {
  модуль: ["module", "module_import"],
  процедура: ["procedure", "module_export"],
  тип: ["type_declaration"],
  использовать: ["module_import"],
  экспорт: ["module_export"],
  из: ["module_import"],
  пусть: ["let"],
  если: ["if"],
  иначе: ["if"],
  иначе_если: ["else_if"],
  пока: ["while"],
  тогда: ["then_keyword"],
  когда: ["match_when"],
  есть: ["match_when"],
  попробовать: ["try_catch"],
  иначе_попытка: ["try_catch"],
  выбросить: ["throw_stmt"],
  для_каждого: ["for_each", "for_each_indexed"],
  в: ["for_each", "for_each_indexed"],
  цикл: ["loop"],
  прервать: ["break"],
  продолжить: ["continue"],
  конец: ["module", "procedure", "if", "while", "for_each", "loop", "try_catch", "match_when"],
  вернуть: ["return"],
  и: ["and"],
  или: ["or"],
  не: ["not"],
  истина: ["bool_literal"],
  ложь: ["bool_literal"],
  пусто: ["null_literal"],
};

const PLANNED_CONSTRUCTIONS: LanguageSchema["constructions"] = [
  {
    id: "higher_order_procedures",
    kind: "helper",
    humanName: "Процедуры высшего порядка",
    description: "Передача процедур как значений и аргументов пока не поддерживается.",
    astNodeType: "N/A",
    fields: [],
    notes: ["planned"],
    status: "planned",
  },
];

const OPCODES: LanguageSchema["opcodes"] = [
  { id: "const", description: "Push constant from pool", relatedNodeTypes: ["число", "строка"] },
  { id: "const.true", description: "Push boolean true", relatedNodeTypes: ["булево"] },
  { id: "const.false", description: "Push boolean false", relatedNodeTypes: ["булево", "унарное"] },
  { id: "const.null", description: "Push null value", relatedNodeTypes: ["пусто", "вернуть"] },
  { id: "local.get", description: "Load local variable", relatedNodeTypes: ["переменная"] },
  { id: "local.set", description: "Store local variable", relatedNodeTypes: ["пусть", "присвоить"] },
  { id: "add", description: "Arithmetic add", relatedNodeTypes: ["бинарное"] },
  { id: "sub", description: "Arithmetic subtract", relatedNodeTypes: ["бинарное"] },
  { id: "mul", description: "Arithmetic multiply", relatedNodeTypes: ["бинарное"] },
  { id: "div", description: "Arithmetic divide", relatedNodeTypes: ["бинарное"] },
  { id: "rem", description: "Arithmetic remainder", relatedNodeTypes: ["бинарное"] },
  { id: "eq", description: "Compare equals", relatedNodeTypes: ["бинарное", "унарное"] },
  { id: "ne", description: "Compare not equals", relatedNodeTypes: ["бинарное"] },
  { id: "lt", description: "Compare less than", relatedNodeTypes: ["бинарное", "для_каждого"] },
  { id: "le", description: "Compare less or equal", relatedNodeTypes: ["бинарное"] },
  { id: "gt", description: "Compare greater than", relatedNodeTypes: ["бинарное"] },
  { id: "ge", description: "Compare greater or equal", relatedNodeTypes: ["бинарное"] },
  { id: "call", description: "Call user procedure", relatedNodeTypes: ["вызов"] },
  { id: "invoke", description: "Invoke system call", relatedNodeTypes: ["вызов"] },
  { id: "jmp", description: "Unconditional jump", relatedNodeTypes: ["если", "пока", "цикл"] },
  { id: "jmp_if", description: "Jump if true", relatedNodeTypes: ["бинарное"] },
  { id: "jmp_if_not", description: "Jump if false", relatedNodeTypes: ["если", "пока", "бинарное"] },
  { id: "try_begin", description: "Start try region", relatedNodeTypes: ["попробовать"] },
  { id: "try_end", description: "End try region", relatedNodeTypes: ["попробовать"] },
  { id: "throw", description: "Throw exception", relatedNodeTypes: ["выбросить"] },
  { id: "ret", description: "Return from procedure", relatedNodeTypes: ["вернуть"] },
  { id: "obj.new", description: "Create object literal", relatedNodeTypes: ["объект"] },
  { id: "obj.get", description: "Get object property", relatedNodeTypes: ["поле"] },
  { id: "obj.set", description: "Set object property", relatedNodeTypes: ["поле_присвоить", "объект"] },
  { id: "dup", description: "Duplicate top stack item", relatedNodeTypes: ["объект"] },
];

function detectConstructionKind(astKind: string): "statement" | "expression" | "type" | "helper" {
  if (astKind === "TypeDeclaration") return "type";
  const statementKinds = new Set([
    "Module",
    "Procedure",
    "пусть",
    "присвоить",
    "поле_присвоить",
    "если",
    "когда",
    "пока",
    "для_каждого",
    "цикл",
    "прервать",
    "продолжить",
    "вернуть",
    "попробовать",
    "выбросить",
    "ImportDeclaration",
  ]);
  return statementKinds.has(astKind) ? "statement" : "expression";
}

function buildTypes(): LanguageSchema["types"] {
  const builtin = [
    { id: "число", category: "primitive" as const, status: "stable" as const },
    { id: "строка", category: "primitive" as const, status: "stable" as const },
    { id: "булево", category: "primitive" as const, status: "stable" as const },
    { id: "пусто", category: "primitive" as const, status: "stable" as const },
    { id: "массив", category: "composite" as const, status: "stable" as const },
    { id: "объект", category: "composite" as const, status: "stable" as const },
    { id: "процедура", category: "function" as const, status: "stable" as const },
    { id: "именованный_тип", category: "type_declaration" as const, status: "stable" as const },
  ];
  return builtin;
}

export function buildLanguageSchema(): LanguageSchema {
  const constructions: LanguageSchema["constructions"] = LANGUAGE_REGISTRY.constructs.map((c) => ({
    id: c.id,
    kind: detectConstructionKind(c.astNode.kind),
    humanName: c.id.replaceAll("_", " "),
    description: c.description ?? "",
    astNodeType: c.astNode.kind,
    fields: c.astNode.fields.map((f) => ({
      name: f.name,
      type: f.type,
      optional: Boolean(f.optional),
      constraints: [],
    })),
    notes: [c.bytecodePattern ? "bytecode-mapped" : "syntax"],
    status: c.implemented ? "stable" : "planned",
  }));
  constructions.push(...PLANNED_CONSTRUCTIONS);

  // Ключевые слова — из карты лексера ПЛЮС закрывающие блок слова (`конец`,
  // `конец_если`, …): они реализованы, но в карту не входят, потому что лексер
  // проверяет их до неё (у них свой TokenKind). Схема обязана их знать, иначе
  // machine-readable канон перестаёт описывать синтаксис, который принимается.
  const blockClosingLexemes = LANGUAGE_REGISTRY.keywords
    .filter((k) => k.kind === "block" && k.implemented)
    .map((k) => k.lexeme);
  const keywordSpellings = Array.from(new Set([...Object.keys(KEYWORDS), ...blockClosingLexemes]))
    .sort((a, b) => a.localeCompare(b, "ru"));

  const keywords = keywordSpellings
    .map((spelling) => {
      const spec = LANGUAGE_REGISTRY.keywords.find((k) => k.lexeme === spelling);
      return {
        spelling,
        tokenKind: KEYWORDS[spelling] ?? spelling,
        relatedConstructions: KEYWORD_TO_CONSTRUCTION[spelling] ?? [],
        status: (spec?.implemented ? "stable" : "experimental") as Status,
      };
    });

  const operators = LANGUAGE_REGISTRY.operators.map((op) => ({
    symbol: op.symbol,
    category: op.kind,
    precedence: op.precedence,
    associativity: op.associativity,
    relatedTokens: [op.symbol],
    relatedAstNodes: ["бинарное", "унарное", "присвоить"],
    status: (op.implemented ? "stable" : "planned") as Status,
  }));

  const syscalls = Object.keys(INVOKE_ARG_COUNT)
    .sort((a, b) => a.localeCompare(b, "ru"))
    .map((id) => {
      const registryRow = LANGUAGE_REGISTRY.syscalls.find((s) => s.name === id);
      const argc = INVOKE_ARG_COUNT[id] ?? registryRow?.argc ?? 0;
      return {
        id,
        signature: {
          args: Array.from({ length: argc }, (_, index) => ({
            name: `arg${index + 1}`,
            type: "any",
          })),
          returns: "any",
        },
        description: registryRow?.description ?? "",
        status: (registryRow?.status ?? "experimental") as Status,
      };
    });

  return {
    languageName: "Основа",
    languageVersion: LANGUAGE_VERSION,
    schemaVersion: "2.0.0",
    constructions: constructions.sort((a, b) => a.id.localeCompare(b.id, "ru")),
    keywords,
    operators: operators.sort((a, b) => a.symbol.localeCompare(b.symbol, "ru")),
    types: buildTypes(),
    syscalls,
    opcodes: OPCODES.sort((a, b) => a.id.localeCompare(b.id, "ru")),
  };
}

export function serializeLanguageSchema(): string {
  return `${JSON.stringify(buildLanguageSchema(), null, 2)}\n`;
}
