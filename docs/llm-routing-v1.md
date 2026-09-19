<!-- doc-status: frozen -->
# LLM-маршрутизация ОС-НОВА v1 (посфазный маршрут + тир/уровень)

Спецификация посфазного выбора модели и уровня усилий для пайплайна ОС-НОВА.
Цель: максимально сэкономить на вызовах DeepSeek, не потеряв качество (в идеале —
сохранив его), за счёт того, что у системы уже есть бесплатный оракул
(компилятор + golden-гейты).

Источник правды: **этот документ до реализации**; после реализации — `src/llm/routing.ts`
(аналог существующего `src/llm/defaults.ts`). Продолжает `docs/llm-providers-v1.md`.

---

## 1. Мотивация

Сейчас модель выбирается **одна на весь прогон** через `OSNOVA_MODEL` (дефолт
`qwen-coder-plus`, у DeepSeek — `deepseek-chat`). Каждый агент хардкодит
`process.env.OSNOVA_MODEL ?? 'qwen-coder-plus'`:

| Фаза | Агент (файл) | Текущая модель | Текущие параметры |
|------|--------------|----------------|-------------------|
| intake (`parseIntent`) | `IntakeAgent` (`src/agents/intake-agent.ts`) | `OSNOVA_MODEL ?? 'qwen-coder-plus'` | `maxTokens 2000`, `json_object`, temp не задан |
| spec (`generateSpec`) | `IntakeAgent` (`src/agents/intake-agent.ts`) | `OSNOVA_MODEL ?? 'qwen-coder-plus'` | `maxTokens 4000`, `json_object`, temp не задан |
| codegen | `OsnovaCodegenAgent` (`src/agents/OsnovaCodegen.ts`) | `OSNOVA_MODEL ?? 'qwen-coder-plus'` | `maxTokens 8000`, `temperature 0.2` |
| repair | `RepairEngineerAgent` (`src/agents/RepairEngineer.ts`) | `OSNOVA_MODEL ?? 'qwen-coder-plus'` | `maxTokens 8000`, `temperature 0.1` |

Проблемы текущей схемы:

1. **Одна модель на всё** — дорогие/трудные фазы неотличимы от дешёвых/лёгких.
2. **Качество не измеряется в момент выбора** — нет механизма «дёшево по умолчанию,
   дорого только когда оракул сказал „не прошло“».
3. **`DeepSeekProvider` не умеет reasoning** — нет `reasoning_effort` и не читается
   `reasoning_content`, поэтому reasoning-режим V4 сегодня недоступен.

---

## 2. Модельные тиры DeepSeek (V4)

