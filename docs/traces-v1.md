# Трейсы пайплайна ОС-НОВА v1

## Назначение

Трейсы — журнал работы LLM-пайплайна. Каждый запуск `osnova new-app` или прямой вызов `runPipeline` записывает одну строку JSONL. Используются для: отладки, анализа качества генерации, дообучения моделей.

Источник правды: `src/trace/types.ts`, `src/trace/traceStore.ts`, `src/pipeline/types.ts`.
Контекст языка для анализа трейсов: `docs/language-v2.md` и `docs/osnova/language-schema.json`.
Архивные документы в `docs/legacy/**` не являются источником истины для нового кода.

---

## Расположение

- **Файл:** `./runs/traces.jsonl` (по умолчанию)
- **Переменная окружения:** `OSNOVA_TRACE_DB` (переопределить путь)
- **Формат:** JSONL (одна запись = одна строка JSON)

---

## Структура записи трейса

| Поле | Тип | Описание |
|------|-----|----------|
| runId | string | UUID прогона |
| timestamp | string | ISO 8601 (момент записи) |
| status | PipelineStatus | Итоговый статус (`success` \| `partial` \| `repair_exhausted` \| `error`) |
| task | string | Исходный текстовый запрос пользователя |
| modelId | string? | LLM-модель (OSNOVA_MODEL) — для анализа качества по провайдерам |
| intent | OsnovaIntent? | Результат фазы intake |
| spec | OsnovaSpec? | Результат фазы spec_generation |
| source | OsnovaSource? | Финальный исходный код (.osnova) |
| buildReport | BuildReport? | Результат компиляции (lexerErrors, parserErrors, compilerErrors, bytecode) |
| goldenReport | GoldenReport? | Результат golden_check (passed, qualityScore, vmErrors, outputDiff) |
| repairAttempts | number | Количество вызовов RepairEngineer |

**BuildReport:** `success`, `lexerErrors`, `parserErrors`, `compilerErrors`, `bytecode`, `compilerSuccess`, `durationMs`

- **`success`** — агрегат: `compilerSuccess && lexerErrors.length === 0 && parserErrors.length === 0`. Для дообучения LLM берём только записи с `buildReport.success === true` (нет ни одной ошибки лексера/парсера).
- **`compilerSuccess`** — сырой результат компилятора (есть байткод или нет). Может быть true при наличии lexer/parser errors — такие примеры невалидны для обучения.

**GoldenReport:** `executed`, `passed`, `qualityScore`, `vmErrors`, `outputDiff`, `durationMs`

---

## Статусы PipelineResult

| Статус | Когда возникает |
|--------|-----------------|
| success | golden_check прошёл (passed=true или qualityScore ≥ 0.7) |
| partial | qualityScore в [0.5, 0.7) — частичный успех, repair не вызывался |
| error | Gate G1 не прошёл (intent/spec) или необработанное исключение |
| repair_exhausted | Исчерпаны MAX_REPAIR_LOOPS (3) попыток repair при провале G2 или G3 |

---

## Анализ трейсов

Примеры запросов с `jq`:

**1. Количество успешных запусков:**
```bash
jq -s 'map(select(.status == "success")) | length' runs/traces.jsonl
```

**2. Ошибки парсера (топ провалов компиляции):**
```bash
jq -c 'select(.buildReport.parserErrors | length > 0) | {task, errors: .buildReport.parserErrors}' runs/traces.jsonl
```

**3. Среднее количество repair-попыток:**
```bash
jq -s 'map(select(.repairAttempts != null) | .repairAttempts) | add / length' runs/traces.jsonl
```

**4. Задачи, закончившиеся repair_exhausted:**
```bash
jq -r 'select(.status == "repair_exhausted") | .task' runs/traces.jsonl
```

**5. Трейсы с провалом golden (не прошли проверку):**
```bash
jq -c 'select(.goldenReport != null and .goldenReport.passed == false) | {task, qualityScore: .goldenReport.qualityScore}' runs/traces.jsonl
```

---

## Использование для дообучения

- **success** — позитивные примеры для fine-tuning: task → intent → spec → source образуют полную цепочку «запрос → работающий код».
- **repair** (трейсы с repairAttempts > 0, но status = success) — примеры исправления ошибок компиляции/VM: source до и после repair, buildReport с ошибками.
- **repair_exhausted** — сложные случаи: задачи, которые текущие промпты/модели не решают; полезны для улучшения промптов и выявления недостатков языка.
- **modelId** — в каждой записи есть поле `modelId` (OSNOVA_MODEL). Анализ «какая модель генерирует больше ошибок лексера»: `jq -s 'group_by(.modelId) | map({model: .[0].modelId, count: length})' runs/traces.jsonl`

---

## Экспорт датасета (export-dataset)

- Назначение: читает `runs/traces.jsonl`, фильтрует записи, пишет `dataset-v1.jsonl`
- Запуск: `npx ts-node src/scripts/export-dataset.ts [--input path] [--output path] [--minQuality N] [--minRepairs N]`
- Параметры:
  - `--input` (default: `runs/traces.jsonl`)
  - `--output` (default: `dataset-v1.jsonl`)
  - `--minQuality` (default: `0`) — минимальный goldenReport.qualityScore
  - `--minRepairs` (default: `-1`, выключено) — брать только записи с `repairAttempts >= N`
- Условия фильтрации: `status=success`, `buildReport.success=true`, `source` непустой, `qualityScore >= minQuality`
- Формат строки вывода: JSON с полями `input_text`, `target_text`, `meta` (runId, status, repairAttempts, qualityScore, modelId)
