<!-- doc-status: frozen -->
# Реестр ОС-НОВА v0.1

Реестр — каталог всех приложений и компонентов ОС-НОВА. Каждая запись реестра соответствует одному `.osapp.yaml` манифесту.

---

## 1. Текущие приложения

| id | name | category | uiKind | permissions |
|----|------|----------|--------|-------------|
| `osnova.todo` | TODO ОСи | utility | window | files:-, network:no |
| `osnova.viewer` | File Viewer ОСи | utility | window | files:read ~/Документы, network:no |
| `osnova.micro_crm` | Micro-CRM (список клиентов) | crm | window | files:-, network:no |
| `osnova.game_rounds` | Игровые раунды (Game) | game | window | files:-, network:no |
| `notepad.osn` | Блокнот ОСи | utility | window | files:read/write, clipboard, network:no |
| `osnova.notifications` | Уведомления ОСи | system | service | system.notifications |

Источник: `src/runtime/fixtures/*.osapp.yaml`

---

## 2. Категории

| Категория | Описание |
|-----------|----------|
| todo | Управление задачами |
| crm | Работа с клиентами |
| game | Игровые приложения |
| utility | Утилиты общего назначения |
| service | Системные сервисы |

---

## 3. Компоненты

Компоненты — переиспользуемые модули без собственного UI. Формат описания компонентов будет добавлен в v0.2.

---

## 4. Как добавить приложение в реестр

1. Создать `.osapp.yaml` по формату из [app-manifest-v0.1.md](app-manifest-v0.1.md).
2. Положить манифест в `src/runtime/fixtures/`.
3. Зарегистрировать в реестре — добавить запись в таблицу «Текущие приложения» выше.
