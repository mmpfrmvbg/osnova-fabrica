# Аудит правдивости планового слоя `.osnova/`

**Дата аудита:** 2026-09-15
**Область:** `.osnova/epics/**` (20 эпиков `EPK-*.yaml` + 289 вложенных `ATM-*.yaml`), `.osnova/state.yaml`, `.osnova/history/**`, `.osnova/task.yaml`, `.osnova/report.yaml`
**Режим:** только чтение. Ни один файл в `.osnova/` и в `src/` не изменён. `done:`-команды не запускались, тесты не запускались. Создан единственный новый файл — этот отчёт.

---

## 1. Метод проверки

| Что сверялось | Как |
|---|---|
| `scope` каждого эпика `EPK-*.yaml` | каждый путь из списка раскрыт в абсолютный и проверен `os.path.exists()` от корня репозитория |
| `scope` каждого ATM `*.yaml` в подкаталогах `EPK-*/` | та же проверка по каждому элементу |
| `scope`-строки (не списки, напр. `scope: scripts/blocker-sync.ts — scaffold only`) | путь отделялся от аннотации по `—`, `–`, ` - `, `:` |
| пути в `done:` | из команды извлекались все файлы (`PATH_RE`) и каталоги (`DIR_RE`), каждый проверялся на диске |
| `state.yaml` → `recent[].scope` | те же пути проверены повторно и сопоставлены с `result`/`status`/`passrate` |
| «фантомные» имена | для каждого отсутствующего пути выполнен поиск файла с тем же именем по всему дереву (исключая `node_modules`, `.git`) — чтобы отличить «не создано» от «создано под другим именем» |
| вердикты исполнителя | агрегирован `.osnova/history/**` (54 файла, 317 записей `RPT`): `review.reason`, `changed`, `tests` |

Классификация эпика: **подтверждён** — существуют все пути `scope`; **частично** — часть путей есть, часть отсутствует; **не подтверждён** — не существует ни одного пути `scope` (таких нет ни одного эпика).

---

## 2. Проблемные эпики

Отсутствие пути фиксируется как **«нет»** (файла нет нигде в дереве) или **«переименован»** (реализация лежит под другим путём; в скобках — фактический файл).

### 2.1 Эпики, отмеченные как завершённые с фантомными файлами в `scope`

| id | Отсутствующие пути `scope` | `result`/`status`/`passrate` в `state.yaml` | Примечание |
|---|---|---|---|
| **EPK-260329-027** | `src/agents/base.ts` — нет; `src/pipeline-llm/executor.ts` — переименован (`src/pipeline/executor.ts`); `src/intelligence/core.ts` — переименован (`src/intelligence/index.ts`) | `ok` / `ok` / `1.0` | `done: npx vitest run src/` — прогон всего дерева, exit 0 не зависит от этих файлов. В `history` 8 атомов `s: OK`, у части причина `PASS: Qwen review unavailable (quota/budget); auto-approved because done-command exited 0` |
| **EPK-260329-026** | `src/vliw/vliw.test.ts` — нет; `.tmp/blocker-sync.log` — нет | `ok` / `ok` / `1.0` | эталонный случай. ATM-013 (`done: npx vitest run src/vliw/vliw.test.ts`) и ATM-015 ссылаются на несуществующий тест-файл; ATM-003 — на несуществующий лог. В каталоге `src/vliw/` 16 файлов, но `vliw.test.ts` среди них нет |
| **EPK-260329-025** | `src/agents/base.ts` — нет; `src/pipeline-llm/runner.ts` — переименован (`src/runtime/runner.ts`); `.tmp/diagnostics.log` — нет | `ok` / `ok` / `1.0` | 6 ATM из 14 объявляют несуществующие пути; все 8 атомов закрыты с `changed: []` |
| **EPK-260329-023** | `src/compiler/compiler.spec.ts`, `src/runtime/vm.spec.ts`, `src/runtime/interpreter.spec.ts`, `src/agents/intake-agent.spec.ts`, `src/agents/plan-agent.spec.ts`, `src/pipeline/pipeline.spec.ts`, `src/pipeline-llm/llm-pipeline.spec.ts` — **все 7 нет** | `ok` / `ok` / `1.0` | 7 из 8 путей — фантомы; подтверждён только `src/pipeline/types.ts`. Эпик целиком про `*.spec.ts`-валидацию, ни один spec-файл не создан |
| **EPK-260329-022** | `src/pipeline-llm/llm-pipeline.test.ts` — нет | `ok` / `ok` / `1.0` | ATM-016 объявляет этот файл и в `scope`, и в `done:` — файла нет. Эпик про test-coverage, целевой тест отсутствует |
| **EPK-260329-021** | `src/pipeline-llm/index.ts` — переименован (`src/agents/index.ts` / `apps/osiris/src/index.ts`); `.tmp/diagnostics.log` — нет | `ok` / `ok` / `1.0` | ATM-009/010 — один и тот же фантомный модуль `pipeline-llm`, ATM-014 — лог. Все записи `history`: `changed: []`, `tests: 0/0` |

