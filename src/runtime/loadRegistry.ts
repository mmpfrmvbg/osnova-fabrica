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

export function loadRegistry(registryRoot?: string): AppRegistry {
  const dir = registryRoot ?? path.join(process.cwd(), 'src', 'runtime');
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
