---
name: add-golden-test
description: Добавляет golden-тест на новую конструкцию или сценарий языка Основа. Используй когда добавлена новая конструкция, исправлена ошибка которую нужно зафиксировать, или нужно расширить покрытие тестов. Источники — docs/golden-schema.md и docs/golden-tests.json.
---

# add-golden-test

## Что делает
Добавляет корректный golden-тест в реестр без нарушения существующих тестов.

## Authoritative sources
- `docs/golden-schema.md` — схема валидации, обязательные поля
- `docs/golden-tests.md` — описание всех сценариев
- `docs/golden-tests.json` — машиночитаемый реестр (сюда добавляем)

## Чеклист перед добавлением

- [ ] Проверь: такой сценарий уже не покрыт в `golden-tests.json`
- [ ] Тест написан по схеме из `golden-schema.md`
- [ ] Все обязательные поля заполнены (id, description, input, expected)
- [ ] Новый тест не ломает существующие (id уникален)
- [ ] Добавлена запись в `golden-tests.md` с описанием сценария

## Структура golden-теста

```json
{
  "id": "уникальный-id-kebab-case",
  "description": "Что проверяет тест (одна фраза)",
  "category": "lexer | parser | compiler",
  "input": "код на языке Основа",
  "expected": {
    "success": true | false,
    "errors": [] 
  }
}
```

## Категории тестов

- `lexer` — токенизация, ключевые слова, идентификаторы
- `parser` — структура AST, блоки, вложенность
- `compiler` — байткод, системные вызовы, типы

## Anti-patterns

- ❌ Добавлять тест без проверки уникальности id
- ❌ Использовать в тесте запрещённые конструкции как "правильные"
- ❌ Оставлять `expected.errors` пустым для негативных тестов
- ❌ Добавлять в `golden-tests.json` без записи в `golden-tests.md`

## Definition of done
Тест добавлен в `golden-tests.json`, описание в `golden-tests.md`,
id уникален, схема валидна по `golden-schema.md`.
