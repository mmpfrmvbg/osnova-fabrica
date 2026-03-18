## Формат трейсинга Основа / Фабрика v0.1

**superseded-by: docs/traces-v1.md** — этот документ устарел. Реальный формат определяется `src/trace/types.ts` и `src/pipeline/types.ts`. См. traces-v1.md.

Цель: зафиксировать **единый JSONL‑формат трейсов**, чтобы через несколько месяцев был готовый датасет для дообучения AI‑ядра и проверки тулчейна.

Один **запись‑трейс** ≈ один прогон пайплайна (обычно «одна спека → один модуль/пакет Основа»).

---

## 1. Общая структура записи

Каждая строка в `traces.jsonl` — валидный JSON‑объект:

```json
{
  "trace_id": "uuid-...",
  "timestamp": "2026-03-13T12:34:56.789Z",

  "meta": { ... },
  "input": { ... },
  "ir": { ... },
  "osnova": { ... },
  "lexer": { ... },
  "tokenization": { ... },
  "ast": { ... },
  "types": { ... },
  "compiler": { ... },
  "golden": { ... },
  "feedback": { ... },
  "env": { ... }
}
```

Необязательные секции можно опускать; важно, чтобы названия полей были стабильны.

---

## 2. Метаданные запуска (`meta`)

```json
"meta": {
  "osnova_version": "0.1.0",
  "fabrica_version": "0.3.2",
  "model_version": "llama-fabrica-1",

  "session_id": "sess-abc123",
  "user_id": "u-anon-42"   // уже анонимизировано/хешировано
}
```

- **`osnova_version`**: версия языка (важно при смене грамматики).
- **`fabrica_version`**: версия фабрики/сервера.
- **`model_version`**: какая модель генерировала код.
- `session_id`, `user_id` — опциональны, но полезны для анализа поведения.

---

## 3. Вход в фабрику (`input`)

```json
"input": {
  "kind": "spec_yaml",        // spec_yaml | natural_language | gui_config | other
  "payload": {
    // нормализованное содержимое спеки (без секретов, ключи можно замаскировать)
  },
  "app_context": {
    "category": "crm",        // crm | todo | game | utility | ...
    "name_hint": "CRM: Базовая"
  }
}
```

- **`kind`**: тип входа.
- **`payload`**: нормализованный JSON/YAML спеки или конфиг GUI (без личных данных).
- **`app_context`**: грубая категория приложения + необязательное имя.

---

## 4. Промежуточное представление (`ir`)

Если у фабрики есть собственный IR (сущности, экраны, действия), стоит его записывать:

```json
"ir": {
  "entities": [
    { "name": "Клиент", "fields": [ { "name": "имя", "type": "Строка" } ] }
  ],
  "screens": [
    { "name": "Список клиентов", "type": "list", "entity": "Клиент" }
  ],
  "flows": [
    { "name": "Создать клиента", "steps": ["форма", "сохранить"] }
  ]
}
```

Структура IR свободная; важно, чтобы она была **стабильна во времени**.

---

## 5. Исходники Основа (`osnova`)

```json
"osnova": {
  "files": [
    {
      "path": "модуль1.osnova",
      "source": "модуль модуль1;\\n\\nпроцедура старт() { ... }\\n",
      "formatted_source": "модуль модуль1;\\n\\nпроцедура старт() {\\n    ...\\n}\\n"
    }
  ]
}
```

Если модуль один — можно писать просто:

```json
"osnova": {
  "source": "модуль тест;\\n...\\n"
}
```

Полный текст **до и после форматтера** полезен для обучения стиля.

---

## 6. Лексер Основа (`lexer`)

Результат официального лексера (`lexer-v0.1.md`):

```json
"lexer": {
  "tokens": [
    {
      "kind": "KwМодуль",
      "lexeme": "модуль",
      "value": null,
      "position": { "line": 1, "column": 1, "offset": 0 }
    },
    {
      "kind": "Identifier",
      "lexeme": "тест1",
      "value": "тест1",
      "position": { "line": 1, "column": 8, "offset": 7 }
    }
    // ...
  ],
  "errors": [
    // пусто, если ошибок нет
  ]
}
```

- **`kind`**: `TokenKind` из лексера (`KwМодуль`, `KwФункция`, `IntLiteral`, `StringLiteral` и т.д.).
- **`lexeme`**: сырой текст, как в исходнике.
- **`value`**: нормализованное значение (число, строка, bool, `null` для `пусто`).
- **`position`**: позиция в исходнике.

---

## 7. Модельная токенизация (`tokenization`)

Токены по `tokenization-v0.1.md` (BPE/специальные токены):

```json
"tokenization": {
  "input_tokens": [
    { "token": "<BOS>" },
    { "token": "KW_МОДУЛЬ" },
    { "token": "_", "category": "WHITESPACE" },
    { "token": "тест1", "category": "ALPHA_CYR" },
    { "token": ";", "category": "PUNCT" },
    { "token": "_NL" }
    // ...
  ],
  "output_tokens": [
    // если модель порождает токены напрямую; иначе можно оставить пустым
  ],
  "mapping": {
    // опционально: сопоставление индекс токена -> диапазон в osnova.source
  }
}
```

