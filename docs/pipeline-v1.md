<!-- doc-status: frozen -->
# LLM-пайплайн ОС-НОВА v1

> ⚠️ **FROZEN — заморожено (2026-09).** Пайплайн `intake → codegen → build → golden → repair`
> сейчас **не используется** как рабочий контур: работа идёт через DSH напрямую.
> Этот документ описывает весеннюю реализацию и остаётся как проектный замысел —
> пайплайн вернётся в пересобранном виде под экосистему. Актуальная картина — в `AGENTS.md`.

Пайплайн — это последовательность фаз преобразования пользовательского запроса в работающее приложение на языке Основа.

Источник правды: `src/pipeline/orchestrator.ts`, `src/pipeline/types.ts`, `src/trace/traceStore.ts`.
Канон языка для codegen: `docs/language-v2.md` и `docs/osnova/language-schema.json`.
Архивные документы в `docs/legacy/**` не использовать как источник истины для генерации кода.

---

## Схема пайплайна

```
intake → spec_generation → codegen → build → golden_check → [repair →] result
```

---

## Фазы пайплайна

| Фаза | Вход | Выход | Агент / Компонент | Трейс |
|------|------|-------|-------------------|-------|
| intake | string (задача) | OsnovaIntent | IntakeAgent | да |
| spec_generation | OsnovaIntent | OsnovaSpec | IntakeAgent | да |
| codegen | OsnovaSpec | OsnovaSource | OsnovaCodegenAgent | да |
| build | OsnovaSource | BuildReport | компилятор (без LLM) | да |
| golden_check | BuildReport.bytecode + OsnovaSpec | GoldenReport | runGoldenCheck (без LLM) | да |
| repair | OsnovaSource + BuildReport + GoldenReport? | OsnovaSource | RepairEngineerAgent | да |
| result | — | PipelineResult | — | да |

**Gates:** между фазами выполняются проверки (G1, G2, G3). При провале G1 — пайплайн останавливается с `error`. При провале G2 — запускается repair (если не исчерпаны попытки). При провале G3 — repair если `qualityScore < 0.5`, `partial` если `0.5 ≤ qualityScore < 0.7`, `success` если `qualityScore ≥ 0.7`. Blocking semantic errors (`unknown_syscall`, `undeclared_var`, `unknown_procedure`) в G2 также роутятся в repair.

---

## App-Registry контекст

С версии Фазы 3.1 пайплайн загружает реестр приложений (`registry.json`) в начале прогона и инжектирует его в `IntakeAgent` и `OsnovaCodegenAgent`. Это позволяет LLM учитывать уже созданные приложения при генерации нового кода.

---

## Статусы прогона

| Статус | Условие |
|--------|---------|
| `success` | G3 пройден, `qualityScore ≥ 0.7` |
| `partial` | G3 не пройден, `0.5 ≤ qualityScore < 0.7` — repair не запускается |
| `repair_exhausted` | Исчерпаны все попытки repair (MAX_REPAIR_LOOPS) |
| `error` | G1 не пройден или unhandled error |

---

## CLI-инструменты

| Команда | Файл | Назначение |
|---------|------|-----------|
| `npm run batch` | `src/scripts/batch-run.ts` | Batch-прогон задач для измерения success rate. Требует `OSNOVA_DRY_RUN=1` |
| `npm run traces` | `src/scripts/trace-viewer.ts` | Анализ трейсов: статистика, топ ошибок, разбивка по моделям. Флаги: `--stats`, `--errors`, `--models`, `--last N`, `--status <статус>` |
| `npm run export-dataset` | `src/scripts/export-dataset.ts` | Экспорт успешных трейсов в JSONL для файн-тюна. Флаги: `--input`, `--output`, `--min-quality`, `--min-repairs` |
| `osnova new-app` | CLI | Генерация нового приложения, сохранение `.osnova` + байткод + манифест, регистрация в `registry.json` |

---

## Контракты типов

### OsnovaIntent

Выход фазы intake. Структурированное намерение пользователя.

| Поле | Тип | Описание |
|------|-----|----------|
| intentId | string | Уникальный идентификатор |
| description | string | Текстовое описание задачи |
| features | string[] | Список фич/возможностей |
| appType | AppType | Тип приложения: `утилита`, `хранилище`, `ui_приложение`, `актор`, `смешанный` |
| constraints | Record<string, unknown> | Дополнительные ограничения |
| confidence | number | Уверенность 0..1 |

---

### OsnovaSpec

Выход фазы spec_generation. Спецификация приложения в терминах модулей, типов и процедур.

| Поле | Тип | Описание |
|------|-----|----------|
| specId | string | Уникальный идентификатор |
| modules | OsnovaModule[] | Описание модулей |
| mainModule | string | Имя главного модуля |
| types | OsnovaType[] | Типы данных |
| procedures | ProcedureSignature[] | Сигнатуры процедур |
| syscalls | string[] | Используемые системные вызовы (`система.хранилище`, `система.окно` и др.) |
| conventions | Record<string, unknown> | Соглашения по коду |

