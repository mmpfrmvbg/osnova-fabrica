<!-- doc-status: scratch -->
# Запуск ОС-НОВА в Termux (Android)

## Требования

- Android 7.0+
- Termux из F-Droid (не из Google Play — устаревшая версия)
- Свободное место: ~300 МБ

## Установка Termux

1. Скачать Termux с https://f-droid.org/packages/com.termux/
2. Открыть Termux, разрешить доступ к хранилищу:
   termux-setup-storage

## Установка зависимостей

pkg update && pkg upgrade -y
pkg install -y nodejs git

Проверить версию Node.js (требуется >= 20):
node --version

## Клонирование репозитория

git clone https://github.com/mmpfrmvbg/osnova-fabrica.git
cd osnova-fabrica
npm install

## Запуск чата с Осирис

Убедиться что Осирис запущен на той же машине или в локальной сети
и доступен по HTTP_PORT (по умолчанию 3000).

Если Осирис на другой машине — адрес сервера задаётся АРГУМЕНТОМ в манифесте,
а не переменной в исходнике (в `apps/chat/chat.osnova` процедура `главная(сервер)`
принимает адрес параметром):
  src/runtime/fixtures/chat.osapp.yaml → entry: args: ["http://<IP-адрес>:3000/chat"]

  Затем перекомпилировать (команда обязана передавать имя файла — иначе канон
  «файл = модуль» назовёт модуль `вход`; `src/cli.ts compile` это умеет):
  npx tsx src/cli.ts compile apps/chat/chat.osnova -o apps/chat/chat.osvbc.json

Запуск:
npx tsx src/cli.ts run \
  --manifest src/runtime/fixtures/chat.osapp.yaml \
  --package apps/chat/ \
  --in-process

Ожидаемый вывод:
  [osnova-runtime] app id: osnova.chat
  [osnova-runtime] package loaded: 2 file(s)
  Чат запущен
  [<адрес сервера>]
  Осирис: <ответ>

Если Осирис не запущен, прогон печатает `[osnova-vm] sandbox: Network error` и
завершается кодом 1 — это ожидаемо: сервера нет. Компиляция и загрузка пакета
при этом проходят (`package loaded`), то есть отсутствие сервера не является
ошибкой сборки.

## Ввод текста из Android UI

VM поддерживает два режима ввода, управляемых переменной окружения
OSNOVA_INPUT_MODE:

stdin (по умолчанию, CLI):
  npx tsx src/cli.ts run --manifest ... --in-process

storage (Android UI-режим):
  OSNOVA_INPUT_MODE=storage npx tsx src/cli.ts run --manifest ... --in-process

  В storage-режиме UI-слой пишет текст пользователя в хранилище:
    ключ: __ввод__
    значение: текст сообщения
  VM читает ключ каждые 100 мс (таймаут 60 с), затем удаляет его.

## Известные ограничения

- better-sqlite3 (используется только в apps/osiris/) требует нативной
  компиляции. Для запуска VM и компилятора Основа он НЕ нужен —
  VM работает без него.
- Если npm install падает на better-sqlite3 — установить только
  корневые зависимости:
  npm install --ignore-scripts
  Осирис при этом не запустится, VM и компилятор — да.
- tsx требует Node.js >= 20. На Termux Node.js из pkg обычно 20+,
  но проверить: node --version

## Проверка компилятора

npx tsx src/cli.ts compile apps/chat/chat.osnova -o /tmp/chat-test.osvbc.json
cat /tmp/chat-test.osvbc.json

Ожидается: валидный JSON с байткодом модуля чат.

## Структура apps/chat/ (расширяемость)

Текущие файлы:
  apps/chat/chat.osnova       — точка входа, процедура главная()
  apps/chat/chat.osvbc.json   — скомпилированный байткод
  apps/chat/README.md         — документация

Планируемые модули (после реализации UI и сети):
  apps/chat/chat-net.osnova       — сетевой слой (система.сеть.пост)
  apps/chat/chat-ui.osnova        — UI-слой (поля ввода, вывод)
  apps/chat/chat-storage.osnova   — история диалога
