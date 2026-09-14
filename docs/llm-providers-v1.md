# LLM-провайдеры ОС-НОВА v1

Спецификация провайдеров и моделей для пайплайна ОС-НОВА. Источник правды: `src/llm/`, `src/llm/defaults.ts`, `.env.example`.

---

## Поддерживаемые провайдеры

| Провайдер | Переменные окружения | Статус |
|-----------|---------------------|--------|
| `deepseek` | `OSNOVA_PROVIDER`, `DEEPSEEK_API_KEY` (обязателен), `OSNOVA_MODEL` | основной, по умолчанию |
| `ollama` | `OSNOVA_PROVIDER`, `OLLAMA_URL`, `OSNOVA_MODEL` | локальный |
| `qwen-cli` | `OSNOVA_PROVIDER`, `OSNOVA_MODEL`, `QWEN_TIMEOUT_MS` | legacy: Qwen CLI выведен из эксплуатации, ключи отозваны |

**Общие переменные (для всех):** `OSNOVA_MODEL` — модель для всех фаз пайплайна (intake, spec, codegen, repair). Если не задана — берётся дефолт по провайдеру.

---

## Рекомендуемые модели по задачам

Все фазы пайплайна используют **одну модель** — `OSNOVA_MODEL` (или дефолт провайдера). Отдельной настройки по задачам нет.

| Задача | Провайдер | Модель (дефолт) | Комментарий |
|--------|-----------|-----------------|-------------|
| intake | любой | см. дефолты ниже | понимание задачи пользователя |
| spec | любой | см. дефолты ниже | генерация спецификации |
| codegen | любой | см. дефолты ниже | генерация кода на Основе |
| repair | любой | см. дефолты ниже | исправление ошибок компиляции |

**Дефолтные модели по провайдеру** (из `src/llm/defaults.ts`):

| Провайдер | Дефолт модели |
|-----------|---------------|
| `qwen-cli` | `qwen-coder-plus` |
| `deepseek` | `deepseek-flash` |
| `ollama` | `llama3.2` |

---

## Пример .env для каждого провайдера

### qwen-cli

Требует установленный [qwen-cli](https://github.com/QwenLM/qwen) (Python). Передача stdin/stdout.

```env
OSNOVA_PROVIDER=qwen-cli
OSNOVA_MODEL=qwen-coder-plus

# Опционально
# QWEN_TIMEOUT_MS=300000
```

### DeepSeek

API DashScope, нужен API-ключ.

```env
OSNOVA_PROVIDER=deepseek
DEEPSEEK_API_KEY=sk-...

# Опционально — по умолчанию deepseek-flash
# OSNOVA_MODEL=deepseek-flash
```

> **V4-тиры.** С 24.07.2026 имена `deepseek-chat` / `deepseek-reasoner` выводятся из
> эксплуатации; актуальные тиры — `deepseek-flash` и `deepseek-pro`.
> Посфазный выбор тира и уровня усилий (`OSNOVA_TIER`, `OSNOVA_LEVEL`) описан в
> `docs/llm-routing-v1.md`.

### Ollama (локальный)

Локальный Ollama, по умолчанию `http://localhost:11434`.

```env
OSNOVA_PROVIDER=ollama
# OSNOVA_MODEL=llama3.2

# Опционально
# OLLAMA_URL=http://localhost:11434
```

---

## Переключение провайдера

1. Установи `OSNOVA_PROVIDER` в нужное значение: `qwen-cli`, `deepseek` или `ollama`.
2. Для DeepSeek задай `DEEPSEEK_API_KEY`.
3. Опционально задай `OSNOVA_MODEL` — иначе будет использован дефолт провайдера (qwen-coder-plus, deepseek-chat или llama3.2).