**OsnovaModule:** `name`, `description`, `isMain`

**OsnovaType:** `name`, `fields` (fieldName → OsnovaType)

**ProcedureSignature:** `name`, `params` (paramName → type), `returnType`

---

### OsnovaSource

Выход фазы codegen и repair. Исходный код на языке Основа.

| Поле | Тип | Описание |
|------|-----|----------|
| filename | string | Имя файла, например `main.osnova` |
| source | string | Полный исходный текст |
| tokensUsed | number? | (опционально) Токены LLM |

---

### BuildReport

Выход фазы build. Результат компиляции исходного кода.

| Поле | Тип | Описание |
|------|-----|----------|
| success | boolean | true, если нет lexer/parser ошибок |
| lexerErrors | LexerError[] | Ошибки лексера |
| parserErrors | ParserError[] | Ошибки парсера |
| compilerErrors | CompilerError[] | Ошибки компилятора |
| bytecode | unknown \| null | OsvbcModule JSON или null |
| compilerSuccess | boolean | Успешна ли компиляция в байткод |
| durationMs | number | Время компиляции, мс |

**LexerError / ParserError:** `line`, `column`, `message`; ParserError дополнительно: `node?`

**CompilerError:** `message`, `node?`

---

### GoldenReport

Выход фазы golden_check. Результат прогона сгенерированного приложения на VM.

| Поле | Тип | Описание |
|------|-----|----------|
| executed | boolean | Был ли код выполнен |
| passed | boolean | Прошла ли golden-проверка |
| qualityScore | number | Оценка качества 0..1 |
| vmErrors | VMError[] | Ошибки VM при выполнении |
| outputDiff | string \| null | Diff вывода, если проверка не прошла |
| durationMs | number | Время прогона, мс |

**VMError:** `message`, `opcode?`, `stack?`

---

### PipelineResult

Итог всего прогона пайплайна.

| Поле | Тип | Описание |
|------|-----|----------|
| status | PipelineStatus | `success` \| `partial` \| `repair_exhausted` \| `error` |
| intent | OsnovaIntent? | Результат intake |
| spec | OsnovaSpec? | Результат spec |
| source | OsnovaSource? | Финальный исходный код |
| buildReport | BuildReport? | Последний отчёт сборки |
| goldenReport | GoldenReport? | Последний golden-отчёт |
| repairAttempts | number | Количество вызовов repair |
| totalDurationMs | number | Общее время прогона, мс |
| error | string? | Сообщение об ошибке (при error/repair_exhausted) |

---

## Repair-цикл

- **Условие запуска:** gate G2 (build) или G3 (golden_check) не прошёл.
- **Вход repair:** текущий `OsnovaSource` + `BuildReport` + (при провале G3) `GoldenReport`.
- **Выход:** обновлённый `OsnovaSource`. Цикл повторяется: build → golden_check → [repair].

**Особый случай:** если `qualityScore` в диапазоне [0.5, 0.7), пайплайн завершается статусом `partial` без вызова repair.

**Максимум попыток:** 3 (`MAX_REPAIR_LOOPS`).

**При исчерпании попыток:** статус `repair_exhausted`, в `PipelineResult.error` — `"max repair loops reached"`.

---

## Трейсы

- **Путь:** переменная окружения `OSNOVA_TRACE_DB`, по умолчанию `./runs/traces.jsonl`
- **Формат:** JSONL — каждая строка — один JSON-объект

**Основные поля записи:**

| Поле | Тип | Описание |
|------|-----|----------|
| runId | string | UUID прогона |
| timestamp | string | ISO 8601 |
| status | PipelineStatus | Итоговый статус |
| task | string | Исходный текстовый запрос |
| intent | OsnovaIntent? | — |
| spec | OsnovaSpec? | — |
| source | OsnovaSource? | — |
| buildReport | BuildReport? | — |
| goldenReport | GoldenReport? | — |
| repairAttempts | number | — |

**Что можно анализировать:**
- успешность по типу задачи (`task`),
- частота repair и причины провалов G2/G3,
- время выполнения фаз,
- качество сгенерированного кода (goldenReport.qualityScore),
- использование для дообучения LLM (task → intent → spec → source).

---

## Версии языка и промпты

Промпты кодогенерации (`buildOsnovaPrompt`) автоматически подхватывают конструкции из `LANGUAGE_REGISTRY` — поле `example` у `ConstructSpec`. При добавлении новой конструкции в реестр с полем `example` промпт обновляется без ручных правок.

Текущие версии языка:
- v1.0.0 — стабильное ядро
- v1.1.0 — `arr[i]` sugar, `тогда`, `главная(аргументы)`, multiline literals
- v1.2.0-alpha — `попробовать/иначе_попытка/выбросить`
- v1.3.0 — `для_каждого` stable + indexed form `для_каждого эл, и в массив`
