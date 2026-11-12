---
name: debug-osnova-errors
description: >-
  Diagnoses and fixes Osnova compiler/parser errors with minimal edits. Use when
  compile fails, repair loop is exhausted, or `npx tsx src/cli.ts compile` rejects .osnova.
---

# debug-osnova-errors

Минимальный точечный фикс по тексту ошибки. Канон синтаксиса: [osnova-lang](../osnova-lang/SKILL.md) и `src/compiler/language-registry.ts` (не `language-v1.md`).

## Правило

Исправляй только сломанное. Не переписывай модуль целиком. Не добавляй конструкций вне registry/кода.

## Частые диагнозы

| Ошибка | Причина | Фикс |
|--------|---------|------|
| `Ожидается 'модуль'` | Нет шапки | `модуль Имя` в начале блока |
| `Ожидается ')'` / странный return | Форма `вернуть(...)` / скобки | `вернуть значение` |
| `Неизвестная инструкция: конец_*` | Составной закрыватель | `конец` |
| `Неизвестный идентификатор: система.вывести` | Устаревший API | `система.лог.вывести` |
| `Ожидается выражение, получено: процедура` | Незакрытый блок | Найди дыру в `если`/`пока`/`процедура` |
| `Переменная уже объявлена` / redeclare | Повторный `пусть` | Присвоение без `пусть` |
| `Ожидается идентификатор` | KW как имя | Переименуй (`и` → `индекс`) |
| `unknown_syscall` / argc | Нет в registry или неверный argc | Сверь registry; host → `extraSyscalls` |
| `invented_syntax` | Выдумка вне канона | Переписать по osnova-lang / живым пакетам |
| Unknown invoke в VM | Host-вызов без `extraInvokes` | Хост Dviglo, не «починить» пакет сетью |

Стек/массивы: `система.массив.добавить` возвращает `null` — см. osnova-lang `reference.md`.

## Алгоритм

1. Текст ошибки + номер строки
2. Строка в файле
3. Таблица / registry / osnova-lang
4. Минимальный фикс
5. `npx tsx src/cli.ts compile <файл>.osnova`
6. Повтор до чистой компиляции

## Anti-patterns

- ❌ Переписать весь модуль из-за одной ошибки
- ❌ Менять логику при чисто синтаксической ошибке
- ❌ Опираться на `docs/language-v1.md` против кода
- ❌ Считать задачу закрытой без успешного compile

## Definition of done

`npx tsx src/cli.ts compile <файл>.osnova` без ошибок (или эквивалентный check пакета Dviglo).
