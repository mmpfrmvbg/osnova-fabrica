/**
 * Режимы UI: window (окно с виджетами через WebSocket), service, tray, cli.
 * В режиме window: HTTP + WebSocket; клиент получает команды (создать_окно, виджет) и шлёт события (клик, закрытие).
 */

import * as http from "http";
import { spawn } from "child_process";
import * as path from "path";
import { WebSocketServer } from "ws";

export interface WindowEvent {
  тип: string;
  окно_id?: number;
  виджет_id?: string;
  значение?: string;
  [k: string]: unknown;
}

export interface WindowApi {
  sendToClient(msg: Record<string, unknown>): void;
  getEvents(): WindowEvent[];
  /** Снять с очереди только события для данного окна. */
  getEventsForWindow(окно_id: number): WindowEvent[];
  pushEvent(ev: WindowEvent): void;
}

const WINDOW_HTML = `
<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Основа</title>
<style>
  body { font-family: system-ui; margin: 0; padding: 8px; }
  .osnova-window { border: 1px solid #ccc; border-radius: 8px; overflow: hidden; }
  .osnova-window .title { padding: 6px 10px; background: #f0f0f0; }
  .osnova-window .body { padding: 10px; min-height: 60px; }
  .osnova-widget { margin: 4px 0; }
  .osnova-widget button { padding: 6px 12px; cursor: pointer; }
  .osnova-widget input { padding: 6px; width: 200px; }
</style>
</head>
<body><div id="root"></div>
<script>
(function() {
  const root = document.getElementById('root');
  const wsUrl = (location.origin.replace(/^http/, 'ws') + '/ws');
  let ws = null;
  let reconnect = null;

  function connect() {
    ws = new WebSocket(wsUrl);
    ws.onmessage = function(e) {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'createWindow') {
          const el = document.createElement('div');
          el.className = 'osnova-window';
          el.dataset.windowId = String(msg.id);
          el.innerHTML = '<div class="title">' + (msg.title || '') + '</div><div class="body" data-container="' + msg.id + '"></div>';
          root.appendChild(el);
          el.querySelector('.title').onclick = function() { sendEvent({ тип: 'клик', окно_id: msg.id, элемент: 'заголовок' }); };
        } else if (msg.type === 'setTitle') {
          const w = root.querySelector('[data-window-id="' + msg.id + '"]');
          if (w) w.querySelector('.title').textContent = msg.title || '';
        } else if (msg.type === 'addWidget') {
          const containerId = msg.kind === 'контейнер' ? (msg.parentId || String(msg.windowId)) : msg.parentId;
          const container = containerId ? root.querySelector('[data-container="' + containerId + '"]') : null;
          if (!container) return;
          const el = document.createElement('div');
          el.className = 'osnova-widget';
          el.dataset.widgetId = msg.widgetId || '';
          if (msg.kind === 'кнопка') {
            el.innerHTML = '<button>' + (msg.text || '') + '</button>';
            el.querySelector('button').onclick = function() { sendEvent({ тип: 'клик_виджета', виджет_id: msg.widgetId }); };
          } else if (msg.kind === 'поле_ввода') {
            el.innerHTML = '<input type="text" placeholder="' + (msg.placeholder || '') + '">';
            el.querySelector('input').oninput = function() { sendEvent({ тип: 'изменение', виджет_id: msg.widgetId, значение: el.querySelector('input').value }); };
          } else if (msg.kind === 'текст') {
            el.textContent = msg.text || '';
          } else if (msg.kind === 'контейнер') {
            el.dataset.container = msg.widgetId;
          } else if (msg.kind === 'область_текста') {
            el.innerHTML = '<textarea rows="4" style="width:100%">' + (msg.text || '').replace(/</g, '&lt;') + '</textarea>';
            el.querySelector('textarea').oninput = function() { sendEvent({ тип: 'изменение', виджет_id: msg.widgetId, значение: el.querySelector('textarea').value }); };
          }
          container.appendChild(el);
        } else if (msg.type === 'setValue') {
          const w = root.querySelector('[data-widget-id="' + msg.widgetId + '"]');
          if (w) {
            const input = w.querySelector('input, textarea');
            if (input) input.value = msg.value || '';
            else w.textContent = msg.value || '';
          }
        } else if (msg.type === 'show') {
          const w = root.querySelector('[data-window-id="' + msg.id + '"]');
          if (w) w.style.display = '';
        } else if (msg.type === 'hide') {
          const w = root.querySelector('[data-window-id="' + msg.id + '"]');
          if (w) w.style.display = 'none';
        } else if (msg.type === 'close') {
          const w = root.querySelector('[data-window-id="' + msg.id + '"]');
          if (w) { w.remove(); sendEvent({ тип: 'закрытие', окно_id: msg.id }); }
        }
      } catch (err) { console.error(err); }
    };
    ws.onclose = function() { reconnect = setTimeout(connect, 1000); };
    ws.onerror = function() {};
  }
  function sendEvent(ev) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'event', event: ev }));
  }
  connect();
})();
</script>
</body></html>
`;

export interface WindowServer {
  port: number;
  close(): void;
  api: WindowApi;
}

/**
 * Запуск HTTP-сервера с WebSocket для окна/виджетов; возвращает server + API для VM.
 */
export function setupWindow(html: string = WINDOW_HTML): Promise<WindowServer> {
  const eventQueue: WindowEvent[] = [];
  const api: WindowApi = {
    sendToClient(msg: Record<string, unknown>) {
      if (client) try { client.send(JSON.stringify(msg)); } catch { /* ignore send errors */ }
    },
    getEvents() {
      const out = eventQueue.slice();
      eventQueue.length = 0;
      return out;
    },
    getEventsForWindow(окно_id: number) {
      const out: WindowEvent[] = [];
      const rest: WindowEvent[] = [];
      for (const e of eventQueue) {
        if (e.окно_id === окно_id) out.push(e);
        else rest.push(e);
      }
      eventQueue.length = 0;
      eventQueue.push(...rest);
      return out;
    },
    pushEvent(ev: WindowEvent) {
      eventQueue.push(ev);
    },
  };

  let client: import("ws") | null = null;

  const server = http.createServer((req, res) => {
    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (req.url === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        client = ws;
        ws.on("message", (data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === "event" && msg.event) api.pushEvent(msg.event as WindowEvent);
          } catch { /* ignore malformed messages */ }
        });
        ws.on("close", () => { client = null; });
      });
    } else socket.destroy();
  });

  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("Could not get server address"));
        return;
      }
      const port = addr.port;
      const url = `http://127.0.0.1:${port}`;
      openBrowser(url).catch((e) => console.error("[osnova-ui] openBrowser:", e));
      resolve({
        port,
        close: () => {
          wss.close();
          server.close();
        },
        api,
      });
    });
    server.on("error", reject);
  });
}

function openBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const plat = process.platform;
    let cmd: string;
    let args: string[];
    if (plat === "win32") {
      cmd = "cmd";
      args = ["/c", "start", "", url];
    } else if (plat === "darwin") {
      cmd = "open";
      args = [url];
    } else {
      cmd = "xdg-open";
      args = [url];
    }
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", reject);
    child.on("close", (code) => (code !== 0 ? reject(new Error(`exit ${code}`)) : resolve()));
    child.unref();
  });
}

/**
 * Режим service: без окна.
 */
export function setupService(options?: { logDir?: string }): { logPath?: string } {
  if (options?.logDir) {
    const logPath = path.join(options.logDir, "service.log");
    return { logPath };
  }
  return {};
}
