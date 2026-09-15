# osnova-fabrica

Кодогенератор для языка **Основа** — кириллического языка программирования с VLIW-поддержкой.

```
task (текст) → LLM → .osnova → компилятор → .osvbc → VM → результат
```

## Язык Основа

Русскоязычный язык с синтаксисом, читаемым как структурированный русский текст. Целевая платформа — VLIW-процессоры (модель e2k). Компилируется в байткод `.osvbc` (JSON), исполняется на стековой VM.

Каноничные источники для языка и генерации кода:

- `docs/language-v2.md` (человекочитаемая спецификация v2.0.0)
- `docs/osnova/language-schema.json` (machine-readable канон)
- `docs/pipeline-v1.md` (актуальный pipeline)
- `docs/traces-v1.md` (актуальные трейсы)

`docs/legacy/**` — архив. Не использовать как источник истины для генерации нового кода.

```
модуль Пример

процедура главная(): Ничто
  пусть x: Целое32 = 42
  система.лог.вывести(x)
конец
```

## Структура

```
src/
  compiler/        — лексер, парсер, AST, кодогенератор (.osnova → .osvbc)
  runtime/         — стековая VM, runner, sandbox, storage, UI-сервер
  vliw/            — VLIW-планировщик e2k: модель устройств, граф зависимостей,
                     планирование с задержками, перестановка, счётчики конвейера
  llm/             — провайдеры LLM (DeepSeek, QwenCli, Ollama)
docs/              — спецификации языка, грамматика, протоколы
```

## VLIW: модель e2k

Планировщик знает о железе «Эльбрус» не по догадкам, а по руководству МЦСТ
(`docs/elbrus-prog-1.2_2024-02-28.pdf`); каждое число и ограничение — со ссылкой
на страницу. Подробно: `docs/vliw-e2k-model.md`.

Что учтено:

- **24 канала выдачи** в широкой команде: 6 АЛУ + СТ + 3 PL + 6 QP + 4 APB +
  4 LIT (стр. 54–56). АЛУ **не равнозначны**: деление и корень — только АЛУ5,
  запись — только АЛУ2 и АЛУ5, чтения нет у АЛУ1 и АЛУ4.
- **Длительности операций** (стр. 71–72): целочисленные 1 такт, `mul` 4, деление
  11/14, чтение L1/L2/L3/память 3/11/40/~100, подготовка возврата 6, штраф
  `fp→int` +2. Калибровка — по примеру самого руководства (стр. 70).
- **Задержки материализуются как `nop`** — так это выглядит в ассемблере e2k
  (стр. 70, 193).
- **Перестановка независимых операций** возможна на регистровом коде, где
  операнды указаны явно. На стековом байткоде порядок `push`/`pop` — часть
  семантики, поэтому там упаковка остаётся in-order.
- **Счётчики конвейера** в терминах `dprof` (стр. 63–64): `TICKS`, `EXEC`,
  `BUB_E2`. Счётчики, которых мы не моделируем (`BUB_B`, `IB_NO_COMMAND`,
  `L2_QUERY`, `L2_HIT`), возвращаются как `null`, а не нулём.

Измеренный выигрыш перестановки против in-order на том же графе (реальный код):
18–38% тактов на четырёх программах из пяти; на пятой — 0% (длинные чтения и
зависимости, переставлять нечего).

### Два уровня абстракции

Формат байткода Основа и железo e2k — разные вещи, и они намеренно разведены:

| Что | Где | Смысл |
|---|---|---|
| Модель железа e2k | `src/vliw/e2kDevices.ts` | 24 канала, длительности, реальные ограничения устройств |
| Формат пакета Основа | `src/vliw/e2kModel.ts` | `VLIW_SLOTS = 4` — ширина пакета **формата**, не железа |

`VLIW_SLOTS` остаётся равным 4, потому что это значение записано в модулях
`.osvbc` и проверяется golden-прогоном. Менять его значило бы сломать формат ради
числа, к формату отношения не имеющего.

## Быстрый старт