### 2.2 Эпики со статусом `partial` и отсутствующими путями

| id | Отсутствующие пути `scope` | `result`/`status`/`passrate` | Примечание |
|---|---|---|---|
| **EPK-260329-028** | `scripts/blocker-resolver.ts` — нет (реализация в `src/tools/blocker-resolver.ts` и `src/pipeline/blocker-resolver.ts`); `scripts/blocker-check.ts` — нет | `partial` / `partial` / `0.5714` | `done: npx vitest run scripts/blocker-resolver.test.ts` — тест существует и проходит, но проверяет не тот модуль, который заявлен в `scope`. `history`: 4 OK / 3 BLK, BLK-причины — «Diff содержит только обновления метаданных .osnova» |
| **EPK-260329-020** | `src/agents/base.ts` — нет; `src/agents/executor.ts` — переименован (`src/pipeline/executor.ts`) | `partial` / `partial` / `0.7778` | 3 ATM из 12 объявляют фантомные `src/agents/base.ts` и `src/agents/executor.ts` |

### 2.3 Эпик без результата, но с фантомными путями

| id | Отсутствующие пути `scope` | Статус | Примечание |
|---|---|---|---|
| **EPK-260329-030** | `scripts/scaffold-agents.ts` — нет; `scripts/scaffold-pipeline.ts` — нет | **отсутствует в `state.yaml.recent`** (эпик самый новый по `githubissue: 97`) | 8 путей `scope`, подтверждено 6. 6 из 14 ATM ссылаются на два несуществующих scaffold-скрипта, при этом все 14 ATM имеют `status: PENDING`. `done:` при этом указывает на уже существующие `src/agents/` и `src/pipeline/` — то есть критерий завершения выполним без создания заявленных скриптов |

### 2.4 Фантомные пути уровня ATM в эпиках с полностью подтверждённым верхним `scope`

| id эпика | Отсутствующие пути ATM | `result`/`status` |
|---|---|---|
| **EPK-260327-001** | `src/llm/VectorDB.ts`, `src/llm/EmbeddingService.ts` (ATM-PHB-002); `src/agents/SpecArchitect.ts` (ATM-PHB-003); `src/trace/RuleDistiller.ts` (ATM-PHB-004); `src/scripts/prepare-lora-dataset.ts` (ATM-PHB-005) — **5 путей, все нет** | `partial` / `partial` / `0.6667` |
| **EPK-260328-016** | `qwen/tasks/EPK-260328-016.md` (ATM-012) — нет; фактически файл лежит в `.qwen/tasks/EPK-260328-016.md` (потеряна ведущая точка в имени каталога) | `ok` / `ok` / `1.0` |
| **EPK-260329-019** | `github/issues` (ATM-016) — нет (каталога нет) | `partial` / `partial` / `0.2917` |
| **EPK-260329-024** | `osnova/state.yaml` (ATM-009, ATM-010, ATM-011, ATM-014) — нет; фактический файл — `.osnova/state.yaml` | `ok` / `ok` / `1.0` |

**Отдельно — `EPK-260329-026`:** подтверждено исходное наблюдение: `src/vliw/vliw.test.ts` отсутствует, остальные 9 путей `scope` существуют. Второй отсутствующий путь — `.tmp/blocker-sync.log` (каталог `.tmp/` существует, содержит 7 файлов, лога синхронизации среди них нет).

---

## 3. Подтверждённые эпики

Полностью подтверждены **9 эпиков** — все пути `scope` и все каталоги из `done:` существуют на диске.

