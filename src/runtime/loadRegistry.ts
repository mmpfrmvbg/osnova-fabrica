import * as fs from 'fs';
import * as path from 'path';

export interface RegistryEntry {
  kind: 'app' | 'service';
  id: string;
  name: string;
  version: string;
  category: string;
  uiKind: string;
  exports?: { invokes?: string[]; ipcChannels?: string[] };
}

export interface AppRegistry {
  entries: RegistryEntry[];
}

export interface AppRegistryItem {
  id: string;
  name: string;
  type: string;
  languageVersion: string;
  mainModule: string;
  modules: string[];
  description?: string;
  tags?: string[];
}

export interface AppCatalogRegistry {
  version: string;
  apps: AppRegistryItem[];
  /**
   * Почему каталог пуст. Пустой список при этом ОСТАЁТСЯ: падать в пайплайне
   * нельзя, контекст без референсных приложений — не отказ сборки.
   *
   * Но причина обязана быть названа. Молчаливый `apps: []` уже один раз скрыл
   * настоящий дефект: `appRegistry.json` содержал два JSON-документа подряд и не
   * разбирался вовсе, а выглядело это как «приложений нет» — реестр не попадал в
   * контекст промпта, и никто этого не видел.
   */
  error?: string;
}

/**
 * Ищет корень монорепо от startDir вверх по дереву,
 * ориентируясь на package.json с "name": "osnova-fabrica".
 * Возвращает путь к директории или null если не нашёл.
 */
function findMonorepoRoot(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { name?: string };
        if (pkg.name === 'osnova-fabrica') return dir;
      } catch {
        // ignore parse errors
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // достигли корня FS
    dir = parent;
  }
  return null;
}

export function loadRegistry(registryRoot?: string): AppRegistry {
  let dir: string;
  if (registryRoot) {
    dir = registryRoot;
  } else if (process.env.REGISTRY_ROOT) {
    dir = process.env.REGISTRY_ROOT;
  } else {
    // Сначала ищем от __dirname вверх (надёжно при запуске из apps/osiris)
    const fromDirname = findMonorepoRoot(path.resolve(__dirname));
    // Затем от cwd (работает при запуске из корня монорепо)
    const fromCwd = findMonorepoRoot(process.cwd());
    const root = fromDirname ?? fromCwd;
    dir = root ? path.join(root, 'src', 'runtime') : path.join(process.cwd(), 'src', 'runtime');
  }

  const filePath = path.join(dir, 'registry.json');
  if (!fs.existsSync(filePath)) return { entries: [] };
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as AppRegistry;
  } catch {
    return { entries: [] };
  }
}

export function loadAppRegistry(registryRoot?: string): AppCatalogRegistry {
  let dir: string;
  if (registryRoot) {
    dir = registryRoot;
  } else if (process.env.REGISTRY_ROOT) {
    dir = process.env.REGISTRY_ROOT;
  } else {
    const fromDirname = findMonorepoRoot(path.resolve(__dirname));
    const fromCwd = findMonorepoRoot(process.cwd());
    const root = fromDirname ?? fromCwd;
    dir = root ? path.join(root, 'src', 'runtime') : path.join(process.cwd(), 'src', 'runtime');
  }

  const filePath = path.join(dir, 'appRegistry.json');
  if (!fs.existsSync(filePath)) {
    return { version: '1.0.0', apps: [], error: `${filePath}: файла нет` };
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as AppCatalogRegistry;
  } catch (e) {
    // Ошибка НАЗЫВАЕТСЯ, а не проглатывается: см. комментарий к `error`.
    return { version: '1.0.0', apps: [], error: `${filePath}: ${(e as Error).message}` };
  }
}

export function registryToContext(registry: AppRegistry, appRegistry?: AppCatalogRegistry): string {
  if (registry.entries.length === 0 && (!appRegistry || appRegistry.apps.length === 0)) return '';
  const apps = registry.entries.filter(e => e.kind === 'app');
  const services = registry.entries.filter(e => e.kind === 'service');
  const lines: string[] = ['Доступные приложения и сервисы платформы:'];
  if (apps.length > 0) {
    lines.push('Приложения:');
    for (const a of apps) lines.push(`  - ${a.id} («${a.name}»)`);
  }
  if (services.length > 0) {
    lines.push('Сервисы (доступны через invoke):');
    for (const s of services) {
      const invokes = s.exports?.invokes?.join(', ') ?? '';
      lines.push(`  - ${s.id} («${s.name}»)${invokes ? ': ' + invokes : ''}`);
    }
  }
  if (appRegistry && appRegistry.apps.length > 0) {
    lines.push('Референсные приложения Основа (appRegistry):');
    for (const app of appRegistry.apps) {
      lines.push(`  - ${app.id} («${app.name}»), main: ${app.mainModule}`);
    }
  }
  return lines.join('\n');
}
