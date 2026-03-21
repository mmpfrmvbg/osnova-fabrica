// src/lib/usage-logger.ts
// Логирует каждый LLM-вызов в logs/llm-usage/YYYY-MM-DD.jsonl
import * as fs from 'fs';
import * as path from 'path';

export interface LlmUsageEntry {
  timestamp: string;
  role: string;
  model: string;
  tokenUsage: {
    prompt: number;
    completion: number;
    total: number;
  };
  durationMs?: number;
  runId?: string;
}

function getLogPath(): string {
  const today = new Date().toISOString().slice(0, 10);
  const dir = path.resolve('logs', 'llm-usage');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${today}.jsonl`);
}

export function logLlmUsage(entry: LlmUsageEntry): void {
  try {
    fs.appendFileSync(getLogPath(), JSON.stringify(entry) + '\n', 'utf-8');
  } catch (err) {
    process.stderr.write(
      `[usage-logger] ошибка записи: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

export function readUsageLog(isoDate?: string): LlmUsageEntry[] {
  const d = isoDate ?? new Date().toISOString().slice(0, 10);
  const p = path.resolve('logs', 'llm-usage', `${d}.jsonl`);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf-8')
    .split('\n').filter(l => l.trim().length > 0)
    .flatMap(l => { try { return [JSON.parse(l) as LlmUsageEntry]; } catch { return []; } });
}
