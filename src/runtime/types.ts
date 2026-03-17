/**
 * Типы манифеста приложения ОСи (app-manifest-v0.1.md).
 */

export interface AppManifest {
  id: string;
  name: string;
  version: string;
  entry: {
    module: string;
    procedure: string;
    args?: unknown[];
  };
  category?: string;
  ui?: {
    kind?: "window" | "tray" | "cli" | "service";
    icon?: string;
    single_instance?: boolean;
  };
  permissions?: {
    files?: { read?: string[]; write?: string[] };
    network?: { outbound?: boolean };
    system?: { clipboard?: boolean; notifications?: boolean };
  };
  /** Запись в реестре: app (по умолчанию) или service. */
  registry_kind?: "app" | "service";
  /** Экспорт API сервиса (для kind: service). */
  exports?: {
    invokes?: string[];
    ipc_channels?: string[];
  };
  runtime?: {
    min_osnova_version?: string;
    min_os_version?: string;
  };
}

export interface RunOptions {
  manifestPath?: string;
  packagePath?: string;
  module?: string;
  procedure?: string;
  args?: string;
  ui?: string;
  singleInstance?: boolean;
  inProcess?: boolean;
}

export interface ResolvedRunConfig {
  appDir: string;
  manifest: AppManifest;
  entryModule: string;
  entryProcedure: string;
  entryArgs: unknown[];
  uiKind: string;
  permissions: AppManifest["permissions"];
  /** Для golden-тестов: мок-события окна (передаются в дочерний процесс через конфиг) */
  mockEvents?: unknown[];
}

/**
 * Контракт исполнения Основа: VM/интерпретатор или подпроцесс.
 * Возвращает код выхода процесса (0 = успех).
 */
export interface IOsnovaRunner {
  run(config: ResolvedRunConfig): Promise<number>;
}
