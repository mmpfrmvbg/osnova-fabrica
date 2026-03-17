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
  runtime/         — стековая VM, runner, sandbox, storage
  vliw/            — VLIW-планировщик e2k (заморожен до v0.2)
  llm/             — провайдеры LLM (QwenCli, DeepSeek, Ollama)
docs/              — спецификации языка, грамматика, протоколы
```

## Быстрый старт

```bash
npm install

# Запустить golden-тесты (проверка VM)
npm run golden

# Компилировать fixtures (.osnova → .osvbc)
npm run compile:fixtures

# Запустить unit-тесты
npm test

# Валидировать spec.yaml
npm run validate:spec
```

## Зависимости

- **Node.js** >= 20
- **TypeScript** 5.x, strict mode
- **tsx** — запуск TS напрямую без сборки
- **js-yaml** — парсинг манифестов `.osapp.yaml`
- **vitest** — тесты
- **LLM провайдер**: `qwen-cli` (по умолчанию), `deepseek` или `ollama`

Скопируй `.env.example` в `.env` и выставь `OSNOVA_PROVIDER`.

## Переменные окружения

| Переменная | По умолчанию | Описание |
|---|---|---|
| `OSNOVA_PROVIDER` | `qwen-cli` | LLM провайдер |
| `DEEPSEEK_API_KEY` | — | Обязателен при `provider=deepseek` |
| `OSNOVA_MODEL` | `llama3.2` | Модель LLM |
| `OLLAMA_URL` | `http://localhost:11434` | URL Ollama |
| `LOG_LEVEL` | `info` | Уровень логирования |

## Статус

- ✅ **batch-1** — LLM провайдеры перенесены
- ✅ **batch-2** — compiler, runtime VM, golden-тесты
- ⏳ **batch-3** — агенты (IntakeAgent, OsnovaCodegen, RepairEngineer)
- ⏳ **batch-4** — трейсы для дообучения LLM