| id | Путей в `scope` | `done:` | `result`/`status`/`passrate` |
|---|---|---|---|
| EPK-260328-013 | 5 | `npx vitest run src/compiler/` | `ok` / `ok` / `1.0` |
| EPK-260328-014 | 7 | `npx vitest run src/runtime/` | `ok` / `ok` / `1.0` |
| EPK-260328-015 | 9 | `src/agents/` + `src/pipeline/` | `ok` / `ok` / `1.0` |
| EPK-260328-017 | 10 | `src/agents/` + `src/pipeline/` | `ok` / `ok` / `1.0` |
| EPK-260328-018 | 10 | `src/agents/` + `src/pipeline/` | `ok` / `ok` / `1.0` |
| EPK-260328-FBK016 | 3 | `src/agents/` + `src/pipeline/` | `ok` / `ok` / `1.0` |
| EPK-260329-019 | 8 | `npm run ci` | `partial` / `partial` / `0.2917` |
| EPK-260329-024 | 5 | `npx vitest run src/pipeline/` | `ok` / `ok` / `1.0` |
| EPK-260329-029 | 4 | `npx vitest run src/` | `partial` / `partial` / `0.1429` |

Оговорка: «подтверждён» здесь означает только то, что **заявленные файлы существуют**. Агрегаты `ok` у 6 эпиков из этой таблицы не доказывают выполнения работ — в `history` у них 302 из 317 записей `RPT` имеют `changed: []`, а 317 из 317 — `tests: {passed: 0, total: 0}` (поле не заполняется, а не «ноль тестов прошло»).

---

## 4. Статистика

### Уровень эпиков

| Показатель | Значение |
|---|---|
| Всего эпиков `EPK-*.yaml` на диске | **20** |
| Всего ATM-файлов в `EPK-*/` | **289** |
| Эпиков с полностью подтверждённым `scope` | **9** (45 %) |
| Эпиков с частично подтверждённым `scope` | **11** (55 %) |
| Эпиков с полностью неподтверждённым `scope` | **0** |
| Всего отсутствующих путей в `scope` эпиков | **27** |
| — из них «нет нигде в дереве» | **20** |
| — из них «реализация под другим именем» | **7** |

### Уровень ATM

| Показатель | Значение |
|---|---|
| Всего ATM | **289** |
| ATM хотя бы с одним отсутствующим путём | **31** (10,7 %) |
| Всего отсутствующих путей в `scope` ATM | **24** |
| — «нет нигде в дереве» | **15** (из них 21 упоминание в 31 ATM) |
| — «реализация под другим именем» | **5** уникальных (12 упоминаний) |
| ATM, чей `done:` ссылается на несуществующий путь | **3** (`EPK-260329-026`/ATM-013 и ATM-015 → `src/vliw/vliw.test.ts`; `EPK-260329-022`/ATM-016 → `src/pipeline-llm/llm-pipeline.test.ts`) |
| Эпиков, у которых `done:` ссылается на несуществующий путь как на каталог | **0** (все каталоги `src/agents`, `src/pipeline`, `src/compiler`, `src/runtime`, `src/intelligence`, `src/vliw` существуют) |

### Расхождение плана и фактического состояния

| Показатель | Значение |
|---|---|
| Эпиков в `state.yaml.recent` | **19** |
| Эпиков на диске | **20** (`EPK-260329-030` отсутствует в `recent`) |
| Эпиков в `recent` с отсутствующими путями `scope` | **8** |
| Из них с `result: ok` и `passrate: 1.0` | **6** (021, 022, 023, 025, 026, 027) |
| Заявлено в `sessionstats.epicsreceived` | **54** — истории за 54 прогона, но различимых id эпиков в `history` только **19**; планов на диске **20** |
| Заявлено `sessionstats.epicsdone` / `epicsblocked` | **29** / **25** |
| `epicprogress` | `totalatoms: 0, done: 0, blocked: 0, current: null` — противоречит `sessionstats` (`atomstotal: 317, atomsdone: 197`) |
| Вердикты исполнителя в `history` | 317 записей `RPT`; **58** закрыты фразой `PASS: Qwen review unavailable (quota/budget); auto-approved because done-command exited 0`; **6** — сервисная ошибка `No auth type is selected...` |

