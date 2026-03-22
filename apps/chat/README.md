# apps/chat — Чат с Jarvis

Приложение на языке Основа для диалога с Jarvis через HTTP.

## Структура

- `chat.osnova` — модуль чата (точка входа: процедура `главная`)

## Зависимости

- Jarvis HTTP-сервер запущен на порту 3000 (`npm run jarvis:http` в apps/jarvis/)
- Системный вызов `система.сеть.пост` — реализуется в Блоке 2

## Запуск (после реализации система.сеть.пост)

```bash
tsx src/cli.ts run --manifest src/runtime/fixtures/chat.osapp.yaml
```

## Расширяемость

Планируемые модули:
- `chat-ui.osnova` — UI-слой (окно/поля ввода)
- `chat-net.osnova` — сетевой слой (система.сеть.пост)
- `chat-storage.osnova` — история диалога (система.хранилище)
