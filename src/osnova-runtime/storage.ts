/**
 * Хранилище приложения: ключ–значение по appId (файл store.json в каталоге приложения).
 */

import * as fs from "fs/promises";
import * as path from "path";

function safeAppId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function getStorageDir(storageRoot: string, appId: string): string {
  return path.join(storageRoot, safeAppId(appId));
}

export async function storageRead(storageRoot: string, appId: string, key: string): Promise<string | null> {
  const dir = getStorageDir(storageRoot, appId);
  const filePath = path.join(dir, "store.json");
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const data = JSON.parse(raw) as Record<string, string>;
    return key in data ? data[key] : null;
  } catch {
    return null;
  }
}

export async function storageWrite(storageRoot: string, appId: string, key: string, value: string): Promise<void> {
  const dir = getStorageDir(storageRoot, appId);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, "store.json");
  let data: Record<string, string> = {};
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    data = JSON.parse(raw) as Record<string, string>;
  } catch {
    // new store
  }
  data[key] = value;
  await fs.writeFile(filePath, JSON.stringify(data, null, 0), "utf-8");
}

export async function storageDelete(storageRoot: string, appId: string, key: string): Promise<void> {
  const dir = getStorageDir(storageRoot, appId);
  const filePath = path.join(dir, "store.json");
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const data = JSON.parse(raw) as Record<string, string>;
    delete data[key];
    await fs.writeFile(filePath, JSON.stringify(data, null, 0), "utf-8");
  } catch {
    // no store or no key — nothing to do
  }
}

export async function storageKeys(storageRoot: string, appId: string): Promise<string[]> {
  const dir = getStorageDir(storageRoot, appId);
  const filePath = path.join(dir, "store.json");
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const data = JSON.parse(raw) as Record<string, string>;
    return Object.keys(data);
  } catch {
    return [];
  }
}
