/**
 * Реестр языка Основа — единый источник правды о ключевых словах и конструкциях.
 * Используется для: генератора (LLM, подсказки), компилятора (валидация), документации, golden-тестов.
 * Версия языка согласована с meta.osnova_version в trace-format и minOsnovaVersion в реестре приложений.
 */

export const LANGUAGE_VERSION = "1.6.0";

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
  | "module_export";

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
}

export interface SyscallSpec {
  name: string;
  argc: number;
  status: "stable" | "experimental" | "deprecated";
  description: string;
  since: string;
}

export interface LiteralSpec {
  kind: "number" | "string" | "bool" | "null" | "array" | "object";
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
  { lexeme: "из", kind: "stmt", implemented: true, since: "1.5.0", description: "служебное слово для синтаксиса импорта" },
  { lexeme: "пусть", kind: "stmt", implemented: true, since: "0.1.0" },
  { lexeme: "если", kind: "stmt", implemented: true, since: "0.1.0" },
  { lexeme: "иначе", kind: "stmt", implemented: true, since: "0.1.0", description: "ветка else после если" },
  { lexeme: "иначе_если", kind: "stmt", implemented: true, since: "0.1.0", description: "цепочка else-if между если и иначе" },
  { lexeme: "пока", kind: "stmt", implemented: true, since: "0.1.0" },
  { lexeme: "попробовать", kind: "stmt", implemented: true, since: "1.2.0", description: "начало блока обработки ошибок" },
  { lexeme: "иначе_попытка", kind: "stmt", implemented: true, since: "1.2.0", description: "блок catch для попробовать" },
  { lexeme: "выбросить", kind: "stmt", implemented: true, since: "1.2.0", description: "выброс исключения" },
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
  { lexeme: "тогда", kind: "stmt", implemented: true, since: "1.1.0", description: "опциональное слово после условия в если/иначе_если/пока" },
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
    syntax: "попробовать\n  <тело>\nиначе_попытка ошибка\n  <обработчик>\nконец",
    example: "попробовать\n  выбросить \"ошибка\"\nиначе_попытка е\n  вернуть 1\nконец",
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
    syntax: "для_каждого <элемент> в <массив> ... конец",
    example: "для_каждого эл в числа\n  сумма = сумма + эл\nконец",
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
    syntax: "для_каждого <элемент>, <индекс> в <массив> ... конец",
    example: "для_каждого эл, и в числа\n  система.лог.вывести(и)\nконец",
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
    syntax: "массив[индекс] = значение  // сахар: система.массив.установить(массив, индекс, значение)",
    example: "числа[1] = 99",
    astNode: {
      kind: "вызов",
      fields: [
        { name: "name", type: "string" },
        { name: "args", type: "Expr[]" },
      ],
    },
    since: "1.1.0",
    implemented: true,
    description: "Синтаксический сахар для записи элемента массива по индексу",
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
    description: "Импорт экспортированных процедур из другого файла",
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
];

