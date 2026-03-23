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

export function registryToContext(registry: AppRegistry): string {
  if (registry.entries.length === 0) return '';
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
  return lines.join('\n');
}
