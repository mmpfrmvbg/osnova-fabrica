import * as fs from "fs/promises";
import * as path from "path";
import yaml from "js-yaml";
import { run as runCli } from "./osnova-runtime/run";
import type { AppManifest } from "./osnova-runtime/types";

/**
 * Минимальный интерфейс osnova-apps v0.1 (реестр/магазин):
 *
 * - list            — показать все записи реестра
 * - info <id>       — подробная информация по записи
 * - run <id> [...]  — запустить app через osnova-runtime
 * - registry build  — собрать registry.json из манифестов (fixtures/*.osapp.yaml)
 *
 * Источник данных: если есть файл registry.json (getRegistryPath()), читаем его;
 * иначе строим реестр по манифестам. Пути в JSON — относительные к каталогу registry.json.
 */

function getRegistryPath(): string {
  const env = process.env.OSNOVA_REGISTRY;
  if (env) return path.resolve(env);
  return path.join(__dirname, "osnova-runtime", "registry.json");
}

type RegistryKind = "app" | "service" | "asset";

interface RegistryPermissionsSummary {
  files?: { read?: string[]; write?: string[] };
  network?: { outbound?: boolean };
  system?: { clipboard?: boolean; notifications?: boolean };
  ipc?: { allowedTargets?: string[] };
}

interface RegistryExports {
  invokes?: string[];
  ipcChannels?: string[];
}

interface RegistryEntry {
  kind: RegistryKind;
  id: string;
  name: string;
  version: string;
  category?: string;
  uiKind?: string;
  manifestPath?: string;
  packagePath?: string;
  description?: string;
  permissions?: RegistryPermissionsSummary;
  exports?: RegistryExports;
}

async function findAppManifests(): Promise<string[]> {
  // v0.1: считаем, что приложения лежат в osnova-runtime/fixtures/*.osapp.yaml
  const fixturesDir = path.join(__dirname, "osnova-runtime", "fixtures");
  let entries: string[] = [];
  try {
    const dirents = await fs.readdir(fixturesDir, { withFileTypes: true });
    for (const d of dirents) {
      if (d.isFile() && d.name.endsWith(".osapp.yaml")) {
        entries.push(path.join(fixturesDir, d.name));
      }
    }
  } catch {
    // no fixtures dir — вернём пустой список
  }
  return entries;
}

async function loadAppEntry(manifestPath: string): Promise<RegistryEntry | null> {
  const raw = await fs.readFile(manifestPath, "utf-8");
  const data = yaml.load(raw) as unknown as AppManifest;
  if (!data?.id || !data.name || !data.version) return null;

  const appDir = path.dirname(manifestPath);
  const uiKind = data.ui?.kind ?? "cli";
  const permissions: RegistryPermissionsSummary | undefined = data.permissions
    ? {
        files: data.permissions.files,
        network: data.permissions.network,
        system: data.permissions.system,
      }
    : undefined;

  const kind: RegistryKind = data.registry_kind === "service" ? "service" : "app";
  const exports: RegistryExports | undefined = data.exports
    ? {
        invokes: data.exports.invokes,
        ipcChannels: data.exports.ipc_channels,
      }
    : undefined;

  return {
    kind,
    id: data.id,
    name: data.name,
    version: data.version,
    category: data.category,
    uiKind,
    manifestPath,
    packagePath: appDir,
    permissions,
    exports,
  };
}

/** Читает реестр из registry.json; пути в файле — относительно каталога registry. */
async function loadRegistryFromFile(registryPath: string): Promise<RegistryEntry[]> {
  const raw = await fs.readFile(registryPath, "utf-8");
  const data = JSON.parse(raw) as { entries?: RegistryEntry[] };
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  const registryDir = path.dirname(registryPath);
  for (const e of entries) {
    if (e.manifestPath && !path.isAbsolute(e.manifestPath)) {
      e.manifestPath = path.resolve(registryDir, e.manifestPath);
    }
    if (e.packagePath && !path.isAbsolute(e.packagePath)) {
      e.packagePath = path.resolve(registryDir, e.packagePath);
    }
  }
  return entries;
}

