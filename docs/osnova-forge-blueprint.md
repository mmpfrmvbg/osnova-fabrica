# OSNOVA Forge — актуальная шина и соответствие GHA

Краткий канон для репозитория. Подробные narrative blueprint’ы (v5 / v5.1 / v5.2) могут жить отдельно; **источник истины по коду** — каталог [`forge/`](../forge/) и [`.github/workflows/`](../.github/workflows/).

## Легаси: v5 и email

**OSNOVA v5 (Living Forge Blueprint)** описывает шину **Gmail**: IMAP (`postman.py`), SMTP (`courier.py` / `retrospective.py`), теги `[BRAIN→FORGE]` в Subject. Это **исторический контур**, не целевой для новых развёртываний.

**Актуально:** **v5.1+** — GitHub Issues (`brain-epic`), GitHub API, без email на основном контуре. Опциональны личные уведомления (например Telegram), не SMTP/IMAP.

## Одна машина (рекомендуемая схема)

Forge (`forge.py`), **GitHub Actions self-hosted runner** с меткой **`osnova-forge`** и рабочий клон репозитория (`OSNOVA_PROJECT`) живут на **одном хосте**. Тогда:

- [`01-epic-intake.yml`](../.github/workflows/01-epic-intake.yml) и [`07-heart-alert.yml`](../.github/workflows/07-heart-alert.yml) используют `runs-on: [self-hosted, osnova-forge]` и видят локальные `epic.sock` / файл heartbeat.
- Для мгновенного пробуждения forge после intake установите **`socat`** на хосте и задайте `FORGE_EPIC_SOCKET`, если сокет не в `/opt/osnova-forge/epic.sock`.

Если когда-нибудь понадобится **только** GitHub-hosted для intake, сокет на forge не доступен — остаётся очередь в репо + `git pull` в цикле forge.

## Канонический путь очереди EPIC

- **GHA** [`01-epic-intake.yml`](../.github/workflows/01-epic-intake.yml) коммитит `<repo>/forge/epic-queue.txt`.
- **Forge** читает ту же очередь через [`epic_queue_path()`](../forge/common.py): при наличии каталога `forge/` в `OSNOVA_PROJECT` используется `OSNOVA_PROJECT/forge/epic-queue.txt`, иначе `OSNOVA_FORGE/epic-queue.txt`.
- **Split deploy:** `OSNOVA_PROJECT` = клон репозитория; после `git pull` очередь совпадает с тем, что записал GHA.

## Триггеры intake

Workflow реагирует на **`opened`** (issue уже с меткой `brain-epic`) и **`labeled`** (добавлена метка `brain-epic`), чтобы не пропускать создание через API. Дубликаты номера issue в файле очереди подавляются при append.

## Unix socket и «мгновенный wake»

При **одной машине** и job на `[self-hosted, osnova-forge]` шаг `socat` → `epic.sock` достигает локального `forge.py` (нужны `socat` и созданный сокет). На **GitHub-hosted** это невозможно — только очередь в репо и `git pull`.

## Heart watchdog

[`07-heart-alert.yml`](../.github/workflows/07-heart-alert.yml) использует `runs-on: [self-hosted, osnova-forge]`. На forge-хосте у runner должна быть метка **`osnova-forge`** (см. также [`self-hosted-runner-runbook.md`](self-hosted-runner-runbook.md)).

## GHA parity: blueprint v5.1 `02`–`06` и этот репозиторий

В markdown blueprint v5.1 перечислены отдельные workflow’ы `02-atm-verify` … `06-cache-warm`. **В OSNOVA-FABRIKA** их **нет как отдельных файлов**; роль проверок и расписаний выполняют существующие пайплайны (например [`ci.yml`](../.github/workflows/ci.yml), `regression-check`, `batch`, прочие). Отдельное обновление поля `state.yaml` → `gha` (как в тексте v5.1) при необходимости добавляется в эти jobs, а не дублируется вторым «atm-verify» workflow.

## Сниппеты из v5.2 markdown (исправления при копировании в прод)

Если переносите примеры из внешнего документа «OSNOVA v5.2 — Resilient Forge Patch»:

1. **`heart.py` / алерт после рестарта** — перед использованием `reason` в теле алерта задайте значение по умолчанию, например `state_ok, reason = check_state_integrity()` и при живом state не обращайтесь к несуществующей переменной.
2. **`parallel_executor.py`** в примере использует `os.environ` — добавьте `import os`.

Реализация в репозитории уже разнесена по [`forge/degradation.py`](../forge/degradation.py), [`forge/parallel_executor.py`](../forge/parallel_executor.py), [`forge/epic_socket.py`](../forge/epic_socket.py) и не обязана совпадать построчно с PDF/markdown.
