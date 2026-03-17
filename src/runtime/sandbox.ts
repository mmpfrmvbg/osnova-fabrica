/**
 * Песочница по permissions: ограничение доступа к ФС и сети в процессе VM.
 * Разрешения из манифеста (files.read, files.write, network.outbound) превращаются
 * в списки разрешённых путей и флаг сети; все обращения к ФС/сети проходят через обёртки.
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import type { AppManifest } from "./types";

export interface SandboxContext {
  /** Разрешённые каталоги для чтения (абсолютные пути). Подпути разрешены. */
  allowedReadPaths: string[];
  /** Разрешённые каталоги для записи. */
  allowedWritePaths: string[];
  /** Разрешён ли исходящий сетевой доступ. */
  allowNetwork: boolean;
  /** Обёртка fs: readFile, readdir, writeFile, mkdir с проверкой путей. */
  fs: SandboxedFs;
}

export interface SandboxedFs {
  readFile(filePath: string, encoding?: BufferEncoding): Promise<string>;
  writeFile(filePath: string, data: string | Buffer): Promise<void>;
  mkdir(dirPath: string, options?: { recursive?: boolean }): Promise<string | undefined>;
  access(filePath: string): Promise<void>;
}

function resolvePath(p: string): string {
  const expanded = p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
  return path.resolve(expanded);
}

function isAllowed(filePath: string, allowedDirs: string[]): boolean {
  const resolved = path.resolve(filePath);
  const normalized = path.normalize(resolved);
  for (const dir of allowedDirs) {
    const allowed = path.normalize(dir);
    if (normalized === allowed || normalized.startsWith(allowed + path.sep)) return true;
  }
  return false;
}

/**
 * Создать контекст песочницы из манифеста.
 * Пути из permissions.files.read/write разрешаются (~ → homedir); при отсутствии списков — запрет всего.
 */
export function createSandboxContext(permissions: AppManifest["permissions"]): SandboxContext {
  const allowedReadPaths = (permissions?.files?.read ?? []).map(resolvePath);
  const allowedWritePaths = (permissions?.files?.write ?? []).map(resolvePath);
  const allowNetwork = permissions?.network?.outbound !== false;

  const fsWrap: SandboxedFs = {
    async readFile(filePath: string, encoding: BufferEncoding = "utf-8"): Promise<string> {
      const resolved = path.resolve(filePath);
      if (allowedReadPaths.length === 0 || !isAllowed(resolved, allowedReadPaths)) {
        throw new SandboxError(`Read not allowed: ${resolved}`);
      }
      const result = await fs.readFile(resolved, { encoding });
      return result;
    },
    async writeFile(filePath: string, data: string | Buffer): Promise<void> {
      const resolved = path.resolve(filePath);
      if (allowedWritePaths.length === 0 || !isAllowed(resolved, allowedWritePaths)) {
        throw new SandboxError(`Write not allowed: ${resolved}`);
      }
      return fs.writeFile(resolved, data);
    },
    async mkdir(dirPath: string, options?: { recursive?: boolean }): Promise<string | undefined> {
      const resolved = path.resolve(dirPath);
      if (allowedWritePaths.length === 0 || !isAllowed(resolved, allowedWritePaths)) {
        throw new SandboxError(`Mkdir not allowed: ${resolved}`);
      }
      return fs.mkdir(resolved, options);
    },
    async access(filePath: string): Promise<void> {
      const resolved = path.resolve(filePath);
      if (allowedReadPaths.length === 0 || !isAllowed(resolved, allowedReadPaths)) {
        throw new SandboxError(`Access not allowed: ${resolved}`);
      }
      return fs.access(resolved);
    },
  };

  return {
    allowedReadPaths,
    allowedWritePaths,
    allowNetwork,
    fs: fsWrap,
  };
}

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}
