## Summary

- 

## Трасса (обязательно, до кода)

> Без этого раздела PR **не принимается** — проверка `src/scripts/traceGate.ts`, оракул
> `src/scripts/traceGate.audit.test.ts`. Случаи 98 и 103 реестра проверяемости, круги 10–22.

- [ ] `diff` эталон vs факт: [цитата]
- [ ] Класс: (A) запись / (B) продвижение / (C) пропуск / (D) не применимо (docs/infra)

## Validation

- [ ] `npm test`
- [ ] `npm run check:language-schema` (if language/schema/docs touched)

## Language change (Osnova v2.0)

If this PR changes the language (syntax, types, operators, syscalls, VM behavior):

- Read `docs/language-contributing-v2.md`.
- Fill the checklist below and keep it in the PR description.
- Add/update entries in `docs/language-changelog-v2.md`.

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
