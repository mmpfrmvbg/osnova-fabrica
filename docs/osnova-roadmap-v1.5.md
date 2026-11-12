<!-- doc-status: superseded -->
# ОСНОВА — Роадмап проекта

> Версия: v1.5 · Составлен: 2026-03-21  
> Изменения v1.5: blame-mode → бинарный поиск log₂(N), regression-check CI на post-merge push
> Изменения v1.4: blame-mode в regression gate, Anti-RFC timeout (14 дней), Decision Journal как память Qwen,
>   L-3 перемещён в Уровень 4, CVT weekly report с 4-й недели, альтернативный beta-gate,
>   Language Complexity Score, Mutation Testing, Trace Replay, Shadow Mode
> Изменения v1.3: исправлен CI language-surface job (tj-actions/changed-files вместо contains())
> Изменения v1.2: golden-gate CI на все PR (`src/**`), расширение S-3
> Изменения v1.1: bootstrap RFC, Competitor Velocity Tracker на Уровень 0, beta-gate, regression gate в конституцию  
> Источники: RFC/Anti-RFC Backlog v1, Architecture v1.1, Language Steward v1, Intelligence Module v1.2, Master Prompt

---

## Принципы (конституция роадмапа)

Каждый уровень подчиняется этим правилам без исключений:

| Принцип | Правило |
|---------|---------|
| **Двухфазный протокол** | Phase A (docs / golden / few-shot) → Phase B (компилятор / рантайм). Canary красный → откат Phase B, Phase A остаётся |
| **Blast radius** | `max_files_changed ≤ 5`; `language-registry.ts` в `forbidden_paths` при инфра-задачах |
| **Deterministic first** | Все измерения — TypeScript-скрипты (0 Qwen req); LLM только для DIAGNOSE/PROPOSE |
| **Anti-RFC перед RFC** | Любую боль языка сначала проверить teaching-слоем (few-shot, repair, prompt); синтаксис меняется только если Anti-RFC не помог |
| **Escalate-to-human** | CI падает 2 раза подряд ИЛИ `dataset_health.score < 0.8` → `report_to_pm` + STOP FACTORY |
| **Regression gate** | Если `semantic_errors_in_success > 0` на любом уровне → запустить **blame-mode**: бинарный поиск (log₂(N) шагов) — `analyzeLanguageHealth()` на середине диапазона между последним зелёным и текущим красным, сужать до виновного коммита → откатить **виновный RFC** (не обязательно последний) + STOP FACTORY |

---

## Уровень 0 — Честная основа

> **Цель:** устранить «ложную истину» — semantic errors in success, нечестный health score, токсичный датасет.
> Без этого уровня все метрики выше — ненадёжны.

| ID | Задача | Файлы | Risk | Auto-approve |
|----|--------|-------|------|--------------|
| **I-1** | Вынести `blocking kinds` из `gateChecker.ts`, `orchestrator.ts`, `RepairEngineer.ts` в единый `language-registry.ts` | `src/compiler/language-registry.ts` | medium | false |
| **I-2** | Schema-validation трейсов через Zod в `traceStore.ts` — невалидные записи не попадают в датасет | `src/traceStore.ts` | low | true |
| **I-3** | Добавить мета-поля в `dataset-v1.jsonl`: `repairAttempts`, `semanticErrorCount`, `traceId`, `category` | `src/export-dataset.ts` | low | true |
| **I-4** | Нормализовать `calcHealthScore()` до `[0, 1]` через clamp | `src/tools/analyze-language-health.ts` | low | true |
| **CVT-0** | Запустить Competitor Velocity Tracker: hh.ru API snapshot → `runs/competitor-snapshots.jsonl`, baseline week | `src/intelligence/sources/hh.ts` | low | true |
| **RC-0** | Regression-check CI job: `on: push → branches: [main], paths: [src/**]` → `npm run analyze-language-health` → при `semantic_errors_in_success > 0` запускает blame-mode + `report_to_pm` | `.github/workflows/regression-check.yml` | low | true |

