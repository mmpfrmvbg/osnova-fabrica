import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';

// ─── I-6: Auth guard ──────────────────────────────────────
function isLocalhost(req: http.IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? '';
  return (
    addr === '127.0.0.1' ||
    addr === '::1' ||
    addr === '::ffff:127.0.0.1'
  );
}

function checkAuth(req: http.IncomingMessage): boolean {
  const apiKey = process.env.OSNOVA_API_KEY;
  if (!apiKey) return true;                    // dev-mode: ключ не задан
  if (isLocalhost(req)) return true;           // localhost без ключа
  const hk = req.headers['x-api-key'];
  if (typeof hk === 'string' && hk === apiKey) return true;
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth === `Bearer ${apiKey}`) return true;
  return false;
}
// ──────────────────────────────────────────────────────────

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

interface CenterTraceEntry {
  runId?: string;
  status?: string;
  task?: string;
  timestamp?: string;
  repairAttempts?: number;
  modelId?: string;
  intent?: { description?: string; appType?: string };
  spec?: { mainModule?: string; procedures?: Array<{ name?: string }> };
  source?: { source?: string };
  buildReport?: {
    success?: boolean;
    compilerSuccess?: boolean;
    lexerErrors?: Array<{ message: string }>;
    parserErrors?: Array<{ message: string }>;
    compilerErrors?: Array<{ message: string }>;
    semanticErrors?: Array<{ message: string }>;
  };
  goldenReport?: { passed?: boolean; qualityScore?: number; outputDiff?: string | null };
}

