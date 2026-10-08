<!-- doc-status: active -->
# Маршруты LLM в DSH: протокол задаётся на ПРОВАЙДЕРА

**Дата:** 2026-10-08
**Зачем:** два замера, оба — «измерение, а не догадка». Первый: кэш промптов Claude
через TeamoRouter не работал (запись кэша 0 при 3,5 млн входных токенов) — найдена
причина и починка. Второй: Jev (TypeSafe) в DSH конфигом не выражается — выяснено,
где именно стена и что нужно, чтобы её обойти. Третий шаг — что из этого уже сделано:
Jev подключён готовым плагином (§3.6).

**Где конфигурация.** Активный файл — `$DSH_HOME/profiles/web/cordis.patch.yml`,
запись `id: llm-pi-ai` → `config.providers`. Файла `~/.dsh/settings.yaml` больше нет:
легаси-документ перенесён в профиль и переименован в `settings.yaml.imported`
(`dsh-settings` → `importLegacyDocument`, 2026-10-08 15:44). Файл профиля
перезагружается горячо (`dsh-hmr` следит за `profile.patchPath`, а обновление читает
его с диска через `loadOptionalPatches`), а редактор настроек GUI перечитывает файл
перед записью и меняет только свою запись — ручные правки он не затирает.

---

## 1. Что настроено

| Маршрут | `api` | `baseURL` | Ключ | Моделей |
|---|---|---|---|---|
| `teamorouter` | `openai-completions` | `https://api.teamorouter.com/v1` | `TEAMOROUTER_API_KEY` | 36 (Claude нет) |
| `teamorouter-anthropic` | `anthropic-messages` | `https://api.teamorouter.com` (без `/v1`) | `TEAMOROUTER_API_KEY` | 13 (только Claude) |
| `deepseek-official` | встроенный маршрут `dsh-llm-deepseek` | — | `DEEPSEEK_API_KEY` (в `.credentials.yaml`) | каталог пакета |

`agent-default-model`: `teamorouter` / `deepseek-flash`.

Ключ `TEAMOROUTER_API_KEY` — переменная **пользователя** (`HKCU:\Environment`, длина 57),
не в `.credentials.yaml` (там только `DEEPSEEK_API_KEY` и грант браузерной сессии):
`dsh-credentials-local` разрешает ссылку слоями `process` → `project-env` → `user-env`.
**Уточнено замером 2026-10-08:** в окружении ПРОЦЕССА хоста ключ есть — плагин Jev
получил его выражением `!!js process.env.TEAMOROUTER_API_KEY` и успешно сходил в шлюз
(§3.6); а вот **оболочки инструментов DSH его не наследуют** (в инструментальном `pwsh`
переменная пуста, как и `DEEPSEEK_API_KEY`), поэтому дочернему `dsh` ключ надо
экспортировать явно, иначе `MISSING_CREDENTIAL`.

## 2. Кэш Claude: почему не работал и как починен

**Причина (две независимые).** `api` в DSH задаётся на провайдера, а не на модель:
один маршрут — один проводной протокол. И на generic-маршруте `openai-completions`
pi-ai вообще не отправляет `cache_control` — `cacheControlFormat: "anthropic"`
включается только для `provider === "openrouter"` и модели `anthropic/*`
(`pi-ai/dist/api/openai-completions.js:1276`).

**Замер на шлюзе** (одинаковый текст 32 100 символов, `cache_control: ephemeral`):

| Запрос | вход | запись кэша | чтение кэша |
|---|---|---|---|
| `POST /v1/messages` №1 | 22 | **13 245** | 0 |
| `POST /v1/messages` №2 | 22 | 0 | **13 245** |
| `POST /v1/chat/completions` №1 | 13 267 | поля нет | поля нет |
| `POST /v1/chat/completions` №2 | 13 267 | поля нет | поля нет |

**Замер внутри DSH** (один и тот же промпт, модель `claude-sonnet-5-5`):

