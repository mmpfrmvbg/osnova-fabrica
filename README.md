# osnova-fabrica

Кодогенератор для языка **Основа** — кириллического языка программирования с VLIW-поддержкой.

```
task (текст) → LLM → .osnova → компилятор → .osvbc → VM → результат
```

## Язык Основа

Русскоязычный язык с синтаксисом, читаемым как структурированный русский текст. Целевая платформа — VLIW-процессоры (модель e2k). Компилируется в байткод `.osvbc` (JSON), исполняется на стековой VM.

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
  vliw/            — VLIW-планировщик e2k (граф зависимостей, list scheduling, упаковка в пакеты)
  llm/             — провайдеры LLM (QwenCli, DeepSeek, Ollama)
docs/              — спецификации языка, грамматика, протоколы
```

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
| `OSNOVA_PROVIDER` | `qwen-cli` | LLM провайдер (`qwen-cli`, `deepseek`, `ollama`) |
| `DEEPSEEK_API_KEY` | — | Обязателен при `provider=deepseek` |
| `OSNOVA_MODEL` | `llama3.2` | Модель LLM |
| `OLLAMA_URL` | `http://localhost:11434` | URL Ollama |
| `OSNOVA_TRACE_DB` | `./runs/traces.jsonl` | Путь к JSONL-файлу трейсов прогонов (диагностика и дообучение LLM) |
| `QWEN_TIMEOUT_MS` | `300000` | Таймаут QwenCliProvider (мс) |
| `LOG_LEVEL` | `info` | Уровень логирования (`debug`, `info`, `warn`, `error`) |

## Статус

- ✅ **batch-1** — LLM провайдеры перенесены
- ✅ **batch-2** — compiler, runtime VM, golden-тесты
- ✅ **batch-3** — агенты (IntakeAgent, OsnovaCodegen, RepairEngineer)
- ✅ **batch-4** — трейсы для дообучения LLM
- ✅ **lint** — ESLint v9 flat config (`eslint.config.mjs`), 0 ошибок
- ⏳ **batch-5** — CLI, логгер, стандартизация ошибок LLM-агентов
