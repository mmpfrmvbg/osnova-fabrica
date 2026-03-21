# ARCHITECTURE-AS-IS.md

## Что реально работает (production-ready компоненты)
- `src/compiler/*` (lexer/parser/AST/compiler/codegen/semantic): компилирует `.osnova` в байткод (JSON) и выдаёт ошибки на всех фазах; покрыт unit-тестами `vitest`.
- `src/runtime/vm/*` (`interpreter.ts`, `bytecode.ts`) + `src/runtime/goldenApps.ts`: исполняют байткод на VM, включая control-flow и syscalls; golden-аппы используются как проверка качества через `runGoldenCheck()`.
- `src/pipeline/orchestrator.ts`: запускает линейный пайплайн фаз `intake → spec_generation → codegen → build → golden_check → [repair]` и сохраняет результат в трейсы.
- `src/pipeline/gateChecker.ts`: реализует “качество/переходы” через `checkG1/checkG2/checkG3`, которые реально определяют поведение оркестратора.
- LLM-провайдеры `src/llm/*`: `QwenCliProvider`, `DeepSeekProvider`, `OllamaProvider` — реальные реализации `complete()`; используются агентами кодогенерации/ремонта.
- Агенты `src/agents/*`:
  - `IntakeAgent` (intent/spec) — используется в оркестраторе;
  - `OsnovaCodegenAgent` — генерирует `.osnova` через промпт и few-shot;
  - `RepairEngineerAgent` — исправляет код по ошибкам.
- Трейсы:
  - `src/trace/traceStore.ts` — запись JSONL в `./runs/traces.jsonl` (или `OSNOVA_TRACE_DB`);
  - `src/scripts/trace-viewer.ts` — чтение/агрегация трейсов.
- Экспорт датасета:
  - `src/scripts/export-dataset.ts` — читает `runs/traces.jsonl`, фильтрует и формирует `runs/dataset-v1.jsonl` (SFT формат).
- Runtime “инфраструктура”:
  - `src/runtime/run.ts` и `src/runtime/sandbox.ts` — обеспечивают запуск основа-приложений с sandbox и манифестами;
  - `src/runtime/ui.ts` — UI-слой для windowed-режима через сервер событий (используется runtime fixture/cli сценариями).
- CLI/Server:
  - `src/cli.ts` — точка входа, запускает `runPipeline(task)`;
  - `src/center/server.ts` + `src/center/index.ts` — web-страницы + API для запуска пайплайна и просмотра трейсов/реестра.
- MCP-сервер (`@modelcontextprotocol/sdk`):
  - `src/mcp-server.ts` — stdio-транспорт MCP; регистрирует tools: `run_patch_agent` (вызов patch-agent / Qwen + git apply), `analyze_trace_health` и `analyze_dataset_health` (разбор `runs/traces.jsonl`), `run_golden_case` (прогон golden-runner по фикстуре), `read_repo` (обзор исходников). Нужен для интеграции с IDE/агентами, которые говорят по MCP; не является частью основного LLM-пайплайна `runPipeline`.

## Что работает, но хрупко (работает сейчас — может сломаться)
- Политика gates для semantic errors задана кодом (не конфигом): в `src/pipeline/gateChecker.ts` блокирует только подмножество `semanticErrors.kind`, а остальное считается “неблокирующим”. Это напрямую влияет на то, что попадёт в success/partial и в ремонт.
- `RepairEngineerAgent` “видит” только часть semanticErrors: в `src/agents/RepairEngineer.ts` и `src/ pipeline/orchestrator.ts` semanticErrors фильтруются по узкому списку kind’ов, поэтому silent semantic ошибки могут не стать целью ремонта.
- JSONL-данные трейсов не валидируются схемой при записи:
  - `src/trace/traceStore.ts` всегда пишет `JSON.stringify(entry)` без runtime schema-validation;
  - любые неожиданные формы полей могут “утечь” в `runs/traces.jsonl` и дальше в экспорт датасета/аналитику.
- `runs/dataset-v1.jsonl` сейчас без `meta`-поля в каждой записи:
  - текущий `runs/dataset-v1.jsonl` содержит только `input_text`/`target_text`, поэтому последующие пайплайны и аудит качества менее контролируемы.
- `QwenCliProvider.complete()` парсит ответ Qwen через ожидание формата “последнего result.success event” (и fallback на raw output). Любое изменение формата stdout от `qwen` может сломать кодогенерацию/repair.
- LLM-подсказки завязаны на “строгие” инструкции промпта:
  - промпт требует “верни только код без markdown”;
  - если модель начнёт возвращать markdown или дополнительные секции, downstream-обработка может начать давать некорректный `.osnova` (хотя есть `stripMarkdownFence`).
- Web-центр `src/center/server.ts` не имеет аутентификации и вызывает пайплайн по POST `task` напрямую:
  - при реальном использовании это делает систему уязвимой к неконтролируемым запускам/нагрузке/засорению `runs/traces.jsonl`.

## Что существует только на бумаге (мёртвые конфиги, архивные docs, заглушки)
- YAML-конфиги “архитектуры” (не читаются runtime-кодом):
  - `pipeline.yaml`
  - `gates.yaml`
  - `roles.yaml`
  - `spec.yaml`
- “Сгенерированные” артефакты:
  - `src/compiler/generated/` (фактически пустой placeholder: есть ` .gitkeep`).
