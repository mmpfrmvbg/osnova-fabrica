# @osnova/jarvis

Персональный ИИ-ассистент Jarvis на базе ОС-НОВА.
Работает через Telegram, хранит контекст в SQLite,
генерирует код на языке Основа через фабрику.

## Запуск
```bash
npm run jarvis          # запуск из корня monorepo
cd apps/jarvis && npm install && npm start
```

## Ошибка `Could not locate the bindings file` (better-sqlite3)

Нативный модуль должен совпадать с версией **Node.js**. Пакет `better-sqlite3` **≥12.4.5** подтягивает prebuild для Node 25.

1. В `apps/jarvis`: `rm -rf node_modules && npm install` (на Windows: удалить папку `node_modules` вручную, затем `npm install`).
2. Если ошибка остаётся: `npm rebuild better-sqlite3` (нужны [инструменты сборки](https://github.com/nodejs/node-gyp#on-windows) для компиляции с исходников).
3. Либо используйте **Node.js 20 LTS** (`nvm use 20`) — самый предсказуемый вариант на Windows.