/** Собирает реестр из манифестов и записывает registry.json (пути — относительные к каталогу registry). */
async function buildRegistryFile(registryPath: string): Promise<number> {
  const manifests = await findAppManifests();
  const registryDir = path.dirname(registryPath);
  const entries: RegistryEntry[] = [];
  for (const m of manifests) {
    try {
      const entry = await loadAppEntry(m);
      if (!entry) continue;
      entry.manifestPath = path.relative(registryDir, entry.manifestPath!);
      entry.packagePath = path.relative(registryDir, entry.packagePath!);
      entries.push(entry);
    } catch (e) {
      console.error("[osnova-apps] failed to load manifest", m, e);
    }
  }
  entries.sort((a, b) => a.id.localeCompare(b.id));
  await fs.writeFile(
    registryPath,
    JSON.stringify({ entries }, null, 2),
    "utf-8"
  );
  console.log(`[osnova-apps] wrote ${entries.length} entries to ${registryPath}`);
  return 0;
}

async function loadRegistry(): Promise<RegistryEntry[]> {
  const registryPath = getRegistryPath();
  try {
    await fs.access(registryPath);
    const entries = await loadRegistryFromFile(registryPath);
    if (entries.length > 0) return entries;
  } catch {
    // файла нет или пустой — строим из манифестов
  }
  const manifests = await findAppManifests();
  const entries: RegistryEntry[] = [];
  for (const m of manifests) {
    try {
      const entry = await loadAppEntry(m);
      if (entry) entries.push(entry);
    } catch (e) {
      console.error("[osnova-apps] failed to load manifest", m, e);
    }
  }
  entries.sort((a, b) => a.id.localeCompare(b.id));
  return entries;
}

function parseListArgs(args: string[]): { kind?: RegistryKind; category?: string } {
  const out: { kind?: RegistryKind; category?: string } = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--kind" && args[i + 1]) {
      const v = args[i + 1].toLowerCase();
      if (v === "app" || v === "service" || v === "asset") out.kind = v;
      i++;
    } else if (args[i] === "--category" && args[i + 1]) {
      out.category = args[i + 1];
      i++;
    }
  }
  return out;
}

function printUsage(): void {
  console.error("Usage:");
  console.error("  osnova-apps list [--kind app|service|asset] [--category <name>]");
  console.error("  osnova-apps info <id> [--json]");
  console.error("  osnova-apps permissions <id>");
  console.error("  osnova-apps run <id> [--ui <kind>] [--module <name>] [--procedure <name>] [--args <json|csv>]");
  console.error("  osnova-apps registry build   # собрать registry.json из манифестов");
}

async function cmdList(args: string[]): Promise<number> {
  const filters = parseListArgs(args);
  let entries = await loadRegistry();
  if (filters.kind) entries = entries.filter((e) => e.kind === filters.kind);
  if (filters.category) entries = entries.filter((e) => (e.category ?? "") === filters.category);
  if (!entries.length) {
    console.log("No entries found.");
    return 0;
  }
  for (const app of entries) {
    const ui = app.uiKind ?? "cli";
    console.log(`${app.id}\t${app.kind}\t${app.name}\t${app.version}\t${ui}\t${app.manifestPath ?? "-"}`);
  }
  return 0;
}

async function cmdPermissions(id: string | undefined): Promise<number> {
  if (!id) {
    console.error("Usage: osnova-apps permissions <id>");
    return 1;
  }
  const entries = await loadRegistry();
  const entry = entries.find((e) => e.id === id);
  if (!entry) {
    console.error(`[osnova-apps] entry not found: ${id}`);
    return 1;
  }
  console.log(`# ${entry.id} (${entry.kind}) — права и экспорт`);
  if (entry.permissions) {
    if (entry.permissions.files) {
      const r = entry.permissions.files.read ?? [];
      const w = entry.permissions.files.write ?? [];
      console.log(`files.read:  ${r.length ? r.join(", ") : "—"}`);
      console.log(`files.write: ${w.length ? w.join(", ") : "—"}`);
    }
    if (entry.permissions.network) {
      console.log(`network.outbound: ${entry.permissions.network.outbound ?? false}`);
    }
    if (entry.permissions.system) {
      const s = entry.permissions.system;
      const parts: string[] = [];
      if (s.clipboard) parts.push("clipboard");
      if (s.notifications) parts.push("notifications");
      console.log(`system: ${parts.length ? parts.join(", ") : "—"}`);
    }
    if (entry.permissions.ipc?.allowedTargets?.length) {
      console.log(`ipc.allowedTargets: ${entry.permissions.ipc.allowedTargets!.join(", ")}`);
    }
  } else {
    console.log("(нет разрешений в манифесте)");
  }
  if (entry.exports && (entry.exports.invokes?.length || entry.exports.ipcChannels?.length)) {
    if (entry.exports.invokes?.length) {
      console.log(`exports.invokes: ${entry.exports.invokes.join(", ")}`);
    }
    if (entry.exports.ipcChannels?.length) {
      console.log(`exports.ipcChannels: ${entry.exports.ipcChannels.join(", ")}`);
    }
  }
  return 0;
}