- Архивные/исторические docs с устаревшими контрактами синтаксиса (фактически не используются как канонический источник):
  - `docs/grammatika-v0.1.md`
  - `docs/compiler-v0.1.md`
  - `docs/lexer-v0.1.md`
  - `docs/parser-v0.1.md`
  - `docs/tokenization-v0.1.md`
  - `docs/pipeline-llm-osnova.md`
  - `docs/trace-format-v0.1.md`
  - `docs/roadmap-osnova-ideal-os.md` (vision/архив; канон — `docs/roadmap.md`)

## Неявные контракты (вещи, которые “все знают” но нигде не написано)
- “Что такое success” в контексте трейсов:
  - определяется `compileToBuildReport()` в `src/pipeline/orchestrator.ts` (через `r.compilerSuccess && lexer/parser errors == 0 && blocking semanticErrors отсутствуют`).
- “Какие semantic kind’ы считаются blocking”:
  - задано напрямую в `src/pipeline/gateChecker.ts` и повторяется/дублируется в `src/pipeline/orchestrator.ts` и `src/agents/RepairEngineer.ts`.
- “Список blocking semantic kinds”:
  - дублируется в `src/pipeline/gateChecker.ts`, `src/pipeline/orchestrator.ts` (compileToBuildReport) и `src/agents/RepairEngineer.ts` как три независимых inline-списка;
  - единого const/enum источника нет, поэтому правка одного списка может оставить остальные рассинхронизированными без компиляторной ошибки.
- “Когда repair применяется”:
  - зависит от `checkG2` и `checkG3`, а также дополнительных условий `qualityScore` в оркестраторе (`partial_success` без repair при диапазоне).
- Формат кода `.osnova`, ожидаемый LLM/скриптами:
  - требуется модуль в начале файла и `конец` в конце;
  - запрещается markdown и лишний текст;
  - ошибки моделей конвертируются через `stripMarkdownFence`, но не через полноценный parser.
- Контракт структуры трейса:
  - “Источник правды” по документам заявлен как `src/trace/types.ts` и `docs/traces-v1.md`, но schema-validation при записи отсутствует, и на практике потребители завязаны на конкретные поля.
- Few-shot набор для `OsnovaCodegenAgent`:
  - строится из `docs/golden-tests.json` и категорий;
  - если `golden-tests.json` сменит структуру/поля, few-shot сборка начнёт давать пустые примеры.
- “Список запрещённых конструкций для генерации”:
  - берётся из `language-registry.ts` (`forbiddenPatterns`), а не из `.cursorrules` напрямую.
- Golden runner как oracle качества:
  - считается главным критерием “работает/не работает” (в отличие от coverage), при этом `g3` имеет отдельные правила “qualityScore/ diff”.

## Карта зависимостей (кто кого использует)
- `src/pipeline/orchestrator.ts → src/agents/IntakeAgent` (получает `intent`)
- `src/pipeline/orchestrator.ts → src/agents/IntakeAgent.generateSpec()` (получает `spec`)
- `src/pipeline/orchestrator.ts → src/agents/OsnovaCodegenAgent` (генерирует `.osnova`)
- `src/pipeline/orchestrator.ts → src/compiler/compiler.compileSource()` (компилирует в байткод)
- `src/pipeline/orchestrator.ts → src/pipeline/gateChecker.checkG1/checkG2/checkG3` (решает переходы/repair)
- `src/pipeline/orchestrator.ts → src/runtime/goldenApps.runGoldenCheck()` (исполняет на VM + сравнивает с golden)
- `src/pipeline/orchestrator.ts → src/agents/RepairEngineerAgent` (repair-loop)
- `src/pipeline/orchestrator.ts → src/trace/traceStore.saveTrace()` (запись JSONL)
- `src/agents/OsnovaCodegenAgent → src/pipeline-llm/buildOsnovaPrompt()` (строит промпт на основе `language-registry.ts`)
- `src/agents/OsnovaCodegenAgent → docs/golden-tests.json` (few-shot примеры)
- `src/agents/RepairEngineerAgent → src/pipeline-llm/buildOsnovaRepairPrompt()` (подсказки + запреты + stable syscalls)
- `src/agents/* → src/llm/index.getLLMProvider()` (вызывает LLM provider)
- `src/scripts/export-dataset.ts → runs/traces.jsonl` (читает трейсы)
- `src/scripts/trace-viewer.ts → runs/traces.jsonl` (читает трейсы)
- `src/center/server.ts → src/pipeline/orchestrator.runPipeline()` (запуск по API)
- `src/center/server.ts → src/runtime/loadRegistry()` и `src/scripts/trace-viewer`-логика (показ данных)
- `src/runtime/goldenApps.ts → src/runtime/vm/interpreter` (исполнение байткода)

## Один абзац: суть проекта в его текущем состоянии
`osnova-fabrica` — это LLM-управляемый генератор кода на языке Основа, который линейным пайплайном превращает текстовую задачу в `.osnova`, компилирует её в байткод, исполняет на VM и сравнивает результат с golden-эталонами; параллельно ведёт JSONL-трейсы для анализа и экспорта датасета, а “качество/переходы” между фазами определяется реализацией gateChecker и RepairEngineer’ом, причём часть semantic-ошибок осознанно/неявно считается неблокирующей и может проходить в успех. YAML-конфиги присутствуют как архитектурные артефакты, но в текущей реализации не управляют runtime-поведением.

