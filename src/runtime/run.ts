/**
 * Минимальный CLI «osnova-runtime run»: реализует шаги протокола
 * лаунчер ↔ рантайм (app-manifest-v0.1.md, п. 5).
 *
 * Соответствие таблице 5.5 (поле манифеста → реализация в run.ts):
 *
 * | Поле манифеста              | Статус        | Где в коде                          |
 * |-----------------------------|---------------|-------------------------------------|
 * | id                          | частично      | Логируем manifest.id в stderr при старте; --app-id не парсим |
 * | entry.module                | по спеце      | parseArgv --module; resolveConfig opts.module ?? manifest.entry.module |
 * | entry.procedure             | по спеце      | parseArgv --procedure; resolveConfig opts.procedure ?? manifest.entry.procedure |
 * | entry.args                  | по спеце      | parseArgv --args; resolveConfig; parseArgsString(); передаются в VM через runner.run(config) |
 * | ui.kind                     | по спеце      | parseArgv --ui; resolveConfig opts.ui ?? manifest.ui?.kind ?? "cli" (значение в config; поведение окно/service — заглушка в vm-runner) |
 * | ui.single_instance          | заглушка      | parseArgv --single-instance; opts.singleInstance нигде не используется (должен лаунчер или рантайм блокировать второй процесс) |
 * | permissions                 | заглушка      | applyPermissions() в run.ts логирует; в vm-runner applySandbox() — заглушка; реальная песочница не создаётся |
 * | runtime.min_osnova_version  | по спеце      | loadManifest; semverAtLeast(RUNTIME_VERSION, minVer); exit 1 при несовместимости |
 * | Путь к пакету/каталогу      | по спеце      | --package / --app-dir → opts.packagePath; иначе appDir = dirname(manifest); loadPackage(appDir) |
 *
 * Выполнение: createSubprocessRunner().run(config) запускает процесс vm-runner.js с конфигом в JSON;
 * vm-runner применяет applySandbox (заглушка), setupUI (заглушка), executeEntry (заглушка — интерпретатор байткода пока не реализован).
 *
 * Заглушки:
 * - id: передача в --app-id не реализована (логирование id есть).
 * - ui.single_instance: флаг парсится, но не используется.
 * - permissions: только логирование в run.ts и vm-runner, без реального ограничения доступа.
 * - VM: vm-runner принимает конфиг и логирует entry; загрузка/интерпретация .osvbc — TODO.
 * - ui.kind: в vm-runner setupUI() только логирует; окно/service не создаются.
 */

import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import type { AppManifest, RunOptions, ResolvedRunConfig } from "./types";
import { createSubprocessRunner } from "./runner";

function readRuntimeVersion(): string {
  const fallback = "0.0.0";
  try {
    const versionPath = path.resolve(__dirname, "..", "..", "VERSION");
    if (!fsSync.existsSync(versionPath)) return fallback;
    const raw = fsSync.readFileSync(versionPath, "utf-8").trim();
    return raw || fallback;
  } catch {
    return fallback;
  }
}

const RUNTIME_VERSION = process.env.OSNOVA_VERSION?.trim() || readRuntimeVersion();

function parseArgv(argv: string[]): RunOptions {
  const opts: RunOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--manifest" && argv[i + 1]) {
      opts.manifestPath = argv[++i];
    } else if ((arg === "--package" || arg === "--app-dir") && argv[i + 1]) {
      opts.packagePath = argv[++i];
    } else if (arg === "--module" && argv[i + 1]) {
      opts.module = argv[++i];
    } else if (arg === "--procedure" && argv[i + 1]) {
      opts.procedure = argv[++i];
    } else if (arg === "--args" && argv[i + 1]) {
      opts.args = argv[++i];
    } else if (arg === "--ui" && argv[i + 1]) {
      opts.ui = argv[++i];
    } else if (arg === "--single-instance") {
      opts.singleInstance = true;
    } else if (arg === "--in-process") {
      opts.inProcess = true;
    }
  }
  return opts;
}

function parseArgsString(argsStr: string): unknown[] {
  try {
    const parsed = JSON.parse(argsStr) as unknown;
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return argsStr.split(",").map((s) => s.trim()).filter(Boolean);
  }
}

function semverAtLeast(actual: string, required: string): boolean {
  const [a1, a2, a3] = actual.split(".").map(Number);
  const [r1, r2, r3] = required.split(".").map(Number);
  if (a1 !== r1) return a1 >= r1;
  if (a2 !== r2) return a2 >= r2;
  return (a3 || 0) >= (r3 || 0);
}

