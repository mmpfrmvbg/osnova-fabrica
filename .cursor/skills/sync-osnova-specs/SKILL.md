---
name: sync-osnova-specs
description: >-
  Syncs Osnova language changes across registry-backed docs, prompts, and golden
  tests after a real compiler/VM patch. Use when adding or banning a construct,
  changing syntax, or adding a система.* syscall.
---

# sync-osnova-specs

Синхронизирует изменение языка после патча **кода**. Не обновлять docs «вперёд» кода.

## Источник истины

1. `src/compiler/language-registry.ts` + `src/compiler/**` + `src/runtime/vm/**`
2. `docs/language-v2.md` — только подтверждённое кодом
3. Канон агентов: `.cursor/skills/osnova-lang/`

`docs/language-v1.md` — не истина; не восстанавливать как канон при расхождении с кодом.

Host API (`игра.*`) в LANGUAGE_REGISTRY **не** добавлять — это extraSyscalls хоста (Dviglo).

## Когда активировать

- Новая/запрещённая конструкция или синтаксис
- Новый/изменённый `система.*`
- Правила модуль/процедура/импорт

## Чеклист

- [ ] 1. Код компилятора/VM уже содержит изменение
- [ ] 2. `language-registry.ts` обновлён (keywords/constructs/syscalls/forbidden)
- [ ] 3. Тесты compiler/semantic/vm зелёные
- [ ] 4. `docs/language-v2.md` отражает факт из кода (без фантазий)
- [ ] 5. При наличии в контуре: `docs/pipeline-llm-osnova.md`, golden-тесты, `LANGUAGE-CHANGELOG.md`
- [ ] 6. При нужде: кратко `osnova-lang` reference/idioms (не раздувать)
- [ ] 7. Коммит патча сразу (только файлы патча; см. fabrika-commit в Dviglo)

## Anti-patterns

- ❌ Править только docs без кода
- ❌ Объявлять конструкцию в v2 до реализации
- ❌ Класть `игра.*` в registry
- ❌ Считать v1 источником истины

## Definition of done

Код + registry + тесты согласованы; v2 не врёт; агентский скилл не противоречит registry.