| Опыт | `api` | свежих входных | запись | чтение |
|---|---|---|---|---|
| шаг 1 | `anthropic-messages` | 4 | **20 794** | — |
| шаг 2 | `anthropic-messages` | 4 | 34 | **20 794** |
| контроль | `openai-completions` | 20 465 | поля нет | поля нет |

**До починки** (статистика DSH, сессия `600e2b90`, 41 запрос): вход 3 505 994,
чтение кэша 0, **запись 0**, выход 39 299.

**Починка:** `teamorouter` оставлен OpenAI-совместимым (36 не-Claude моделей),
Claude вынесен в `teamorouter-anthropic` (`anthropic-messages`, `baseURL` без `/v1` —
Anthropic SDK сам добавляет `/v1/messages`, аутентификация нативная: `x-api-key` +
`anthropic-version`). `apiKeyEnv` не менялся. Бэкап:
`profiles/web/cordis.patch.yml.bak-before-claude-cache-fix`.

## 3. Jev: настройка в DSH

Jev — «модель решений» TypeSafe: принимает `state` + `questions`
(`noul` / `score`), отдаёт вероятности, а не текст.

### 3.1. Прямая проверка (Jev исправен?)

```
POST https://api.teamorouter.com/v1/systemone
Authorization: Bearer $TEAMOROUTER_API_KEY
{"model":"jev","state":"…","questions":{"успех":{"type":"noul",…},"качество":{"type":"score",…}}}
```

| Что | Значение |
|---|---|
| Код ответа | **200** |
| Время | **1,5 с** (первая попытка дала `000` — разовый сетевой сбой, повтор прошёл) |
| `model` в ответе | `typesafe-ai/jev` |
| `answers.успех.noul` | **0,97** |
| `answers.качество.score` | **3,98** из 4, `confidence` 0,99 |
| `probabilities` | `{3: 0,01, 4: 0,99}` |
| `usage` | вход 458, выход 44 |
| Стоимость (`provider_metadata.gateway.cost`) | $0,0000192 |

**Итог: Jev доступен, ключ и шлюз исправны, отдельный ключ TypeSafe не нужен.**

### 3.2. Вариант А — Jev отдельным провайдером с произвольным `api`

Проверено для трёх написаний — `typesafe-systemone`, `systemone`, `jev`. Отказ
одинаковый и локальный (остальное дерево грузится):

```
dsh: warning: 1 entry did not activate
llm-pi-ai (@deepseek-ai/dsh-llm-pi-ai): ValidationError: invalid config:
  - $.providers.teamorouter-jev.api expected "openai-completions" | "openai-responses"
    | "anthropic-messages" but got "typesafe-systemone" (at providers.teamorouter-jev.api)
```

Причина в коде: таблица `PROTOCOLS` (`dsh-llm-pi-ai/lib/index.js:798`) содержит ровно
три протокола, а схема профиля — их объединение. Произвольный endpoint как `api`
**не выражается конфигом**, и это не недосмотр: сама документация пакета называет
набор намеренно узким и говорит, что новый протокол — «одна строка в таблице, когда
у развёртывания появится нужда».

### 3.3. Вариант Б — Jev моделью у `teamorouter` (OpenAI)

Ответы шлюза (запросы дошли до TeamoRouter — ошибки его собственные):

| id модели | Ответ |
|---|---|
| `jev` | `400 INVALID_REQUEST: {"message":"Model 'jev' is temporarily not supported. Please choose another model from GET /v1/models.","type":"model_not_supported","code":400}` |
| `typesafe-ai/jev` | `400 INVALID_REQUEST: {"message":"Model 'typesafe-ai/jev' is temporarily unavailable. Please retry.","type":"model_not_available","code":400}` |

