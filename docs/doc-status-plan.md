<!-- doc-status: frozen -->
# Статус документации — osnova-fabrica

> ⚠️ **FROZEN — устарело (последнее обновление 2026-03-19).** Этот план не отражает
> сентябрь 2026: `pipeline-v1.md`, `traces-v1.md` и прочие «canonical» здесь — это
> весенний контур, который заморожен. Актуальная карта — в `AGENTS.md`.

Дата обновления: 2026-03-19

---

## Канонические документы (источники истины)

| Документ              | Что описывает                                      | Синхронизирован с кодом?                              |
|-----------------------|----------------------------------------------------|-------------------------------------------------------|
| `language-v2.md`      | Человекочитаемый канон языка Основа v2.0.0        | **Да.** Следует `src/compiler/**` и `docs/osnova/language-schema.json`. |
| `osnova/language-schema.json` | Machine-readable канон языка Основа        | **Да.** Генерируется из кода компилятора. |
| `bytecode-v1.md`      | Формат байткода OsVbcModule и инструкции VM v1    | **Да.** Соответствует `src/runtime/vm/{bytecode,interpreter}.ts`. |
| `system-api-v1.md`    | Системное API `система.*` (stable/experimental)   | **Да.** Согласован с `src/runtime/vm/invokeRegistry.ts`, `vm-runner.ts`. |
| `pipeline-v1.md`      | LLM‑пайплайн `intake → spec → codegen → build → golden_check → repair` | **Да.** Реализован в `src/pipeline/orchestrator.ts`, `gateChecker.ts`, `thresholds.ts`. |
| `traces-v1.md`        | Формат трейсов `runs/traces.jsonl`                | **Да.** Соответствует `src/trace/types.ts`, `traceStore.ts`. |
| `golden-tests.md`     | Набор golden‑кейсов для лексера/парсера/байткода и golden‑приложений | **Да.** Используется как тестовый ориентир, но язык для генерации брать из v2-канона. |
| `llm-providers-v1.md` | Поддерживаемые LLM‑провайдеры и модели            | **Да.** Соответствует `src/llm/{index,defaults,*.ts}` и `.env`‑переменным. |
| `roadmap.md`          | Текущая дорожная карта (Фазы 1–4)                 | **Да.** Обновляется вместе с кодом. |

---

## Исторические/архивные документы

| Документ                     | Статус                       | Заменён на / актуальный аналог              |
|------------------------------|------------------------------|---------------------------------------------|
| `docs/legacy/grammatika-v0.1.md`        | `deprecated`                 | Канон языка: `language-v2.md` + `osnova/language-schema.json`. |
| `docs/legacy/trace-format-v0.1.md`      | `superseded-by: traces-v1.md`| Актуальный формат трейсов — `traces-v1.md` + `src/trace/types.ts`. |
| `docs/legacy/pipeline-llm-osnova.md`    | Исторический референтный дизайн‑документ | Актуальная реализация пайплайна — `src/pipeline/orchestrator.ts`; актуальная спека — `pipeline-v1.md`; трейс‑формат — `traces-v1.md`. |
| `docs/legacy/roadmap-osnova-ideal-os.md`| Vision‑документ              | Актуальная рабочая дорожная карта — `roadmap.md`. |
| `compiler-v0.1.md`                      | Исторический design-doc       | Для текущего языка использовать `language-v2.md` + `osnova/language-schema.json`. |
| `lexer-v0.1.md`                         | Историческая спецификация      | Для текущего языка использовать `language-v2.md` + `osnova/language-schema.json`. |
| `parser-v0.1.md`                        | Историческая спецификация      | Для текущего языка использовать `language-v2.md` + `osnova/language-schema.json`. |
| `tokenization-v0.1.md`                  | Историческая заметка           | Для текущего языка использовать `language-v2.md` + `osnova/language-schema.json`. |

Эти файлы полезны только как исторический контекст. Они не являются источником истины для генерации нового кода.

---

## Требуют доработки

- **Юнит‑тесты лексера и парсера:**
  - Добавить `src/compiler/lexer.test.ts` с прямыми тестами `tokenize()` на базовые конструкции MVP‑языка (модуль/процедура, литералы, операторы, ошибка лексера).
  - Добавить `src/compiler/parser.test.ts` с прямыми тестами `parse()` (минимальный модуль, `пусть`+присваивание, `если/иначе`, негативный кейс).
- **Тест repair‑цикла пайплайна:**
  - Расширить `src/pipeline/orchestrator.partial.test.ts` интеграционным тестом, в котором `runPipeline` проходит через хотя бы одну итерацию `RepairEngineer` (невалидный код → исправленный код).
- **Документация по расширенному языку:**
  - По мере реализации typechecker и расширенного синтаксиса обновлять статусы разделов в `compiler-v0.1.md`, `lexer-v0.1.md`, `parser-v0.1.md` и матрицу в `golden-tests.md` (переводить Extended/VLIW‑тесты из «планируется» в «реализовано/частично»).
- **Единая «карта документации» в Getting Started:**
  - Вынести краткое резюме этого файла в раздел «Как читать документацию» (GETTING-STARTED), чтобы новым контрибьюторам было сразу видно, какие доки считать каноническими, какие — архивными и какие — рабочими планами.

# План статусов документации

Материал для реализации GETTING-STARTED. Конвенция: каждый документ в docs/ должен иметь в шапке:

```
status: canonical | deprecated | superseded-by | draft
last-synced-with: <файлы>
```

**Правило для разработчика (раздел «Как читать документацию» в GETTING-STARTED):** документы со статусом в шапке актуальны; документы без шапки — переходный период, доверяй коду больше чем документу.

---

## Назначенные статусы (сессия аудита)

| Документ | Статус |
|----------|--------|
| `language-v2.md` | canonical |
| `osnova/language-schema.json` | canonical |
| `traces-v1.md` | canonical |
| `legacy/grammatika-v0.1.md` | deprecated |
| `legacy/trace-format-v0.1.md` | superseded-by: traces-v1.md |
| `spec-alignment.md` | canonical |
| `legacy/pipeline-llm-osnova.md` | draft — не соответствует реальному orchestrator |
| `training-llm-from-traces-v0.1.md` | canonical |

**Остальные документы** — требуют проверки при реализации GETTING-STARTED.

---

## Действие при реализации

1. Пройтись по всем файлам в docs/ и проставить статус в шапку.
2. Внести раздел «Как читать документацию» в GETTING-STARTED.
3. В training-llm-from-traces-v0.1.md добавить `last-synced-with: traces-v1.md, src/scripts/export-dataset.ts, src/trace/types.ts`.
