# Реестр ОСи v0.1

Реестр — это **единый источник правды** о приложениях, системных сервисах и ассетах ОСи.  
Он строится поверх манифестов `*.osapp.yaml` и (в будущем) пакетов `.osvpk`, но хранится в машинно‑удобном виде (JSON/SQLite).

В v0.1 достаточно представить реестр как **массив записей** типа `RegistryEntry` c полем `kind: "app" | "service" | "asset"`.

---

## 1. Общая структура записи

```ts
type RegistryKind = "app" | "service" | "asset";

interface RegistryEntryBase {
  /** Уникальный идентификатор (из манифеста или сгенерированный для asset). */
  id: string;
  /** Человекочитаемое имя. */
  name: string;
  /** Семантическая версия (из манифеста или для asset). */
  version: string;
  /** Категория: crm | todo | game | utility | system | other | asset. */
  category?: string;
  /** Тип записи реестра. */
  kind: RegistryKind;
  /**
   * Путь к манифесту .osapp.yaml (для app/service) или к файлу/пакету (для asset),
   * относительно корня реестра/каталога приложений.
   */
  manifestPath?: string;
  /**
   * Путь к пакету приложения (.osvpk) или к каталогу, где лежат байткод/ресурсы.
   * Может быть равен dirname(manifestPath) при файловой раскладке.
   */
  packagePath?: string;
  /** Краткое описание (по желанию). */
  description?: string;
  /** Метаданные для магазина/каталога (теги, автор и т.п.). */
  tags?: string[];
  author?: string;
  homepage?: string;
}

interface EntryRuntime {
  /** Минимальная версия рантайма Основа. Совпадает с версией языка из реестра (`docs/osnova/language-registry.md`, `language-schema.json`): по ней можно определить, какие конструкции языка доступны приложению. */
  minOsnovaVersion?: string;
  /** Минимальная версия ОСи. */
  minOsVersion?: string;
}

interface EntryPermissionsSummary {
  files?: {
    read?: string[];   // каталоги/маски, доступные на чтение
    write?: string[];  // каталоги/маски, доступные на запись
  };
  network?: {
    outbound?: boolean;
  };
  system?: {
    clipboard?: boolean;
    notifications?: boolean;
  };
  ipc?: {
    /** Явно разрешённые appId/каналы для обмена (если будет введено в манифест). */
    allowedTargets?: string[];
  };
}

interface EntryUI {
  /** window | tray | cli | service (для app/service). */
  kind?: "window" | "tray" | "cli" | "service";
  /** Путь к иконке (относительно packagePath). */
  icon?: string;
  /** Только один экземпляр приложения. */
  singleInstance?: boolean;
}
```

---

## 2. Форматы записей по видам

### 2.1. Приложение (`kind: "app"`)

```ts
interface AppRegistryEntry extends RegistryEntryBase {
  kind: "app";
  ui: EntryUI;
  /** Точка входа для рантайма. */
  entry: {
    module: string;
    procedure: string;
    args?: unknown[];
  };
  runtime?: EntryRuntime;
  permissions?: EntryPermissionsSummary;
}
```

**Пример (TODO‑приложение):**

```json
{
  "id": "osnova.todo",
  "name": "TODO ОСи",
  "version": "0.1.0",
  "category": "utility",
  "kind": "app",
  "manifestPath": "src/tools/osnova-runtime/fixtures/todo.osapp.yaml",
  "packagePath": "src/tools/osnova-runtime/fixtures",
  "ui": {
    "kind": "window",
    "singleInstance": false
  },
  "entry": {
    "module": "todo",
    "procedure": "запуск",
    "args": []
  },
  "runtime": {
    "minOsnovaVersion": "0.1.0"
  },
  "permissions": {
    "files": {
      "read": [],
      "write": []
    },
    "network": {
      "outbound": false
    }
  }
}
```

### 2.2. Системный сервис (`kind: "service"`)

Сервис — это такое же приложение, но:

- обычно `category: "system"`,
- чаще всего `ui.kind: "service"` или `ui.kind: "cli"`,
- **экспортирует API** (invoke/IPC) для других приложений.