```bash
npm install

# Полный CI: сборка + тесты + lint + golden
npm run ci

# По отдельности:
npm run build           # tsc
npm test                # vitest run
npm run lint            # eslint src
npm run lint:fix        # eslint src --fix
npm run golden          # запуск golden-аппов

# Дополнительно:
npm run compile:fixtures   # компилировать fixtures (.osnova → .osvbc)
npm run validate:spec      # валидировать spec.yaml
```

## Версионирование и релизы

- Единый источник версии: `VERSION` (корень репозитория).
- Helper: `node scripts/get-version.mjs`
  - `--raw` -> `0.1.1`
  - `--tag` -> `v0.1.1`
  - `--android-code` -> числовой `versionCode`
- Синхронизация версий в проекты:

```bash
node scripts/get-version.mjs --sync --raw
```

- Ручной релиз через CI:

```bash
gh workflow run release.yml --ref main -f bump=patch
```

Подробно: `docs/release-process.md`.

## Зависимости

- **Node.js** >= 20
- **TypeScript** 5.x, strict mode
- **tsx** — запуск TS напрямую без сборки
- **js-yaml** — парсинг манифестов `.osapp.yaml`
- **vitest** — тесты
- **typescript-eslint** — lint (ESLint v9 flat config)
- **LLM провайдер**: `qwen-cli` (по умолчанию), `deepseek` или `ollama`

Скопируй `.env.example` в `.env` и выставь `OSNOVA_PROVIDER`.

## Переменные окружения

| Переменная | По умолчанию | Описание |
|---|---|---|
| `OSNOVA_PROVIDER` | `deepseek` | LLM провайдер (`deepseek`, `ollama`, `qwen-cli` — legacy) |
| `DEEPSEEK_API_KEY` | — | Обязателен при `provider=deepseek` |
| `OSNOVA_MODEL` | `deepseek-flash` | Модель LLM |
| `OLLAMA_URL` | `http://localhost:11434` | URL Ollama |
| `OSNOVA_TRACE_DB` | `./runs/traces.jsonl` | Путь к JSONL-файлу трейсов прогонов (диагностика и дообучение LLM) |
| `QWEN_TIMEOUT_MS` | `300000` | legacy: таймаут QwenCliProvider (Qwen CLI выведен из эксплуатации) |
| `LOG_LEVEL` | `info` | Уровень логирования (`debug`, `info`, `warn`, `error`) |

## Статус

- ✅ **batch-1** — LLM провайдеры перенесены
- ✅ **batch-2** — compiler, runtime VM, golden-тесты
- ✅ **batch-3** — агенты (IntakeAgent, OsnovaCodegen, RepairEngineer)
- ✅ **batch-4** — трейсы для дообучения LLM
- ✅ **batch-5** — CLI, логгер, стандартизация ошибок LLM-агентов, адаптация под Qwen Code v0.12.6
- ✅ **lint** — ESLint v9 flat config (`eslint.config.mjs`), 0 ошибок

## Known Limitations

| Задача | Статус | Причина |
|---|---|---|
| Скалярные утилиты | ✅ success | Поддерживается |
| Коллекции / массивы | ✅ success | Поддерживается с v2.0.0 |
| Многомодульный код | ⚠️ parser error | Один модуль на файл |

### Пример запуска

```bash
OSNOVA_PROVIDER=qwen-cli \
OSNOVA_MODEL=qwen-coder-plus \
LOG_LEVEL=debug \
npx tsx src/cli.ts --task "посчитай сумму чисел от 1 до 10"
```

Ожидаемый результат (сокращённо):

```text
[pipeline] phase: intake
[pipeline] phase: spec_generation
[pipeline] gate G1 passed
[pipeline] phase: codegen
[pipeline] phase: build (attempt 1)
...
[pipeline] gate G2 passed
[pipeline] phase: golden_check
[pipeline] gate G3 passed — pipeline complete

Статус:          success
Файл:            Главный.osnova
Golden:          passed ✅
```

## OSNOVA Forge CLI

Команды `osnova` (status, health, forge, do, fix, …): см. [OSNOVA-CLI.md](OSNOVA-CLI.md).
