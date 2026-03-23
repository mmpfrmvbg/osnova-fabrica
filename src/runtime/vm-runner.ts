/**
 * Процесс VM Основа: конфиг, песочница, хранилище, сеть, окно/виджеты, выполнение байткода.
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import type { ResolvedRunConfig, AppManifest } from "./types";
import { createSandboxContext, SandboxError } from "./sandbox";
import { setupWindow, setupService } from "./ui";
import type { WindowApi } from "./ui";
import * as storage from "./storage";
import { isOsVbcModule } from "./vm/bytecode";
import { VM, loadModule } from "./vm/interpreter";
import type { StackValue } from "./vm/interpreter";

const STORAGE_ROOT = path.join(os.tmpdir(), "osnova-storage");

let mockEventsQueue: unknown[] | null = null;

function ensureMockEventsQueue(): void {
  if (mockEventsQueue !== null) return;
  const envVal = process.env.OSNOVA_VM_MOCK_EVENTS;
  if (!envVal) return;
  try {
    const parsed = JSON.parse(envVal);
    if (Array.isArray(parsed)) {
      mockEventsQueue = [...parsed];
    }
  } catch {
    // ignore invalid JSON
  }
}

function applySandbox(permissions: AppManifest["permissions"]) {
  return createSandboxContext(permissions ?? {});
}

async function setupUI(
  uiKind: string,
  appDir: string
): Promise<{ close?: () => void; windowApi?: WindowApi }> {
  switch (uiKind) {
    case "window": {
      const server = await setupWindow();
      return { close: () => server.close(), windowApi: server.api };
    }
    case "service":
      setupService({ logDir: appDir });
      return {};
    case "tray":
      console.error("[osnova-vm] ui: tray (stub)");
      return {};
    default:
      return {};
  }
}

export interface AppContext {
  appId: string;
  storageRoot: string;
  windowApi: WindowApi | null;
}

interface GuiState {
  nextWindowId: number;
  nextWidgetId: number;
  widgetValues: Record<string, string>;
}

function createGuiState(): GuiState {
  return { nextWindowId: 1, nextWidgetId: 1, widgetValues: {} };
}

function createInvokeHandler(
  sandbox: ReturnType<typeof createSandboxContext>,
  appContext: AppContext,
  gui: GuiState
) {
  const { windowApi } = appContext;

  return async (name: string, args: StackValue[]): Promise<StackValue | null> => {
    switch (name) {
      case "система.лог.вывести":
        console.log(String(args[0] ?? ""));
        return null;

      case "система.файлы.прочитать_все": {
        const p = String(args[0] ?? "");
        const data = await sandbox.fs.readFile(p, "utf-8");
        return data;
      }
      case "система.файлы.записать_все": {
        const p = String(args[0] ?? "");
        const data = typeof args[1] === "string" ? args[1] : Buffer.from(String(args[1]));
        await sandbox.fs.writeFile(p, data);
        return null;
      }
      case "система.файлы.существует": {
        const p = String(args[0] ?? "");
        try {
          await sandbox.fs.access(p);
          return true;
        } catch {
          return false;
        }
      }

      case "система.время.сейчас":
        return Date.now();
      case "система.время.метка":
        return new Date().toISOString();
      case "система.время.спать": {
        const ms = Number(args[0]) || 0;
        await new Promise((r) => setTimeout(r, ms));
        return null;
      }

      case "система.хранилище.записать": {
        const key = String(args[0] ?? "");
        const value = String(args[1] ?? "");
        await storage.storageWrite(appContext.storageRoot, appContext.appId, key, value);
        return null;
      }
      case "система.хранилище.прочитать": {
        const key = String(args[0] ?? "");
        const v = await storage.storageRead(appContext.storageRoot, appContext.appId, key);
        return v ?? "";
      }
      case "система.хранилище.удалить": {
        const key = String(args[0] ?? "");
        await storage.storageDelete(appContext.storageRoot, appContext.appId, key);
        return null;
      }
      case "система.хранилище.ключи": {
        const keys = await storage.storageKeys(appContext.storageRoot, appContext.appId);
        return keys;
      }
      case "система.хранилище.ключи_с_префиксом": {
        const prefix = String(args[0]);
        const allKeys = await storage.storageKeys(appContext.storageRoot, appContext.appId);
        return allKeys.filter((k: string) => k.startsWith(prefix));
      }

      case "система.сеть.запрос": {
        if (!sandbox.allowNetwork) throw new SandboxError("Network not allowed");
        const url = String(args[0] ?? "");
        const method = (args[1] != null ? String(args[1]) : "GET").toUpperCase();
        const headers = (args[2] as Record<string, string> | null) ?? {};
        const body = args[3] != null ? String(args[3]) : undefined;
        try {
          const res = await fetch(url, { method, headers: headers as Record<string, string>, body });
          const text = await res.text();
          return text;
        } catch (e) {
          throw new SandboxError(`Network error: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      case "система.сеть.получить": {
        if (!sandbox.allowNetwork) throw new SandboxError("Network not allowed");
        const url = String(args[0] ?? "");
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30_000);
        try {
          const res = await fetch(url, { method: "GET", signal: controller.signal });
          const text = await res.text();
          if (!res.ok) throw new SandboxError(`HTTP ${res.status}: ${text.slice(0, 200)}`);
          return text;
        } catch (e) {
          if (e instanceof SandboxError) throw e;
          throw new SandboxError(`Network error: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          clearTimeout(timeout);
        }
      }

      case "система.сеть.пост": {
        if (!sandbox.allowNetwork) throw new SandboxError("Network not allowed");
        const url = String(args[0] ?? "");
        const body = String(args[1] ?? "");
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30_000);
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "text/plain; charset=utf-8" },
            body,
            signal: controller.signal,
          });
          const text = await res.text();
          if (!res.ok) throw new SandboxError(`HTTP ${res.status}: ${text.slice(0, 200)}`);
          return text;
        } catch (e) {
          if (e instanceof SandboxError) throw e;
          throw new SandboxError(`Network error: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          clearTimeout(timeout);
        }
      }

      case "система.json.создать": {
        try {
          return JSON.stringify(args[0] ?? null);
        } catch (e) {
          throw new SandboxError(`JSON serialize error: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      case "система.json.разобрать": {
        const raw = String(args[0] ?? "");
        try {
          return JSON.parse(raw) as StackValue;
        } catch (e) {
          throw new SandboxError(`JSON parse error: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      case "система.ввод.текст": {
        const prompt = String(args[0] ?? "");
        const inputMode = process.env.OSNOVA_INPUT_MODE ?? "stdin";

        if (inputMode === "storage") {
          // Android/Termux: UI-слой пишет текст в хранилище по ключу __ввод__
          // VM полит каждые 100мс до появления значения, затем очищает ключ
          const POLL_INTERVAL_MS = 100;
          const POLL_TIMEOUT_MS = 60_000;
          if (prompt) process.stdout.write(prompt);
          const deadline = Date.now() + POLL_TIMEOUT_MS;
          while (Date.now() < deadline) {
            const val = await storage.storageRead(
              appContext.storageRoot,
              appContext.appId,
              "__ввод__"
            );
            if (val !== null && val !== "") {
              await storage.storageDelete(
                appContext.storageRoot,
                appContext.appId,
                "__ввод__"
              );
              return val;
            }
            await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
          }
          throw new SandboxError("система.ввод.текст: timeout waiting for storage input");
        }

        if (inputMode === "test") {
          return process.env.OSNOVA_TEST_INPUT ?? "";
        }

        // stdin-режим (CLI по умолчанию)
        if (prompt) process.stdout.write(prompt);
        const buf = Buffer.alloc(1024);
        let line = "";
        try {
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const n = (await import("fs")).default.readSync(0, buf, 0, 1, null);
            if (n === 0) break;
            const ch = buf.toString("utf8", 0, n);
            if (ch === "\n") break;
            line += ch;
          }
        } catch {
          // stdin недоступен (тест/pipe) — вернуть пустую строку
        }
        return line.replace(/\r$/, "");
      }

      case "система.окно.создать_окно": {
        const title = String(args[0] ?? "");
        const width = Number(args[1]) || 400;
        const height = Number(args[2]) || 300;
        const id = gui.nextWindowId++;
        if (windowApi) windowApi.sendToClient({ type: "createWindow", id, title, width, height });
        return id;
      }
      case "система.окно.показать": {
        const id = Number(args[0]);
        if (windowApi) windowApi.sendToClient({ type: "show", id });
        return null;
      }
      case "система.окно.скрыть": {
        const id = Number(args[0]);
        if (windowApi) windowApi.sendToClient({ type: "hide", id });
        return null;
      }
      case "система.окно.закрыть": {
        const id = Number(args[0]);
        if (windowApi) windowApi.sendToClient({ type: "close", id });
        return null;
      }
      case "система.окно.установить_заголовок": {
        const id = Number(args[0]);
        const title = String(args[1] ?? "");
        if (windowApi) windowApi.sendToClient({ type: "setTitle", id, title });
        return null;
      }
      case "система.окно.получить_события": {
        if (windowApi) {
          const events = windowApi.getEvents();
          for (const e of events) {
            if (e.тип === "изменение" && e.виджет_id != null) gui.widgetValues[e.виджет_id] = e.значение ?? "";
          }
          return events as unknown as StackValue;
        }
        ensureMockEventsQueue();
        if (mockEventsQueue && mockEventsQueue.length > 0) {
          const ev = mockEventsQueue.shift();
          return [ev] as unknown as StackValue;
        }
        return [];
      }

      case "система.интерфейс.контейнер": {
        const windowId = Number(args[0]);
        const parentId = args[1] != null ? String(args[1]) : "";
        const id = args[2] != null ? String(args[2]) : `c${gui.nextWidgetId++}`;
        if (windowApi) windowApi.sendToClient({ type: "addWidget", kind: "контейнер", windowId, parentId, widgetId: id });
        return id;
      }
      case "система.интерфейс.кнопка": {
        const parentId = String(args[0] ?? "");
        const text = String(args[1] ?? "");
        const id = args[2] != null ? String(args[2]) : `b${gui.nextWidgetId++}`;
        if (windowApi) windowApi.sendToClient({ type: "addWidget", kind: "кнопка", parentId, text, widgetId: id });
        return id;
      }
      case "система.интерфейс.поле_ввода": {
        const parentId = String(args[0] ?? "");
        const placeholder = String(args[1] ?? "");
        const id = args[2] != null ? String(args[2]) : `i${gui.nextWidgetId++}`;
        if (windowApi) windowApi.sendToClient({ type: "addWidget", kind: "поле_ввода", parentId, placeholder, widgetId: id });
        return id;
      }
      case "система.интерфейс.текст": {
        const parentId = String(args[0] ?? "");
        const text = String(args[1] ?? "");
        const id = args[2] != null ? String(args[2]) : `t${gui.nextWidgetId++}`;
        if (windowApi) windowApi.sendToClient({ type: "addWidget", kind: "текст", parentId, text, widgetId: id });
        return id;
      }
      case "система.интерфейс.область_текста": {
        const parentId = String(args[0] ?? "");
        const lines = String(args[1] ?? "");
        const id = args[2] != null ? String(args[2]) : `a${gui.nextWidgetId++}`;
        if (windowApi) windowApi.sendToClient({ type: "addWidget", kind: "область_текста", parentId, text: lines, widgetId: id });
        return id;
      }
      case "система.интерфейс.получить_значение": {
        const widgetId = String(args[0] ?? "");
        return gui.widgetValues[widgetId] ?? "";
      }
      case "система.интерфейс.установить_значение": {
        const widgetId = String(args[0] ?? "");
        const value = String(args[1] ?? "");
        gui.widgetValues[widgetId] = value;
        if (windowApi) windowApi.sendToClient({ type: "setValue", widgetId, value });
        return null;
      }
      case "система.интерфейс.диалог_сообщение": {
        console.log("[диалог]", String(args[0] ?? ""), String(args[1] ?? ""));
        return null;
      }
      case "система.интерфейс.диалог_подтвердить": {
        console.log("[подтвердить]", String(args[0] ?? ""), String(args[1] ?? ""));
        return false;
      }
      case "система.интерфейс.диалог_ввод": {
        console.log("[ввод]", String(args[0] ?? ""), String(args[1] ?? ""));
        return "";
      }

      case "система.массив.создать":
        return [];
      case "система.массив.добавить": {
        const arr = args[0] as StackValue[];
        if (Array.isArray(arr)) arr.push(args[1] as StackValue);
        return null;
      }
      case "система.массив.установить": {
        const arr = args[0] as StackValue[];
        const idx = Number(args[1]) | 0;
        const val = args[2];
        if (Array.isArray(arr) && idx >= 0 && idx < arr.length) arr[idx] = val as StackValue;
        return null;
      }
      case "система.массив.удалить": {
        const arr = args[0] as StackValue[];
        const idx = Number(args[1]) | 0;
        if (Array.isArray(arr) && idx >= 0 && idx < arr.length) arr.splice(idx, 1);
        return null;
      }
      case "система.массив.срез": {
        const arr = args[0];
        const from = Number(args[1]) | 0;
        const to = Number(args[2]) | 0;
        return Array.isArray(arr) ? arr.slice(from, to) : [];
      }
      case "система.массив.длина": {
        const arr = args[0];
        return Array.isArray(arr) ? arr.length : 0;
      }
      case "система.массив.получить": {
        const arr = args[0];
        const idx = Number(args[1]) | 0;
        if (!Array.isArray(arr) || idx < 0 || idx >= arr.length) return null;
        return arr[idx] as StackValue;
      }
      case "система.объект.получить": {
        const obj = args[0];
        const key = String(args[1] ?? "");
        if (obj == null || typeof obj !== "object" || Array.isArray(obj)) return null;
        return (obj as Record<string, unknown>)[key] as StackValue ?? null;
      }
      case "система.строка.объединить": {
        const a = String(args[0] ?? "");
        const b = String(args[1] ?? "");
        return a + b;
      }
      case "система.строка.длина": {
        const s = String(args[0] ?? "");
        return s.length;
      }
      case "система.строка.содержит": {
        const haystack = String(args[0] ?? "");
        const needle = String(args[1] ?? "");
        return haystack.includes(needle);
      }
      case "система.строка.начинается_с": {
        const s = String(args[0] ?? "");
        const prefix = String(args[1] ?? "");
        return s.startsWith(prefix);
      }
      case "система.строка.заканчивается_на": {
        const s = String(args[0] ?? "");
        const suffix = String(args[1] ?? "");
        return s.endsWith(suffix);
      }
      case "система.строка.подстрока": {
        const s = String(args[0] ?? "");
        const start = Number(args[1] ?? 0);
        const end = Number(args[2] ?? s.length);
        return s.slice(start, end);
      }
      case "система.строка.в_верхний": {
        return String(args[0] ?? "").toUpperCase();
      }
      case "система.строка.в_нижний": {
        return String(args[0] ?? "").toLowerCase();
      }
      case "система.строка.обрезать": {
        return String(args[0] ?? "").trim();
      }
      case "система.строка.заменить": {
        const s = String(args[0] ?? "");
        const from = String(args[1] ?? "");
        const to = String(args[2] ?? "");
        return s.split(from).join(to);
      }
      case "система.строка.разделить": {
        const s = String(args[0] ?? "");
        const sep = String(args[1] ?? "");
        return s.split(sep);
      }
      case "система.строка.найти": {
        const haystack = String(args[0] ?? "");
        const needle = String(args[1] ?? "");
        return haystack.indexOf(needle);
      }

      default:
        if (name.startsWith("система.сеть") && !sandbox.allowNetwork) {
          throw new SandboxError("Network not allowed");
        }
        console.error("[osnova-vm] invoke stub:", name);
        return null;
    }
  };
}

async function executeEntry(
  config: ResolvedRunConfig,
  windowApi: WindowApi | null,
  cliArgv: readonly string[] = [],
): Promise<number> {
  mockEventsQueue = null;
  if (config.mockEvents && Array.isArray(config.mockEvents)) {
    mockEventsQueue = [...config.mockEvents];
  }
  const { appDir, entryModule, entryProcedure, entryArgs, manifest } = config;
  const sandbox = applySandbox(config.permissions);
  const appContext: AppContext = {
    appId: manifest.id,
    storageRoot: STORAGE_ROOT,
    windowApi,
  };
  const gui = createGuiState();

  const mod = await loadModule(appDir, entryModule);
  if (!mod) {
    console.error("[osnova-vm] module not found:", entryModule, "in", appDir);
    return 1;
  }
  if (!isOsVbcModule(mod)) {
    console.error("[osnova-vm] invalid bytecode format:", entryModule);
    return 1;
  }

  const vm = new VM(mod, {
    invoke: createInvokeHandler(sandbox, appContext, gui),
  });

  let procIndex: number;
  try {
    procIndex = vm.findProcedureIndex(entryProcedure);
  } catch (e) {
    console.error("[osnova-vm] procedure not found:", entryProcedure, e);
    return 1;
  }

  const stackArgs: StackValue[] = entryArgs.map((a) => (a as StackValue) ?? null);
  const procMeta = mod.procedures[procIndex];
  let callArgs: StackValue[] = stackArgs;
  // Backward compatibility:
  // - главная() -> no args
  // - главная(аргументы) -> one array<string> argument
  if (entryProcedure === "главная" && procMeta) {
    if (procMeta.argc === 0) {
      callArgs = [];
    } else if (procMeta.argc === 1) {
      const argvSource = entryArgs.length > 0 ? entryArgs : cliArgv;
      const argv = argvSource.map((v) => String(v ?? ""));
      callArgs = [argv as unknown as StackValue];
    }
  }

  try {
    await vm.runProcedure(procIndex, callArgs);
    return 0;
  } catch (e) {
    if (e instanceof SandboxError) {
      console.error("[osnova-vm] sandbox:", e.message);
      return 126;
    }
    console.error("[osnova-vm] run error:", e);
    return 1;
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  let configPath: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" && args[i + 1]) {
      configPath = args[++i];
      break;
    }
  }

  if (!configPath) {
    console.error("Usage: osnova-vm --config <path-to-config.json>");
    return 1;
  }

  const raw = await fs.readFile(configPath, "utf-8");
  const config = JSON.parse(raw) as ResolvedRunConfig;

  applySandbox(config.permissions);

  const ui = await setupUI(config.uiKind, config.appDir);

  const code = await executeEntry(config, ui.windowApi ?? null, process.argv.slice(2));
  ui.close?.();
  return code;
}

export async function runWithConfig(config: ResolvedRunConfig): Promise<number> {
  applySandbox(config.permissions);
  const ui = await setupUI(config.uiKind, config.appDir);
  try {
    return await executeEntry(config, ui.windowApi ?? null, []);
  } finally {
    ui.close?.();
  }
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