---

## 5. Вывод

**Ложных отчётов о завершении: не менее 6 эпиков с вердиктом `ok`/`passrate: 1.0`, в `scope` которых отсутствуют заявленные файлы** (EPK-260329-021, -022, -023, -025, -026, -027), **плюс 1 эпик `partial` с тем же дефектом** (EPK-260329-028), **плюс 1 эпик вообще без записи в `state.yaml`, все ATM которого в `PENDING`** (EPK-260329-030). Если считать по «наличию фантомных путей», затронуто **11 эпиков из 20**, а не 6. Ложным считается отчёт, в котором `status`/`passrate` выше, чем подтверждает дерево файлов; случай `EPK-260329-030` — обратный (заявка есть, исполнения нет), но он так же искажает картину.

**Механизм (воспроизводимая цепочка из четырёх звеньев):**

1. **Критерий завершения не связан с целью.** `scope` эпика перечисляет файлы, которые нужно создать, а `done:` — это `npx vitest run <каталог>` (`src/`, `src/vliw/`, `src/agents/`, `src/pipeline/`). Vitest возвращает exit 0, если прошли *любые* найденные тесты. Целевой файл (`src/vliw/vliw.test.ts`, `src/pipeline-llm/llm-pipeline.test.ts`, все 7 `*.spec.ts` из EPK-023) может не существовать — команда всё равно зелёная. Каталоги `src/vliw/` и `src/pipeline-llm/` существуют и содержат другие тесты, поэтому проверка «каталог есть» тоже ничего не ловит.
2. **Ревьюер выключен.** В `history` 58 записей закрыты строкой `PASS: Qwen review unavailable (quota/budget); auto-approved because done-command exited 0`. То есть единственная содержательная проверка (`diff`-обзор) не выполнялась, а решение принималось по exit-коду из п.1. Ещё на 6 записях ревью упало на сервисной ошибке `No auth type is selected...`.
3. **`state.yaml` пишет не заявленный `scope`, а «фактический».** Поля `recent[].scope` пересобираются из того, что реально изменено, поэтому фантомы исчезают из записи. Пример: ATM-024 заявляет `osnova/state.yaml`, а в `state.yaml` пишется `.osnova/state.yaml`; ATM эпика 016 заявляет `qwen/tasks/...`, а фактический файл — `.qwen/tasks/...`. Исключение — EPK-260329-020…-028, где `recent[].scope` совпадает с эпиком и фантомы видны; именно они и вскрываются внешней проверкой.
4. **Потерянные/подменённые имена маскируются под «выполнено».** 7 из 27 отсутствующих путей — это переименования (`src/agents/base.ts` → реализован как `src/agents/index.ts`, `src/pipeline-llm/executor.ts` → `src/pipeline/executor.ts`, `src/intelligence/core.ts` → `src/intelligence/index.ts`). Эти замены даже зафиксированы в самом `state.yaml` (`codebase.pending`: `src/agents/index.ts — epic agents/base.ts`, `src/intelligence/index.ts — epic intelligence/core.ts`, `src/pipeline/executor.ts — epic pipeline-llm/executor.ts`). То есть система знает о расхождении, но продолжает закрывать эпики как `ok`.

**Сопутствующие признаки недостоверности слоя:**

- `sessionstats` (54 получено / 29 сделано / 317 атомов / passrate 0.621) не согласуется с диском: 20 планов, 19 различимых id в `history`, `epicprogress` обнулён. `codebase.implemented` содержит 175 путей, но это рукописный список, а не результат проверки.
- `.osnova/report.yaml` — итоговый отчёт последнего прогона — содержит `s: OK`, `changed: []`, `tests: {passed: 0, total: 0}`. Формально «успех» без единого изменения.
- `.osnova/task.yaml` — активная задача в состоянии `status: in_progress` с `attempt: 2` и `last_failure: FAIL: expected files missing: ['', '']` — то есть проверку существования файлов исполнитель уже пытался делать, но получал пустые пути вместо имён.

**Что даёт аудит как минимальный детектор:** сверку `scope` с деревом (`Test-Path` по каждому пути) без запуска тестов. Из 6 ложно-«ok» эпиков эта проверка ловит 6 из 6; `done:`-код не ловит ни одного, потому что все каталоги из `done:` существуют.