async function loadManifest(manifestPath: string): Promise<AppManifest> {
  const raw = await fs.readFile(manifestPath, "utf-8");
  const data = yaml.load(raw) as Record<string, unknown>;
  if (!data?.entry || typeof data.entry !== "object") {
    throw new Error(`Invalid manifest: missing or invalid "entry" in ${manifestPath}`);
  }
  const entry = data.entry as Record<string, unknown>;
  if (typeof entry.module !== "string" || typeof entry.procedure !== "string") {
    throw new Error(`Invalid manifest: entry.module and entry.procedure must be strings in ${manifestPath}`);
  }
  return data as unknown as AppManifest;
}

function resolveConfig(opts: RunOptions, manifest: AppManifest, manifestDir: string): ResolvedRunConfig {
  const appDir = opts.packagePath ? path.resolve(opts.packagePath) : manifestDir;
  const entryArgs = opts.args != null
    ? parseArgsString(opts.args)
    : (manifest.entry.args ?? []);

  return {
    appDir,
    manifest,
    entryModule: opts.module ?? manifest.entry.module,
    entryProcedure: opts.procedure ?? manifest.entry.procedure,
    entryArgs,
    uiKind: opts.ui ?? manifest.ui?.kind ?? "cli",
    permissions: manifest.permissions ?? {},
  };
}

/** Загрузка пакета: проверяем наличие каталога и список файлов кода (минимально). */
async function loadPackage(appDir: string): Promise<{ codeFiles: string[] }> {
  const entries = await fs.readdir(appDir, { withFileTypes: true }).catch(() => []);
  const codeFiles: string[] = [];
  for (const e of entries) {
    if (e.isFile() && (e.name.endsWith(".osnova") || e.name.endsWith(".osvbc") || e.name.endsWith(".json"))) {
      codeFiles.push(path.join(appDir, e.name));
    }
  }
  return { codeFiles };
}

/** Настройка песочницы по permissions. Заглушка: таблица 5.5 — реальная песочница не создаётся, только логируем. */
function applyPermissions(permissions: AppManifest["permissions"]): void {
  if (!permissions) return;
  if (permissions.files?.read?.length) {
    console.error("[osnova-runtime] sandbox: read allowed:", permissions.files.read);
  }
  if (permissions.files?.write?.length) {
    console.error("[osnova-runtime] sandbox: write allowed:", permissions.files.write);
  }
  if (permissions.network?.outbound === false) {
    console.error("[osnova-runtime] sandbox: network outbound disabled");
  }
}

export async function run(argv: string[]): Promise<number> {
  const opts = parseArgv(argv);

  if (!opts.manifestPath && !opts.packagePath) {
    console.error("Usage: osnova-runtime run --manifest <path> [--package <path>] [--module <name>] [--procedure <name>] [--args <json>] [--ui <kind>] [--single-instance]");
    return 1;
  }

  const manifestPath = opts.manifestPath
    ? path.resolve(opts.manifestPath)
    : path.join(path.resolve(opts.packagePath!), "manifest.osapp.yaml");

  const manifestDir = path.dirname(manifestPath);

  let manifest: AppManifest;
  try {
    manifest = await loadManifest(manifestPath);
  } catch (e) {
    console.error("Failed to load manifest:", e);
    return 1;
  }

  const minVer = manifest.runtime?.min_osnova_version;
  if (minVer && !semverAtLeast(RUNTIME_VERSION, minVer)) {
    console.error(`Runtime version ${RUNTIME_VERSION} is below required ${minVer}`);
    return 1;
  }

  const config = resolveConfig(opts, manifest, manifestDir);

  // Мок-события для golden-тестов: передаём в дочерний процесс через конфиг
  const mockEnv = process.env.OSNOVA_VM_MOCK_EVENTS;
  if (mockEnv) {
    try {
      const parsed = JSON.parse(mockEnv);
      if (Array.isArray(parsed)) {
        config.mockEvents = parsed;
      }
    } catch {
      // ignore
    }
  }

  // Таблица 5.5: id — логирование (частично: выводим в stderr для идентификации процесса)
  if (manifest.id) {
    console.error("[osnova-runtime] app id:", manifest.id);
  }

  const { codeFiles } = await loadPackage(config.appDir);
  if (codeFiles.length === 0) {
    console.error("[osnova-runtime] no code files (.osnova / .osvbc) in", config.appDir);
  } else {
    console.error("[osnova-runtime] package loaded:", codeFiles.length, "file(s)");
  }

  applyPermissions(config.permissions);

  if (opts.inProcess) {
    const { runWithConfig } = await import("./vm-runner");
    return runWithConfig(config);
  }
  const runner = createSubprocessRunner();
  return runner.run(config);
}