> **RC-0 — кто запускает blame-mode:** regression-check срабатывает автоматически на каждый `push` в `main` по `src/**`. Регрессия обнаруживается сразу после merge, а не через часы или дни scheduled-джоба.

```yaml
# .github/workflows/regression-check.yml
on:
  push:
    branches: [main]
    paths: ['src/**']
jobs:
  regression-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0          # нужна полная история для blame-mode bisect
      - run: npm ci
      - run: npm run analyze-language-health
      - name: blame-mode bisect on regression
        if: failure()
        run: npm run blame-mode-bisect   # log₂(N) шагов между last-green и HEAD
      - name: report to PM
        if: failure()
        run: npm run report-to-pm -- --priority CRITICAL --stop-factory
```

> **CVT-0 запускается здесь, а не на Уровне 8.** Данные competitor velocity нужно копить с первого дня — через 3 месяца baseline должен быть за весь период, а не за последние недели.

**Gate выхода:** `semantic_errors_in_success = 0` подтверждено детерминированно; regression-check CI job зелёный на тестовом push.

---

## Уровень 1 — Наблюдаемость Steward (0 Qwen-запросов)

> **Цель:** включить Language Steward как живой инструмент измерения — детерминированно, без LLM.

| ID | Задача | Суть |
|----|--------|------|
| **S-1** | AST-майнинг `top_workaround_patterns` | Обнаружение catchVar, sentinel, обходных паттернов в success-трейсах |
| **T-8** | Teachability score в `LanguageHealthReport` | Доля задач, где LLM решила с первой попытки |
| **S-7** | `windowMode: lastN / lastHours24` в Steward | Гибкие окна анализа трейсов |
| **LLM Monitoring** | `llm-usage-report.py`, лимит 1000 req/день, Telegram 12:00 + 00:00 MSK | Контроль бюджета Qwen |

**Gate выхода:** `analyzeLanguageHealth()` возвращает стабильный `LanguageHealthReport` с `triggers_fired` без LLM.

---

## Уровень 2 — Steward как рабочий процесс RFC

> **Цель:** замкнуть петлю MEASURE → DECIDE → PROPOSE в автоматический цикл.

> **Bootstrap RFC (обязательный первый шаг):** перед запуском авто-approve создать первый RFC вручную
> (например, I-1 оформить как RFC-001) и провести его через полный loop — Steward → Telegram approval →
> CursorTaskContract → CI → merge. Это проверяет, что loop работает, до того как система начнёт
> создавать RFC автоматически.

| ID | Задача | Суть |
|----|--------|------|
| **S-2** | Поле `type: rfc / anti-rfc` в интерфейсе RFC | Все изменения явно классифицируются |
| **S-5** | Decision Journal `decisions.jsonl` | Каждое решение Steward: `rationale`, `alternatives`, `risk`. Qwen-оркестратор загружает последние N записей как контекст при каждом PLAN-шаге — журнал является **памятью**, а не архивом |
| **S-3** | CI-хук `.github/workflows/steward-on-change.yml` | Изменения Language Change Surface → авто-запуск `analyze_language_contract` + `run_golden_case`. **v1.2:** расширить `paths` до `src/**` (не только language surface) + добавить `golden-gate` job: `npm run golden` — обязательное условие merge для любого PR |
| **S-4** | Авто-approve RFC с `risk: low` и пустой Phase B | Telegram-кнопка, без участия человека |

**Конфигурация golden-gate (`.github/workflows/steward-on-change.yml`):**

```yaml
on:
  pull_request:
    paths:
      - 'src/**'          # не только language surface — любой src
jobs:
  golden-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run golden   # 100% pass = обязательное условие merge

  language-surface:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: tj-actions/changed-files@v44
        id: changed
        with:
          files: 'src/compiler/**,src/runtime/**'
      - if: steps.changed.outputs.any_changed == 'true'
        run: npm ci
      - if: steps.changed.outputs.any_changed == 'true'
        run: npm run analyze-language-contract
      - if: steps.changed.outputs.any_changed == 'true'
        run: npm run canary-run
```

