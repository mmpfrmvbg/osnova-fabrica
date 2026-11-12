<!-- doc-status: active -->
# Osnova CLI

Тонкий CLI поверх `forge/`: статус, health, лог, квоты, запуск EPIC/ATM, пауза forge, completions.

## Установка

Из корня репозитория:

```bash
pip install -e ".[dev]"
```

При слабом канале до PyPI см. `requirements-cli.txt` и `OFFLINE-INSTALL.txt`.

Интерактивный `osnova ask --interactive`:

```bash
pip install -e ".[interactive]"
```

## Команды

| Команда | Назначение |
|--------|------------|
| `osnova status` | Текущий EPIC, прогресс, passrate |
| `osnova health` | Heartbeat, forge, executors, CI blockers |
| `osnova log` | История прогонов |
| `osnova quota` | Квоты Qwen / Cursor |
| `osnova watch` | Live-дашборд |
| `osnova plan "цель"` | План ATM (`--full` — реальный atomizer) |
| `osnova run "цель"` | Полный конвейер EPIC |
| `osnova do "задача"` | Один ATM без atomizer (`--dry-run`) |
| `osnova fix ATM-...` | Повтор ATM через `run_single_atm` (`--dry-run`, `--executor`) |
| `osnova ask "вопрос"` | Qwen с контекстом (`--files`, `--interactive`) |
| `osnova pause` / `osnova resume` | Пауза forge (`forge-state.json`) |
| `osnova forge start\|stop\|status` | Демон `python -m forge.forge` |
| `osnova epic list\|show\|kill` | Манифесты EPIC |

Подробнее: `osnova --help`, `osnova <команда> --help`.

## Переменные окружения

Шаблон: [.env.cli.example](.env.cli.example) в корне (и секция CLI в `.env.example`).

Ключевые: `OSNOVA_PROJECT`, `OSNOVA_FORGE`, `QWEN_BIN`, `CURSOR_BIN`, при необходимости `GH_TOKEN`, `GH_REPO`.

## Shell completions

Typer включает опции при `add_completion=True`:

```bash
osnova --install-completion bash   # или zsh, fish
osnova --show-completion bash      # вывести скрипт
```

**PowerShell** — добавить в профиль (`$PROFILE`):

```powershell
(osnova --show-completion powershell) | Out-String | Invoke-Expression
```

## Разработка

```bash
pip install -e ".[dev]"
pytest tests/ -v --tb=short
```

Опционально: `mypy osnova`, `ruff check osnova` (см. `[tool.mypy]` / `[tool.ruff]` в `pyproject.toml`).