function renderTracePage(trace: CenterTraceEntry): string {
  const icon =
    trace.status === 'success'
      ? '✅'
      : trace.status === 'repair_exhausted'
        ? '❌'
        : trace.status === 'partial'
          ? '⚠️'
          : '❓';
  const ts = trace.timestamp ? new Date(trace.timestamp).toLocaleString('ru-RU') : '';

  const allErrors = [
    ...(trace.buildReport?.lexerErrors ?? []),
    ...(trace.buildReport?.parserErrors ?? []),
    ...(trace.buildReport?.compilerErrors ?? []),
    ...(trace.buildReport?.semanticErrors ?? []),
  ];

  const errHtml = allErrors.length
    ? allErrors.map(e => `<div style="color:#e07e7e;font-size:12px">⚠ ${e.message}</div>`).join('')
    : '<div style="color:#888;font-size:12px">нет ошибок</div>';

  const sourceLines = (trace.source?.source ?? '').split('\n').slice(0, 50).join('\n');
  const procs = (trace.spec?.procedures ?? []).map(p => p.name ?? '?').join(', ') || '—';

  return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>Трейс ${(trace.runId ?? '').slice(0,8)}</title>
<style>
body{font-family:system-ui,sans-serif;background:#0f0f0f;color:#e0e0e0;padding:20px;max-width:900px}
a{color:#7ec8e3} h1{color:#7ec8e3} h2{color:#aaa;font-size:13px;text-transform:uppercase;letter-spacing:1px;margin:20px 0 6px}
pre{background:#1a1a1a;padding:12px;border-radius:6px;font-size:12px;overflow:auto;white-space:pre-wrap}
.meta{color:#888;font-size:12px} .row{display:flex;gap:32px;margin-bottom:16px}
.field{background:#1a1a1a;padding:10px 14px;border-radius:6px;flex:1}
.field-l{font-size:11px;color:#555;margin-bottom:2px} .field-v{font-size:14px}
</style></head><body>
<a href="/">← ОС-НОВА Center</a>
<h1>${icon} Трейс <span style="font-size:16px;color:#888">${trace.runId ?? ''}</span></h1>
<div class="row">
  <div class="field"><div class="field-l">Статус</div><div class="field-v">${trace.status ?? '—'}</div></div>
  <div class="field"><div class="field-l">Время</div><div class="field-v">${ts}</div></div>
  <div class="field"><div class="field-l">Модель</div><div class="field-v">${trace.modelId ?? '—'}</div></div>
  <div class="field"><div class="field-l">Repairs</div><div class="field-v">${trace.repairAttempts ?? 0}</div></div>
</div>
<h2>Задача</h2>
<pre>${trace.task ?? '—'}</pre>
<h2>Intent</h2>
<pre>${trace.intent?.description ?? '—'} | тип: ${trace.intent?.appType ?? '—'}</pre>
<h2>Spec</h2>
<pre>модуль: ${trace.spec?.mainModule ?? '—'}\nпроцедуры: ${procs}</pre>
<h2>Исходный код (первые 50 строк)</h2>
<pre>${sourceLines || '—'}</pre>
<h2>Build</h2>
<div style="margin-bottom:8px">
  Компилятор: ${trace.buildReport?.compilerSuccess ? '✅ ok' : trace.buildReport ? '❌ fail' : '—'}
</div>
${errHtml}
<h2>Golden</h2>
<pre>passed: ${trace.goldenReport?.passed ?? '—'}
qualityScore: ${trace.goldenReport?.qualityScore ?? '—'}
diff: ${trace.goldenReport?.outputDiff ?? 'нет'}</pre>
</body></html>`;
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
      }</td><td>${ts}</td><td style="font-size:11px;color:#888"><a href="/trace/${encodeURIComponent(
        t.runId ?? '',
      )}" style="color:#7ec8e3">${(t.runId ?? '').slice(0, 8)}</a></td></tr>`;
    })
    .join('');

  const appRows = apps
    .map(
      a =>
        `<tr><td><b><a href="/app/${encodeURIComponent(a.id)}" style="color:#7ec8e3">${a.id}</a></b></td><td>${a.name}</td><td>${a.category ?? ''}</td><td>${
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
<div style="font-size:11px;color:#555;margin-bottom:6px">
  Обновляется каждые 30 сек · <a href="/" style="color:#555">обновить сейчас</a>
</div>
<table><tr><th>Статус</th><th>Задача</th><th>Repairs</th><th>Время</th><th>runId</th></tr>${traceRows}</table>
<h2>Ассистент — создать приложение</h2>
<div id="assistant" style="background:#1a1a1a;padding:16px;border-radius:6px;margin-bottom:24px">
  <textarea id="task-input" rows="3" placeholder="Опишите задачу для нового приложения..."
    style="width:100%;box-sizing:border-box;background:#111;color:#e0e0e0;border:1px solid #333;border-radius:4px;padding:8px;font-size:13px;resize:vertical"></textarea>
  <div style="margin-top:8px;display:flex;gap:8px;align-items:center">
    <button id="run-btn" onclick="runPipeline()"
      style="background:#7ec8e3;color:#000;border:none;padding:8px 20px;border-radius:4px;cursor:pointer;font-size:13px;font-weight:bold">
      ▶ Создать приложение
    </button>
    <span id="status-text" style="font-size:12px;color:#888"></span>
  </div>
  <div id="result-box" style="margin-top:12px;font-size:12px;display:none"></div>
</div>
<script>
async function runPipeline() {
  const task = document.getElementById('task-input').value.trim();
  if (!task) return;
  const btn = document.getElementById('run-btn');
  const status = document.getElementById('status-text');
  const box = document.getElementById('result-box');
  btn.disabled = true;
  btn.textContent = '⏳ Генерация...';
  status.textContent = 'Запускаем пайплайн...';
  box.style.display = 'none';
  try {
    const r = await fetch('/api/new-app', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task })
    });
    const data = await r.json();
    const icon = data.status === 'success' ? '✅' : data.status === 'partial' ? '⚠️' : '❌';
    box.style.display = 'block';
    box.style.color = data.status === 'success' ? '#7ec8e3' : '#e07e7e';
    box.innerHTML = icon + ' <b>' + data.status + '</b>' +
      (data.qualityScore != null ? ' | Q=' + data.qualityScore.toFixed(2) : '') +
      ' | repairs: ' + (data.repairAttempts ?? 0) +
      ' | runId: ' + (data.runId ?? '').slice(0, 8) +
      (data.error ? '<br>Ошибка: ' + data.error : '') +
      '<br><small style="color:#888">Обновите страницу чтобы увидеть новое приложение в списке</small>';
    status.textContent = '';
  } catch(e) {
    status.textContent = 'Ошибка: ' + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '▶ Создать приложение';
  }
}
</script>
<script>
setTimeout(function(){ location.reload(); }, 30000);
</script>
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

    if (req.method === 'POST' && req.url === '/api/new-app') {
      if (!checkAuth(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      let body = '';
      req.on('data', chunk => {
        body += chunk;
      });
      req.on('end', async () => {
        try {
          const { task } = JSON.parse(body) as { task?: string };
          if (!task || !task.trim()) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'task обязателен' }));
            return;
          }
          const { runPipeline } = await import('../pipeline/orchestrator');
          const result = await runPipeline(task.trim());
          const lastTrace = loadTraces(1)[0] as { runId?: string } | undefined;
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(
            JSON.stringify({
              status: result.status,
              runId: lastTrace?.runId ?? null,
              repairAttempts: result.repairAttempts,
              qualityScore: result.goldenReport?.qualityScore ?? null,
            }),
          );
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        }
      });
      return;
    }

    const traceMatch = req.url?.match(/^\/trace\/(.+)$/);
    if (req.method === 'GET' && traceMatch) {
      const runId = decodeURIComponent(traceMatch[1]!);
      const all = loadTraces(10000) as CenterTraceEntry[];
      const found = all.find(
        t => t.runId === runId || (t.runId ?? '').startsWith(runId),
      );
      if (!found) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          `<p>Трейс не найден: ${runId} <a href="/" style="color:#7ec8e3">← назад</a></p>`,
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderTracePage(found));
      return;
    }

    const appMatch = req.url?.match(/^\/app\/(.+)$/);
    if (req.method === 'GET' && appMatch) {
      const appId = decodeURIComponent(appMatch[1]!);
      const reg = loadRegistry() as {
        entries?: Array<{
          id: string;
          name?: string;
          kind?: string;
          permissions?: unknown;
          version?: string;
          manifestPath?: string;
        }>;
      };
      const entry = (reg.entries ?? []).find(e => e.id === appId);
      if (!entry) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          `<p>Приложение не найдено: ${appId} <a href="/" style="color:#7ec8e3">← назад</a></p>`,
        );
        return;
      }

      const perms = JSON.stringify(entry.permissions ?? {}, null, 2);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>${
          entry.name ?? appId
        }</title>
<style>body{font-family:system-ui,sans-serif;background:#0f0f0f;color:#e0e0e0;padding:20px}
a{color:#7ec8e3}pre{background:#1a1a1a;padding:16px;border-radius:6px;font-size:12px;overflow:auto}
h1{color:#7ec8e3}h2{color:#aaa;font-size:13px;text-transform:uppercase;letter-spacing:1px}</style></head>
<body><a href="/">← ОС-НОВА Center</a>
<h1>${entry.name ?? appId}</h1>
<p style="color:#888;font-size:13px">ID: ${entry.id} | Версия: ${entry.version ?? '—'} | Тип: ${
          entry.kind ?? '—'
        }</p>
<h2>Права (permissions)</h2>
<pre>${perms}</pre>
${entry.manifestPath ? `<p style="font-size:12px;color:#555">Манифест: ${entry.manifestPath}</p>` : '' }
</body></html>`,
      );
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