> **Разница с v1.1:** S-3 в v1.1 запускал golden только при изменениях Language Change Surface. Теперь `golden-gate` запускается на любой PR в `src/**` — инфра-изменения (I-5, I-6) и teaching-изменения (T-1..T-7) тоже проходят через 100% golden. Это закрывает gap: `golden_stability: 100%` в Beta-gate теперь проверяется автоматически, а не на доверии.
> 
> **Разница с v1.2:** `language-surface` job использует `tj-actions/changed-files@v44` вместо `contains(github.event.pull_request.changed_files, ...)`. `changed_files` в GitHub Actions API — это число (количество файлов), не список путей; `contains()` на числе всегда возвращал `false`. Исправлено на `steps.changed.outputs.any_changed == 'true'`.

**Gate выхода:** bootstrap RFC прошёл полный loop; первый авто-approved RFC создан и слит; `golden-gate` job зелёный на тестовом PR.

---

## Уровень 3 — Anti-RFC: чиним фабрику, не трогая язык

> **Цель:** доказать или опровергнуть, что проблема — в teaching-слое, а не в синтаксисе.
> Каждый Anti-RFC — это гипотеза с измеримым результатом.
>
> **Timeout правило:** Anti-RFC считается просроченной если `canary_run` не запускался > 14 дней → автоматически эскалировать в Telegram: «A-N не проверялась 14+ дней — требует canary_run или явного закрытия».

| ID | Гипотеза | Проверка | Условие перехода к RFC языка |
|----|----------|----------|------------------------------|
| **A-3** | `semantic_errors_in_success = 0` после I-1 | Запустить `analyzeLanguageHealth` после I-1 | Если проблема осталась → L-RFC |
| **A-1** | LLM учится try/catch avoidance через few-shot (3+ примера) | `canary_run` 50 задач, сравнить до/после | Если `avoidance_rate > 0.10` → L-1 |
| **A-4** | `repair_attempts = 1` → SFT-фильтр: «успехи с 3 попыток» не в датасет | `analyzeDatasetHealth` после фильтрации | Если `teachability < 0.7` → L-RFC |
| **A-2** | repairExhausted кластеризованы по категориям задач | `repair-failures.jsonl` группировка | Если кластер однородный → targeted RFC |
| **A-5** | IntakeAgent: spec completeness решается 3+ few-shot | `checkSpec` + `canary_run` | Если провалы остаются → L-5 |

---

## Уровень 4 — Инфра и Teaching (параллельно с уровнями 2–3)

> **Цель:** укрепить фабрику под нагрузку, устранить хрупкость инфры.

| ID | Задача | Risk | Зависимость |
|----|--------|------|-------------|
| **I-5** | Стабилизировать `QwenCliProvider`: snapshot stdout + version-detector | medium | — |
| **I-6** | Auth guard на `POST /task` web-центра | low | — |
| **L-3** | Запретные паттерны в repair-промпте (`forbiddenPatterns` docs + repair-примеры → `return` guard) | low | — |
| **CVT-weekly** | Еженедельный Competitor Health Check: через 4 недели после CVT-0 — первый Telegram-отчёт по `vacancy_count_delta` и `new_skills`; не ждать Уровня 8 | low | CVT-0 |
| **T-1** | Guard в `buildOsnovaPrompt`: assert `N > 0` few-shot | low | — |
| **T-2** | repair-target: передавать `blocking kinds` в repair-промпт | medium | I-1 |
| **T-3** | Snapshot-тест `stripMarkdownFence` (100% success rate) | low | — |
| **T-7** | `checkSpec` в IntakeAgent: валидация полноты spec до codegen | low | — |

---

## ★ Beta-gate: после Уровня 4 — продукт готов к первым клиентам

Перед выходом на beta выполнены все условия:

