// src/intelligence/store.ts
// Хранилище сигналов: read/write runs/intelligence.jsonl

import * as fs from 'fs';
import * as path from 'path';

export type SignalStatus = 'new' | 'watching' | 'stale' | 'archived';

export interface IntelligenceSignal {
  id: string; // sha256-like: source:title[:8]
  source: string; // 'arxiv' | 'github-releases' | 'hh' | 'rss'
  title: string;
  url: string;
  raw_date: string; // ISO или как у источника
  fetched_at: string; // ISO
  summary?: string; // заполняет summarizer
  relevance_score?: number; // 0..1, заполняет summarizer
  status: SignalStatus;
  tags: string[];
}

const STORE_PATH = path.resolve('runs', 'intelligence.jsonl');

export function readSignals(storePath = STORE_PATH): IntelligenceSignal[] {
  if (!fs.existsSync(storePath)) return [];
  return fs
    .readFileSync(storePath, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as IntelligenceSignal];
      } catch {
        return [];
      }
    });
}

export function writeSignals(signals: IntelligenceSignal[], storePath = STORE_PATH): void {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(
    storePath,
    signals.map((s) => JSON.stringify(s)).join('\n') + '\n',
    'utf-8',
  );
}

export function appendSignal(signal: IntelligenceSignal, storePath = STORE_PATH): void {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.appendFileSync(storePath, JSON.stringify(signal) + '\n', 'utf-8');
}

/** Upsert по id: если сигнал уже есть — обновляем, иначе append. */
export function upsertSignal(signal: IntelligenceSignal, storePath = STORE_PATH): void {
  const existing = readSignals(storePath);
  const idx = existing.findIndex((s) => s.id === signal.id);
  if (idx >= 0) {
    existing[idx] = signal;
    writeSignals(existing, storePath);
  } else {
    appendSignal(signal, storePath);
  }
}
