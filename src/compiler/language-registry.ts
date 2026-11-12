/**
 * Реестр языка Основа — единый источник правды о ключевых словах и конструкциях.
 * Используется для: генератора (LLM, подсказки), компилятора (валидация), документации, golden-тестов.
 * Версия языка согласована с meta.osnova_version в trace-format и minOsnovaVersion в реестре приложений.
 */

export const LANGUAGE_VERSION = "2.3.2";

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
  | "else_if"
  | "field_assign"
  | "then_keyword"
  | "try_catch"
  | "throw_stmt"
  | "while"
  | "for_each"
  | "for_each_indexed"
  | "loop"
  | "break"
  | "continue"
  | "return"
  | "proc_call"
  | "proc_call_recursive"
  | "and"
  | "or"
  | "not"
  | "array_index_read"
  | "array_index_write"
  | "main_with_args"
  | "module_import"
  | "module_export"
  | "variant_type"
  | "variant_literal"
  | "param_types"
  | "typed_field_check"
  | "match_when";

export interface AstFieldSpec {
  name: string;
  type: string;
  optional?: boolean;
}

export interface ConstructSpec {
  id: ConstructId;
  /** Человекочитаемый шаблон синтаксиса для документации и LLM. */
  syntax: string;
  /** Короткий пример кода для LLM-промптов. Без модуль/конец обёртки. */
  example?: string;
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

export interface OperatorSpec {
  symbol: string;
  kind: "arithmetic" | "compare" | "logical" | "assign" | "compound_assign";
  precedence: number;
  associativity: "left" | "right";
  implemented: boolean;
  since: string;
  /**
   * Написания-алиасы, которые лексер сводит к этому же оператору (метаданные, а
   * не отдельный оператор). Отдельная запись оператора означала бы отдельный
   * `TokenKind`, а инвариант `compiler.test.ts` требует, чтобы символ оператора
   * давал токен того же вида.
   */
  aliases?: string[];
}

export interface SyscallSpec {
  name: string;
  argc: number;
  status: "stable" | "experimental" | "deprecated";
  description: string;
  since: string;
}

export interface LiteralSpec {
  /**
   * Вид литерала.
   *
   * `file_mode` добавлен 2026-10-04 вместе с файловыми операциями: `чтение`, `запись`, `дописать`
   * — ЛИТЕРАЛЫ (владелец: «режимы (литералы, не строки)»), а не имена переменных и не константы
   * модуля. Вид назван отдельно, потому что эти слова допустимы ТОЛЬКО в позиции второго аргумента
   * `открыть`: `пусть чтение = 5` остаётся законным именем, и запрещать его незачем.
   */
  kind: "number" | "string" | "bool" | "null" | "array" | "object" | "file_mode";
  examples: string[];
  implemented: boolean;
  since: string;
}

export interface ForbiddenPatternSpec {
  id: string;
  description: string;
  bad: string;
  good?: string;
}

export interface LanguageRegistry {
  version: string;
  keywords: KeywordSpec[];
  constructs: ConstructSpec[];
  operators: OperatorSpec[];
  syscalls: SyscallSpec[];
  literals: LiteralSpec[];
  forbiddenPatterns: ForbiddenPatternSpec[];
}

/** Ключевые слова v0.1: реализованные в MVP + зарезервированные на будущее. */
const KEYWORDS_V01: KeywordSpec[] = [
  { lexeme: "модуль", kind: "module", implemented: true, since: "0.1.0" },
  { lexeme: "процедура", kind: "stmt", implemented: true, since: "0.1.0" },
  { lexeme: "тип", kind: "type", implemented: true, since: "1.6.0", description: "объявление именованного типа" },
  { lexeme: "использовать", kind: "stmt", implemented: true, since: "1.5.0", description: "импорт процедур из другого модуля" },
  { lexeme: "экспорт", kind: "stmt", implemented: true, since: "1.5.0", description: "экспорт процедур для импорта" },
  { lexeme: "чистый", kind: "stmt", implemented: true, since: "2.5.0", description: "модификатор процедуры: без побочных эффектов" },
  { lexeme: "из", kind: "stmt", implemented: true, since: "1.5.0", description: "служебное слово для синтаксиса импорта" },
  { lexeme: "пусть", kind: "stmt", implemented: true, since: "0.1.0" },
  { lexeme: "если", kind: "stmt", implemented: true, since: "0.1.0" },
  { lexeme: "иначе", kind: "stmt", implemented: true, since: "0.1.0", description: "ветка else после если" },
  { lexeme: "иначе_если", kind: "stmt", implemented: true, since: "0.1.0", description: "цепочка else-if между если и иначе" },
  { lexeme: "пока", kind: "stmt", implemented: true, since: "0.1.0" },
  { lexeme: "попробовать", kind: "stmt", implemented: true, since: "1.2.0", description: "начало блока обработки ошибок" },
  { lexeme: "поймать", kind: "stmt", implemented: true, since: "2.6.0", description: "блок catch для попробовать (канон)" },
  { lexeme: "иначе_попытка", kind: "stmt", implemented: false, since: "1.2.0", description: "ALIAS: то же, что поймать; канон — поймать" },
  { lexeme: "выбросить", kind: "stmt", implemented: true, since: "1.2.0", description: "выброс исключения" },
  { lexeme: "для", kind: "stmt", implemented: true, since: "2.6.0", description: "цикл по коллекции (канон)" },
  { lexeme: "для_каждого", kind: "stmt", implemented: false, since: "0.1.0", description: "ALIAS: то же, что для; канон — для" },
  { lexeme: "в", kind: "stmt", implemented: true, since: "0.1.0", description: "в конструкции для x в expr" },
  { lexeme: "цикл", kind: "stmt", implemented: true, since: "0.1.0" },
  { lexeme: "конец", kind: "block", implemented: true, since: "0.1.0",
    description: "LEGACY: закрывает текущий блок по контексту; канон — конец_<что закрывается>. Вне позиции закрытия работает как обычное имя" },
  { lexeme: "конец_если", kind: "block", implemented: true, since: "2.6.0",
    description: "закрывает блок если/иначе_если/иначе" },
  { lexeme: "конец_когда", kind: "block", implemented: true, since: "2.6.0",
    description: "закрывает блок когда" },
  { lexeme: "конец_пока", kind: "block", implemented: true, since: "2.6.0",
    description: "закрывает цикл пока" },
  { lexeme: "конец_для", kind: "block", implemented: true, since: "2.6.0",
    description: "закрывает цикл для_каждого (короткая форма канона)" },
  { lexeme: "конец_для_каждого", kind: "block", implemented: true, since: "2.6.0",
    description: "закрывает цикл для_каждого (полная форма)" },
  { lexeme: "конец_цикла", kind: "block", implemented: true, since: "2.6.0",
    description: "закрывает безусловный цикл цикл" },
  { lexeme: "конец_попробовать", kind: "block", implemented: true, since: "2.6.0",
    description: "закрывает блок попробовать/иначе_попытка" },
  { lexeme: "конец_процедуры", kind: "block", implemented: true, since: "2.6.0",
    description: "закрывает тело процедуры" },
  { lexeme: "конец_модуля", kind: "block", implemented: true, since: "2.6.0",
    description: "закрывает модуль" },
  { lexeme: "вернуть", kind: "stmt", implemented: true, since: "0.1.0" },
  { lexeme: "истина", kind: "expr", implemented: true, since: "0.1.0" },
  { lexeme: "ложь", kind: "expr", implemented: true, since: "0.1.0" },
  { lexeme: "пусто", kind: "expr", implemented: true, since: "0.1.0" },
  { lexeme: "и", kind: "expr", implemented: true, since: "0.1.0", description: "логическое И, short-circuit" },
  { lexeme: "или", kind: "expr", implemented: true, since: "0.1.0", description: "логическое ИЛИ, short-circuit" },
  { lexeme: "не", kind: "expr", implemented: true, since: "0.1.0", description: "логическое НЕ" },
  // БЛОК 2: целочисленное деление. `//` занять нельзя — это комментарий до конца
  // строки (lexer.ts), и `10 // 3` молча даёт 10. Форма `div` — короткое
  // ASCII-написание (как алиасы `for`/`catch`/`end`), русское `цел_деление` ведёт к
  // тому же виду токена через LLM_KEYWORD_ALIASES. Округление — к нулю (см. оракул).
  { lexeme: "div", kind: "expr", implemented: true, since: "2.6.0",
    description: "целочисленное деление с отсечением к нулю (10 div 3 = 3; -7 div 3 = -2)" },
  { lexeme: "тогда", kind: "stmt", implemented: true, since: "1.1.0", description: "опциональное слово после условия в если/иначе_если/пока" },
  { lexeme: "когда", kind: "stmt", implemented: true, since: "2.2.0", description: "разбор перечня по вариантам, с исчерпыванием" },
  { lexeme: "есть", kind: "stmt", implemented: true, since: "2.2.0", description: "ветка когда: есть Имя.вариант" },
  { lexeme: "прервать", kind: "stmt", implemented: true, since: "1.8.0",
    description: "выход из текущего цикла пока/цикл" },
  { lexeme: "продолжить", kind: "stmt", implemented: true, since: "1.9.0",
    description: "переход к следующей итерации цикла пока/цикл (continue)" },
];

/** Конструкции v0.1 с привязкой к AST и синтаксису. */
const CONSTRUCTS_V01: ConstructSpec[] = [
  {
    id: "module",
    // Канон БЛОК 3, пункт 1: модуль — сам файл, имя берётся из имени файла.
    // Шапка `модуль <имя>` остаётся legacy-формой и принимается; закрытие
    // (`конец_модуля`/`конец`) при шапке по-прежнему необязательно.
    syntax: "файл = модуль (legacy: модуль <имя> … конец_модуля)",
    astNode: { kind: "Module", fields: [{ name: "name", type: "string" }, { name: "procedures", type: "Procedure[]" }] },
    since: "0.1.0",
    implemented: true,
    description:
      "Один файл — один модуль; имя модуля берётся из имени файла (привет.osnova → «привет»). " +
      "Шапка `модуль <имя>` не обязательна; `конец_модуля` без шапки — ошибка",
  },
  {
    id: "procedure",
    syntax: "процедура <имя>(<параметры>) ... конец",
    astNode: { kind: "Procedure", fields: [{ name: "name", type: "string" }, { name: "params", type: "string[]" }, { name: "body", type: "Stmt[]" }] },
    since: "0.1.0",
    implemented: true,
    description: "Конец без вернуть даёт пусто (v2.3.2), чтобы вызов как инструкция не снимал пустой стек",
  },
  {
    id: "let",
    syntax: "пусть <имя> = <выражение>",
    example: "пусть х = 42",
    astNode: { kind: "пусть", fields: [{ name: "name", type: "string" }, { name: "init", type: "Expr" }] },
    since: "0.1.0",
    implemented: true,
  },
  {
    id: "assign",
    syntax: "<имя> = <выражение>",
    example: "х = х + 1",
    astNode: { kind: "присвоить", fields: [{ name: "name", type: "string" }, { name: "value", type: "Expr" }] },
    since: "0.1.0",
    implemented: true,
  },
  {
    id: "if",
    syntax: "если <условие> ... иначе ... конец",
    example: "если х > 0\n  вернуть истина\nиначе\n  вернуть ложь\nконец",
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
    id: "then_keyword",
    syntax: "если условие тогда  // тогда опционально",
    astNode: {
      kind: "если",
      fields: [
        { name: "condition", type: "Expr" },
        { name: "body", type: "Stmt[]" },
        { name: "elseBody", type: "Stmt[]", optional: true },
      ],
    },
    since: "1.1.0",
    implemented: true,
    description: "Опциональное ключевое слово 'тогда' после условия в если/иначе_если/пока",
  },
  {
    id: "else_if",
    syntax: "если <условие>\n  ...\nиначе_если <условие>\n  ...\nиначе\n  ...\nконец",
    astNode: {
      kind: "если",
      fields: [
        { name: "condition", type: "Expr" },
        { name: "body", type: "Stmt[]" },
        { name: "elseIfClauses", type: "{ condition: Expr; body: Stmt[] }[]", optional: true },
        { name: "elseBody", type: "Stmt[]", optional: true },
      ],
    },
    since: "0.1.0",
    implemented: true,
    description: "Цепочка ветвления: если / иначе_если / иначе / конец",
  },
  {
    id: "match_when",
    syntax: "когда <выражение>\n  есть Имя.вариант\n    ...\n  иначе\n    ...\nконец",
    example: "когда карта.масть\n  есть Масть.пики\n    вернуть 1\n  есть Масть.черви\n    вернуть 2\nконец",
    astNode: {
      kind: "когда",
      fields: [
        { name: "scrutinee", type: "Expr" },
        { name: "arms", type: "{ variant: Expr; body: Stmt[] }[]" },
        { name: "elseBody", type: "Stmt[]", optional: true },
      ],
    },
    since: "2.2.0",
    implemented: true,
    description: "Разбор перечня: все варианты должны быть названы, иначе — ветка иначе. Компилятор разворачивает в если.",
  },
  {
    id: "field_assign",
    syntax: "<объект>.<поле> = <выражение>",
    astNode: {
      kind: "поле_присвоить",
      fields: [
        { name: "object", type: "string" },
        { name: "field", type: "string" },
        { name: "value", type: "Expr" },
      ],
    },
    since: "0.1.0",
    implemented: true,
    description: "Присваивание поля объекта",
  },
  {
    id: "try_catch",
    syntax: "попробовать\n  <тело>\nпоймать ошибка\n  <обработчик>\nконец",
    example: "попробовать\n  выбросить \"ошибка\"\nпоймать е\n  вернуть 1\nконец",
    astNode: {
      kind: "попробовать",
      fields: [
        { name: "body", type: "Stmt[]" },
        { name: "catchVar", type: "string" },
        { name: "catchBody", type: "Stmt[]" },
      ],
    },
    since: "1.2.0",
    implemented: true,
    description: "Блок перехвата ошибок",
  },
  {
    id: "throw_stmt",
    syntax: "выбросить <выражение>",
    astNode: {
      kind: "выбросить",
      fields: [{ name: "value", type: "Expr" }],
    },
    since: "1.2.0",
    implemented: true,
    description: "Выбросить значение как исключение",
  },
  {
    id: "while",
    syntax: "пока <условие> ... конец",
    example: "пока i < 10\n  i = i + 1\nконец",
    astNode: { kind: "пока", fields: [{ name: "condition", type: "Expr" }, { name: "body", type: "Stmt[]" }] },
    since: "0.1.0",
    bytecodePattern: "loopStart: condition → jmp_if_not exit; body; jmp loopStart; exit:",
    implemented: true,
  },
  {
    id: "for_each",
    syntax: "для <элемент> в <массив> ... конец",
    example: "для эл в числа\n  сумма = сумма + эл\nконец",
    astNode: {
      kind: "для_каждого",
      fields: [
        { name: "item", type: "string" },
        { name: "source", type: "Expr" },
        { name: "body", type: "Stmt[]" },
      ],
    },
    since: "1.0.0",
    bytecodePattern: "source → __forEach_src_N; len(source) → __forEach_len_N; __forEach_i_N=0; loop: i<len? jmp_if_not exit; item=получить(source,i); body; i=i+1; jmp loop; exit:",
    implemented: true,
    description: "Цикл по массиву через система.массив.длина / система.массив.получить",
  },
  {
    id: "for_each_indexed",
    syntax: "для <элемент>, <индекс> в <массив> ... конец",
    example: "для эл, инд в числа\n  система.лог.вывести(инд)\nконец",
    astNode: {
      kind: "для_каждого",
      fields: [
        { name: "item", type: "string" },
        { name: "index", type: "string", optional: true },
        { name: "source", type: "Expr" },
        { name: "body", type: "Stmt[]" },
      ],
    },
    since: "1.3.0",
    bytecodePattern: "как for_each + index=i перед телом цикла",
    implemented: true,
    description: "Итерация по массиву с доступом к индексу",
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
    id: "break",
    syntax: "прервать",
    example:
      "пока истина\n  пусть ввод = система.ввод.текст(\"> \")\n  если ввод == \"/выход\"\n    прервать\n  конец\n  система.лог.вывести(ввод)\nконец",
    astNode: {
      kind: "прервать",
      fields: [],
    },
    since: "1.8.0",
    bytecodePattern: "jmp patchExit  // адрес сразу за телом цикла",
    implemented: true,
    description: "Немедленный выход из ближайшего охватывающего цикла пока или цикл",
  },
  {
    id: "continue",
    syntax: "продолжить",
    example: "пока i < 10\n  если i % 2 == 0\n    продолжить\n  конец\n  сумма = сумма + i\nконец",
    astNode: { kind: "продолжить", fields: [] },
    since: "1.9.0",
    bytecodePattern: "jmp loopStart  // переход к началу итерации",
    implemented: true,
    description: "Переход к следующей итерации ближайшего охватывающего цикла пока/цикл",
  },
  {
    id: "return",
    syntax: "вернуть <выражение> | вернуть",
    example: "вернуть значение",
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
  {
    id: "array_index_read",
    syntax: "массив[индекс]  // сахар: система.массив.получить(массив, индекс)",
    example: "пусть первый = числа[0]",
    astNode: {
      kind: "вызов",
      fields: [
        { name: "name", type: "string" },
        { name: "args", type: "Expr[]" },
      ],
    },
    since: "1.1.0",
    implemented: true,
    description: "Синтаксический сахар для чтения элемента массива по индексу",
  },
  {
    id: "array_index_write",
    syntax: "массив[индекс] = значение  // сахар: система.массив.установить(массив, индекс, значение); также объект.поле[i] =",
    example: "мир.поле[i] = Камень.огонь",
    astNode: {
      kind: "вызов",
      fields: [
        { name: "name", type: "string" },
        { name: "args", type: "Expr[]" },
      ],
    },
    since: "1.1.0",
    implemented: true,
    description: "Синтаксический сахар для записи элемента массива по индексу, в том числе объект.поле[i] =",
  },
  {
    id: "main_with_args",
    syntax: "процедура главная(аргументы)  // аргументы — массив строк из CLI",
    astNode: { kind: "Procedure", fields: [{ name: "name", type: "string" }, { name: "params", type: "string[]" }, { name: "body", type: "Stmt[]" }] },
    since: "1.1.0",
    implemented: true,
    description: "Точка входа может принимать один параметр-массив CLI аргументов",
  },
  {
    id: "proc_call",
    syntax: "пусть результат = имя_процедуры(аргументы)",
    example: "пусть р = удвоить(5)",
    astNode: { kind: "вызов", fields: [{ name: "name", type: "string" }, { name: "args", type: "Expr[]" }] },
    since: "1.4.0",
    implemented: true,
    description: "Вызов пользовательской процедуры (из процедуры/тела программы)",
  },
  {
    id: "proc_call_recursive",
    syntax: "вернуть имя_процедуры(выражение)",
    example: "вернуть факториал(н - 1)",
    astNode: { kind: "вызов", fields: [{ name: "name", type: "string" }, { name: "args", type: "Expr[]" }] },
    since: "1.4.0",
    implemented: true,
    description: "Рекурсивный вызов пользовательской процедуры",
  },
  {
    id: "module_import",
    syntax: 'использовать модуль <namespace> из "<путь>"',
    example: 'использовать модуль Утилиты из "утилиты.osnova"\n\nпроцедура главная()\n  пусть р = Утилиты.сложить(2, 3)\n  вернуть р\nконец',
    astNode: {
      kind: "ImportDeclaration",
      fields: [
        { name: "module", type: "string" },
        { name: "path", type: "string" },
      ],
    },
    since: "1.5.0",
    implemented: true,
    description: "Импорт экспортированных процедур и типов из другого файла. Два файла с одним именем типа — ошибка; один файл, импортированный дважды, — нет. Ошибка называет файл импорта.",
  },
  {
    id: "module_export",
    syntax: "процедура экспорт имя(...)",
    example: "процедура экспорт сложить(а, б)\n  вернуть а + б\nконец",
    astNode: {
      kind: "Procedure",
      fields: [{ name: "exported", type: "boolean", optional: true }],
    },
    since: "1.5.0",
    implemented: true,
    description: "Объявление публичной процедуры модуля",
  },
  {
    id: "variant_type",
    syntax: "тип Имя = вариант1 | вариант2 | …",
    example: "тип Масть = пики | черви | буби | трефы",
    astNode: {
      kind: "TypeDeclaration",
      fields: [
        { name: "name", type: "string" },
        { name: "variants", type: "string[]", optional: true },
      ],
    },
    since: "2.1.0",
    implemented: true,
    description: "Перечень вариантов без полезной нагрузки; в VM литерал — строка Имя.вариант",
  },
  {
    id: "variant_literal",
    syntax: "Имя.вариант",
    example: "пусть м = Масть.пики",
    astNode: {
      kind: "вариант",
      fields: [
        { name: "typeName", type: "string" },
        { name: "variant", type: "string" },
      ],
    },
    since: "2.1.0",
    implemented: true,
    description: "Квалифицированный литерал перечня",
  },
  {
    id: "param_types",
    syntax: "процедура имя(параметр: Тип, …)",
    example: "процедура сила(карта: Карта, козырь: Масть)",
    astNode: {
      kind: "Procedure",
      fields: [{ name: "paramTypes", type: "TypeRef[]", optional: true }],
    },
    since: "2.1.0",
    implemented: true,
    description: "Опциональные аннотации типов параметров",
  },
  {
    id: "typed_field_check",
    syntax: "obj.поле при известном типе obj",
    example: "пусть x = мир.счет  // ошибка, если у Мир нет поля счет",
    astNode: { kind: "поле", fields: [{ name: "field", type: "string" }] },
    since: "2.1.0",
    implemented: true,
    description: "Проверка неизвестных полей и несовпадения типов у аннотированных переменных",
  },
];

const OPERATORS_V01: OperatorSpec[] = [
  // `:=` — алиас присваивания из Паскаля (пункт 1.3 требований): лексер сводит его к `=`.
  // Метаданные, а не отдельный оператор: отдельная запись потребовала бы своего TokenKind.
  { symbol: "=", kind: "assign", precedence: 1, associativity: "right", implemented: true, since: "0.1.0", aliases: [":="] },
  { symbol: "==", kind: "compare", precedence: 4, associativity: "left", implemented: true, since: "0.1.0" },
  { symbol: "!=", kind: "compare", precedence: 4, associativity: "left", implemented: true, since: "0.1.0" },
  { symbol: "<", kind: "compare", precedence: 4, associativity: "left", implemented: true, since: "0.1.0" },
  { symbol: "<=", kind: "compare", precedence: 4, associativity: "left", implemented: true, since: "0.1.0" },
  { symbol: ">", kind: "compare", precedence: 4, associativity: "left", implemented: true, since: "0.1.0" },
  { symbol: ">=", kind: "compare", precedence: 4, associativity: "left", implemented: true, since: "0.1.0" },
  { symbol: "+", kind: "arithmetic", precedence: 5, associativity: "left", implemented: true, since: "0.1.0" },
  { symbol: "-", kind: "arithmetic", precedence: 5, associativity: "left", implemented: true, since: "0.1.0" },
  { symbol: "-(унарный)", kind: "arithmetic", precedence: 7, associativity: "right", implemented: true, since: "0.1.0" },
  { symbol: "*", kind: "arithmetic", precedence: 6, associativity: "left", implemented: true, since: "0.1.0" },
  { symbol: "/", kind: "arithmetic", precedence: 6, associativity: "left", implemented: true, since: "0.1.0" },
  { symbol: "%", kind: "arithmetic", precedence: 6, associativity: "left", implemented: true, since: "0.1.0" },
  { symbol: "+=", kind: "compound_assign", precedence: 1, associativity: "right", implemented: true, since: "0.1.1" },
  { symbol: "-=", kind: "compound_assign", precedence: 1, associativity: "right", implemented: true, since: "0.1.1" },
  { symbol: "*=", kind: "compound_assign", precedence: 1, associativity: "right", implemented: true, since: "0.1.1" },
  { symbol: "/=", kind: "compound_assign", precedence: 1, associativity: "right", implemented: true, since: "0.1.1" },
];

const SYSCALLS_V01: SyscallSpec[] = [
  { name: "система.лог.вывести", argc: 1, status: "stable", description: "Вывод сообщения в лог", since: "0.1.0" },
  { name: "система.файлы.прочитать_все", argc: 1, status: "experimental", description: "Прочитать файл целиком", since: "0.1.0" },
  { name: "система.файлы.записать_все", argc: 2, status: "experimental", description: "Записать данные в файл", since: "0.1.0" },
  { name: "система.файлы.существует", argc: 1, status: "experimental", description: "Проверить существование файла", since: "0.1.0" },
  // ── ФАЙЛОВЫЕ ОПЕРАЦИИ НА ЦЕЛИ (2026-10-04, долг §3.105.3) ─────────────────────────────────────
  //
  // В программе на v3 эти имена не пишутся: их ставит разворот ВСТРОЕННЫХ СЛОВ `открыть`,
  // `читать`, `писать`, `закрыть` (`src/compiler-v3/parser.ts`), потому что `система.файлы.открыть`
  // — цепочка из двух точек, а её v3 запрещает. В написании v2 имена работают напрямую.
  //
  // Номера системных вызовов e2k: open 5, read 3, write 4, close 6. На x86_64 ОНИ ДРУГИЕ (2, 0, 1, 3)
  // — числа e2k сверены с `linux-user/e2k/syscall_nr.h:11-14` и проверены прогоном на модели
  // (`src/self-host/foundationE2k.test.ts`).
  //
  // Режимы — ЛИТЕРАЛЫ языка (`чтение`, `запись`, `дописать`), они объявлены ниже в LITERALS_V01.
  { name: "система.файлы.открыть", argc: 2, status: "stable", description: "Открыть файл: открыть(путь, режим) → дескриптор. Режим — литерал: чтение (O_RDONLY), запись (O_WRONLY|O_CREAT|O_TRUNC), дописать (O_WRONLY|O_APPEND). В v3 пишется словом открыть", since: "2.7.0" },
  { name: "система.файлы.читать", argc: 2, status: "stable", description: "Прочитать из файла: читать(дескриптор, длина) → Строка. Длина — в КОДОВЫХ ТОЧКАХ, как у длина: иначе двухбайтовая буква разрезалась бы пополам. На конце файла — пустая строка, а не отказ. В v3 пишется словом читать", since: "2.7.0" },
  { name: "система.файлы.писать", argc: 2, status: "stable", description: "Записать в файл: писать(дескриптор, текст) → число записанных байтов. В v3 пишется словом писать", since: "2.7.0" },
  { name: "система.файлы.закрыть", argc: 1, status: "stable", description: "Закрыть файл: закрыть(дескриптор). Незакрытый дескриптор течёт: у процесса их конечное число, и это названная цена, а не свойство. В v3 пишется словом закрыть", since: "2.7.0" },
  { name: "система.время.сейчас", argc: 0, status: "stable", description: "Текущее время в миллисекундах", since: "0.1.0" },
  { name: "система.время.метка", argc: 0, status: "stable", description: "Текущая дата-время в виде строки ISO 8601 (например 2026-03-23T17:59:00Z)", since: "2.0.0" },
  { name: "система.время.разобрать", argc: 1, status: "stable", description: "Разобрать ISO-строку даты/времени в объект с полями год, месяц, день, часы, минуты", since: "2.0.0" },
  { name: "система.время.форматировать", argc: 2, status: "stable", description: "Отформатировать объект даты в строку по заданному формату (\"дд.мм.гггг\" или \"дд.мм.гггг чч:мм\")", since: "2.0.0" },
  { name: "система.время.добавить_дни", argc: 2, status: "stable", description: "Добавить N дней к ISO-метке и вернуть новую ISO-метку", since: "2.0.0" },
  { name: "система.время.разница_дней", argc: 2, status: "stable", description: "Вернуть целое количество дней между двумя ISO-метками", since: "2.0.0" },
  { name: "система.время.спать", argc: 1, status: "experimental", description: "Приостановить выполнение на N мс", since: "0.1.0" },
  { name: "система.хранилище.записать", argc: 2, status: "stable", description: "Записать значение по ключу", since: "0.1.0" },
  { name: "система.хранилище.прочитать", argc: 1, status: "stable", description: "Прочитать значение по ключу", since: "0.1.0" },
  { name: "система.хранилище.удалить", argc: 1, status: "stable", description: "Удалить значение по ключу", since: "0.1.0" },
  { name: "система.хранилище.ключи", argc: 0, status: "stable", description: "Получить список ключей хранилища", since: "0.1.0" },
  { name: "система.хранилище.ключи_с_префиксом", argc: 1, status: "stable", description: "Получить список ключей хранилища с заданным префиксом", since: "2.0.0" },
  { name: "система.сеть.запрос", argc: 4, status: "experimental", description: "Выполнить сетевой HTTP-запрос", since: "0.1.0" },
  { name: "система.сеть.получить", argc: 1, status: "stable", description: "HTTP GET-запрос, возвращает тело ответа", since: "1.7.0" },
  { name: "система.сеть.пост", argc: 2, status: "stable", description: "HTTP POST-запрос с телом, возвращает тело ответа", since: "1.7.0" },
  { name: "система.окно.создать_окно", argc: 3, status: "experimental", description: "Создать окно интерфейса", since: "0.1.0" },
  { name: "система.окно.показать", argc: 1, status: "experimental", description: "Показать окно", since: "0.1.0" },
  { name: "система.окно.скрыть", argc: 1, status: "experimental", description: "Скрыть окно", since: "0.1.0" },
  { name: "система.окно.закрыть", argc: 1, status: "experimental", description: "Закрыть окно", since: "0.1.0" },
  { name: "система.окно.установить_заголовок", argc: 2, status: "experimental", description: "Изменить заголовок окна", since: "0.1.0" },
  { name: "система.окно.получить_события", argc: 0, status: "experimental", description: "Получить события окна", since: "0.1.0" },
  { name: "система.интерфейс.контейнер", argc: 3, status: "experimental", description: "Создать контейнер интерфейса", since: "0.1.0" },
  { name: "система.интерфейс.кнопка", argc: 3, status: "experimental", description: "Создать кнопку интерфейса", since: "0.1.0" },
  { name: "система.интерфейс.поле_ввода", argc: 3, status: "experimental", description: "Создать поле ввода", since: "0.1.0" },
  { name: "система.интерфейс.текст", argc: 3, status: "experimental", description: "Создать текстовый виджет", since: "0.1.0" },
  { name: "система.интерфейс.область_текста", argc: 3, status: "experimental", description: "Создать область текста", since: "0.1.0" },
  { name: "система.интерфейс.получить_значение", argc: 1, status: "experimental", description: "Получить значение виджета", since: "0.1.0" },
  { name: "система.интерфейс.установить_значение", argc: 2, status: "experimental", description: "Установить значение виджета", since: "0.1.0" },
  { name: "система.интерфейс.диалог_сообщение", argc: 2, status: "experimental", description: "Показать диалоговое сообщение", since: "0.1.0" },
  { name: "система.интерфейс.диалог_подтвердить", argc: 2, status: "experimental", description: "Показать диалог подтверждения", since: "0.1.0" },
  { name: "система.интерфейс.диалог_ввод", argc: 3, status: "experimental", description: "Показать диалог ввода", since: "0.1.0" },
  { name: "система.массив.создать", argc: 0, status: "stable", description: "Создать пустой массив", since: "0.1.0" },
  { name: "система.массив.добавить", argc: 2, status: "stable", description: "Добавить элемент в массив", since: "0.1.0" },
  { name: "система.массив.установить", argc: 3, status: "stable", description: "Установить элемент массива по индексу", since: "0.1.0" },
  { name: "система.массив.удалить", argc: 2, status: "stable", description: "Удалить элемент массива по индексу", since: "0.1.0" },
  { name: "система.массив.срез", argc: 3, status: "stable", description: "Получить срез массива", since: "0.1.0" },
  { name: "система.массив.длина", argc: 1, status: "stable", description: "Получить длину массива", since: "0.1.0" },
  { name: "система.массив.получить", argc: 2, status: "stable", description: "Получить элемент массива по индексу", since: "0.1.0" },
  // ── КОЛЛЕКЦИИ НА `brk`: ОБЪЯВЛЕНЫ В КАНОНЕ (2026-10-04, долг §3.105.5) ────────────────────────
  //
  // Прежде эти четыре операции жили ТОЛЬКО в рантайме (`extraInvokes`): цель их исполняла, эталон
  // считал, а канон не объявлял — программе на v2 они были недоступны, а на v3 и подавно
  // (`система.коллекция.выделить(4)` — цепочка из двух точек, канон v3 её запрещает). Теперь
  // объявлены, и в v3 к ним ведут ВСТРОЕННЫЕ СЛОВА: `выделить`, `положить`, `взять`, `расширить`
  // (`src/compiler-v3/parser.ts`).
  //
  // Пятое слово — `расширить_удвоением` — В КАНОН НЕ ВХОДИТ, и это названный отказ, а не забывчивость:
  // чтобы удвоить ёмкость, её надо СНАЧАЛА ПРОЧИТАТЬ, а чтения ёмкости в языке нет (она лежит в
  // заголовке блока в памяти, `src/e2k/collectionsRuntime.ts:14-17`). Разбор называет причину
  // (`расширить_удвоением` → отказ с текстом), а не подставляет догадку.
  { name: "система.коллекция.выделить", argc: 1, status: "stable", description: "Выделить блок коллекции ёмкостью N; результат — ЧИСЛО-адрес (отдельного типа «Адрес» нет). Шаг блока 8 + N·8 байт. В v3 пишется словом выделить", since: "2.7.0" },
  { name: "система.коллекция.положить", argc: 3, status: "stable", description: "Записать элемент: положить(база, индекс, значение). Индекс за границей блока — НАЗВАННЫЙ отказ, а не тихая запись в чужую память. В v3 пишется словом положить", since: "2.7.0" },
  { name: "система.коллекция.взять", argc: 2, status: "stable", description: "Прочитать элемент: взять(база, индекс). Незаписанный элемент читается нулём (свежая страница кучи приходит от ядра нулевой). В v3 пишется словом взять", since: "2.7.0" },
  { name: "система.коллекция.расширить", argc: 2, status: "stable", description: "Переезд в блок большей ёмкости: расширить(база, новая_ёмкость) → новый адрес. Новая ёмкость не больше текущей — НАЗВАННЫЙ отказ. Старый блок остаётся мёртвым: возврата памяти нет. В v3 пишется словом расширить", since: "2.7.0" },
  { name: "система.объект.получить", argc: 2, status: "stable", description: "Получить поле объекта по ключу", since: "0.1.0" },
  { name: "система.строка.объединить", argc: 2, status: "stable", description: "Объединить две строки", since: "0.1.0" },
  { name: "система.строка.из_числа", argc: 1, status: "stable", description: "преобразует число в строку", since: "0.1.0" },
  { name: "система.строка.длина", argc: 1, status: "stable", description: "Длина строки в КОДОВЫХ ТОЧКАХ (не в байтах UTF-8 и не в единицах UTF-16: длина(\"🙂\") = 1)", since: "0.1.0" },
  { name: "система.строка.символ", argc: 2, status: "stable", description: "КОД символа строки по индексу в КОДОВЫХ ТОЧКАХ: символ(\"абв\", 0) = 1072 (U+0430), символ(\"abc\", 0) = 97. Возвращает ЧИСЛО, а не строку (решение владельца 2026-10-10): строковая модель цели требует известной на сборке длины, а символ по рантаймовому индексу — 1–4 байта, известных только в рантайме. Выход за границу в VM — названный отказ, а не null: null сложился бы с числом как ноль. Разворачивается из формы arr[i], когда операнд — строка (как длина — по типу операнда)", since: "2.7.0" },
  { name: "система.строка.содержит", argc: 2, status: "stable", description: "Проверить, содержит ли строка подстроку", since: "0.1.0" },
  { name: "система.строка.начинается_с", argc: 2, status: "stable", description: "Проверить префикс строки", since: "0.1.0" },
  { name: "система.строка.заканчивается_на", argc: 2, status: "stable", description: "Проверить суффикс строки", since: "0.1.0" },
  { name: "система.строка.подстрока", argc: 3, status: "stable", description: "Подстрока по диапазону КОДОВЫХ ТОЧЕК (границы не рвут суррогатную пару). В v3 доступна ВСТРОЕННЫМ СЛОВОМ `подстрока(строка, начало, конец)`: трёхсегментное имя v3 не разбирает (§3.105.3), а после решения 2026-10-10 (`символ` — ЧИСЛО) это единственный способ получить из исходника ТЕКСТ — без него self-host-лексер не выразим (§3.133)", since: "0.1.0" },
  { name: "система.строка.в_верхний", argc: 1, status: "stable", description: "Преобразовать строку в верхний регистр", since: "0.1.0" },
  { name: "система.строка.в_нижний", argc: 1, status: "stable", description: "Преобразовать строку в нижний регистр", since: "0.1.0" },
  { name: "система.строка.обрезать", argc: 1, status: "stable", description: "Удалить пробелы по краям строки", since: "0.1.0" },
  { name: "система.строка.заменить", argc: 3, status: "stable", description: "Заменить подстроку в строке", since: "0.1.0" },
  { name: "система.строка.разделить", argc: 2, status: "stable", description: "Разделить строку по разделителю", since: "0.1.0" },
  { name: "система.строка.найти", argc: 2, status: "stable",
    description: "Индекс первого вхождения подстроки в КОДОВЫХ ТОЧКАХ; -1 если не найдено",
    since: "1.7.0" },
  { name: "система.память.выделить", argc: 1, status: "experimental",
    description:
      "Выделить байт памяти из арены; результат — ЧИСЛО (адрес — это число, отдельного типа «Адрес» нет). " +
      "Арена растёт и не возвращается; при исчерпании — отказ: код 231 и строка «арена исчерпана: выделение сверх предела»",
    since: "2.6.0" },
  { name: "система.json.создать", argc: 1, status: "stable", description: "Сериализация значения в JSON-строку", since: "1.7.0" },
  { name: "система.json.разобрать", argc: 1, status: "stable", description: "Десериализация JSON-строки в значение", since: "1.7.0" },
  { name: "система.ввод.текст", argc: 1, status: "experimental", description: "Читает строку ввода от пользователя", since: "1.7.0" },
  { name: "система.математика.округлить", argc: 1, status: "stable", description: "Округление до ближайшего целого", since: "2.0.1" },
  { name: "система.математика.пол", argc: 1, status: "stable", description: "Округление вниз", since: "2.0.1" },
  { name: "система.математика.потолок", argc: 1, status: "stable", description: "Округление вверх", since: "2.0.1" },
  { name: "система.математика.абс", argc: 1, status: "stable", description: "Абсолютное значение", since: "2.0.1" },
  { name: "система.математика.макс", argc: 2, status: "stable", description: "Максимум из двух чисел", since: "2.0.1" },
  { name: "система.математика.мин", argc: 2, status: "stable", description: "Минимум из двух чисел", since: "2.0.1" },
  { name: "система.математика.степень", argc: 2, status: "stable", description: "Возведение в степень", since: "2.0.1" },
  { name: "система.математика.корень", argc: 1, status: "stable", description: "Квадратный корень", since: "2.0.1" },
  { name: "система.математика.остаток", argc: 2, status: "stable", description: "Остаток от деления (а % б)", since: "2.0.1" },
  { name: "система.объект.ключи", argc: 1, status: "stable", description: "Массив ключей объекта", since: "2.0.2" },
  { name: "система.объект.установить", argc: 3, status: "stable", description: "Установить значение поля объекта", since: "2.0.2" },
  { name: "система.итератор.из", argc: 1, status: "stable", description: "Нормализация к массиву: массив → как есть, объект → Object.keys", since: "2.0.2" },
  { name: "система.пайплайн.ид_спецификации", argc: 0, status: "stable", description: "Получить ID спецификации пайплайна", since: "2.0.0" },
  { name: "система.пайплайн.главный_модуль", argc: 0, status: "stable", description: "Получить имя главного модуля пайплайна", since: "2.0.0" },
  { name: "система.пайплайн.ожидаемый_возврат", argc: 0, status: "stable", description: "Получить ожидаемое возвращаемое значение пайплайна", since: "2.0.0" },
  { name: "система.оценить", argc: 1, status: "stable", description: "Скомпилировать и исполнить строку кода на лету (eval)", since: "2.4.0" },
  { name: "система.оценить_в", argc: 2, status: "stable", description: "Исполнить код на лету с доступом к окружению", since: "2.4.0" },
  { name: "система.оценить.получить", argc: 1, status: "stable", description: "Прочитать значение из окружения eval по ключу", since: "2.4.0" },
  { name: "система.оценить.установить", argc: 2, status: "stable", description: "Записать значение в окружение eval по ключу", since: "2.4.0" },
];

const LITERALS_V01: LiteralSpec[] = [
  { kind: "number", examples: ["42", "3.14"], implemented: true, since: "0.1.0" },
  { kind: "string", examples: ['"текст"'], implemented: true, since: "0.1.0" },
  { kind: "bool", examples: ["истина", "ложь"], implemented: true, since: "0.1.0" },
  { kind: "null", examples: ["пусто"], implemented: true, since: "0.1.0" },
  { kind: "array", examples: ["[]", "[1, 2, 3]"], implemented: true, since: "0.1.0" },
  { kind: "object", examples: ['{ a: 1, b: "текст" }'], implemented: true, since: "0.1.0" },
  // Режимы открытия файла — литералы, и только в позиции второго аргумента `открыть`. Числа флагов
  // (`O_RDONLY` 0, `O_WRONLY|O_CREAT|O_TRUNC` 577, `O_WRONLY|O_APPEND` 1025) живут ОДНИМ местом:
  // `src/runtime/vm/fileCalls.ts#FILE_MODE_FLAGS` (взяты из общего `fcntl.h` порта e2k).
  { kind: "file_mode", examples: ["чтение", "запись", "дописать"], implemented: true, since: "2.7.0" },
];

const FORBIDDEN_V01: ForbiddenPatternSpec[] = [
  { id: "let_outside_procedure", description: "пусть разрешён только внутри процедуры", bad: "модуль m\nпусть x = 1" },
  { id: "assign_in_if", description: "в условии сравнение через ==, не через =", bad: "если x = 0", good: "если x == 0" },
  {
    id: "then_keyword_optional",
    description: "ключевое слово тогда опционально в если/иначе_если/пока",
    bad: "если x > 0 тогда тогда",
    good: "если x > 0 тогда",
  },
  { id: "walrus_assign", description: "оператор := не поддерживается", bad: "пусть x := 1", good: "пусть x = 1" },
  { id: "missing_converters", description: "конверторы строка()/число()/целое32() не поддерживаются", bad: "целое32(x)" },
  {
    id: "prefer_obiedinit_for_clarity",
    description: "канон склейки строк — система.строка.объединить; + тоже склеивает, если есть строка",
    bad: 'система.строка.сложить("а", "б")',
    good: 'система.строка.объединить("а", "б")  // или "а" + "б"',
  },
  {
    id: "no_string_to_num_converter",
    description: "нет система.число.из_строки — конвертация строки в число не поддерживается в v1",
    bad: "система.число.из_строки(s)",
  },
  { id: "env_api_missing", description: "система.окружение.* не поддерживается", bad: "система.окружение.получить(\"X\")" },
  {
    id: "foreach_js_syntax",
    description: "Не использовать JavaScript forEach/for...of",
    bad: "arr.forEach(el => { })",
    good: "для элемент в arr\n  ...\nконец",
  },
  {
    id: "js_try_catch",
    description: "Не использовать JavaScript try/catch",
    bad: "try { } catch(e) { }",
    good: "попробовать\n  ...\nпоймать ошибка\n  ...\nконец",
  },
  {
    id: "array_index_syscall_direct",
    description: "Не использовать система.массив.получить когда можно arr[i]",
    bad: "система.массив.получить(arr, 0)",
    good: "arr[0]",
  },
  // `wrong_log_api` («система.вывести не существует») УДАЛЁН 2026-09-25: запись
  // противоречила реестру синонимов. `SYSCALL_ALIASES` принимает
  // `система.вывести` → `система.лог.вывести`, парсер сводит имя к канону, и в
  // байткод уходит каноническое `система.лог.вывести` — то есть вызов
  // КОМПИЛИРУЕТСЯ (проверено пробой: 0 ошибок парсера, 0 семантических). Промпт
  // же рендерил «✗ система.вывести не существует / НЕЛЬЗЯ: система.вывести(x)» и
  // учил модель тому, что компилятор тут же собирает.
  //
  // Сторону выбрал замер, а не вкус: канон (`docs/language-v2.md`, таблица
  // синонимов) перечисляет `система.вывести` среди ПРИНЯТЫХ записей, а сам
  // синоним добавлен по следам (§1.5 требований, `unknown_syscall` 41 → 16).
  // Убрать синоним значило бы вернуть отказы на программах, которые сегодня
  // компилируются, — то есть отменить измеренный выигрыш ради записи в списке
  // запретов. Оракул: `src/compiler/registryConsistency.test.ts`.
  { id: "return_with_parens", description: "вернуть x и вернуть(x) оба допустимы", bad: "return(сумма)", good: "вернуть сумма" },
  { id: "composite_end", description: "закрывающее слово обязано называть свой блок: конец_пока закрывает пока, а не если", bad: "пока x\n  конец_если", good: "пока x\n  конец_пока" },
  {
    id: "throw_undefined_var",
    description: "выбросить переменную которой нет в текущей процедуре",
    bad: "процедура а(х)\n  выбросить сообщение  // сообщение не параметр а!\nконец",
    good: "процедура а(х)\n  выбросить х  // только то что объявлено в процедуре\nконец",
  },
  {
    id: "english_keywords",
    description: "канон — русские слова; let/if/true/&& принимаются как пусть/если/истина/и",
    bad: "func main() {}",
    good: "процедура главная()\n  вернуть 0\nконец",
  },
  { id: "redeclare_with_let", description: "повторное объявление через пусть не допускается", bad: "пусть x = 1\nпусть x = 2", good: "пусть x = 1\nx = 2" },
  { id: "assign_before_let", description: "первая инициализация переменной должна быть через пусть", bad: "x = 1", good: "пусть x = 1" },
  { id: "keyword_as_identifier", description: "ключевые слова нельзя использовать как имена", bad: "пусть если = 1" },
  {
    id: "keyword_as_loop_counter_i",
    description:
      "«и» — логический оператор языка, нельзя использовать как имя переменной или счётчика цикла",
    bad: "пусть и = 0\nпока и < 10\n  и = и + 1\nконец",
    good: "пусть индекс = 0\nпока индекс < 10\n  индекс = индекс + 1\nконец",
  },
  {
    id: "forbidden_param_names",
    description: "ключевые слова нельзя использовать как имена параметров (особенно: в, конец, если, пока, пусть, вернуть, истина, ложь, и, или, не)",
    bad: "процедура f(если, пока, в, конец, пусть, вернуть)",
    good: "процедура f(нач, пред, элемент, до, значение, результат)",
  },
  { id: "higher_order_procedures", description: "передача процедур как аргументов не поддерживается", bad: "фильтровать(список, предикат)" },
  {
    id: "module_call_unexported",
    description: "вызов не-экспортированной процедуры другого модуля",
    bad: "Утилиты.внутренняя()",
    good: "Утилиты.удвоить(21)",
  },
  {
    id: "module_import_not_first",
    description: "использовать после объявления процедуры запрещено",
    bad: "процедура главная() ... конец\nиспользовать модуль X из \"x.osnova\"",
  },
];

/**
 * Английские/C-подобные написания → канонический токен Основы.
 * Канон генерации — русские слова; алиасы, чтобы нейросеть не упиралась в лексер.
 *
 * @remarks
 * Здесь же живут «почти канонические» русские написания, которые модель пишет
 * систематически: `иначе_попытка` — старое написание канонического `поймать`.
 * Без алиаса старое слово становится идентификатором, и разбор `попробовать`
 * ломается на опечатке.
 */
export const LLM_KEYWORD_ALIASES: Readonly<Record<string, string>> = {
  module: "модуль",
  function: "процедура",
  fn: "процедура",
  type: "тип",
  let: "пусть",
  const: "пусть",
  var: "пусть",
  if: "если",
  else: "иначе",
  elif: "иначе_если",
  "else if": "иначе_если",
  elseif: "иначе_если",
  then: "тогда",
  return: "вернуть",
  while: "пока",
  для_каждого: "для",
  for: "для",
  in: "в",
  break: "прервать",
  continue: "продолжить",
  true: "истина",
  false: "ложь",
  null: "пусто",
  and: "и",
  or: "или",
  not: "не",
  end: "конец",
  export: "экспорт",
  when: "когда",
  is: "есть",
  /** `попробовать` … `поймать ошибка` — канон; старое `иначе_попытка` — алиас. */
  иначе_попытка: "поймать",
  catch: "поймать",
  /** БЛОК 2: русское написание целочисленного деления ведёт к канону `div`. */
  цел_деление: "div",
};

/** Реестр языка Основа v0.1 (текущая реализованная версия). */
export const LANGUAGE_V01: LanguageRegistry = {
  version: LANGUAGE_VERSION,
  keywords: KEYWORDS_V01,
  constructs: CONSTRUCTS_V01,
  operators: OPERATORS_V01,
  syscalls: SYSCALLS_V01,
  literals: LITERALS_V01,
  forbiddenPatterns: FORBIDDEN_V01,
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