| Метрика | Порог |
|---------|-------|
| `semantic_errors_in_success` | = 0 |
| `dataset_health.score` | ≥ 0.8 |
| `teachability` | ≥ 0.7 |
| `repair_exhausted_rate` | < 0.15 |
| `golden_stability` | 100% (нет регрессий) — проверяется автоматически через `golden-gate` CI job на каждый PR в `src/**` |
| Bootstrap RFC | прошёл полный loop |
| Anti-RFC A-1..A-5 | все проверены (результат зафиксирован) |

> После Уровня 4 фабрика генерирует приложения на Основа с измеримым, честным качеством.
> Можно показывать продукт первым клиентам и собирать реальные задачи в трейсы.
>
> **Альтернативный Beta-gate** (если A-1 провалилась и L-1 ещё в работе):
> `avoidance_rate < 0.25` (LLM редко попадает в catchVar-ловушку) + все остальные 6 метрик выполнены
> → beta допустима с known limitation: «Result type в разработке, обходные паттерны возможны».
> L-1 продолжается параллельно с beta — не блокирует первых клиентов.

---

## Уровень 5 — Языковые RFC: низкий риск (авто-approve)

> Запускается только после подтверждения Anti-RFC уровня.
> Phase A обязательна перед Phase B.
> **Regression gate активен:** merge любого RFC → немедленная проверка `semantic_errors_in_success`.

| ID | Конструкция | Phase A | Phase B |
|----|-------------|---------|---------|
| **L-6** | Многострочные выражения | golden × 5, docs | lexer, codegen flatten |
| **L-8** | `нет` вместо `null` / sentinel | docs, golden | лексер, семантика |
| **L-10** | Алиасы для распространённых идиом | golden × 5, docs | parser, codegen |
| **L-7** | 3-символьные сокращения ключевых слов | golden, few-shot | лексер `...` |

> **Shadow Mode** (обязателен перед Phase B каждого RFC): компилятор принимает новую конструкцию, но не исполняет — только логирует попытки LLM. Критерий перехода к Phase B: LLM использует конструкцию корректно в **≥ 80% случаев** за 50+ трейсов. Если < 80% → добавить few-shot, повторить Shadow Mode.

---

## Уровень 6 — Языковые RFC: средний риск (human approve)

| ID | Конструкция | Phase A | Phase B |
|----|-------------|---------|---------|
| **L-2** | Пространства имён / `я.поле` | golden × 3, docs, few-shot | lexer, parser, codegen |
| **L-4** | Форматирование вывода | golden, few-shot | lexer, codegen |
| **L-9** | Деструктуризация в присваивании | golden, docs | parser, codegen |

---

## Уровень 7 — Языковые RFC: высокий риск (RFC + human + full canary)

> Только при провале Anti-RFC A-1 или A-5. Полный canary перед слиянием Phase B.
>
> **Mutation Testing** (обязателен перед каждым Level 7 RFC): автоматически вносить мелкие синтаксические мутации в golden-программы и проверять что компилятор их отвергает. Цель: убедиться что golden достаточно строгие — можно сломать семантику и golden пройдут только если тест не покрывает edge case.
>
> **Trace Replay** (финальная проверка перед merge Phase B): взять 20 успешных трейсов из последнего месяца → переиграть через текущую фабрику → `success_rate_replay ≥ baseline`. Если упал — регрессия всей цепочки (промпт + LLM + компилятор + gate), а не только компилятора.

| ID | Конструкция | Предусловие | Cascade |
|----|-------------|-------------|---------|
| **L-1** | Result type `ok(v) / ошибка(e)` (Rust-style) | A-1 не закрыл catchVar avoidance | grammar → parser → codegen → semantic → golden → few-shot → docs |
| **L-5** | Named arguments в вызовах | A-5 не решила проблему spec completeness | parser `f(a=...)` → semantic named call sites |

---

## Уровень 8 — Observability и Intelligence (полный запуск)

> **Цель:** система видит себя и внешний мир; эволюция становится управляемой и измеримой.
> Competitor Velocity Tracker уже работает с Уровня 0 — здесь подключаются остальные источники и полный pipeline.