С 24 июля 2026 старые имена `deepseek-chat` / `deepseek-reasoner` выводятся из
эксплуатации и указывают на V4-Flash. Актуальные тиры ([источник](https://en.theblockbeats.news/flash/342825)):

| Титр | Input (промах кэша) | Input (попадание кэша) | Output | Контекст |
|------|---------------------|------------------------|--------|----------|
| **V4-Flash** (`deepseek-flash`) | $1/М | $0.2/М | $2/М | 1M |
| **V4-Pro** (`deepseek-pro`) | $12/М | $1/М | $24/М | 1M |

Ключевые факты:

- Разница по output — **12×**; по промаху input — **12×**; по попаданию кэша — **5×**.
- Оба тира поддерживают reasoning-режим с `reasoning_effort ∈ { high, max }`.
- **V4-Pro сейчас ограничен по пропускной способности** (мало high-end вычислителей);
  заметное снижение цены ожидается во второй половине года (после ввода 950 Ascend-узлов).
  Поэтому Pro — последняя ступень эскалации, а не дефолт.
- Кэш-попадание input дешевле промаха в 5× — это отдельный крупный рычаг экономии (§7).

---

## 3. Два селектора

### 3.1 Тир — `OSNOVA_TIER`

| Значение | Модель по умолчанию | Эскалация repair→Pro |
|----------|---------------------|----------------------|
| `flash` | `deepseek-flash` | нет |
| `pro` | `deepseek-pro` | нет (уже Pro) |
| `auto` (default) | `deepseek-flash` | да, по порогу §5 |

`auto` — режим «сэкономить, не потеряв качество»: почти всё на Flash, Pro тратится
только на упорно не проходящие golden-гейт итерации.

### 3.2 Уровень — `OSNOVA_LEVEL`

Уровень — это **политика усилий**, а не смена модели: он управляет
`reasoning_effort`, температурой и бюджетом повторов посфазно.

| Значение | Смысл |
|----------|-------|
| `low` | без reasoning, минимум thinking-токенов, эскалации нет |
| `med` (default) | reasoning на трудных фазах, сбалансированный бюджет |
| `high` | `reasoning_effort=max` на трудных фазах, агрессивнее эскалация, выше бюджет |

---

## 4. Профиль фаз и маршрутная матрица

### 4.1 Почему фазы нельзя обслуживать одинаково

| Фаза | Характер | Цена ошибки | Вывод |
|------|----------|-------------|-------|
| intake | NLU русского текста → JSON, короткий | средняя | reasoning полезен для неоднозначных формулировок |
| spec | схема-constrained JSON, валидируется G1 | низкая | reasoning почти всегда лишний — **дешёвое место** |
| codegen | генерация всего `.osnova` | **высокая** | главный кандидат на reasoning и на Pro |
| repair | маленький патч, но **повторяется ×3–6** | высокая + множитель | **скрытый центр затрат**; Pro — только при застревании |

### 4.2 Матрица уровней (тир = Flash; для Pro строки те же, модель заменяется)

Обозначения: `—` — thinking выключен (thinking-токены не тратятся); `high` / `max` — `reasoning_effort`.

| Фаза | Low | Med (default) | High |
|------|-----|----------------|------|
| intake | — | `high` | `max` |
| spec | — | — | `high` |
| codegen | — | `high` | `max` |
| repair | — | `high` | `max` |

`temperature` действует **только там, где thinking выключен**: в thinking-режиме
DeepSeek её игнорирует (§8). Значения по фазам: intake 0, spec 0,
codegen 0.2 / 0.3 / 0.4, repair 0.1. Так как у codegen thinking включается уже на
Med, значения 0.3 и 0.4 сейчас не задействованы (см. §12).

`maxTokens` — базовый по фазе (intake 2000, spec 4000, codegen/repair 8000) и
**удваивается**, когда thinking включён (§8, пункт 5).

---

## 5. Правила эскалации (только `OSNOVA_TIER=auto`)

Эскалация касается **только фазы repair** — она зациклена, поэтому именно там
дешёвая модель либо справляется быстро, либо застревает.

| Уровень | Порог | Поведение |
|---------|-------|-----------|
| low | — | эскалации нет |
| med | 3 подряд неудачных build/golden | repair переключается на `deepseek-pro` |
| high | 1 неудачная итерация | repair сразу на `deepseek-pro` |

Точка вставки: `src/pipeline/loop.ts` и `src/pipeline/orchestrator.ts` — вызовы
`new RepairEngineerAgent().fix(...)`; перед вызовом `fix` счётчик подряд неудачных
итераций сверяется с порогом, и при срабатывании в `fix` передаётся
`{ model: resolveEscalationModel('repair') }`.

> Правило «каскад»: **сначала дешёвое → оракул → эскалация только на провале.**
> Средняя стоимость ≈ Flash, итоговое качество ≈ Pro.

---

## 6. Резолвер и конфигурация

### 6.1 Новый модуль `src/llm/routing.ts`

```ts
type LlmTier  = 'auto' | 'flash' | 'pro';
type LlmLevel = 'low' | 'med' | 'high';
type PipelinePhase = 'intake' | 'spec' | 'codegen' | 'repair';
type ReasoningEffort = 'low' | 'high' | 'max';

resolveTier(raw?: string): LlmTier        // из OSNOVA_TIER, иначе DEFAULT_TIER
resolveLevel(raw?: string): LlmLevel      // из OSNOVA_LEVEL, иначе DEFAULT_LEVEL
resolveProvider(): string                 // OSNOVA_PROVIDER, без инстанцирования провайдера
resolveModel(phase: PipelinePhase, tier?: LlmTier): string
resolveEscalationModel(phase: PipelinePhase): string
resolveThinking(phase, level?): boolean
resolveReasoningEffort(phase, level?): ReasoningEffort | undefined
resolveTemperature(phase, level?): number | undefined
resolveMaxTokens(phase, level?): number
shouldEscalateToPro(phase, level?, consecutiveFailures?, tier?): boolean

// Единая точка входа для агентов:
resolvePhaseRouting(phase, opts?: { tier?, level?, model? }): PhaseRouting
routingSummary(tier?, level?): readonly PhaseRouting[]
```

> Уточнение к первоначальной спеке: из `resolveModel` убран неиспользуемый параметр
> `level` (модель определяется тиром), а `shouldEscalateToPro` получил 4-м аргументом
> `tier` — чтобы проверка `tier=auto` жила внутри резолвера, а не на стороне вызова.

Семантика `resolveModel`:

1. Явный override фазы (`OSNOVA_MODEL_INTAKE` и т.п., §6.3) — приоритет.
2. DeepSeek: тир → `deepseek-flash` / `deepseek-pro`.
3. Другие провайдеры (`qwen-cli`, `ollama`): тир **не применяется**, возвращается
   `OSNOVA_MODEL ?? getDefaultModel(provider)`. Аналогично `reasoning_effort` —
   best-effort, игнорируется провайдерами, у которых его нет.

### 6.2 Переменные окружения

```env
OSNOVA_TIER=auto        # auto | flash | pro
OSNOVA_LEVEL=med        # low | med | high
```

### 6.3 (опционально) Посфазные override — по прецеденту `OSNOVA_INTELLIGENCE_MODEL`

```env
# OSNOVA_MODEL_INTAKE=deepseek-flash
# OSNOVA_MODEL_SPEC=deepseek-flash
# OSNOVA_MODEL_CODEGEN=deepseek-flash
# OSNOVA_MODEL_REPAIR=deepseek-pro
```

Нужны для ручного точечного переопределения, не для повседневного запуска.

---

## 7. Кэш контекста — бесплатный множитель экономии

`DeepSeekProvider` уже возвращает `prompt_cache_hit_tokens`, но значение нигде не
используется. Попадание в кэш стоит **5× дешевле** промаха ($0.2 vs $1/М).

Правила максимизации попаданий:

1. **Стабильные части промпта — в начало**, изменяемые — в конец. У `RepairEngineer`
   это уже так: большой `SYSTEM_PROMPT` идёт первым и не меняется между итерациями.
2. Не перегенерировать `system`-промпт и few-shot примеры внутри цикла repair.
3. Следить, чтобы spec/golden-префикс не менялся между repair-итерациями.

Ожидаемый эффект: основная часть input-токенов повторных вызовов становится
cache-hit → ещё ~3–5× экономии на input без смены модели.

---

## 8. Правки в `DeepSeekProvider` (обязательны для reasoning)

Уточнено по официальной доке DeepSeek «Thinking Mode»:

1. **Thinking-режим включён по умолчанию** (effort = `high`). Поэтому провайдер
   отправляет явный тумблер `{"thinking": {"type": "enabled" | "disabled"}}` — иначе
   уровень Low физически не смог бы выключить reasoning.
2. **`reasoning_effort`** — top-level поле тела запроса, ступени `low | high | max`
   (в API `medium`→`high`, `xhigh`→`high`, т.е. осмысленных ступеней три).
3. **`temperature` в thinking-режиме игнорируется** (без ошибки, но и без эффекта) —
   поэтому `buildBody` не отправляет temperature, когда thinking включён.
4. **`reasoning_content`** — CoT приходит отдельным полем рядом с `content`
   (`choices[0].message.reasoning_content`, в стриме — `delta.reasoning_content`).
   Провайдер его читает и возвращает как `reasoningContent`. Обратно в API передавать
   не нужно (запросы без `tools`).
5. **`maxTokens` и reasoning** — при включённом thinking лимит удваивается
   (`resolveMaxTokens`), иначе рассуждения обрежутся до финального ответа.
6. **Имена моделей** — `defaults.ts` и `.env` сменить `deepseek-chat` →
   `deepseek-flash` (старое имя уйдёт 24.07.2026).

---

## 9. Поверхность изменений — реализовано

| # | Файл | Что | Статус |
|---|------|-----|--------|
| 1 | `src/llm/routing.ts` (новый) | резолверы + типы + таблицы §4/§5 | ✅ |
| 1b | `src/llm/routing.test.ts` (новый) | 24 теста: матрица, тиры, эскалация, override | ✅ |
| 2 | `src/llm/DeepSeekProvider.ts`, `src/llm/types.ts` | `thinking`, `reasoning_effort`, `reasoningContent` (§8) | ✅ |
| 3 | `src/llm/defaults.ts` | `deepseek-chat` → `deepseek-flash` | ✅ |
| 4 | `src/agents/intake-agent.ts` (2 места), `OsnovaCodegen.ts`, `RepairEngineer.ts` | `OSNOVA_MODEL` → `resolvePhaseRouting(...)` | ✅ |
| 5 | `src/pipeline/loop.ts`, `src/pipeline/orchestrator.ts` | счётчик неудач + `shouldEscalateToPro` + modelId в трейсе | ✅ |
| 6 | `src/llm/index.ts` | реэкспорт публичного API `routing.ts` | ✅ |
| 7 | `pipeline.yaml` | декларативный блок `llmRouting` (источник правды — `routing.ts`) | ✅ |
| 8 | `.env.example`, `docs/llm-providers-v1.md` | `OSNOVA_TIER`/`OSNOVA_LEVEL`, новые имена моделей | ✅ |

---

## 10. Риски и что легко сломать

- **`reasoning_effort` работает только при включённом thinking** — поэтому режим
  (`thinking: enabled/disabled`) задаётся отдельным флагом, а не выводится из effort.
- **Thinking включён у API по умолчанию** — «ничего не отправлять» = reasoning `high`,
  а не выключенный reasoning: для Low тумблер нужно гасить явно.
- **`temperature` в thinking-режиме не действует** — не ожидать от неё влияния на Med/High.
- **Reasoning-ответ = `reasoning_content` + `content`** — игнорировать первое нельзя.
- **Не кидать repair на Pro по умолчанию** — Pro ограничен по throughput, а repair повторяется.
- **Тир/уровень DeepSeek-специфичны** — для `qwen-cli`/`ollama` деградируют к `OSNOVA_MODEL`.

---

## 11. Этап 2 — уточнение чисел по реальным трейсам (DEBT)

Матрица §4 и пороги §5 — **стартовые эвристики**, заданные на ощущениях. Их надо
подтвердить данными. Трейсы уже пишутся в `runs/loop-traces.jsonl` с полями
`modelId`, `qualityScore`, `errorKind`, `durationMs`, `phase`, `iteration`.

План этапа 2:

1. Агрегатор по `runs/loop-traces.jsonl` (расширение `scripts/trace-viewer.ts`):
   распределение итераций по фазам, где застревает Flash, сколько repair реально
   нужно, фактический `cacheHitTokens`/`total` на вызов.
2. Пересчитать порог эскалации (`med`-порог = медианное число repair до успеха).
3. Скорректировать матрицу §4 и переписать числа в `routing.ts`.

---

## 12. Открытые решения

- [ ] Нужен ли `best-of-2` на codegen при `level=high` (2 кандидата, оракул выбирает)?
- [ ] Вести ли отдельный счётчик стоимости за прогон (руб/run) для A/B тира/уровня?
- [ ] Наследовать ли `OSNOVA_TIER`/`OSNOVA_LEVEL` в `self-improve`/`resident`-контуры?
- [ ] `temperature` для codegen на Med/High (0.3/0.4) сейчас недостижима: там уже
  включён thinking, который её игнорирует. Либо убрать как мёртвые значения, либо
  оставить как задел под non-thinking codegen.
- [ ] CLI-флаги `--tier/--level` (сейчас только env-переменные).
