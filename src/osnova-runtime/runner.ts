/**
 * Реализация IOsnovaRunner: запуск процесса VM (vm-runner.js) с конфигом в JSON-файле.
 * invokeEntry в run.ts заменён на вызов runner.run(config).
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { spawn } from "child_process";
import type { IOsnovaRunner, ResolvedRunConfig } from "./types";

const RUNTIME_DIR = __dirname;

async function getVmRunnerExec(): Promise<{ executable: string; args: string[] }> {
  const jsPath = path.join(RUNTIME_DIR, "vm-runner.js");
  const tsPath = path.join(RUNTIME_DIR, "vm-runner.ts");
  try {
    await fs.access(jsPath);
    return { executable: process.execPath, args: [jsPath] };
  } catch {
    try {
      await fs.access(tsPath);
      const nodeDir = path.dirname(process.execPath);
      const npxName = process.platform === "win32" ? "npx.cmd" : "npx";
      const npxPath = path.join(nodeDir, npxName);
      try {
        await fs.access(npxPath);
        return { executable: npxPath, args: ["tsx", tsPath] };
      } catch {
        return { executable: "npx", args: ["tsx", tsPath] };
      }
    } catch {
      throw new Error("vm-runner.js and vm-runner.ts not found in " + RUNTIME_DIR);
    }
  }
}

/**
 * Сериализуемый конфиг для VM-процесса (без непередаваемых полей).
 * manifest оставляем для будущего использования в VM (id, name и т.д.).
 */
function configToJson(config: ResolvedRunConfig): string {
  return JSON.stringify({
    appDir: config.appDir,
    manifest: config.manifest,
    entryModule: config.entryModule,
    entryProcedure: config.entryProcedure,
    entryArgs: config.entryArgs,
    uiKind: config.uiKind,
    permissions: config.permissions,
    mockEvents: config.mockEvents,
  });
}

/**
 * Запуск VM в отдельном процессе: записываем конфиг во временный файл,
 * вызываем node vm-runner.js --config <path>, ждём завершения и возвращаем код выхода.
 */
async function runSubprocess(config: ResolvedRunConfig): Promise<number> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-vm-"));
  const configPath = path.join(tmpDir, "config.json");

  try {
    await fs.writeFile(configPath, configToJson(config), "utf-8");
  } catch (e) {
    console.error("[osnova-runtime] failed to write VM config:", e);
    await fs.rm(tmpDir, { recursive: true }).catch(() => {});
    return 1;
  }

  const { executable, args } = await getVmRunnerExec();
  const spawnArgs = [...args, "--config", configPath];

  const useShell = executable !== process.execPath;
  const escape = (s: string) => (s.includes(" ") || s.includes('"') ? `"${s.replace(/"/g, '\\"')}"` : s);
  return new Promise((resolve) => {
    const child = useShell
      ? spawn(
          [executable, ...spawnArgs].map(escape).join(" "),
          { stdio: ["ignore", "inherit", "inherit"], cwd: path.dirname(config.appDir), env: { ...process.env }, shell: true }
        )
      : spawn(executable, spawnArgs, {
          stdio: ["ignore", "inherit", "inherit"],
          cwd: path.dirname(config.appDir),
          env: { ...process.env },
        });

    child.on("error", (err) => {
      console.error("[osnova-runtime] VM process error:", err);
      resolve(1);
    });

    child.on("close", (code, signal) => {
      fs.rm(tmpDir, { recursive: true }).catch(() => {});
      if (signal) {
        resolve(128 + (signal === "SIGKILL" ? 9 : 1));
      } else {
        resolve(code ?? 0);
      }
    });
  });
}

/**
 * Раннер по умолчанию: один подпроцесс VM на один run.
 * Позже можно добавить in-process runner (встраиваемый интерпретатор).
 */
export function createSubprocessRunner(): IOsnovaRunner {
  return {
    run: runSubprocess,
  };
}
