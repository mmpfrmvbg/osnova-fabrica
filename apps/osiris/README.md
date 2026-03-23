# @osnova/osiris

Персональный ИИ-ассистент Осирис на базе ОС-НОВА.
Работает через Telegram, хранит контекст в SQLite,
генерирует код на языке Основа через фабрику.

## Запуск
```bash
npm run osiris          # запуск из корня monorepo
cd apps/osiris && npm install && npm start
```

## Ошибка `Could not locate the bindings file` (better-sqlite3)

Нативный модуль должен совпадать с версией **Node.js**. Пакет `better-sqlite3` **≥12.4.5** подтягивает prebuild для Node 25.

1. В `apps/osiris`: `rm -rf node_modules && npm install` (на Windows: удалить папку `node_modules` вручную, затем `npm install`).
2. Если ошибка остаётся: `npm rebuild better-sqlite3` (нужны [инструменты сборки](https://github.com/nodejs/node-gyp#on-windows) для компиляции с исходников).
3. Либо используйте **Node.js 20 LTS** (`nvm use 20`) — самый предсказуемый вариант на Windows.

## HTTP `/pipeline`: статусы

`POST /pipeline` возвращает два поля статуса:

- `status` — бинарный статус для обратной совместимости: `ok | error`
- `pipelineStatus` — канонический статус пайплайна: `success | partial | repair_exhausted | error`

Маппинг:

- `success` -> `status: "ok"`
- `partial` -> `status: "ok"`
- `repair_exhausted` -> `status: "error"`
- `error` -> `status: "error"`

## E2E-тесты `/pipeline`

- Запуск: `npm run test:e2e-osiris`
- Проверяется контракт HTTP-ответа `POST /pipeline`: наличие `status`, `pipelineStatus`, `result`.
- Допустимые значения:
  - `status`: `ok | error`
  - `pipelineStatus`: `success | partial | repair_exhausted | error`
- Это контрактный тест HTTP-слоя и маппинга ответа; он не дублирует логику `orchestrator`.

## Metrics `/pipeline` v2 (локальный режим)

OSIRIS пишет каноническое структурированное событие в stdout при завершении каждого вызова `POST /pipeline`:

- `component`: `osiris_pipeline`
- `event`: `pipeline_completed`
- `ts`: ISO timestamp
- `status`: `ok | error`
- `pipelineStatus`: `success | partial | repair_exhausted | error`

Дополнительно (если доступны): `httpStatus`, `duration_ms`, `traceId`, `runId`, `userId`, `sessionId`, `mode`.

### Сбор логов в файл

Пример для локального запуска с разделением stdout/stderr:

```bash
npm run osiris 1> osiris.out.log 2> osiris.err.log
```

События `pipeline_completed` находятся в `osiris.out.log` и легко фильтруются по `component/event`.

### Локальная аналитика

Запуск отчёта по умолчанию (последние 7 дней):

```bash
npm run pipeline:metrics
```

Кастомный период и JSON-вывод:

```bash
npx tsx scripts/pipeline-metrics.ts --file ./osiris.out.log --from 2026-03-01 --to 2026-03-23 --json
```

Что показывает утилита:

- общее число запусков pipeline за период;
- распределение по статусам (`success`, `partial`, `repair_exhausted`, `error`) в count и %;
- daily breakdown по статусам;
- summary по `duration_ms` (если поле присутствует в логах).

Интерпретация:

- рост `repair_exhausted` и `error` — главный тревожный сигнал;
- рост `partial` при стабильном `error` — обычно признак деградации качества, но не полного отказа;
- падение общего числа запусков может означать сбой маршрута/клиентского потока, а не только качество генерации.