```ts
interface ServiceRegistryEntry extends RegistryEntryBase {
  kind: "service";
  ui: EntryUI;
  entry: {
    module: string;
    procedure: string;
    args?: unknown[];
  };
  runtime?: EntryRuntime;
  permissions?: EntryPermissionsSummary;
  /**
   * Список экспортируемых API (invoke‑функций или IPC‑каналов),
   * которые могут вызывать другие приложения.
   */
  exports?: {
    invokes?: string[];    // например: ["система.уведомления.показать", ...]
    ipcChannels?: string[]; // например: ["osnova.notifications.events"]
  };
}
```

**Пример (эскиз `osnova.notifications`):**

```json
{
  "id": "osnova.notifications",
  "name": "Уведомления ОСи",
  "version": "0.1.0",
  "category": "system",
  "kind": "service",
  "manifestPath": "core/notifications/notifications.osapp.yaml",
  "packagePath": "core/notifications",
  "ui": {
    "kind": "service",
    "singleInstance": true
  },
  "entry": {
    "module": "notifications",
    "procedure": "запуск"
  },
  "runtime": {
    "minOsnovaVersion": "0.1.0"
  },
  "permissions": {
    "system": {
      "notifications": true
    }
  },
  "exports": {
    "invokes": [
      "система.уведомления.показать"
    ],
    "ipcChannels": [
      "osnova.notifications.events"
    ]
  }
}
```

### 2.3. Ассет / пакет данных (`kind: "asset"`)

Ассет — это не исполняемое приложение, а пакет данных/ресурсов (иконки, темы, модели, словари и т.п.), на который могут ссылаться приложения и сервисы.

```ts
interface AssetRegistryEntry extends RegistryEntryBase {
  kind: "asset";
  /**
   * Тип ассета: icon-pack, theme, model, dictionary, data-bundle, etc.
   */
  assetType: string;
  /**
   * Путь к файлу пакета (.zip/.osvpk/.tar) или каталогу с ресурсами.
   */
  assetPath: string;
  /**
   * Опциональная информация о совместимости: для каких версий ядра/ОСи
   * или каких приложений ассет предназначен.
   */
  compatibleWith?: {
    osnovaVersion?: string;
    osVersion?: string;
    apps?: string[]; // список id приложений, для которых ассет актуален
  };
}
```

**Пример (икон‑пак):**

```json
{
  "id": "osnova.icons.default",
  "name": "Default Icons",
  "version": "0.1.0",
  "category": "asset",
  "kind": "asset",
  "description": "Базовый набор иконок для приложений ОСи",
  "assetType": "icon-pack",
  "assetPath": "assets/icon-packs/default",
  "compatibleWith": {
    "osnovaVersion": "0.1.0"
  }
}
```

---

## 3. Хранение реестра

В v0.1 достаточно хранить реестр как **один JSON‑файл**:

```json
{
  "entries": [
    { /* AppRegistryEntry */ },
    { /* ServiceRegistryEntry */ },
    { /* AssetRegistryEntry */ }
  ]
}
```

или как таблицу в SQLite с колонкой `kind` и JSON‑полем `data`.

CLI/сервисы, работающие с реестром, должны:

- уметь пересканировать манифесты `*.osapp.yaml` и обновить/дополнить записи,
- уметь получать запись по `id` и проверять согласованность `manifestPath`/`packagePath`,
- использовать `permissions`/`exports` для отображения прав и доступных API на уровне UI/ассистента.

---

## 4. Связь с текущей архитектурой

- Записи вида **`kind: "app"`** напрямую соответствуют манифестам приложений (`todo`, `viewer` и т.п.).
- Записи **`kind: "service"`** — это будущие системные сервисы (notifications, clipboard, identity, chat), оформленные так же, как приложения:
  - с манифестами `*.osapp.yaml`,
  - с golden‑тестами,
  - с описанными `exports`, чтобы LLM и другие приложения понимали, какие API можно вызывать.
- Записи **`kind: "asset"`** позволяют в будущем описывать темы, иконки и другие ресурсы в том же реестре, что и код.

Реестр v0.1 не навязывает конкретное хранилище (файл / БД), но фиксирует **форматы записей**, на которые могут опираться:

- лаунчер/магазин,
- системные сервисы,
- LLM‑pipeline (как источник правды о доступных приложениях, сервисах и ассетах).