const OPERATORS_V01: OperatorSpec[] = [
  { symbol: "=", kind: "assign", precedence: 1, associativity: "right", implemented: true, since: "0.1.0" },
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
  { name: "система.время.сейчас", argc: 0, status: "stable", description: "Текущее время в миллисекундах", since: "0.1.0" },
  { name: "система.время.спать", argc: 1, status: "experimental", description: "Приостановить выполнение на N мс", since: "0.1.0" },
  { name: "система.хранилище.записать", argc: 2, status: "stable", description: "Записать значение по ключу", since: "0.1.0" },
  { name: "система.хранилище.прочитать", argc: 1, status: "stable", description: "Прочитать значение по ключу", since: "0.1.0" },
  { name: "система.хранилище.удалить", argc: 1, status: "stable", description: "Удалить значение по ключу", since: "0.1.0" },
  { name: "система.хранилище.ключи", argc: 0, status: "stable", description: "Получить список ключей хранилища", since: "0.1.0" },
  { name: "система.сеть.запрос", argc: 4, status: "experimental", description: "Выполнить сетевой HTTP-запрос", since: "0.1.0" },
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
  { name: "система.объект.получить", argc: 2, status: "stable", description: "Получить поле объекта по ключу", since: "0.1.0" },
  { name: "система.строка.объединить", argc: 2, status: "stable", description: "Объединить две строки", since: "0.1.0" },
  { name: "система.строка.длина", argc: 1, status: "stable", description: "Получить длину строки", since: "0.1.0" },
  { name: "система.строка.содержит", argc: 2, status: "stable", description: "Проверить, содержит ли строка подстроку", since: "0.1.0" },
  { name: "система.строка.начинается_с", argc: 2, status: "stable", description: "Проверить префикс строки", since: "0.1.0" },
  { name: "система.строка.заканчивается_на", argc: 2, status: "stable", description: "Проверить суффикс строки", since: "0.1.0" },
  { name: "система.строка.подстрока", argc: 3, status: "stable", description: "Получить подстроку по диапазону", since: "0.1.0" },
  { name: "система.строка.в_верхний", argc: 1, status: "stable", description: "Преобразовать строку в верхний регистр", since: "0.1.0" },
  { name: "система.строка.в_нижний", argc: 1, status: "stable", description: "Преобразовать строку в нижний регистр", since: "0.1.0" },
  { name: "система.строка.обрезать", argc: 1, status: "stable", description: "Удалить пробелы по краям строки", since: "0.1.0" },
  { name: "система.строка.заменить", argc: 3, status: "stable", description: "Заменить подстроку в строке", since: "0.1.0" },
  { name: "система.строка.разделить", argc: 2, status: "stable", description: "Разделить строку по разделителю", since: "0.1.0" },
];

const LITERALS_V01: LiteralSpec[] = [
  { kind: "number", examples: ["42", "3.14"], implemented: true, since: "0.1.0" },
  { kind: "string", examples: ['"текст"'], implemented: true, since: "0.1.0" },
  { kind: "bool", examples: ["истина", "ложь"], implemented: true, since: "0.1.0" },
  { kind: "null", examples: ["пусто"], implemented: true, since: "0.1.0" },
  { kind: "array", examples: ["[]", "[1, 2, 3]"], implemented: true, since: "0.1.0" },
  { kind: "object", examples: ['{ a: 1, b: "текст" }'], implemented: true, since: "0.1.0" },
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
    id: "no_num_to_string_converter",
    description: "нет система.строка.из_числа — для вывода числа используй система.строка.объединить",
    bad: "система.строка.из_числа(x)",
    good: 'система.строка.объединить("", x)',
  },
  {
    id: "no_num_string_arith_concat",
    description: "число не конкатенируется со строкой напрямую — используй объединить",
    bad: '"итого: " + 42',
    good: 'система.строка.объединить("итого: ", 42)',
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
    good: "для_каждого элемент в arr\n  ...\nконец",
  },
  {
    id: "js_try_catch",
    description: "Не использовать JavaScript try/catch",
    bad: "try { } catch(e) { }",
    good: "попробовать\n  ...\nиначе_попытка ошибка\n  ...\nконец",
  },
  {
    id: "array_index_syscall_direct",
    description: "Не использовать система.массив.получить когда можно arr[i]",
    bad: "система.массив.получить(arr, 0)",
    good: "arr[0]",
  },
  { id: "wrong_log_api", description: "система.вывести не существует", bad: "система.вывести(x)", good: "система.лог.вывести(x)" },
  { id: "return_with_parens", description: "скобки после вернуть не поддерживаются", bad: "вернуть(сумма)", good: "вернуть сумма" },
  { id: "composite_end", description: "составные конец_* не поддерживаются", bad: "конец_пока", good: "конец" },
  {
    id: "throw_undefined_var",
    description: "выбросить переменную которой нет в текущей процедуре",
    bad: "процедура а(х)\n  выбросить сообщение  // сообщение не параметр а!\nконец",
    good: "процедура а(х)\n  выбросить х  // только то что объявлено в процедуре\nконец",
  },
  { id: "english_keywords", description: "английские ключевые слова не поддерживаются", bad: "let x = 1" },
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