**Ловушка, которую стоит помнить:** `typesafe-ai/jev` **числится** в
`GET /v1/models` (и поэтому уже стоит в списке моделей маршрута `teamorouter`), но
через `chat/completions` не обслуживается вовсе. То есть модель видна в выборе и
падает при вызове — это не «временно», это другой API.

Консоль «Вызовы API» TeamoRouter мне недоступна; факт доставки запросов доказан
иначе — тела ошибок `400` пришли от шлюза с его собственными кодами
(`model_not_supported` / `model_not_available`), а не от DSH.

### 3.4. Вывод

Jev **работает**, но **DSH не умеет его нативно**: конфиг выражает маршрут только
через три протокола, а `/v1/systemone` — четвёртый, со своей формой тела
(`state` + `questions` вместо `messages`). Нужен плагин; правкой `cordis.patch.yml`
задача не решается.

### 3.5. Что должен делать плагин

**Путь (а) — внешний мост, без правок DSH.** Небольшой локальный HTTP-сервис,
который поднимает OpenAI-совместимую поверхность и переводит её в `/v1/systemone`:

- `POST /v1/chat/completions` → последний пользовательский текст становится `state`,
  фиксированный набор вопросов маршрута (`noul` «успех?», `score` «качество?») —
  `questions`;
- ответы → текст ассистента (например `успех: 0.97; качество: 3.98/4 (0.99)`),
  `usage` — из ответа шлюза (вход 458 / выход 44 в замере);
- `GET /v1/models` → одна объявленная «модель» `jev`, иначе DSH не покажет маршрут.

В конфиг добавляется обычный маршрут: `api: openai-completions`,
`baseURL: http://127.0.0.1:<порт>/v1`, ключ-плейсхолдер (pi-ai требует ключ или
`Authorization` даже для локального сервера — известное ограничение пакета).

*Плюсы:* ноль правок узлов DSH, маршрут описывается штатной троицей полей.
*Минусы:* нужен постоянно живущий процесс; «модель» получается псевдо-чат — Jev не
генерирует текст, поэтому ценность только в машинных решениях (`noul`/`score`).

**Путь (б) — свой маршрут отдельным плагином, без правки чужих пакетов.** Плагин
регистрирует маршрут через LLM-шов `ctx.llm.registerAdapter([provider], adapter)`
с наследником `LlmAdapter` — ровно так устроен встроенный
`@deepseek-ai/dsh-llm-deepseek` (`lib/index.js:2065` — класс адаптера, `:2262` —
регистрация). Конфиг `cordis.patch.yml` при этом даже не нужен: маршрут появляется
от самого плагина. Маппинг «вопросы → сообщения» нужен тот же, что и в пути (а), но
чужие пакеты не трогаются и обновление DSH правку не сносит.

**Путь (в) — расширить сам pi-ai.** Реализация API `/v1/systemone` в pi-ai плюс одна
строка в `PROTOCOLS` у `dsh-llm-pi-ai`; тогда конфиг становится
`api: typesafe-systemone`, `baseURL: https://api.teamorouter.com/v1`. Это самый
«родной» для DSH путь, но правка ложится в `node_modules` и живёт до следующего
обновления, а механизма патчей в этой установке нет (проверено 2026-10-08: ни
`patches/`, ни `patchedDependencies`, ни единого `*.patch`), поэтому адрес такой
правки — PR в pi-ai, а не локальный патч.
Адаптеру всё равно понадобится маппинг «вопросы → текст», потому что остальной DSH
ждёт сообщения, а Jev отдаёт числа: это оракул решений, а не собеседник.

### 3.6. Сделано 2026-10-08: плагин `dsh-jev-decide` (Jev подключён инструментом)

Готовый плагин нашёлся в npm и закрывает задачу — это путь (б) в готовом виде.