### Language Complexity Score

Измеряется начиная с Уровня 5 (первый языковой RFC) и отслеживается еженедельно:

```
LCS = уникальных конструкций в language-registry × средняя длина golden в токенах
```

| Сигнал | Действие |
|--------|----------|
| LCS растёт быстрее teachability | Остановить языковые RFC → сначала Anti-RFC |
| LCS стабилен при росте teachability | RFC безопасны, язык "переваривается" LLM |

### Observability

| ID | Задача | Суть |
|----|--------|------|
| **T-4** | A/B Genetic Prompting через `canary_run` (50+ трейсов) | Эволюция few-shot без изменений языка |
| **TR** | Trace Replay: 20 исторических трейсов → переиграть → `success_rate_replay ≥ baseline` | Регрессионный тест всей цепочки: промпт + LLM + компилятор + gate |
| **MT** | Mutation Testing: синтаксические мутации golden → компилятор обязан их отвергнуть | Проверка строгости golden-тестов перед Level 7 RFC |
| **T-5** | Балансировка few-shot по категориям (из meta I-3) | `analyzeDatasetHealth` следит за balance |
| **T-6** | `repair-failures.jsonl` + группировка по `last_error_kind` | Видимость провалов repair |
| **S-6** | Expressiveness Report: LOC Основа vs TypeScript/Rust (3 бенчмарка) | Объективная картина выразительности |
| **S-8** | Week-over-week health diff → Telegram (воскресенье 10:00 MSK) | Тренд, а не снимок |

### Intelligence Module v1.2 (полный запуск)

```
06:00 MSK  Collector → Pre-filter (0 Qwen) → Dedup
06:45 MSK  Decay check: watching → stale (30 дней)
08:00 MSK  Digest Telegram: топ-10 сигналов за 24ч
10:00 MSK  Weekly recap: watching, stale, lifecycle updates
```

**Источники сигналов:**

| Категория | Источник | Приоритет |
|-----------|----------|-----------|
| language | arXiv cs.PL (codegen, bytecode, VLIW, DSL, compiler) | 1 |
| llm | arXiv cs.LG (LoRA, few-shot, RLHF for code), HuggingFace Hub | 2 |
| llm | GitHub Releases: ollama, llama.cpp | 3 |
| platform | GitHub Releases: TypeScript, MCP spec, Vitest | 3 |
| competitor | hh.ru API *(baseline с Уровня 0, weekly report с 4-й недели)*, МойСклад RSS, Эвотор RSS, Контур RSS | 4 |
| market | vc.ru RSS, Habr RSS | 4 |

**Signal Lifecycle:**
```
detectedAt → reviewedAt → linkedRfc → rfcStatus(draft→accepted→released) → languageVersion → releasedAt
```

**ROI сигнала:** `get_signal_roi()` — измеримый путь от внешнего сигнала до прироста success rate.

---

## Итоговая карта зависимостей

```
Уровень 0: I-1 → I-2 → I-3 → I-4
           CVT-0 (competitor snapshot, baseline)
           RC-0 (regression-check CI, post-merge, blame-mode log₂N)
                ↓ CVT-weekly начинается через 4 недели
Уровень 1: S-1, T-8, S-7, LLM Monitoring
                ↓
Уровень 2: Bootstrap RFC (вручную) → S-2, S-5[память Qwen], S-3, S-4
                ↓
Уровень 3: A-3 → A-1 → A-4 → A-2 → A-5  (Anti-RFC, timeout 14 дней)
          ↙                    ↓ (если Anti-RFC не помог)
Уровень 4: I-5, I-6, L-3,    Уровни 5–7: L-RFC
           T-1..T-7            Shadow Mode → Phase B → Trace Replay
                ↓
         ★ BETA-GATE (или альтернативный если A-1 в работе)
                ↓
Уровень 8: T-4, TR, MT, T-5, T-6, S-6[LCS], S-8
           Intelligence v1.2 (полный запуск всех источников)
```

