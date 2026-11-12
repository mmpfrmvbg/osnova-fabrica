<!-- doc-status: stable; source: src/runtime/goldenApps.ts -->
## JSON‑схема для golden‑кейсов Основа v0.1

Эталонное машинное представление golden‑тестов, чтобы **фабрика** и **тулчейн** читали один и тот же `.json` / `.yaml` и не парсили markdown.

Формат: один файл‑сьют:

```json
{
  "version": "0.1.0",
  "tests": [ /* массив TestCase */ ]
}
```

Ниже — JSON Schema (draft‑07) и краткие пояснения.

---

### 1. JSON Schema (draft‑07)

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "Osnova Golden Tests v0.1",
  "type": "object",
  "required": ["version", "tests"],
  "properties": {
    "version": {
      "type": "string",
      "description": "Версия формата golden-тестов, например '0.1.0'"
    },
    "tests": {
      "type": "array",
      "items": { "$ref": "#/definitions/TestCase" }
    }
  },
  "definitions": {
    "TestCase": {
      "type": "object",
      "required": ["id", "name", "kind", "source"],
      "properties": {
        "id": {
          "type": "string",
          "description": "Уникальный идентификатор теста, например 'test1', 'micro_strings'"
        },
        "name": {
          "type": "string",
          "description": "Человекочитаемое имя теста"
        },
        "kind": {
          "type": "string",
          "enum": ["positive", "negative"],
          "description": "Позитивный тест (ожидается успешный проход) или негативный (ожидается ошибка)"
        },
        "tags": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Произвольные теги: 'lexer', 'parser', 'vliw', 'result', 'strings' и т.п."
        },
        "source": {
          "type": "string",
          "description": "Исходный код на Основа целиком (один модуль)"
        },
        "expectLexer": {
          "type": "object",
          "description": "Ожидания от лексера",
          "properties": {
            "tokens": {
              "type": "array",
              "description": "Последовательность ожидаемых токенов; минимум — их kind, опционально lexeme/value",
              "items": {
                "type": "object",
                "required": ["kind"],
                "properties": {
                  "kind": {
                    "type": "string",
                    "description": "Имя TokenKind, например 'KwМодуль', 'Identifier', 'IntLiteral', 'StringLiteral'"
                  },
                  "lexeme": {
                    "type": "string",
                    "description": "Сырой текст токена (опционально)"
                  },
                  "value": {
                    "type": ["string", "number", "boolean", "null"],
                    "description": "Декодированное значение (важно для StringLiteral/BoolLiteral)"
                  }
                },
                "additionalProperties": false
              }
            },
            "shouldError": {
              "type": "boolean",
              "description": "Ожидается ли ошибка лексера",
              "default": false
            }
          },
          "additionalProperties": false
        },
        "expectParser": {
          "type": "object",
          "description": "Ожидания от парсера",
          "properties": {
            "shouldError": {
              "type": "boolean",
              "description": "Ожидается ли ошибка парсера (например, вызов без 'вызвать')",
              "default": false
            },
            "rootKind": {
              "type": "string",
              "description": "Ожидаемый kind корневого AST-узла, обычно 'Module'"
            },
            "nodes": {
              "type": "array",
              "description": "Набор ключевых узлов AST, которые должны присутствовать (паттерны, а не полный AST)",
              "items": {
                "type": "object",
                "required": ["kind"],
                "properties": {
                  "kind": {
                    "type": "string",
                    "description": "Например 'FunctionDecl', 'ProcedureDecl', 'LetStmt', 'MatchStmt', 'ActorDecl'"
                  },
                  "name": {
                    "type": "string",
                    "description": "Имя сущности, если применимо (модуль, функция, тип, актор и т.д.)"
                  },
                  "path": {
                    "type": "array",
                    "items": { "type": ["string", "integer"] },
                    "description": "Опциональный путь внутри AST (например ['declarations', 0, 'body', 'statements', 1])"
                  },
                  "props": {
                    "type": "object",
                    "description": "Мини-набор ожидаемых полей узла (например returnType.name, optional, typeArgs)",
                    "additionalProperties": true
                  }
                },
                "additionalProperties": false
              }
            }
          },
          "additionalProperties": false
        },
        "expectCompiler": {
          "type": "object",
          "description": "Ожидания от компиляции/байткода",
          "properties": {
            "shouldError": {
              "type": "boolean",
              "description": "Ожидается ли ошибка на стадии компиляции (типчек/бэкенд)",
              "default": false
            },
            "functions": {
              "type": "array",
              "description": "Паттерны для отдельных функций/процедур в байткоде",
              "items": {
                "type": "object",
                "required": ["name"],
                "properties": {
                  "name": {
                    "type": "string",
                    "description": "Имя функции/процедуры в исходнике"
                  },
                  "expectsInstructions": {
                    "type": "array",
                    "description": "Подмножество / последовательность инструкций, которые должны встретиться",
                    "items": {
                      "type": "object",
                      "required": ["opcode"],
                      "properties": {
                        "opcode": {
                          "type": "string",
                          "description": "Имя инструкции, например 'const i32', 'local.set', 'add', 'call', 'invoke', 'const.null'"
                        },
                        "contains": {
                          "type": "string",
                          "description": "Опциональная подстрока/паттерн в текстовом представлении инструкции (например имя внешнего вызова для 'invoke')"
                        },
                        "order": {
                          "type": "string",
                          "enum": ["any", "sequence"],
                          "description": "'sequence' — порядок важен, 'any' — достаточно вхождения где-либо",
                          "default": "any"
                        }
                      },
                      "additionalProperties": false
                    }
                  }
                },
                "additionalProperties": false
              }
            }
          },
          "additionalProperties": false
        }
      },
      "additionalProperties": false
    }
  }
}
```

---

### 2. Пример: негативный тест «вызов без `вызвать`»

```json
{
  "id": "test10_call_without_vyzvat",
  "name": "Вызов без 'вызвать' — ошибка парсера",
  "kind": "negative",
  "tags": ["parser", "call", "error"],
  "source": "модуль тест10;\\n\\nпроцедура ошибочно() {\\n    печать(1);\\n}\\n",
  "expectLexer": {
    "tokens": [
      { "kind": "KwМодуль" },
      { "kind": "Identifier", "lexeme": "тест10" },
      { "kind": "Semicolon" },
      { "kind": "KwПроцедура" },
      { "kind": "Identifier", "lexeme": "ошибочно" },
      { "kind": "LParen" },
      { "kind": "RParen" },
      { "kind": "LBrace" },
      { "kind": "Identifier", "lexeme": "печать" },
      { "kind": "LParen" },
      { "kind": "IntLiteral", "value": 1 },
      { "kind": "RParen" },
      { "kind": "Semicolon" },
      { "kind": "RBrace" },
      { "kind": "EndOfFile" }
    ],
    "shouldError": false
  },
  "expectParser": {
    "shouldError": true
  }
}
```

---

### 3. Пример: микротест Result / Option / Успех / Неудача

```json
{
  "id": "micro_result",
  "name": "Result / ?Тип, пусто, Успех/Неудача без match",
  "kind": "positive",
  "tags": ["compiler", "result", "option"],
  "source": "модуль микро_результат;\\n\\nтип Ошибка { текст: Строка; }\\n\\nфункция может_пусто(): ?Строка {\\n    вернуть пусто;\\n}\\n\\nфункция вернуть_успех(значение: Строка): Результат<Строка, Ошибка> {\\n    вернуть Успех(значение);\\n}\\n\\nфункция вернуть_неудачу(путь: Строка): Результат<Строка, Ошибка> {\\n    вернуть Неудача(Ошибка{ текст: \\\"нет файла\\\" });\\n}\\n",
  "expectParser": {
    "shouldError": false,
    "rootKind": "Module",
    "nodes": [
      { "kind": "FunctionDecl", "name": "может_пусто" },
      { "kind": "FunctionDecl", "name": "вернуть_успех" },
      { "kind": "FunctionDecl", "name": "вернуть_неудачу" }
    ]
  },
  "expectCompiler": {
    "shouldError": false,
    "functions": [
      {
        "name": "может_пусто",
        "expectsInstructions": [
          { "opcode": "const.null", "order": "sequence" },
          { "opcode": "ret", "order": "sequence" }
        ]
      },
      {
        "name": "вернуть_успех",
        "expectsInstructions": [
          { "opcode": "local.get", "order": "sequence" },
          { "opcode": "result.tag", "contains": "Успех", "order": "any" },
          { "opcode": "ret", "order": "sequence" }
        ]
      },
      {
        "name": "вернуть_неудачу",
        "expectsInstructions": [
          { "opcode": "const.str", "contains": "нет файла" },
          { "opcode": "result.tag", "contains": "Неудача" },
          { "opcode": "ret" }
        ]
      }
    ]
  }
}
```

---

### 4. Использование в фабрике и тулчейне

- **Фабрика**: читает один JSON/ YAML‑файл по этой схеме, для каждого `TestCase` прогоняет лексер/парсер/компилятор и сверяет результаты с `expectLexer` / `expectParser` / `expectCompiler`.\n- **Тулчейн**: использует тот же файл как набор unit/integration‑тестов в CI, без привязки к markdown‑докам.\n+
