import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';

const REGISTRY_PATH = path.join(process.cwd(), 'src/runtime/registry.json');
const TRACES_PATH = path.join(process.cwd(), 'runs/traces.jsonl');
const PORT = parseInt(process.env.OSNOVA_CENTER_PORT ?? '7777', 10);

function loadRegistry(): unknown {
  if (!fs.existsSync(REGISTRY_PATH)) return { entries: [] };
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
}

function loadTraces(limit = 50): unknown[] {
  if (!fs.existsSync(TRACES_PATH)) return [];
  return fs
    .readFileSync(TRACES_PATH, 'utf-8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l))
    .slice(-limit);
}

function renderHtml(registry: unknown, traces: unknown[]): string {
  const reg = registry as {
    entries?: Array<{ id: string; name: string; category?: string; kind?: string; version?: string }>;
  };
  const apps = (reg.entries ?? []).filter(e => e.kind === 'app');
  const services = (reg.entries ?? []).filter(e => e.kind === 'service');
  const traceRows = (
    traces as Array<{
      runId?: string;
      status?: string;
      task?: string;
      timestamp?: string;
      repairAttempts?: number;
    }>
  )
    .reverse()
    .map(t => {
      const icon =
        t.status === 'success'
          ? '✅'
          : t.status === 'repair_exhausted'
            ? '❌'
            : t.status === 'partial'
              ? '⚠️'
              : '❓';
      const ts = t.timestamp ? new Date(t.timestamp).toLocaleString('ru-RU') : '';
      return `<tr><td>${icon} ${t.status ?? ''}</td><td>${t.task?.slice(0, 60) ?? ''}</td><td>${
        t.repairAttempts ?? 0
      }</td><td>${ts}</td><td style="font-size:11px;color:#888">${(t.runId ?? '').slice(0, 8)}</td></tr>`;
    })
    .join('');

  const appRows = apps
    .map(
      a =>
        `<tr><td><b>${a.id}</b></td><td>${a.name}</td><td>${a.category ?? ''}</td><td>${
          a.version ?? ''
        }</td></tr>`,
    )
    .join('');

  const svcRows = services
    .map(s => `<tr><td><b>${s.id}</b></td><td>${s.name}</td><td>${s.version ?? ''}</td></tr>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ОС-НОВА Center</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0f0f0f; color: #e0e0e0; margin: 0; padding: 20px; }
  h1 { color: #7ec8e3; margin-bottom: 4px; }
  h2 { color: #aaa; font-size: 14px; margin: 24px 0 8px; text-transform: uppercase; letter-spacing: 1px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 24px; }
  th { text-align: left; color: #888; font-weight: normal; padding: 4px 8px; border-bottom: 1px solid #333; }
  td { padding: 5px 8px; border-bottom: 1px solid #1e1e1e; }
  tr:hover td { background: #1a1a1a; }
  .stats { display: flex; gap: 24px; margin-bottom: 16px; }
  .stat { background: #1a1a1a; padding: 10px 16px; border-radius: 6px; }
  .stat-n { font-size: 24px; font-weight: bold; color: #7ec8e3; }
  .stat-l { font-size: 11px; color: #888; }
</style>
</head>
<body>
<h1>⚙️ ОС-НОВА Center</h1>
<div class="stats">
  <div class="stat"><div class="stat-n">${apps.length}</div><div class="stat-l">Приложений</div></div>
  <div class="stat"><div class="stat-n">${services.length}</div><div class="stat-l">Сервисов</div></div>
  <div class="stat"><div class="stat-n">${traces.length}</div><div class="stat-l">Трейсов (последние)</div></div>
</div>

<h2>Приложения</h2>
<table><tr><th>ID</th><th>Название</th><th>Категория</th><th>Версия</th></tr>${appRows}</table>

<h2>Сервисы</h2>
<table><tr><th>ID</th><th>Название</th><th>Версия</th></tr>${svcRows}</table>

<h2>Последние трейсы</h2>
<table><tr><th>Статус</th><th>Задача</th><th>Repairs</th><th>Время</th><th>runId</th></tr>${traceRows}</table>
</body></html>`;
}

export function startCenter(): void {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/registry') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(loadRegistry()));
      return;
    }
    if (req.url === '/api/traces') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(loadTraces()));
      return;
    }

    const registry = loadRegistry();
    const traces = loadTraces();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderHtml(registry, traces));
  });

  server.listen(PORT, () => {
    console.log(`[osnova-center] http://localhost:${PORT}`);
  });
}