async function cmdInfo(id: string | undefined, args: string[]): Promise<number> {
  if (!id) {
    printUsage();
    return 1;
  }
  const apps = await loadRegistry();
  const entry = apps.find((a) => a.id === id);
  if (!entry) {
    console.error(`[osnova-apps] app not found: ${id}`);
    return 1;
  }
  const json = args.includes("--json");
  if (json) {
    console.log(JSON.stringify(entry, null, 2));
  } else {
    console.log(`id:        ${entry.id}`);
    console.log(`name:      ${entry.name}`);
    console.log(`version:   ${entry.version}`);
    console.log(`kind:      ${entry.kind}`);
    console.log(`category:  ${entry.category ?? "-"}`);
    console.log(`ui.kind:   ${entry.uiKind ?? "cli"}`);
    console.log(`manifest:  ${entry.manifestPath ?? "-"}`);
    console.log(`package:   ${entry.packagePath ?? "-"}`);
    if (entry.permissions) {
      console.log("permissions:");
      if (entry.permissions.files) {
        console.log(`  files.read:  ${JSON.stringify(entry.permissions.files.read ?? [])}`);
        console.log(`  files.write: ${JSON.stringify(entry.permissions.files.write ?? [])}`);
      }
      if (entry.permissions.network) {
        console.log(`  network.outbound: ${entry.permissions.network.outbound ?? false}`);
      }
      if (entry.permissions.system) {
        console.log(`  system: ${JSON.stringify(entry.permissions.system)}`);
      }
      if (entry.permissions.ipc) {
        console.log(`  ipc.allowedTargets: ${JSON.stringify(entry.permissions.ipc.allowedTargets ?? [])}`);
      }
    }
    if (entry.exports) {
      console.log("exports:");
      if (entry.exports.invokes) {
        console.log(`  invokes: ${JSON.stringify(entry.exports.invokes)}`);
      }
      if (entry.exports.ipcChannels) {
        console.log(`  ipcChannels: ${JSON.stringify(entry.exports.ipcChannels)}`);
      }
    }
  }
  return 0;
}

async function cmdRun(id: string | undefined, extra: string[]): Promise<number> {
  if (!id) {
    printUsage();
    return 1;
  }
  const apps = await loadRegistry();
  const entry = apps.find((a) => a.id === id);
  if (!entry) {
    console.error(`[osnova-apps] app not found: ${id}`);
    return 1;
  }

  if (!entry.manifestPath) {
    console.error(`[osnova-apps] manifest path is missing for app: ${id}`);
    return 1;
  }

  // extra уже содержит, например, ["--ui", "window", "--args", "[1,2]"]
  const args: string[] = ["--manifest", entry.manifestPath, ...extra];
  return runCli(args);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    printUsage();
    process.exit(0);
  }

  switch (cmd) {
    case "list": {
      const listArgs = argv.slice(1);
      const code = await cmdList(listArgs);
      process.exit(code);
      break;
    }
    case "permissions": {
      const id = argv[1];
      const code = await cmdPermissions(id);
      process.exit(code);
      break;
    }
    case "info": {
      const id = argv[1];
      const rest = argv.slice(2);
      const code = await cmdInfo(id, rest);
      process.exit(code);
      break;
    }
    case "run": {
      const id = argv[1];
      const rest = argv.slice(2);
      const code = await cmdRun(id, rest);
      process.exit(code);
      break;
    }
    case "registry": {
      const sub = argv[1];
      if (sub === "build") {
        const code = await buildRegistryFile(getRegistryPath());
        process.exit(code);
      } else {
        console.error("Usage: osnova-apps registry build");
        process.exit(1);
      }
      break;
    }
    default:
      printUsage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("[osnova-apps] ERROR:", err);
  process.exit(1);
});