| Что | Значение |
|---|---|
| Пакет | `dsh-jev-decide` **0.1.2**, лицензия MIT |
| Код | `github.com/nanami-0713/dsh-jev-decide` |
| Что даёт | инструмент `jev_decide` (`noul` / `choice` / `score`) |
| Внутри | один ESM-файл, `inject = ['tools']`, peer `@deepseek-ai/dsh-tools` (разрешается из runtime DSH) |
| Установка | `dsh plugin --profile web add dsh-jev-decide` — пакет несёт свой `dsh.bundle.patch`, ручная вставка не нужна |

Умолчания плагина нам не годятся: `baseUrl` = `https://api.typesafe.ai/v1`, `model` =
`jev-latest`, ключ — `TYPESAFE_*`. Наш Jev идёт через TeamoRouter, поэтому в
`profiles/web/cordis.patch.yml` добавлена запись (правится тот же файл, что и всё
остальное; секрет в файл не попадает):

```yaml
- id: dsh-jev-decide
  config:
    baseUrl: https://api.teamorouter.com/v1        # плагин сам дописывает /systemone
    model: jev                                     # "jev-latest" шлюзу неизвестно
    apiKey: !!js process.env.TEAMOROUTER_API_KEY    # ключ остаётся в env процесса хоста
```

**Измерено.** Прямой замер шлюза: `POST https://api.teamorouter.com/v1/systemone` →
**HTTP 200 за 1,44 с**, `model: typesafe-ai/jev`, `answers.ok.noul` **0,56**, usage
279/20, стоимость **$0,0000117**. Тот же путь через инструмент, в НОВОЙ сессии после
установки и правки конфига:

```json
{"model":"typesafe-ai/jev","type":"noul","answer":0.56,"usage":{"input_tokens":279,"output_tokens":20}}
```

Совпадение usage (279/20) доказывает, что плагин пошёл именно через TeamoRouter и ключ
из `!!js` разрешился.

**Перезапуск не потребовался, вопреки README плагина** («host 插件在进程启动时装配»):
инструмент появился в сессии, созданной через две минуты после `dsh plugin add`, при
живом хосте. Механизм тот же, что горячо подхватывает правки профиля (§1: `dsh-hmr` +
редактор профиля перечитывает с диска) — то есть в этой установке host-плагин встаёт
без остановки DSH.

## 4. Чем проверено

- Протоколы и признак включения `cache_control`: `dsh-llm-pi-ai/lib/index.js:798`
  (`PROTOCOLS`), `pi-ai/dist/api/openai-completions.js:1276`, `anthropic-messages.js:29`.
- Кэш: `POST /v1/messages` и `POST /v1/chat/completions` напрямую; сквозные
  headless-прогоны DSH с чтением `usage` из журнала сессии (`cacheWriteTokens` /
  `cacheReadTokens`).
- Jev: `POST /v1/systemone` (curl), три попытки варианта А и обе — варианта Б
  (коды выхода и тексты ошибок выше).
- Jev как инструмент (2026-10-08): прямой curl шлюза и вызов `jev_decide` из новой
  сессии живого хоста — usage 279/20 в обоих случаях, ключ разрешился выражением
  `!!js process.env.TEAMOROUTER_API_KEY`.
- Состав конфига: `dsh --profile web --dump-config` и разбор
  `profiles/web/cordis.patch.yml`.

## 5. Чего НЕ делать

- **Не добавлять `jev` / `typesafe-ai/jev` к маршруту `teamorouter`** — проверено,
  оба падают `400`, хотя модель и видна в каталоге.
- Не менять `apiKeyEnv`: ключ тот же, `TEAMOROUTER_API_KEY`.
- Не переключать Claude обратно на OpenAI-маршрут — это и была причина `запись кэша 0`.
- Не передавать Jev `messages` / `stream` / `temperature` / `max_tokens` — форма тела
  только `state` + `questions`.
- Не заводить второй ключ (`TYPESAFE_API_KEY`) и не писать ключ в `apiKey` буквально:
  ключ один и уже лежит в env процесса хоста, а копия в файле — это утечка.
