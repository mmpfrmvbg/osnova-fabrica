# Манифест приложения ОС-НОВА (v0.1)

Манифест приложения `*.osapp.yaml` — контракт между приложением и ОС-НОВА: точка входа, права доступа и метаданные.

---

## 1. Обязательные поля

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | string | Стабильный идентификатор, например `osnova.todo` |
| `name` | string | Человекочитаемое имя |
| `entry.module` | string | Имя модуля без расширения |
| `entry.procedure` | string | Имя точки входа |
| `permissions` | object | Права: storage, ui, files, network, log. В v0.1: `files.read`, `files.write` (массивы путей), `network.outbound` (логический) |

---

## 2. Опциональные поля

| Поле | Тип | Описание |
|------|-----|----------|
| `version` | string | Семантическая версия (например, `0.1.0`) |
| `description` | string | Краткое описание |
| `category` | string | Категория: `todo` / `crm` / `game` / `utility` / `service` |
| `ui.kind` | string | Режим UI: `cli` / `window` / `none` |
| `ui.single_instance` | boolean | Один экземпляр приложения |
| `entry.args` | array | Аргументы для точки входа (golden-тесты и др.) |
| `runtime.min_osnova_version` | string | Минимальная версия рантайма |

---

## 3. Полный пример манифеста

Из `src/runtime/fixtures/micro_crm.osapp.yaml`:

```yaml
id: "osnova.micro_crm"
name: "Micro-CRM (список клиентов)"
version: "0.1.0"

entry:
  module: "micro_crm"
  procedure: "run_golden"
  args:
    - - имя: "А"
        баланс: 10
        статус: "активен"
      - имя: "Б"
        баланс: 20
        статус: "активен"
      - имя: "В"
        баланс: 30
        статус: "закрыт"
      - имя: "Г"
        баланс: 5
        статус: "новый"

category: "crm"

ui:
  kind: "window"
  single_instance: false

permissions:
  files:
    read: []
    write: []
  network:
    outbound: false

runtime:
  min_osnova_version: "0.1.0"
```

---

## 4. Второй пример — минималистичный манифест

Только обязательные и минимальные опциональные поля:

```yaml
id: "osnova.minimal"
name: "Минимальное приложение"

entry:
  module: "minimal"
  procedure: "запуск"

permissions:
  files:
    read: []
    write: []
  network:
    outbound: false
```
