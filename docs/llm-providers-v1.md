# LLM-провайдеры ОС-НОВА v1

Спецификация провайдеров и моделей для пайплайна ОС-НОВА. Источник правды: `src/llm/`, `src/llm/defaults.ts`, `.env.example`.

---

## Поддерживаемые провайдеры

| Провайдер | Переменные окружения | Статус |
|-----------|---------------------|--------|
| `qwen-cli` | `OSNOVA_PROVIDER`, `OSNOVA_MODEL`, `QWEN_TIMEOUT_MS` | основной, по умолчанию |
| `deepseek` | `OSNOVA_PROVIDER`, `DEEPSEEK_API_KEY` (обязателен), `OSNOVA_MODEL` | API DashScope |
| `ollama` | `OSNOVA_PROVIDER`, `OLLAMA_URL`, `OSNOVA_MODEL` | локальный |

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
| `deepseek` | `deepseek-chat` |
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

# Опционально — по умолчанию deepseek-chat
# OSNOVA_MODEL=deepseek-chat
```

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
