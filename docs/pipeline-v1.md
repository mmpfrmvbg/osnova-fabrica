# LLM-пайплайн ОС-НОВА v1

Пайплайн — это последовательность фаз преобразования пользовательского запроса в работающее приложение на языке Основа.

Источник правды: `src/pipeline/orchestrator.ts`, `src/pipeline/types.ts`, `src/trace/traceStore.ts`.

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

**Gates:** между фазами выполняются проверки (G1, G2, G3). При провале G1 — пайплайн останавливается с `failure`. При провале G2/G3 — запускается repair (если не исчерпаны попытки).

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
| status | PipelineStatus | `success` \| `partial` \| `failure` \| `repair_exhausted` |
| intent | OsnovaIntent? | Результат intake |
| spec | OsnovaSpec? | Результат spec |
| source | OsnovaSource? | Финальный исходный код |
| buildReport | BuildReport? | Последний отчёт сборки |
| goldenReport | GoldenReport? | Последний golden-отчёт |
| repairAttempts | number | Количество вызовов repair |
| totalDurationMs | number | Общее время прогона, мс |
| error | string? | Сообщение об ошибке (при failure/repair_exhausted) |

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