- **`input_tokens`**: что модель реально видела.
- **`output_tokens`**: что модель сгенерировала (до склейки в строку).
- **`mapping`**: удобно для аудита/обучения, но не обязательно.

---

## 8. AST и типы (`ast`, `types`)

### 8.1. AST

```json
"ast": {
  "root": {
    "kind": "Module",
    "name": "тест3",
    "declarations": [
      {
        "kind": "ProcedureDecl",
        "name": "старт",
        "params": [],
        "body": {
          "kind": "Block",
          "statements": [
            { "kind": "LetStmt", "name": "счётчик" },
            { "kind": "AssignStmt" },
            { "kind": "CallStmt" }
          ]
        }
      }
    ]
  }
}
```

Можно хранить **упрощённый AST** (без позиций, без лишних полей) — важно, чтобы `kind`/`name` совпадали со спецификацией парсера.

### 8.2. Типы

```json
"types": {
  "nodes": [
    {
      "path": ["root", "declarations", 0, "body", "statements", 0],
      "kind": "LetStmt",
      "inferred_type": "Целое32"
    },
    {
      "path": ["root", "declarations", 0],
      "kind": "ProcedureDecl",
      "name": "старт",
      "signature": {
        "params": [],
        "return": "Ничто"
      }
    }
  ]
}
```

`path` — любой стабильный способ адресации узлов (массив ключей/индексов).

---

## 9. Компиляция и байткод (`compiler`)

```json
"compiler": {
  "success": true,
  "errors": [],
  "bytecode": {
    "summary": [
      {
        "function": "старт",
        "instruction_count": 12,
        "opcodes_histogram": {
          "const i32": 2,
          "local.set": 2,
          "local.get": 1,
          "add": 1,
          "call": 1,
          "ret": 1
        }
      }
    ],
    "functions": [
      {
        "name": "старт",
        "instructions": [
          "const i32 0",
          "local.set 0",
          "local.get 0",
          "const i32 1",
          "add",
          "local.set 0",
          "local.get 0",
          "call fi",
          "ret"
        ]
      }
    ]
  }
}
```

- Для крупных модулей можно:
  - хранить только `summary` (гистограммы, счётчики),
  - а `functions[].instructions` — только для небольших/эталонных кейсов (например, когда связан `golden.id`).

---

## 10. Связь с golden‑тестами (`golden`)

Если трейс получен при прогоне golden‑теста (`docs/osnova/golden-tests.json`):

```json
"golden": {
  "id": "test3_proc_let_assign_call",
  "expected_version": "0.1.0",
  "results": {
    "lexer_ok": true,
    "parser_ok": true,
    "compiler_ok": true
  }
}
```

Это позволит обучать модель **на успешных и неуспешных** совпадениях с эталоном.

---

## 11. Фидбек пользователя (`feedback`)

Самое ценное для дообучения:

```json
"feedback": {
  "rating": 4,                 // 1..5 или -1/0/1
  "comment": "Нужно меньше бойлерплейта в акторах",
  "user_edits": {
    "has_edits": true,
    "diff": [
      {
        "file": "модуль1.osнова",
        "hunk": "@@ -3,7 +3,7 @@",
        "before": "процедура старт() { ... }",
        "after":  "процедура старт(конфиг: Конфиг) { ... }"
      }
    ]
  },
  "actions": [
    "accepted_with_edits"      // accepted | accepted_with_edits | discarded | regenerated
  ]
}
```

Если дифф дорогой, можно хранить только флаг `has_edits` или агрегированную статистику (кол-во строк изменено/добавлено).

---

## 12. Среда выполнения (`env`)

```json
"env": {
  "os": "win32",
  "arch": "x64",
  "runtime": {
    "node": "22.0.0",
    "fabrica_cli": "0.3.2"
  },
  "limits": {
    "max_tokens": 4096,
    "max_time_ms": 20000
  }
}
```

Это помогает понимать, как лимиты/среда влияют на качество.

---

## 13. Минимальный обязательный поднабор

Если нужно выбрать **минимум, который точно писать** с первого дня:

- `trace_id`, `timestamp`.
- `meta.osnova_version`, `meta.fabrica_version`, `meta.model_version`.
- `input.kind`, `input.payload` (нормализованный, без секретов).
- `osnova.source` (или `osnova.files[]`).
- `lexer.tokens` (kind + lexeme + value).
- `tokenization.input_tokens` (по `tokenization-v0.1.md`).
- `ast.root` (упрощённый).
- `compiler.success`, `compiler.errors`, `compiler.bytecode.summary`.
- Если прогоняется golden‑тест: `golden.id`, `golden.results`.
- По возможности: `feedback.rating`, `feedback.actions`, базовая информация о правках.

С таким трейсом через несколько месяцев будет готов **полноценный датасет** для:

- дообучения модели генерации Основа‑кода по спекам;
- дообучения токенизации/лексера;
- обучения моделей, понимающих AST/типы и байткод языка Основа.