**Regression gate** работает на всех уровнях начиная с 0:
```
on: push → main → src/**
  → npm run analyze-language-health
  → semantic_errors_in_success > 0?
      → blame-mode bisect: log₂(N) шагов между last-green и HEAD
      → найти виновный коммит
      → откатить ВИНОВНЫЙ RFC (не обязательно последний)
      → STOP FACTORY
      → report_to_pm (CRITICAL)
```

---

## Статистика бэклога

| Категория | Всего | Low risk | Medium risk | High risk | Auto-approve |
|-----------|-------|----------|-------------|-----------|--------------|
| Инфра (I) | 7 | 5 | 2 | 0 | 5 |
| Язык (L) | 10 | 6 | 3 | 1 | 6 |
| Teaching (T) | 8 | 6 | 2 | 0 | 6 |
| Steward Process (S) | 8 | 8 | 0 | 0 | 8 |
| Anti-RFC (A) | 5 | 5 | 0 | 0 | 5 |
| **Итого** | **38** | **30** | **7** | **1** | **30 (79%)** |

> 79% позиций бэклога auto-approvable. Человек нужен только для 8 из 38 изменений.

---

## Changelog

| Версия | Изменение |
|--------|-----------|
| v1.5 | **Regression-check CI** (`RC-0`): `on: push → main → src/**` → автозапуск blame-mode; регрессия обнаруживается сразу после merge |
| v1.5 | **Blame-mode bisect**: уточнён как log₂(N) шагов (не N), существенно при 20+ RFC между проверками |
| v1.4 | **Blame-mode** в regression gate: bisect от последнего зелёного, откат виновного RFC |
| v1.4 | **Anti-RFC timeout**: просрочена если `canary_run` не запускался > 14 дней → Telegram-эскалация |
| v1.4 | **Decision Journal как память Qwen**: загружается как контекст при каждом PLAN-шаге |
| v1.4 | **L-3** перемещён с Уровня 5 в Уровень 4 (teaching, не языковое изменение) |
| v1.4 | **CVT weekly report** с 4-й недели работы CVT-0, не ждать Уровня 8 |
| v1.4 | **Альтернативный Beta-gate** при провале A-1: `avoidance_rate < 0.25` + остальные метрики |
| v1.4 | **Language Complexity Score** на Уровне 8: LCS = конструкции × avg golden tokens |
| v1.4 | **Mutation Testing** обязателен перед Level 7 RFC |
| v1.4 | **Trace Replay** как финальная проверка перед merge Phase B |
| v1.4 | **Shadow Mode** обязателен перед Phase B каждого языкового RFC (≥ 80% корректных за 50+ трейсов) |
| v1.3 | **CI fix:** `language-surface` job — заменён `contains(github.event.pull_request.changed_files, ...)` на `tj-actions/changed-files@v44`; `changed_files` — это число, не список путей; без этого job никогда не срабатывал |
| v1.2 | **S-3 расширен:** `golden-gate` CI job запускается на любой PR в `src/**`, не только на Language Change Surface — закрывает gap в автоматической проверке `golden_stability: 100%` |
| v1.1 | Добавлен **Regression gate** в конституцию (откат последнего RFC при `semantic_errors_in_success > 0`) |
| v1.1 | **CVT-0** (Competitor Velocity Tracker) перенесён с Уровня 8 на Уровень 0 — baseline копится с первого дня |
| v1.1 | Добавлен **Bootstrap RFC** на Уровне 2 — первый RFC создаётся вручную для проверки loop |
| v1.1 | Добавлен **Beta-gate** после Уровня 4 — явный критерий готовности к первым клиентам |
| v1.0 | Первая версия |

---

*Роадмап сгенерирован на основе: `osnova-rfc-backlog-v1.md`, `osnova-architecture-v1.1.md`, `osnova-language-steward-v1.md`, `osnova-intelligence-module-v1.2.md`, `osnova-master-prompt.md`*
