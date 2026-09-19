<!-- doc-status: stable; source: src/compiler/language-schema.ts -->
# Language Contributing v2.0

Документ описывает обязательный процесс изменения языка Основа v2.0.

## 1. Принципы канона

Источник истины о языке Основа v2.0 — связка:

- код компилятора/VM: `src/compiler/**` (и связанные runtime-реестры),
- machine-readable schema: `docs/osnova/language-schema.json`,
- человекочитаемый канон: `docs/language-v2.md`.

`docs/legacy/**` — архивные документы. Они не являются источником истины и не должны использоваться как входная точка для изменения языка или генерации нового кода.

Любое изменение языка обязано пройти через все слои канона: компилятор/VM, schema, `language-v2`, тесты и changelog.

## 2. Что считается изменением языка

Language change — это добавление, изменение или удаление:

- синтаксических конструкций (`statement`, `expression`),
- операторов,
- типов,
- syscalls,
- семантики VM/bytecode (изменение наблюдаемого поведения исполнения, опкодов, правил обработки).

Даже небольшой багфикс считается изменением языка, если он меняет наблюдаемое поведение пользовательского кода.

## 3. Обязательный pipeline изменения (atomic)

Для любого language change выполняйте шаги ниже последовательно.

### 1) Design и статус

- Сформулируйте, что меняется и зачем.
- Определите статус фичи: `planned -> experimental -> stable` или `deprecated`.
- Добавьте черновую запись в `docs/language-changelog-v2.md` в секцию `Unreleased` (`Added` / `Changed` / `Deprecated` / `Fixed`).

### 2) Изменения в компиляторе/VM

Обновите по необходимости:

- lexer (токены/ключевые слова),
- parser (AST и правила парсинга),
- semantic/type phase,
- codegen/VM (opcodes и поведение),
- syscall-реестры (`invokeRegistry` и связанные маппинги).

Для deprecated-фич обязательно задайте поведение: warning, ошибка, миграционная подсказка.

### 3) Обновление language-schema (через код)

В `src/compiler/language-schema.ts`:

- добавьте/обновите конструкции, операторы, типы, syscalls,
- выставьте корректный статус (`stable` / `experimental` / `deprecated` / `planned`),
- проверьте маппинг на реальные AST-тип/opcode/syscall-id.

Обязательные команды:

- `npm run generate:language-schema`
- `npm run check:language-schema`

MR не проходит, если `check:language-schema` не зеленый.

### 4) Обновление `docs/language-v2.md`

- Обновите человекочитаемое описание изменения.
- Укажите явный статус фичи.
- Добавьте короткий пример для `stable`/`experimental`.
- Для `deprecated` укажите замену (если есть) и отметку о нерекомендуемом использовании.

### 5) Golden-тесты и примеры

- Добавьте/обновите golden-тесты:
  - позитивные сценарии,
  - негативные сценарии,
  - для deprecated — сценарии warning/error.
- Убедитесь, что тесты проверяют реальное поведение, а не только отсутствие падения.

### 6) Обновление changelog

- Добавьте запись в `Unreleased` (`Added` / `Changed` / `Deprecated` / `Fixed`) в `docs/language-changelog-v2.md`.
- При релизе языка переносите записи в версионный блок.
- Если принято версионировать канон синхронно, обновляйте `languageVersion`/`schemaVersion`.

## 4. Definition of Done перед merge

MR с изменением языка готов к merge только если:

- есть диффы в релевантных частях компилятора/VM,
- есть изменения в `src/compiler/language-schema.ts` и регенерирован `docs/osnova/language-schema.json`,
- `docs/language-v2.md` обновлен по смыслу и статусу фичи,
- golden-тесты добавлены/обновлены,
- в `docs/language-changelog-v2.md` есть запись в `Unreleased`.

Перед merge должны проходить:

- `npm run generate:language-schema`
- `npm run check:language-schema`
- `npm test`
- `npm run ci` (если используется в текущем PR)

## 5. Анти-паттерны

- **Только parser:** "сначала парсер, schema и доки потом".  
  Приводит к рассинхрону канона и ломает LLM/инструменты.
- **Новая фича без schema/language-v2:**  
  Фича есть в коде, но отсутствует в официальном описании и в machine-readable источнике.
- **Правки только в docs:**  
  Документация обещает поведение, которого нет в компиляторе/VM.
- **Смена VM-поведения без тестов/changelog:**  
  Тихие регрессии без трассируемой истории изменений.

## 6. Шаблон PR-чеклиста

Для PR с language change этот чеклист обязателен в описании PR:

```text
Language change checklist (v2.0):

[ ] Design и статус фичи зафиксированы (planned / experimental / stable / deprecated)
[ ] Обновлён компилятор/VM (src/compiler/**, runtime registry)
[ ] Обновлён src/compiler/language-schema.ts
[ ] Перегенерирована схема: docs/osnova/language-schema.json
[ ] npm run check:language-schema проходит
[ ] Обновлён docs/language-v2.md (описание + статус + пример)
[ ] Добавлены/обновлены golden-тесты
[ ] Добавлена запись в docs/language-changelog-v2.md (Unreleased)
```

## 7. Связка с `.cursorrules`

- Задачи на изменение языка через Cursor/LLM должны ссылаться на этот документ.
- Приоритет источников при language change:
  - `src/compiler/**`,
  - `docs/osnova/language-schema.json`,
  - `docs/language-v2.md`.
- `docs/legacy/**` нельзя использовать как источник истины.

Любая LLM-задача на изменение языка должна соблюдать pipeline из этого документа.
